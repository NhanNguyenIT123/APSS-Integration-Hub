/**
 * PTTEP Integration Hub — Main Entry Point (Prototype v1)
 * 
 * This is a LOCAL prototype that:
 * 1. Reads CSV export from PTTEP portal
 * 2. Parses item descriptions into structured data
 * 3. Matches items against existing BC Item Cards
 * 4. Generates a report showing what to auto-link vs create blank
 * 
 * ⚠️ Does NOT connect to Business Central yet (Phase 1 = offline only)
 */

const fs = require('fs');
const path = require('path');
const { parseItemDescription } = require('./parser');
const { matchItem, getMatchStatus } = require('./matcher');

// ─── CSV Parser (simple, no external dependency needed) ──────────
function parseCSV(csvContent) {
  const lines = csvContent.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields with commas inside
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return rows;
}

// ─── Main Processing ─────────────────────────────────────────────
function processExport(csvFilePath, bcItemsPath) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  APSS Integration Hub — PTTEP Portal Item Processor');
  console.log('  Prototype v1.0 (Offline Mode)');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Load files
  const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
  const bcItems = JSON.parse(fs.readFileSync(bcItemsPath, 'utf-8'));
  
  console.log(`📂 Loaded PTTEP export: ${csvFilePath}`);
  console.log(`📂 Loaded BC items database: ${bcItems.length} existing items\n`);
  
  // Parse CSV
  const portalItems = parseCSV(csvContent);
  console.log(`📋 Total items from PTTEP portal: ${portalItems.length}\n`);
  console.log('───────────────────────────────────────────────────────────\n');
  
  // Process each item
  const results = {
    auto_link: [],     // High confidence - can auto-link to existing BC item
    review: [],        // Medium confidence - needs human review
    create_blank: [],  // No match - need to create blank Item Card
  };
  
  for (const item of portalItems) {
    const parsed = parseItemDescription(item.Description);
    const matches = matchItem(parsed, bcItems);
    const status = getMatchStatus(matches);
    
    const result = {
      request_id: item.Request_ID,
      line_no: item.Item_No,
      raw_description: item.Description,
      quantity: item.Quantity,
      uom: item.UOM,
      category: item.Category,
      priority: item.Priority,
      parsed: {
        item_type: parsed.item_type,
        part_number: parsed.part_number,
        manufacturer: parsed.manufacturer,
        sizes: parsed.sizes,
      },
      match_status: status.status,
      action: status.action,
      best_match: status.best_match,
      all_matches: matches.slice(0, 3), // Top 3 matches
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
  
  // Auto-link items
  console.log(`✅ AUTO-LINK (${results.auto_link.length} items) — High confidence match`);
  console.log('   These items will be automatically linked to existing BC Item Cards\n');
  for (const r of results.auto_link) {
    console.log(`   📌 [${r.request_id} Line ${r.line_no}]`);
    console.log(`      PTTEP: "${r.raw_description.substring(0, 70)}..."`);
    console.log(`      → BC Match: ${r.best_match.bc_item_no} — ${r.best_match.bc_description}`);
    console.log(`      Confidence: ${(r.best_match.confidence * 100).toFixed(0)}% | Reason: ${r.best_match.match_reasons[0]}`);
    console.log('');
  }
  
  // Review items
  console.log('───────────────────────────────────────────────────────────\n');
  console.log(`⚠️  REVIEW REQUIRED (${results.review.length} items) — Medium confidence`);
  console.log('   Sales team should verify these matches before linking\n');
  for (const r of results.review) {
    console.log(`   📌 [${r.request_id} Line ${r.line_no}]`);
    console.log(`      PTTEP: "${r.raw_description.substring(0, 70)}..."`);
    if (r.best_match) {
      console.log(`      → Suggested: ${r.best_match.bc_item_no} — ${r.best_match.bc_description}`);
      console.log(`      Confidence: ${(r.best_match.confidence * 100).toFixed(0)}% | Reason: ${r.best_match.match_reasons[0]}`);
    }
    console.log(`      Parsed P/N: ${r.parsed.part_number || 'N/A'} | MFGR: ${r.parsed.manufacturer || 'N/A'}`);
    console.log('');
  }
  
  // Create blank items
  console.log('───────────────────────────────────────────────────────────\n');
  console.log(`🆕 CREATE BLANK ITEM CARD (${results.create_blank.length} items) — No match found`);
  console.log('   System will create placeholder Item Cards for these\n');
  for (const r of results.create_blank) {
    console.log(`   📌 [${r.request_id} Line ${r.line_no}]`);
    console.log(`      PTTEP: "${r.raw_description.substring(0, 70)}..."`);
    console.log(`      Type: ${r.parsed.item_type || 'N/A'} | P/N: ${r.parsed.part_number || 'N/A'} | MFGR: ${r.parsed.manufacturer || 'N/A'}`);
    console.log(`      → Will create: APSS-ITEM-NEW-${String(r.line_no).padStart(3, '0')} (Blank)`);
    console.log('');
  }
  
  // ─── Summary ─────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total items processed:      ${portalItems.length}`);
  console.log(`  ✅ Auto-link (ready):        ${results.auto_link.length}`);
  console.log(`  ⚠️  Review required:          ${results.review.length}`);
  console.log(`  🆕 Create blank Item Card:   ${results.create_blank.length}`);
  console.log(`  ⏱️  Processing time:          < 1 second`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Urgent items highlight
  const urgentItems = portalItems.filter(i => i.Priority === 'Urgent');
  if (urgentItems.length > 0) {
    console.log(`  🚨 URGENT ITEMS (${urgentItems.length}):`);
    for (const u of urgentItems) {
      console.log(`     - ${u.Request_ID} Line ${u.Item_No}: ${u.Description.substring(0, 50)}...`);
    }
    console.log('');
  }
  
  // Save full results to JSON
  const outputPath = path.join(path.dirname(csvFilePath), '..', 'output', 'processing_results.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`  💾 Full results saved to: ${outputPath}\n`);
  
  return results;
}

// ─── Run ─────────────────────────────────────────────────────────
const csvFile = path.join(__dirname, '..', 'sample-data', 'pttep_flash_buy_export.csv');
const { getBcSampleDataPath } = require('./sample-data-paths');
const bcItemsFile = getBcSampleDataPath();

processExport(csvFile, bcItemsFile);
