/**
 * APSS Integration Hub — Full Pipeline
 * 
 * Complete flow:
 * 1. Read PTTEP FlashBuy Excel
 * 2. AI parse item descriptions (Ollama - local)
 * 3. Match against BC existing items (via BC API)
 * 4. Create blank Item Cards for unmatched items
 * 5. Create Sales Quote with all items
 * 
 * Usage:
 *   node shared/pipeline.js <excel-file>
 *   node shared/pipeline.js --watch <folder>    ← Auto-detect new exports
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readFlashBuyExcel } = require('./excel-reader');
const { parseItemDescription } = require('./parser');
const { matchItem, getMatchStatus, stringSimilarity } = require('./matcher');
const { aiParseItem, checkAICapability } = require('./ai-client');
const { BCClient } = require('./bc-client');
const { getBcSampleDataPath } = require('./sample-data-paths');

function normalizeBrandName(value) {
  const text = String(value || '').trim();
  return text || 'UNSPECIFIED BRAND';
}

function makeBrandGroupKey(brandName, excelFilePath = '') {
  const normalized = normalizeBrandName(brandName);
  let rfqNoDigits = '';
  if (excelFilePath) {
    const match = path.basename(excelFilePath).match(/\d+/);
    if (match) {
      rfqNoDigits = match[0];
    }
  }
  if (!rfqNoDigits) {
    rfqNoDigits = '1782180246343'; // Default fallback digit sequence
  }

  let hashNum = 0;
  for (let i = 0; i < normalized.length; i++) {
    hashNum = (hashNum * 31 + normalized.charCodeAt(i)) % 100000;
  }
  const paddedHash = String(hashNum).padStart(5, '0');
  return `${rfqNoDigits}${paddedHash}`;
}

function makeExternalDocNumber(brandName, today) {
  const slug = normalizeBrandName(brandName)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'UNSPECIFIED';
  return `PTTEP-${slug}-${today}`.slice(0, 35);
}

// ─── Config ──────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PTTEP_CUSTOMER_NO = 'APSS-CUST-01941'; // PTTEP fixed customer in BC

// ─── Pipeline ────────────────────────────────────────────────
async function runPipeline(excelFilePath, options = {}) {
  const startTime = Date.now();
  const dryRun = options.dryRun !== false; // Default to dry-run (safe mode)
  const useAI = options.useAI !== false;
  const maxAI = options.maxAI || 20;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const reportProgress = (percent, stage, detail = '') => {
    if (!onProgress) return;
    onProgress({
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      stage,
      detail,
    });
  };

  reportProgress(1, 'Starting import', path.basename(excelFilePath));

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  APSS Integration Hub — Full Pipeline                   ║');
  console.log(`║  Mode: ${dryRun ? '🔍 DRY RUN (preview only)' : '🚀 LIVE (writing to BC)'}              ║`);
  console.log('║  🤖 Auto-Routing Cloud (Bedrock) / Local AI (Ollama)      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Check AI capability (Bedrock / Ollama)
  let aiEnabled = false;
  let aiMode = 'REGEX';
  if (useAI) {
    const aiCapability = await checkAICapability();
    aiEnabled = aiCapability.running;
    aiMode = aiCapability.mode;
    console.log(`🤖 AI Provider: ${aiCapability.detail}`);
  }
  reportProgress(5, 'Checking AI and Business Central connectivity');

  // Check BC config
  let bc = null;
  let bcItems = [];
  let isSimulatedBC = false;
  
  // Try to connect to real Business Central to fetch items, even in Dry Run mode
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (
      String(config.tenantId || '').startsWith('YOUR_') ||
      String(config.clientId || '').startsWith('YOUR_') ||
      String(config.clientSecret || '').startsWith('YOUR_')
    ) {
      throw new Error('Placeholder credentials detected in config.json');
    }
    const client = new BCClient(config);
    console.log('🔗 Connecting to Business Central (Read-only for matching)...');
    await client.init();
    
    // Fetch existing items from BC
    console.log('📥 Fetching existing Item Cards from BC for matching...');
    bcItems = await client.getItems();
    console.log(`   Found ${bcItems.length} existing items in BC\n`);
    
    if (!dryRun) {
      bc = client; // Keep client for writing if not dry-run
    }
  } catch (err) {
    console.log(`⚠️  Live BC connection/fetch failed: ${err.message}`);
    console.log('👉 Falling back to BC Simulation Mode (using local or example sample BC data for matching)\n');
    isSimulatedBC = true;
    
    // Instantiate Simulated BC Client
    bc = {
      init: async () => ({ displayName: 'APSS-SG (Simulated Sandbox)', id: 'mock-co-id' }),
      getItems: async () => [],
      createItem: async (itemData) => {
        // Simulate latency
        await new Promise(r => setTimeout(r, 100)); 
        return {
          number: `APSS-ITEM-${Math.floor(100000 + Math.random() * 900000)}`,
          id: `mock-item-id-${Math.floor(1000 + Math.random() * 9000)}`
        };
      },
      createSalesQuote: async (quoteData) => {
        return {
          number: `SQ-${Math.floor(100000 + Math.random() * 900000)}`,
          id: 'mock-quote-id'
        };
      },
      addSalesQuoteLine: async (quoteId, lineData) => {
        return { success: true };
      }
    };
    
    // Load mock items for matching context
    const mockPath = getBcSampleDataPath();
    if (fs.existsSync(mockPath)) {
      bcItems = JSON.parse(fs.readFileSync(mockPath, 'utf-8'));
      console.log(`   Loaded mock BC data for matching: ${bcItems.length} items`);
    }
  }
  reportProgress(10, 'Reading Excel source');

  // ─── Step 1: Read Excel ──────────────────────────────────────
  console.log(`\n📂 Reading: ${path.basename(excelFilePath)}`);
  const flashBuy = readFlashBuyExcel(excelFilePath);
  console.log(`   Period: ${flashBuy.period}`);
  console.log(`   Items: ${flashBuy.total_items}\n`);
  reportProgress(15, 'Excel loaded', `${flashBuy.total_items} item(s) detected`);

  // ─── Step 2: Process each item ───────────────────────────────
  console.log('⚙️  Processing items...\n');

  const results = {
    matched: [],      // Matched to existing BC item
    review: [],       // Needs human review
    to_create: [],    // Need to create blank Item Card
    errors: [],       // Processing errors
  };

  // Transform BC items to match format expected by matcher
  const bcItemsForMatch = bcItems.map(item => ({
    item_no: item.number || item.item_no,
    description: item.displayName || item.description,
    description_2: item.description_2 || '',
    item_references: item.gtin ? [{ reference_no: item.gtin }] : (item.item_references || []),
  }));

  for (let i = 0; i < flashBuy.items.length; i++) {
    const item = flashBuy.items[i];
    const progress = `[${i + 1}/${flashBuy.total_items}]`;
    const loopPercent = 15 + Math.round(((i + 1) / Math.max(flashBuy.items.length, 1)) * 65);
    reportProgress(loopPercent, 'Matching items', `${i + 1}/${flashBuy.total_items}: ${item.material_description.substring(0, 80)}`);

    try {
      // Regex parse
      const parsed = parseItemDescription(item.material_description);
      
      // Enrich with PTTEP's own columns (more reliable)
      parsed.part_number = (item.part_number && item.part_number !== 'N/A') 
        ? item.part_number : parsed.part_number;
      parsed.manufacturer = (item.manufacturer && item.manufacturer !== 'N/A')
        ? item.manufacturer : parsed.manufacturer;

      // AI parse (limited count for performance)
      let aiResult = null;
      if (aiEnabled && i < maxAI) {
        process.stdout.write(`  ${progress} 🤖 ${aiMode}: ${item.material_description.substring(0, 45)}...`);
        aiResult = await aiParseItem(
          item.material_description, item.long_description,
          item.part_number, item.manufacturer
        );
        console.log(aiResult ? ' ✅' : ' ⚠️');
      }

      // Match against BC items
      const matches = matchItem(parsed, bcItemsForMatch);
      const status = getMatchStatus(matches);

      const processedItem = {
        line_no: item.item_no,
        material_code: item.material_code,
        material_description: item.material_description,
        long_description: item.long_description,
        part_number: parsed.part_number || item.part_number,
        manufacturer: parsed.manufacturer || item.manufacturer,
        uom: item.uom,
        quantity: item.total_quantity,
        pr_number: item.pr_number,
        certificate_required: item.certificate_required,
        shelf_life_required: item.shelf_life_required,
        quote_status: item.quote_status,
        unit_price: item.unit_price,
        currency: item.currency,
        delivery_lead_time: item.delivery_lead_time_weeks,
        match_status: status.status,
        best_match: status.best_match,
        ai_parsed: aiResult,
        short_description: aiResult?.short_description 
          || item.material_description.substring(0, 50),
      };

      if (status.action === 'AUTO_LINK') {
        results.matched.push(processedItem);
      } else if (status.action === 'REVIEW_REQUIRED') {
        results.review.push(processedItem);
      } else {
        results.to_create.push(processedItem);
      }
    } catch (err) {
      results.errors.push({ line_no: item.item_no, error: err.message });
    }
  }

  reportProgress(82, 'Grouping brand feed');

  // ─── Step 3: Create blank Item Cards in BC ───────────────────
  if (bc && !dryRun && results.to_create.length > 0) {
    console.log(`\n🆕 Creating ${results.to_create.length} blank Item Cards in BC...\n`);
    
    const newMockItems = [];
    for (let i = 0; i < results.to_create.length; i++) {
      const item = results.to_create[i];
      try {
        process.stdout.write(`  [${i + 1}/${results.to_create.length}] Creating: ${item.short_description.substring(0, 40)}...`);
        
        const newItem = await bc.createItem({
          description: item.short_description,
          type: 'Inventory',
          uom: item.uom || 'EA',
          part_number: item.part_number || '',
        });
        
        item.bc_item_no = newItem.number;
        item.bc_item_id = newItem.id;
        console.log(` ✅ → ${newItem.number}`);

        if (isSimulatedBC) {
          newMockItems.push({
            item_no: newItem.number,
            description: item.short_description,
            description_2: item.manufacturer || '',
            base_uom: item.uom || 'EA',
            gen_prod_posting_group: 'GOODS_OUTOFSCOPE',
            vendor_no: '',
            vendor_name: '',
            unit_cost: 0,
            gtin: item.part_number || '',
            item_references: item.part_number ? [{ reference_type: 'Customer', reference_no: item.part_number }] : []
          });
        }
      } catch (err) {
        console.log(` ❌ ${err.message.substring(0, 60)}`);
        item.create_error = err.message;
      }
    }

    // Append mock items to the local simulation file so they are matched next time
    if (isSimulatedBC && newMockItems.length > 0) {
      const mockPath = path.join(__dirname, '..', 'sample-data', 'bc_existing_items.local.json');
      if (fs.existsSync(mockPath)) {
        try {
          const currentMock = JSON.parse(fs.readFileSync(mockPath, 'utf-8'));
          const updatedMock = [...currentMock, ...newMockItems];
          fs.writeFileSync(mockPath, JSON.stringify(updatedMock, null, 2));
          console.log(`💾 Saved ${newMockItems.length} newly simulated items to local mock database.`);
        } catch (e) {
          console.error(`Failed to update mock database: ${e.message}`);
        }
      } else if (newMockItems.length > 0) {
        console.log('ℹ️  Skipped updating sample BC data because only the public example file is available.');
      }
    }
  }

  // ─── Step 4: Group items by PR Number ───────────────────────
  // Each PR Number → 1 separate Sales Quote in BC
  // IMPORTANT: One Excel row can belong to MULTIPLE PRs (comma-separated).
  // In that case, we duplicate the item entry into each PR group.
  const allProcessedItems = [
    ...results.matched,
    ...results.review,
    ...results.to_create,
  ];

  const brandGroups = new Map();
  for (const item of allProcessedItems) {
    const brandName = normalizeBrandName(item.manufacturer);
    const brandKey = makeBrandGroupKey(brandName, excelFilePath);

    if (!brandGroups.has(brandKey)) {
      brandGroups.set(brandKey, {
        brand_key: brandKey,
        brand_name: brandName,
        items: [],
      });
    }

    brandGroups.get(brandKey).items.push({
      ...item,
      quantity: item.total_quantity || item.quantity || 1,
      total_quantity: item.total_quantity || item.quantity || 1,
      _brand_key: brandKey,
      _brand_name: brandName,
    });
  }

  const brandList = Array.from(brandGroups.values()).sort((a, b) =>
    a.brand_name.localeCompare(b.brand_name)
  );
  console.log(`\nFound ${brandList.length} brand group(s) across ${allProcessedItems.length} items:`);
  for (const group of brandList) {
    console.log(`   ${group.brand_name}: ${group.items.length} item(s)`);
  }

  const salesQuotes = [];

  if (bc && !dryRun) {
    reportProgress(86, 'Creating Sales Quotes in Business Central');
    console.log(`\nCreating ${brandList.length} Sales Quote(s) in BC (one per brand)...\n`);

    for (const group of brandList) {
      const brandItems = group.items;
      const today = new Date().toISOString().split('T')[0];
      const extDocNo = makeExternalDocNumber(group.brand_name, today);

      console.log(`  Brand ${group.brand_name} (${brandItems.length} items)`);
      try {
        const sq = await bc.createSalesQuote({
          customerNumber: PTTEP_CUSTOMER_NO,
          externalDocNumber: extDocNo,
        });
        console.log(`    SQ created: ${sq.number}`);

        let linesOk = 0;
        for (const item of brandItems) {
          try {
            const itemId = item.best_match?.bc_item_id || item.bc_item_id;
            if (!itemId) { process.stdout.write('!'); continue; }

            await bc.addSalesQuoteLine(sq.id, {
              itemId,
              quantity: parseInt(item.quantity) || 1,
              uom: item.uom || 'EA',
              description: item.material_description.substring(0, 100),
            });
            process.stdout.write('.');
            linesOk++;
          } catch (err) {
            process.stdout.write('x');
          }
        }
        console.log(` (${linesOk}/${brandItems.length} lines added)\n`);

        salesQuotes.push({
          brand_key: group.brand_key,
          brand_name: group.brand_name,
          sq_number: sq.number,
          sq_id: sq.id,
          item_count: brandItems.length,
          lines_added: linesOk,
        });
      } catch (err) {
        console.log(`    SQ creation failed for brand ${group.brand_name}: ${err.message}\n`);
        salesQuotes.push({
          brand_key: group.brand_key,
          brand_name: group.brand_name,
          sq_number: null,
          error: err.message,
          item_count: brandItems.length,
          lines_added: 0,
        });
      }
    }
  }

  reportProgress(92, 'Writing output report');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sqCreated = salesQuotes.filter(s => s.sq_number).length;

  console.log('\n==============================================');
  console.log('PIPELINE COMPLETE');
  console.log('==============================================');
  console.log(`Items processed:          ${flashBuy.total_items}`);
  console.log(`Matched to existing BC:   ${results.matched.length}`);
  console.log(`Review required:          ${results.review.length}`);
  console.log(`Blank Item Cards:         ${results.to_create.length}`);
  console.log(`Errors:                   ${results.errors.length}`);
  console.log(`Brand groups found:       ${brandList.length}`);
  console.log(`Sales Quotes created:     ${sqCreated}`);
  console.log(`Time:                     ${elapsed}s`);
  console.log(`Mode:                     ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  if (salesQuotes.length > 0 && !dryRun) {
    for (const sq of salesQuotes) {
      console.log(`  ${sq.brand_name} -> ${sq.sq_number || 'FAILED'}`);
    }
  }

  if (dryRun && brandList.length > 0) {
    console.log('\nDRY RUN - Sales Quotes were not created. Planned groups:');
    for (const group of brandList) {
      console.log(`  ${group.brand_name} (${group.items.length} items)`);
    }
    console.log('');
  }

  // Save report
  const outputDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  
  const report = {
    timestamp: new Date().toISOString(),
    file: path.basename(excelFilePath),
    period: flashBuy.period,
    mode: dryRun ? 'DRY_RUN' : 'LIVE',
    // Legacy single SQ field (kept for backward compat with server.js list API)
    sales_quote: salesQuotes.length > 0 && salesQuotes[0].sq_number ? salesQuotes[0].sq_number : null,
    // New: per-brand breakdown
    brand_count: brandList.length,
    sales_quotes: salesQuotes,
    brand_groups: Object.fromEntries(
      brandList.map(group => [
        group.brand_key,
        {
          brand_name: group.brand_name,
          item_count: group.items.length,
          total_quantity: group.items.reduce((sum, item) => sum + (parseFloat(item.quantity) || 0), 0),
          items: group.items,
        }
      ])
    ),
    summary: {
      total: flashBuy.total_items,
      matched: results.matched.length,
      review: results.review.length,
      to_create: results.to_create.length,
      errors: results.errors.length,
      brand_count: brandList.length,
      sq_created: sqCreated,
    },
    items: {
      matched: results.matched,
      review: results.review,
      to_create: results.to_create,
      errors: results.errors,
    },
  };

  // Clean up all old reports and POSCO files in output directory to keep the feed fresh
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir);
    files.forEach(file => {
      if ((file.startsWith('report_') && file.endsWith('.json')) || (file.startsWith('posco_rfqs_') && file.endsWith('.json'))) {
        try {
          fs.unlinkSync(path.join(outputDir, file));
        } catch (e) {
          console.error(`Failed to delete old file ${file}: ${e.message}`);
        }
      }
    });
  }

  const reportPath = path.join(outputDir, `report_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`💾 Report saved: ${reportPath}\n`);

  reportProgress(100, 'Import completed', `${report.summary.total} items grouped into ${report.summary.brand_count} brand record(s)`);

  return report;
}

// ─── File Watcher Mode ───────────────────────────────────────
function watchFolder(folderPath, options = {}) {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  APSS Integration Hub — Watch Mode                      ║');
  console.log(`║  Watching: ${folderPath.substring(0, 43).padEnd(43)} ║`);
  console.log('║  Drop a FlashBuy Excel file to auto-process             ║');
  console.log('║  Press Ctrl+C to stop                                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const processedFiles = new Set();

  // Scan for existing xlsx files on startup
  const existing = fs.readdirSync(folderPath).filter(f => 
    f.toLowerCase().endsWith('.xlsx') && f.toLowerCase().includes('flashbuy')
  );
  existing.forEach(f => processedFiles.add(f));
  console.log(`  ℹ️  Found ${existing.length} existing FlashBuy file(s) (skipped)\n`);
  console.log('  👀 Waiting for new files...\n');

  fs.watch(folderPath, async (eventType, filename) => {
    if (!filename) return;
    if (!filename.toLowerCase().endsWith('.xlsx')) return;
    if (!filename.toLowerCase().includes('flashbuy')) return;
    if (processedFiles.has(filename)) return;

    // Wait a moment for file to finish writing
    await new Promise(r => setTimeout(r, 2000));

    const filePath = path.join(folderPath, filename);
    if (!fs.existsSync(filePath)) return;

    processedFiles.add(filename);
    console.log(`\n  🆕 New file detected: ${filename}`);
    console.log('  ═══════════════════════════════════════════\n');

    try {
      await runPipeline(filePath, options);
    } catch (err) {
      console.error(`  ❌ Pipeline error: ${err.message}\n`);
    }

    console.log('  👀 Waiting for next file...\n');
  });
}

// ─── CLI ─────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node shared/pipeline.js <excel-file>             Process a single file (dry run)');
    console.log('  node shared/pipeline.js <excel-file> --live      Process and write to BC');
    console.log('  node shared/pipeline.js --watch <folder>         Watch folder for new exports');
    console.log('  node shared/pipeline.js --watch <folder> --live  Watch + auto-write to BC');
    console.log('');
    console.log('Examples:');
    console.log('  node shared/pipeline.js "D:\\Downloads\\FlashBuy_Catalog.xlsx"');
    console.log('  node shared/pipeline.js --watch "D:\\Downloads" --live');
    process.exit(0);
  }

  const isWatch = args.includes('--watch');
  const isLive = args.includes('--live');
  const noAI = args.includes('--no-ai');
  const filePath = args.find(a => !a.startsWith('--'));

  const options = {
    dryRun: !isLive,
    useAI: !noAI,
    maxAI: 20,
  };

  if (isWatch) {
    const watchDir = filePath || path.join('D:', 'GITHUB', 'my-extension');
    watchFolder(watchDir, options);
  } else if (filePath) {
    await runPipeline(filePath, options);
  } else {
    console.log('Error: Please provide an Excel file path or use --watch');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runPipeline };

