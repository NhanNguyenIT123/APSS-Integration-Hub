/**
 * PTTEP Integration Hub — v2 with Real Data + Local AI (Ollama)
 * 
 * Reads real PTTEP FlashBuy Excel export
 * Uses local Qwen2.5:7B via Ollama for AI parsing
 * ALL DATA STAYS ON YOUR MACHINE
 */

const path = require('path');
const fs = require('fs');
const { readFlashBuyExcel } = require('./excel-reader');
const { parseItemDescription } = require('./parser');
const { matchItem, getMatchStatus } = require('./matcher');
const { aiParseItem, checkOllama, DEFAULT_MODEL } = require('./ollama-client');
const { getBcSampleDataPath } = require('./sample-data-paths');

// ─── Config ──────────────────────────────────────────────────────
const EXCEL_FILE = path.join(__dirname, '..', 'FlashBuy_Catalog_09JUN2026_13JUN2026_06.48.19.xlsx');
const BC_ITEMS_FILE = getBcSampleDataPath();
const MAX_AI_ITEMS = 208;  // Process ALL items for full demo

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  APSS Integration Hub v2.0                              ║');
  console.log('║  PTTEP FlashBuy Processor + Local AI (Ollama)           ║');
  console.log('║  🔒 All data processed locally — nothing sent outside   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Step 1: Check Ollama
  console.log('🔍 Checking Ollama...');
  const ollamaStatus = await checkOllama();
  
  if (!ollamaStatus.running) {
    console.log('❌ Ollama is not running! Start it with: ollama serve');
    console.log('   Falling back to regex-only mode...\n');
  } else {
    console.log(`✅ Ollama is running`);
    console.log(`   Available models: ${ollamaStatus.models.join(', ')}`);
    console.log(`   Using: ${DEFAULT_MODEL}\n`);
  }

  // Step 2: Read Excel
  console.log('📂 Reading PTTEP FlashBuy export...');
  const flashBuy = readFlashBuyExcel(EXCEL_FILE);
  console.log(`   Period: ${flashBuy.period}`);
  console.log(`   Total items: ${flashBuy.total_items}\n`);

  // Step 3: Load BC items
  const bcItems = JSON.parse(fs.readFileSync(BC_ITEMS_FILE, 'utf-8'));
  console.log(`📂 Loaded BC Item database: ${bcItems.length} existing items\n`);

  // Step 4: Process items
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Processing items...');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results = {
    auto_link: [],
    review: [],
    create_blank: [],
    ai_parsed: [],
  };

  const aiItemCount = Math.min(MAX_AI_ITEMS, flashBuy.total_items);
  
  for (let i = 0; i < flashBuy.items.length; i++) {
    const item = flashBuy.items[i];
    const progress = `[${i + 1}/${flashBuy.total_items}]`;
    
    // Step 4a: Regex parsing
    const regexParsed = parseItemDescription(item.material_description);
    
    // Use PTTEP's own part number and manufacturer columns (more reliable than regex)
    const enrichedParsed = {
      ...regexParsed,
      part_number: item.part_number && item.part_number !== 'N/A' 
        ? item.part_number 
        : regexParsed.part_number,
      manufacturer: item.manufacturer && item.manufacturer !== 'N/A'
        ? item.manufacturer
        : regexParsed.manufacturer,
    };

    // Step 4b: AI parsing (for first N items in demo)
    let aiParsed = null;
    if (ollamaStatus.running && i < aiItemCount) {
      process.stdout.write(`  ${progress} AI parsing: ${item.material_description.substring(0, 50)}...`);
      aiParsed = await aiParseItem(
        item.material_description,
        item.long_description,
        item.part_number,
        item.manufacturer
      );
      if (aiParsed) {
        console.log(' ✅');
        results.ai_parsed.push({
          item_no: item.item_no,
          material_description: item.material_description,
          ai_result: aiParsed,
        });
      } else {
        console.log(' ⚠️ (fallback to regex)');
      }
    }

    // Step 4c: Match against BC items
    const matches = matchItem(enrichedParsed, bcItems);
    const status = getMatchStatus(matches);

    const result = {
      item_no: item.item_no,
      material_code: item.material_code,
      material_description: item.material_description,
      part_number: enrichedParsed.part_number,
      manufacturer: enrichedParsed.manufacturer,
      uom: item.uom,
      quantity: item.total_quantity,
      pr_number: item.pr_number,
      quote_status: item.quote_status,
      certificate_required: item.certificate_required,
      match_status: status.status,
      action: status.action,
      best_match: status.best_match,
      ai_parsed: aiParsed,
      // For blank item creation
      suggested_short_desc: aiParsed?.short_description || item.material_description.substring(0, 50),
    };

    if (status.action === 'AUTO_LINK') {
      results.auto_link.push(result);
    } else if (status.action === 'REVIEW_REQUIRED') {
      results.review.push(result);
    } else {
      results.create_blank.push(result);
    }
  }

  // ─── Print Results ───────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Auto-link
  console.log(`✅ AUTO-LINK (${results.auto_link.length} items)\n`);
  for (const r of results.auto_link) {
    console.log(`   #${r.item_no} ${r.material_description.substring(0, 60)}`);
    console.log(`   → ${r.best_match.bc_item_no} (${(r.best_match.confidence * 100).toFixed(0)}%)`);
    console.log('');
  }

  // Review
  console.log(`⚠️  REVIEW REQUIRED (${results.review.length} items)\n`);
  for (const r of results.review) {
    console.log(`   #${r.item_no} ${r.material_description.substring(0, 60)}`);
    console.log(`   P/N: ${r.part_number || 'N/A'} | MFGR: ${r.manufacturer || 'N/A'}`);
    if (r.best_match) {
      console.log(`   → Suggested: ${r.best_match.bc_item_no} (${(r.best_match.confidence * 100).toFixed(0)}%)`);
    }
    console.log('');
  }

  // Create blank
  console.log(`🆕 CREATE BLANK (${results.create_blank.length} items)\n`);
  for (const r of results.create_blank.slice(0, 15)) { // Show first 15
    console.log(`   #${r.item_no} ${r.material_description.substring(0, 60)}`);
    console.log(`   P/N: ${r.part_number || 'N/A'} | MFGR: ${r.manufacturer || 'N/A'} | UOM: ${r.uom}`);
    if (r.ai_parsed) {
      console.log(`   AI → Type: ${r.ai_parsed.item_type} | Short: "${r.ai_parsed.short_description}"`);
    }
    console.log('');
  }
  if (results.create_blank.length > 15) {
    console.log(`   ... and ${results.create_blank.length - 15} more items\n`);
  }

  // ─── Summary ─────────────────────────────────────────────────
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY                                                ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  📋 Total items from PTTEP:     ${String(flashBuy.total_items).padStart(4)}                    ║`);
  console.log(`║  ✅ Auto-link (matched):         ${String(results.auto_link.length).padStart(4)}                    ║`);
  console.log(`║  ⚠️  Review required:             ${String(results.review.length).padStart(4)}                    ║`);
  console.log(`║  🆕 Create blank Item Card:      ${String(results.create_blank.length).padStart(4)}                    ║`);
  console.log(`║  🤖 AI-parsed items:             ${String(results.ai_parsed.length).padStart(4)}                    ║`);
  console.log(`║  🔒 Data sent externally:           0                    ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Save results
  const outputDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  
  const outputPath = path.join(outputDir, 'flashbuy_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`💾 Full results saved to: ${outputPath}`);
  
  // Save AI-parsed items separately
  if (results.ai_parsed.length > 0) {
    const aiPath = path.join(outputDir, 'ai_parsed_items.json');
    fs.writeFileSync(aiPath, JSON.stringify(results.ai_parsed, null, 2));
    console.log(`🤖 AI parse results saved to: ${aiPath}`);
  }

  console.log('\n✨ Done!\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
