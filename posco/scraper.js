/**
 * APSS Integration Hub — POSCO Portal Scraper
 * 
 * Automates POSCO International (Myanmar E&P) e-Pro portal RFQ extraction.
 * Uses Playwright with a persisted local session file
 * to maintain cookies/sessions and bypass daily OTP login friction.
 * 
 * Usage:
 *   node src/posco-scraper.js
 *   node src/posco-scraper.js --login     ← Trigger headed manual login to save session
 */

const { chromium } = require('playwright');
const { parsePdfTableRegex, parseItemDescription } = require('../shared/parser');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, 'session.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const POSCO_URL = 'https://gw.poscointl-enp.com/'; // POSCO International (Myanmar E&P) e-Pro

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Helper function to perform OCR on a physical image file using tesseract.js
async function performOcr(filePath) {
  let worker = null;
  try {
    const { createWorker } = require('tesseract.js');
    console.log(`      [OCR] Initializing Tesseract for: ${path.basename(filePath)}...`);
    worker = await createWorker('eng');
    const ret = await worker.recognize(filePath);
    const text = ret.data.text || '';
    console.log(`      [OCR] Successfully extracted ${text.length} characters from: ${path.basename(filePath)}`);
    return text;
  } catch (err) {
    console.error(`      ⚠️ OCR failed for ${path.basename(filePath)}:`, err.message);
    return '';
  } finally {
    if (worker) {
      await worker.terminate();
    }
  }
}

// Helper function to unzip an .xlsx file, extract any embedded screenshots from xl/media, and run OCR on them
async function extractAndOcrExcelImages(excelFilePath, rfqDocsDir) {
  let combinedText = '';
  try {
    const AdmZip = require('adm-zip');
    console.log(`      [Excel Image Extractor] Checking for embedded images in: ${path.basename(excelFilePath)}...`);
    const zip = new AdmZip(excelFilePath);
    const zipEntries = zip.getEntries();
    
    // Embedded images in Excel are stored inside the 'xl/media/' directory
    const mediaEntries = zipEntries.filter(entry => entry.entryName.startsWith('xl/media/'));
    
    if (mediaEntries.length === 0) {
      console.log('      [Excel Image Extractor] No embedded images found.');
      return '';
    }
    
    console.log(`      [Excel Image Extractor] Found ${mediaEntries.length} embedded image(s) inside Excel. Extracting...`);
    
    const excelImagesDir = path.join(rfqDocsDir, 'excel_media');
    if (!fs.existsSync(excelImagesDir)) {
      fs.mkdirSync(excelImagesDir, { recursive: true });
    }
    
    for (let i = 0; i < mediaEntries.length; i++) {
      const entry = mediaEntries[i];
      const imgFileName = path.basename(entry.entryName);
      const imgFilePath = path.join(excelImagesDir, imgFileName);
      
      // Extract the image file to the local directory
      fs.writeFileSync(imgFilePath, entry.getData());
      
      // Run OCR on the extracted image
      const ocrText = await performOcr(imgFilePath);
      if (ocrText && ocrText.trim().length > 0) {
        combinedText += `\n--- Excel Embedded Image: ${imgFileName} ---\n${ocrText}\n`;
      }
    }
  } catch (err) {
    console.error(`      ⚠️ Excel image extraction/OCR failed:`, err.message);
  }
  return combinedText;
}


// Native Excel parser for POSCO MTO tables to bypass AI for large tabular data
function parsePoscoExcel(filePath) {
  let items = [];
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    let itemNoCounter = 1;

    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      if (!rows || rows.length === 0) return;

      // Find header row
      let headerRowIdx = -1;
      let headerMapping = {}; 
      
      for (let i = 0; i < Math.min(30, rows.length); i++) {
        const row = rows[i];
        if (!row || !Array.isArray(row)) continue;
        
        const rowStr = [];
        for (let k=0; k<row.length; k++) {
          rowStr.push(String(row[k] || '').toLowerCase().trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '));
        }
        
        let descIdx = rowStr.indexOf('pr description');
        if (descIdx === -1) descIdx = rowStr.indexOf('mto description');
        if (descIdx === -1) descIdx = rowStr.indexOf('description');
        if (descIdx === -1) descIdx = rowStr.indexOf('material description');
        if (descIdx === -1) {
          descIdx = rowStr.findIndex(v => v && (v.includes('desc') || (v.includes('material') && !v.includes('code'))) && !v.includes('item'));
        }
        
        let qtyIdx = rowStr.indexOf('total qty');
        if (qtyIdx === -1) qtyIdx = rowStr.indexOf('req qty');
        if (qtyIdx === -1) qtyIdx = rowStr.indexOf('quantity');
        if (qtyIdx === -1) qtyIdx = rowStr.indexOf('actual qty');
        if (qtyIdx === -1) {
          qtyIdx = rowStr.findIndex(v => v && (v.includes('qty') || v.includes('quantity') || v.includes('amount')));
        }
        
        let uomIdx = rowStr.indexOf('unit');
        if (uomIdx === -1) uomIdx = rowStr.indexOf('uom');
        if (uomIdx === -1) {
          uomIdx = rowStr.findIndex(v => v && (v.includes('unit') || v.includes('uom')));
        }
        
        if (descIdx !== -1 && qtyIdx !== -1) {
          headerRowIdx = i;
          headerMapping = { desc: descIdx, qty: qtyIdx, uom: uomIdx !== -1 ? uomIdx : -1 };
          break;
        }
      }

      if (headerRowIdx !== -1) {
        for (let i = headerRowIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || !Array.isArray(row) || row.length === 0) continue;

          let qtyRaw = String(row[headerMapping.qty] || '').trim();
          if (!qtyRaw || !/^\d/.test(qtyRaw)) continue;

          let qty = parseFloat(qtyRaw.replace(/,/g, ''));
          if (isNaN(qty) || qty <= 0) continue; 

          let uom = headerMapping.uom !== -1 ? String(row[headerMapping.uom] || '').trim() : 'EA';
          if (!uom) uom = 'EA';

          let descParts = [];
          let mainDesc = String(row[headerMapping.desc] || '').trim();
          if (mainDesc) descParts.push(mainDesc);
          
          for (let j = 0; j < row.length; j++) {
            if (j !== headerMapping.desc && j !== headerMapping.qty && j !== headerMapping.uom) {
               let val = String(row[j] || '').trim().replace(/[\r\n]+/g, ' ');
               let headerName = String(rows[headerRowIdx][j] || '').trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
               
               if (!val || !headerName) continue;
               
               let hLower = headerName.toLowerCase();
               if (hLower.includes('no') || hLower.includes('remark') || hLower.includes('spare') || hLower.includes('qty')) continue;
               
               if (hLower.includes('desc') || hLower.includes('spec') || hLower.includes('material')) {
                 if (val && !descParts.includes(val)) descParts.push(val);
               } else {
                 if (headerName.length <= 25) {
                   descParts.push(`${headerName}: ${val}`);
                 }
               }
            }
          }
          
          let desc = descParts.join(' - ');
          if (!desc) continue;

          items.push({
            item_no: String(itemNoCounter++),
            description: desc,
            uom: uom,
            qty: String(qty),
            part_number: '',
            manufacturer: ''
          });
        }
      }
    });
  } catch (e) {
    console.error(`      ⚠️ Native Excel parsing failed for ${filePath}: ${e.message}`);
  }
  return items;
}


// Fallback text parser for POSCO text tables that don't use standard HTML <table> tags
function parsePoscoTextTable(rawText) {
  const items = [];
  try {
    const lines = rawText.replace(/\t/g, '  ').split('\n').map(l => l.trim()).filter(l => l);
    
    // Find header
    let headerIdx = -1;
    for (let i = 0; i < Math.min(20, lines.length - 3); i++) {
      const block = lines.slice(i, i + 4).join(' ').toLowerCase();
      if ((block.includes('no.') || block.includes('no ')) && 
          (block.includes('desc') || block.includes('material')) && 
          (block.includes('qty') || block.includes('quantity'))) {
        headerIdx = i + 3; // Start after block
        break;
      }
    }

    const uomRegex = /\b(EA|PAI|ROL|SET|LOT|PC|PCS|BTL|BOX|CAN|MTR)\b/i;
    let currentDesc = [];
    let currentItemNo = '1';

    for (let i = headerIdx !== -1 ? headerIdx + 1 : 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toLowerCase().startsWith('please be requested') || line.toLowerCase().startsWith('note') || line.toLowerCase().startsWith('delivery')) {
        break;
      }

      // Check if line contains UOM
      const uomMatch = line.match(uomRegex);
      if (uomMatch) {
         // Is Qty on same line?
         const parts = line.split(/\s+/);
         const uomIndex = parts.findIndex(p => p.toLowerCase() === uomMatch[0].toLowerCase());
         let qty = '';
         if (uomIndex > 0 && /^\d+(\.\d+)?$/.test(parts[uomIndex - 1])) {
            qty = parts[uomIndex - 1]; // e.g. "24 EA"
         } else if (uomIndex < parts.length - 1 && /^\d+(\.\d+)?$/.test(parts[uomIndex + 1])) {
            qty = parts[uomIndex + 1]; // e.g. "EA 24"
         }
         
         if (qty) {
            let descLine = line.replace(uomMatch[0], '').replace(qty, '').trim();
            if (descLine) currentDesc.push(descLine);
            
            if (currentDesc.length > 0) {
              items.push({
                item_no: currentItemNo,
                description: currentDesc.join('\n').replace(/^\d+\s+/, ''),
                uom: uomMatch[0].toUpperCase(),
                qty: qty,
                part_number: '',
                manufacturer: ''
              });
              currentItemNo = String(items.length + 1);
              currentDesc = [];
            }
            continue;
         }
      }
      
      // Is Qty on the next line?
      if (line.match(/^[a-zA-Z]{2,3}$/) && i + 1 < lines.length && /^\d+(\.\d+)?$/.test(lines[i+1])) {
         items.push({
            item_no: currentItemNo,
            description: currentDesc.join('\n').replace(/^\d+\s+/, ''),
            uom: line.toUpperCase(),
            qty: lines[i+1],
            part_number: '',
            manufacturer: ''
         });
         currentItemNo = String(items.length + 1);
         currentDesc = [];
         i++; // Skip the qty line
         continue;
      }
      
      // Check if it's an item number starting a new block
      if (/^\d+$/.test(line) && currentDesc.length === 0) {
        currentItemNo = line;
        continue;
      }

      currentDesc.push(line);
    }
  } catch (e) {
    console.log(`      ⚠️ Text parser failed: ${e.message}`);
  }
  return items;
}

// AI Helper to parse raw PDF text to structured JSON array using local Ollama (Llama)
async function parsePdfWithOllama(rawText) {
  let jsonText = '';
  try {
    const { ollamaGenerate, DEFAULT_MODEL } = require('../shared/ollama-client');
    const prompt = `You are an expert procurement assistant. Extract the list of RFQ items from the raw text below.
Return ONLY a valid JSON object containing an "items" key which is an array of objects, with no markdown formatting, no code blocks, and no extra explanations.

CRITICAL INSTRUCTIONS FOR ACCURATE EXTRACTION:
1. SOURCE OF TRUTH HIERARCHY:
   - CASE A (Notice has items): If the "Board Notice Description/Body" contains a list or table of items with quantities and UOMs (e.g. "BOOTS size 9... Qty 13..."), the "Board Notice Description/Body" is the PRIMARY source of truth for the items, quantities, and UOMs. In this case, the "Document" sections are just technical datasheets/specifications—do NOT use the quantities or pack sizes (like "1" or "1 pair per box") mentioned in the datasheets.
   - CASE B (Notice has no items): If the "Board Notice Description/Body" does NOT list any items or quantities (e.g., it is just a cover letter or greeting like "please see attached"), then the "Document" sections are the PRIMARY source of truth. You MUST extract the list of items, their quantities, and UOMs directly from the documents.
2. DO NOT MERGE UOM AND QTY INTO PART NUMBERS: Keep the Unit of Measure (UoM/uom, e.g. "PAA", "PAIR", "EA", "ROL") and Quantity (Qty/qty, e.g. "13", "7", "6", "110") strictly in their respective fields. Do NOT concatenate them (like "PAA110") or put them into the part_number field.
3. PART NUMBERS & MANUFACTURERS: Extract the actual model numbers, part numbers (e.g., "J0266 JALASKA"), and manufacturer/brand names (e.g. "JALLATTE", "SAFETY JOGGER") from both the Board Notice and the technical documents. Always preserve these specifications!

CRITICAL RULE FOR TECHNICAL DRAWINGS / BOM TABLES:
If the text appears to be a Bill of Materials (BOM) or component list of a single equipment assembly from a technical drawing or design schematic, do NOT extract these components as separate RFQ items. 
In such cases, return an empty "items" array: { "items": [] }.

CRITICAL EXTRACTION RULES:
- NEVER drop the technical specifications (e.g. material, dimensions, color, fluid ounces). ALWAYS include them in the "description" field.
- NEVER append the manufacturer/brand or part number to the "description" if you have already extracted them into their own fields.
- If a column says "Brand / Model", carefully split the Brand into "manufacturer" and the Model into "part_number".
- If a column says "Specs & Part Numbers", carefully split the Specs into "description" and the Part Number into "part_number".

The JSON object must have this exact structure:
{
  "items": [
    {
      "item_no": "1",
      "description": "The product name COMBINED WITH all technical specifications, dimensions, and materials. DO NOT include the Brand/Manufacturer or Part Number here if they can be separated. NEVER drop the technical specs!",
      "uom": "unit of measure (e.g. EA, SET, BOX)",
      "qty": "quantity (number only)",
      "part_number": "The specific part number, model code, or series (e.g. 'V75-486-04YL', '14250', '0106 Series'). If none, use empty string.",
      "manufacturer": "The Brand or Manufacturer name (e.g. 'TEC Products', 'XXXFLOWER', 'DEVCON', 'PERMATEX'). If none, use empty string."
    }
  ]
}

Raw RFQ text:
${rawText}`;

    // Call AI Abstraction Interface
    const aiClient = require('../shared/ai-client.js');
    const aiResponse = await aiClient.aiGenerateText(prompt, "You are a strict data extraction AI. Only output valid JSON.", 0.1);
    jsonText = aiResponse.text.trim();
    
    console.log(`\n      [REAL AI LOG - PDF] Prompt Tokens (Input): ${aiResponse.prompt_tokens}`);
    console.log(`      [REAL AI LOG - PDF] Completion Tokens (Output): ${aiResponse.completion_tokens}\n`);
    
    // Extract JSON object from response
    let parsedObj;
    try {
      parsedObj = JSON.parse(jsonText);
    } catch (e) {
      const startIdx = jsonText.indexOf('{');
      const endIdx = jsonText.lastIndexOf('}');
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        parsedObj = JSON.parse(jsonText.substring(startIdx, endIdx + 1));
      } else {
        const arrayStart = jsonText.indexOf('[');
        const arrayEnd = jsonText.lastIndexOf(']');
        if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
          return JSON.parse(jsonText.substring(arrayStart, arrayEnd + 1));
        }
        throw e;
      }
    }
    
    if (parsedObj && Array.isArray(parsedObj.items)) {
      return parsedObj.items;
    }
    if (Array.isArray(parsedObj)) {
      return parsedObj;
    }
    return null;
  } catch (err) {
    console.error(`      ⚠️ AI PDF parsing failed: ${err.message}.`);
    if (jsonText) {
      console.log(`      [Debug] Raw Ollama response was:\n${jsonText}\n`);
    }
    return null;
  }
}

// AI Helper to clean descriptions and extract manufacturer and part number from HTML scraped items using local Ollama
async function cleanItemsWithOllama(items) {
  let allCleaned = [];
  const chunkSize = 15;
  
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    let jsonText = '';
    try {
      const prompt = `You are an expert procurement assistant. We have a list of raw RFQ items scraped from an HTML table.
For each item, extract the structured "manufacturer" and "part_number" fields from the description.
DO NOT delete or modify the original description. Leave the description EXACTLY as it was provided.
Return ONLY a valid JSON object containing an "items" key which is an array of objects, with no markdown formatting, no code blocks, and no extra explanations.

The JSON object must have this exact structure:
{
  "items": [
    {
      "item_no": "item_no",
      "description": "the EXACT SAME description as provided, do NOT remove anything",
      "uom": "uom",
      "qty": "qty",
      "part_number": "part_number",
      "manufacturer": "manufacturer"
    }
  ]
}

EXAMPLE INPUT:
[
  {
    "item_no": "1",
    "description": "MANUAL CHAIN HOIST\\nMFR#SHELL GADUS S2 V100 2\\nMFR: GS CALTEX\\nDRG#: SHK-ME-EL-M01-0098",
    "uom": "EA",
    "qty": "24",
    "part_number": "",
    "manufacturer": ""
  }
]

EXAMPLE OUTPUT:
{
  "items": [
    {
      "item_no": "1",
      "description": "MANUAL CHAIN HOIST\\nMFR#SHELL GADUS S2 V100 2\\nMFR: GS CALTEX\\nDRG#: SHK-ME-EL-M01-0098",
      "uom": "EA",
      "qty": "24",
      "part_number": "SHK-ME-EL-M01-0098",
      "manufacturer": "GS CALTEX / SHELL"
    }
  ]
}

Raw items:
${JSON.stringify(chunk, null, 2)}`;

      const aiClient = require('../shared/ai-client.js');
      const aiResponse = await aiClient.aiGenerateText(prompt, "You are a data cleaner. Only output valid JSON.", 0.1);
      jsonText = aiResponse.text.trim();

      console.log(`\n      [REAL AI LOG - HTML] Prompt Tokens (Input): ${aiResponse.prompt_tokens}`);
      console.log(`      [REAL AI LOG - HTML] Completion Tokens (Output): ${aiResponse.completion_tokens}\n`);
      
      let parsedObj;
      try {
        parsedObj = JSON.parse(jsonText);
      } catch (e) {
        const startIdx = jsonText.indexOf('{');
        const endIdx = jsonText.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          parsedObj = JSON.parse(jsonText.substring(startIdx, endIdx + 1));
        } else {
          const arrayStart = jsonText.indexOf('[');
          const arrayEnd = jsonText.lastIndexOf(']');
          if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
            parsedObj = { items: JSON.parse(jsonText.substring(arrayStart, arrayEnd + 1)) };
          } else {
            throw e;
          }
        }
      }
      
      let extractedItems = [];
      if (parsedObj && Array.isArray(parsedObj.items)) {
        extractedItems = parsedObj.items;
      } else if (Array.isArray(parsedObj)) {
        extractedItems = parsedObj;
      }
      
      // Strict guard: if AI dropped items, keep the original chunk instead of losing data
      if (extractedItems.length === chunk.length) {
        allCleaned.push(...extractedItems);
      } else {
        console.warn(`      ⚠️ AI truncated chunk! Expected ${chunk.length} items, got ${extractedItems.length}. Keeping original chunk.`);
        allCleaned.push(...chunk);
      }
    } catch (err) {
      console.error(`      ⚠️ AI HTML item cleaning failed: ${err.message}. Keeping original chunk.`);
      allCleaned.push(...chunk);
    }
  }
  return allCleaned;
}

async function runScraper(forceLogin = false, forceMock = false, onProgress = null, targetRfqNo = null) {
  const reportProgress = (percent, message) => {
    console.log(`[POSCO Scraper Progress ${percent}%] ${message}`);
    if (onProgress) {
      onProgress({ percent, message });
    }
  };

  reportProgress(5, 'Initializing POSCO portal scraper...');

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  APSS Integration Hub — POSCO Portal Scraper            ║');
  console.log('║  🔒 Automated Browser via Playwright                     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  if (forceMock) {
    console.log('ℹ️ Running in DEMO/MOCK mode — bypassing actual portal authentication and network calls.');
    const activeBids = [
      { 
        no: "9163", 
        rfq_no: "5000042638", 
        subject: "RFQ 5000042638_TAPE, DENSO, 3 INCH", 
        drafter: "Moe Sandar Soe", 
        regi_date: "11-06-2026", 
        close_date: "17-06-2026",
        items: [
          { item_no: "1", description: "TAPE, DENSO, 3 INCH x 10M ROLL", uom: "ROL", qty: "24" },
          { item_no: "2", description: "DENSO PASTE PRIMER, 2.5KG CAN", uom: "CAN", qty: "6" },
          { item_no: "3", description: "DENSO MASTIC, 3KG BAR", uom: "PCS", qty: "12" }
        ]
      },
      { 
        no: "9162", 
        rfq_no: "5000042281", 
        subject: "RFQ 5000042281_GASKET, FLAT RING, CNAF, 150, 3 INCH", 
        drafter: "Moe Sandar Soe", 
        regi_date: "11-06-2026", 
        close_date: "17-06-2026",
        items: [
          { item_no: "1", description: "GASKET, FLAT RING, CNAF, 150LB, 3 INCH", uom: "PCS", qty: "100" },
          { item_no: "2", description: "GASKET, FLAT RING, CNAF, 150LB, 2 INCH", uom: "PCS", qty: "50" }
        ]
      },
      { 
        no: "9161", 
        rfq_no: "5000042272", 
        subject: "RFQ 5000042272_HVAC CORE DRYER FILTER, DANFOSS 023U1391", 
        drafter: "Moe Sandar Soe", 
        regi_date: "11-06-2026", 
        close_date: "17-06-2026",
        items: [
          { item_no: "1", description: "HVAC CORE DRYER FILTER, DANFOSS 023U1391", uom: "PCS", qty: "4" }
        ]
      }
    ];
    console.log(`\n📥 Successfully crawled ${activeBids.length} item(s) (MOCK):`);
    console.table(activeBids);
    // Clean up all old reports and POSCO files in output directory to keep the feed fresh
    if (fs.existsSync(OUTPUT_DIR)) {
      const files = fs.readdirSync(OUTPUT_DIR);
      files.forEach(file => {
        if (file.startsWith('posco_rfqs_') && file.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(OUTPUT_DIR, file));
          } catch (e) {
            console.error(`Failed to delete old file ${file}: ${e.message}`);
          }
        }
      });
    }

    const outputFilename = `posco_rfqs_${Date.now()}.json`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, JSON.stringify(activeBids, null, 2));
    console.log(`\n💾 POSCO crawled catalog saved: ${outputPath}`);
    console.log('👋 Done.');
    return activeBids;
  }

  let contextOptions = {
    viewport: { width: 1280, height: 800 },
  };

  // Always force fresh login
  const hasSession = false;
  console.log('🌐 Always performing fresh login for POSCO scraper...');

  // ALWAYS run headless since we now have Remote OTP
  const isHeaded = false;
  console.log(`🌐 Launching Chromium (HEADLESS - Full background auto-pilot)...`);
  
  const browser = await chromium.launch({ 
    headless: true,
    slowMo: 0
  });
  global.activeBrowser = browser;

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    console.log(`🔗 Navigating to POSCO B2B Portal: ${POSCO_URL}...`);
    await page.goto(POSCO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Check if we are already logged in
    let isLoggedIn = forceMock;
    
    if (forceMock) {
      console.log('ℹ️ Running in DEMO/MOCK mode — bypassing actual portal authentication.');
    }
    
    if (hasSession && !forceLogin && !forceMock) {
      try {
        // Look for common logged-in elements or text: e-Pro, RFQ List, Logout, etc.
        await page.waitForSelector('text=RFQ List', { timeout: 12000 });
        isLoggedIn = true;
        console.log('✅ Session authenticated successfully via cookie storage.');
      } catch (err) {
        console.log('⚠️ Saved session expired or invalid. Redirecting to login page.');
        isLoggedIn = false;
      }
    }

    if (!isLoggedIn) {
      if (fs.existsSync(SESSION_PATH)) {
        try {
          fs.unlinkSync(SESSION_PATH);
          console.log('🗑️ Expired POSCO session cleared.');
        } catch (e) {
          console.error('⚠️ Failed to clear session file:', e.message);
        }
      }

      console.log('\n📣 Remote login initiated...');
      reportProgress(10, 'Logging into POSCO portal...');

      try {
        // Read config for username/password
        const configPath = path.join(__dirname, '..', 'config.json');
        const configStr = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configStr);
        const username = config.posco?.username;
        const password = config.posco?.password;

        if (!username || !password || username === 'your_posco_username_here') {
          throw new Error('POSCO credentials not configured in config.json');
        }

        // Fill User and Pass using correct POSCO selectors
        await page.fill('#txtPC_LoginID', username, { timeout: 10000 }).catch(()=>null);
        
        // POSCO has a dummy password input. Click it to reveal and focus the real password input.
        await page.click('#txtPC_LoginPWTemp').catch(()=>null);
        // Now the real password box is focused, type the password normally!
        await page.keyboard.type(password);
        
        let loginAlert = null;
        const dialogHandler = async dialog => {
          loginAlert = dialog.message();
          console.log(`⚠️ POSCO Alert Popup: ${loginAlert}`);
          await dialog.dismiss().catch(()=>null);
        };
        page.on('dialog', dialogHandler);

        // Press Enter to submit the form (most reliable)
        await page.keyboard.press('Enter');
        // Also force click the Login button just in case
        await page.click('#btnPC_Login', { force: true }).catch(()=>null);
        
        // Wait a bit to see if OTP screen appears or if it succeeds
        await page.waitForTimeout(3000);
        page.off('dialog', dialogHandler);

        if (loginAlert) {
          throw new Error(`Website Alert: ${loginAlert}`);
        }

        // UNCONDITIONAL DEBUG CAMERA: Take a screenshot of whatever the page looks like now!
        const debugImgPath = path.join(OUTPUT_DIR, 'posco_login_debug.png');
        await page.screenshot({ path: debugImgPath, fullPage: true }).catch(()=>null);
        console.log(`📸 DEBUG CAMERA: Saved screenshot of POSCO screen to ${debugImgPath}`);

        // Check if OTP input exists AND is visible
        const needsOtp = await page.evaluate(() => {
           const otpInput = document.querySelector('#txtPC_LoginOTP') || document.querySelector('#txtPC_LoginMFA');
           return otpInput && otpInput.offsetParent !== null;
        });

        if (needsOtp) {
          console.log('⏳ POSCO is requesting OTP. Waiting for remote input from Web UI...');

          // Request OTP from global state
          reportProgress(15, 'WAITING_FOR_OTP');
          
          const otpCode = await new Promise((resolve, reject) => {
            // Give user 3 minutes to enter OTP
            const timeout = setTimeout(() => {
              global.poscoOtpCallback = null;
              reject(new Error('OTP input timed out after 3 minutes.'));
            }, 180000);

            global.poscoOtpCallback = (code) => {
              clearTimeout(timeout);
              resolve(code);
            };
          });

          console.log(`🤖 Received remote OTP: ${otpCode}. Injecting...`);
          reportProgress(20, 'Verifying OTP...');

          // Inject OTP
          await page.evaluate((code) => {
             const otpInput = document.querySelector('#txtPC_LoginOTP') || document.querySelector('#txtPC_LoginMFA');
             if (otpInput) {
               otpInput.value = code;
               otpInput.dispatchEvent(new Event('input', { bubbles: true }));
             }
             
             // Click submit button for OTP/MFA
             const submitBtn = document.querySelector('#btnPC_OTP_Login') || document.querySelector('#btnPC_MFA_Login');
             if (submitBtn) submitBtn.click();
          }, otpCode);

          await page.waitForTimeout(3000);
        }

        // Wait until the dashboard/RFQ page loads
        await page.waitForSelector('text=RFQ List', { timeout: 30000 });
        
        console.log('🎉 Login detected! Saving new POSCO session state...');
        await context.storageState({ path: SESSION_PATH });
        console.log('💾 Session saved. Future crawls will run seamlessly.');

      } catch (err) {
        throw new Error(`POSCO login failed: ${err.message}`);
      }
    }

    // ─── Crawl POSCO Data ─────────────────────────────────────
    console.log('\n📂 Accessing RFQ list page...');
    
    // In case the login drops us to home, navigate directly to BoardList
    if (!page.url().includes('BoardList.aspx')) {
      await page.goto('https://gw.poscointl-enp.com/WebSite/Basic/Board/BoardList.aspx?system=Board.PROCUREMENT&fdid=1277&fdalias=epro_Notice', { waitUntil: 'domcontentloaded' });
    }
    
    console.log('🔎 Scanning RFQ tables for active entries...');

    if (targetRfqNo) {
      console.log(`\n🔎 [TARGET MODE] Automatically searching POSCO portal for "${targetRfqNo}"...`);
      const searchSuccess = await page.evaluate((target) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
        const searchInput = inputs.find(i => i.offsetWidth > 60 && !i.readOnly);
        if (searchInput) {
          searchInput.value = target;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));
          
          const btns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
          const searchBtn = btns.find(b => b.textContent.toLowerCase().includes('search') || (b.value && b.value.toLowerCase().includes('search')));
          
          if (searchBtn) {
            searchBtn.click();
            return true;
          }
        }
        return false;
      }, targetRfqNo);
      
      if (searchSuccess) {
         console.log('  -> Search triggered! Waiting for table to reload...');
         await page.waitForTimeout(4000); // Wait for AJAX refresh
      } else {
         console.log('  -> Warning: Could not find the native search bar. Falling back to normal pagination crawl...');
      }
    }
    
    const allActiveBids = [];
    let currentPage = 1;
    let keepCrawling = true;
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Clear time for precise date comparison
    
    // Helper to parse dates in format "DD-MM-YYYY"
    function parseCloseDate(dateStr) {
      if (!dateStr) return null;
      const cleanStr = dateStr.trim().split(/\s+/)[0];
      const parts = cleanStr.split('-');
      if (parts.length !== 3) return null;
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      return new Date(year, month, day);
    }

    // Load RFQ Cache to prevent redundant downloads and AI generation
    const CACHE_PATH = path.join(OUTPUT_DIR, 'posco_rfqs_cache.json');
    let rfqCache = {};
    if (fs.existsSync(CACHE_PATH) && !forceLogin) {
      try {
        rfqCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        console.log(`💾 Loaded ${Object.keys(rfqCache).length} cached RFQ(s) from: ${path.basename(CACHE_PATH)}`);
      } catch (e) {
        console.warn('⚠️ Failed to parse RFQ Cache file. Starting with empty cache.');
      }
    } else if (forceLogin) {
      console.log('🔄 Session renewal requested — bypassing and clearing RFQ cache to run a completely fresh crawl.');
      if (fs.existsSync(CACHE_PATH)) {
        try {
          fs.unlinkSync(CACHE_PATH);
        } catch (e) {
          console.error('⚠️ Failed to delete cache file:', e.message);
        }
      }
    }

    while (keepCrawling && !forceMock) {
      console.log(`\n📄 Scraped Page ${currentPage}...`);
      await page.waitForSelector('table', { timeout: 15000 });

      // Extract table rows dynamically for the current page
      const pageBids = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('table'));
        const rfqTable = tables.find(t => t.textContent.includes('RFQ No.') && t.textContent.includes('Subject'));
        if (!rfqTable) return { bids: [], totalPages: 1 };

        const rows = Array.from(rfqTable.querySelectorAll('tr'));
        const headerRow = rows.find(r => r.textContent.includes('RFQ No.') && r.textContent.includes('Subject'));
        let indexMap = { no: -1, rfq_no: -1, subject: -1, drafter: -1, regi_date: -1, close_date: -1 };
        
        if (headerRow) {
          const headerCells = Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim().toLowerCase());
          indexMap = {
            no: headerCells.findIndex(h => h.includes('no.') && !h.includes('rfq')),
            rfq_no: headerCells.findIndex(h => h.includes('rfq no.') || h.includes('rfq number')),
            subject: headerCells.findIndex(h => h.includes('subject')),
            drafter: headerCells.findIndex(h => h.includes('drafter') || h.includes('writer') || h.includes('drafter/')),
            regi_date: headerCells.findIndex(h => h.includes('regi. date') || h.includes('regi.date') || h.includes('registration date') || h.includes('regi_date') || h.includes('reg. date')),
            close_date: headerCells.findIndex(h => h.includes('close date') || h.includes('closing date') || h.includes('close_date'))
          };
        }

        const dataRows = rows.filter(row => {
          if (row === headerRow) return false;
          if (row.textContent.includes('RFQ No.')) return false;
          return row.querySelectorAll('td').length > 5;
        });

        // Get pagination info
        let totalPages = 1;
        const bodyText = document.body.textContent;
        const totalPageMatch = bodyText.match(/Total\s+(\d+)Page/i);
        if (totalPageMatch) {
          totalPages = parseInt(totalPageMatch[1], 10);
        }

        const bids = dataRows.map(row => {
          const cols = row.querySelectorAll('td');
          const getValue = (key) => {
            const idx = indexMap[key];
            if (idx !== undefined && idx !== -1 && cols[idx]) {
              return cols[idx].textContent.trim();
            }
            return '';
          };

          let detail_url = '';
          const subjectIdx = indexMap['subject'] !== -1 ? indexMap['subject'] : 6;
          if (cols[subjectIdx]) {
            const anchor = cols[subjectIdx].querySelector('a');
            if (anchor) {
              const href = anchor.getAttribute('href') || '';
              const match = href.match(/BoardViewPop\((\d+),\s*(\d+)\)/);
              if (match) {
                detail_url = `https://gw.poscointl-enp.com/WebSite/Basic/Board/BoardView_Pop.aspx?system=Board.PROCUREMENT&BoardType=Normal&FromOuterYN=N&FromAdminPageYN=N&fdid=${match[1]}&MsgId=${match[2]}&DateBarYN=`;
              } else {
                detail_url = href;
              }
            }
          }

          return {
            no: getValue('no'),
            rfq_no: getValue('rfq_no'),
            subject: getValue('subject'),
            drafter: getValue('drafter'),
            regi_date: getValue('regi_date'),
            close_date: getValue('close_date'),
            detail_url: detail_url
          };
        });

        return { bids, totalPages };
      });

      if (!pageBids || !pageBids.bids || pageBids.bids.length === 0) {
        console.log('⚠️ No RFQs found on this page.');
        break;
      }

      console.log(`📊 Found ${pageBids.bids.length} RFQ(s) on Page ${currentPage}. Checking activity status...`);
      
      let pageActiveCount = 0;
      let pageExpiredCount = 0;
      const activeBidsThisPage = [];

      for (const bid of pageBids.bids) {
        // Evaluate close date
        const [day, month, year] = bid.close_date.split('-');
        const closeDate = new Date(`${year}-${month}-${day}T23:59:59Z`);
        
        let shouldProcess = false;
        
        if (targetRfqNo) {
          // In target mode, we already searched the portal. We process ALL returned rows, ignoring expiry!
          shouldProcess = true;
          console.log(`🎯 TARGET SEARCH MODE: Processing found RFQ ${bid.rfq_no}`);
        } else {
          // Normal mode: check if active
          if (closeDate >= new Date()) {
            shouldProcess = true;
          }
        }

        if (shouldProcess) {
          pageActiveCount++;
          activeBidsThisPage.push(bid);
        } else {
          pageExpiredCount++;
        }
      }

      console.log(`   ✅ Active: ${pageActiveCount} | ❌ Expired: ${pageExpiredCount}`);

      // Process details for active RFQs on this page
      const totalOnPage = activeBidsThisPage.length;
      for (let i = 0; i < totalOnPage; i++) {
        const bid = activeBidsThisPage[i];
        const rfqIndexOnPage = i + 1;
        const percent = Math.min(95, Math.round(25 + (currentPage - 1) * 20 + (rfqIndexOnPage / totalOnPage) * 18));
        
        // ⚡ Cache Hit Check: Skip fully if RFQ already exists in cache and hasn't expired
        if (rfqCache[bid.rfq_no]) {
          reportProgress(percent, `[Page ${currentPage}] ⚡ Loaded RFQ ${bid.rfq_no} from Cache (Instant)`);
          console.log(`      🚀 Cache Hit! Restored ${rfqCache[bid.rfq_no].items?.length || 0} items for RFQ ${bid.rfq_no}`);
          allActiveBids.push(rfqCache[bid.rfq_no]);
          continue;
        }

        reportProgress(percent, `[Page ${currentPage}] Scraped RFQ ${bid.rfq_no} (${rfqIndexOnPage}/${totalOnPage}): "${bid.subject.replace(/RFQ\s+\d+_+/, '').replace(/_/g, ' ').substring(0, 40)}"`);

        console.log(`\n🔗 Navigating to details for RFQ ${bid.rfq_no} — "${bid.subject}"...`);
        
        // ⚡ Anti-detection: Introduce a randomized human-like delay (3 to 7 seconds) before opening details
        const randomDelay = Math.floor(Math.random() * (7000 - 3000 + 1)) + 3000;
        console.log(`      [Anti-Detection] Mimicking human delay: Sleeping for ${(randomDelay / 1000).toFixed(1)}s...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));
        
        try {
          // Navigate in the SAME tab to preserve sessionStorage/active session context
          await page.goto(bid.detail_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          let items = [];

          // Extract the Board Notice Body Text (e.g. the post description/content)
          const boardBodyText = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('td, div, span, p'));
            const contentElements = elements.filter(el => {
              const text = el.textContent || '';
              return text.includes('Dear Sir') || 
                     text.includes('Good Day') || 
                     text.includes('With reference to the subject') || 
                     text.includes('request the quotations') ||
                     text.includes('requested to provide quotation');
            });
            if (contentElements.length === 0) return '';
            contentElements.sort((a, b) => b.textContent.length - a.textContent.length);
            return contentElements[0].textContent.trim();
          });

          if (boardBodyText) {
            console.log(`      Extracted board notice body text (${boardBodyText.length} chars).`);
            bid.notice_text = boardBodyText;
          }

          // 1. Download and parse all attached files
          let attachLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            return links
              .map((l, index) => {
                const href = (l.getAttribute('href') || '').toLowerCase();
                const text = l.textContent.trim();
                const lowerText = text.toLowerCase();
                const isDoc = href.includes('download') || href.includes('file') || 
                              href.includes('.pdf') || href.includes('.xlsx') || href.includes('.xls') || 
                              href.includes('.docx') || href.includes('.doc') || href.includes('.png') || 
                              href.includes('.jpg') || href.includes('.jpeg') ||
                              lowerText.includes('.pdf') || lowerText.includes('.xlsx') || lowerText.includes('.xls') || 
                              lowerText.includes('.docx') || lowerText.includes('.doc') || lowerText.includes('.png') || 
                              lowerText.includes('.jpg') || lowerText.includes('.jpeg');
                return { href: l.getAttribute('href'), text, index, isDoc };
              })
              .filter(item => item.isDoc);
          });

          // Extract inline notice body images across ALL page frames and iframes (e.g. Nameplate photo under INLINEATTACH)
          const inlineImages = await page.evaluate(() => {
            const allImgs = [];
            const extractFromDoc = (doc) => {
              try {
                const imgs = Array.from(doc.querySelectorAll('img'));
                imgs.forEach(img => {
                  const src = img.src || img.getAttribute('src') || '';
                  const alt = img.getAttribute('alt') || img.getAttribute('title') || 'Notice_Photo.jpg';
                  if (src) allImgs.push({ src, alt });
                });
              } catch (e) {}
            };

            extractFromDoc(document);

            const iframes = Array.from(document.querySelectorAll('iframe, frame'));
            iframes.forEach(iframe => {
              try {
                if (iframe.contentDocument) {
                  extractFromDoc(iframe.contentDocument);
                }
              } catch (e) {}
            });

            return allImgs.filter(item => {
              if (!item.src) return false;
              const lower = item.src.toLowerCase();
              return !lower.includes('icon') && !lower.includes('btn') && !lower.includes('logo') && 
                     !lower.includes('blank') && !lower.includes('common') && !lower.includes('header') &&
                     !lower.includes('footer') && !lower.includes('menu');
            });
          });

          // Deduplicate attachments to prevent double downloads (e.g. text link + download icon next to it)
          const uniqueAttachLinks = [];
          const seenHrefs = new Set();
          const seenTexts = new Set();
          const seenFileNames = new Set();
          for (const link of attachLinks || []) {
            const cleanHref = (link.href || '').trim().toLowerCase();
            const cleanText = (link.text || '').trim().toLowerCase();
            const isGenericHref = !cleanHref || cleanHref === '#' || cleanHref.includes('javascript:void(0)');
            
            let isDuplicate = false;
            if (!isGenericHref && seenHrefs.has(cleanHref)) {
              isDuplicate = true;
            }
            if (cleanText && seenTexts.has(cleanText)) {
              isDuplicate = true;
            }
            
            if (!isDuplicate) {
              if (!isGenericHref) seenHrefs.add(cleanHref);
              if (cleanText) seenTexts.add(cleanText);
              uniqueAttachLinks.push(link);
            }
          }
          attachLinks = uniqueAttachLinks;

          const rfqDocsDir = path.join(OUTPUT_DIR, 'docs', `rfq_${bid.rfq_no}`);
          if (!fs.existsSync(rfqDocsDir)) {
            fs.mkdirSync(rfqDocsDir, { recursive: true });
          }

          let htmlTableItems = [];
          let nativeExcelItems = [];
          
          // NEW: Fallback text parser for pseudo-tables
          let textTableItems = parsePoscoTextTable(boardBodyText);
          if (textTableItems.length > 0 && htmlTableItems.length === 0) {
            console.log(`      🚀 Fallback Text Table Parser successfully extracted ${textTableItems.length} items from body text!`);
            htmlTableItems = textTableItems;
          }

          let combinedRawText = boardBodyText ? `--- Board Notice Description/Body ---\n${boardBodyText}\n\n` : '';
          const attachmentsList = [];

          if (attachLinks && attachLinks.length > 0) {
              console.log(`      Found ${attachLinks.length} attached document(s). Processing all files...`);

              // Tải và xử lý tài liệu TUẦN TỰ (Sequential Processing to avoid race conditions in Playwright)
              const results = [];
              const seenFilePaths = new Set(); // Deduplicate by actual saved file path
              for (let d = 0; d < attachLinks.length; d++) {
                const docLink = attachLinks[d];
                const docDisplayName = docLink.text || `Attachment_${d+1}${path.extname(docLink.href || '') || '.pdf'}`;
                console.log(`      [Sequential Doc ${d+1}/${attachLinks.length}] Spawning download for: "${docDisplayName}"...`);
                
                const downloadPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
                
                // Click the link natively using Playwright's pageIndex-based nth selector
                let clicked = false;
                try {
                  const linkLocator = page.locator('a').nth(docLink.index);
                  if (await linkLocator.count() > 0) {
                    await linkLocator.click({ timeout: 5000 });
                    clicked = true;
                  }
                } catch (e) {
                  console.log(`      ⚠️ Click at index ${docLink.index} failed, falling back to page.evaluate...`);
                }

                if (!clicked) {
                  await page.evaluate((targetIndex) => {
                    const anchors = Array.from(document.querySelectorAll('a'));
                    if (anchors[targetIndex]) {
                      anchors[targetIndex].click();
                    }
                  }, docLink.index);
                }
                
                // Short delay for custom JS dialogs/modals
                await page.waitForTimeout(1000);

                // Bypass dialogs
                await page.evaluate(() => {
                  const elements = Array.from(document.querySelectorAll('button, input[type="button"], a, span, td'));
                  const okBtn = elements.find(el => {
                    const txt = (el.textContent || el.value || '').trim().toUpperCase();
                    return txt === 'OK' || txt === 'YES' || txt === 'XÁC NHẬN';
                  });
                  if (okBtn) okBtn.click();
                });

                await page.evaluate(() => {
                  const divs = Array.from(document.querySelectorAll('div'));
                  const multiDownDialog = divs.find(d => d.textContent.includes('MultiFileDown') && d.offsetHeight > 0);
                  if (multiDownDialog) {
                    const fileLinks = Array.from(multiDownDialog.querySelectorAll('a, span, td'));
                    const fileLink = fileLinks.find(l => {
                      const txt = l.textContent.toLowerCase();
                      return txt.includes('.pdf') || txt.includes('.xlsx') || txt.includes('.xls') ||
                             txt.includes('.docx') || txt.includes('.doc') || txt.includes('.png') || 
                             txt.includes('.jpg') || txt.includes('1.') || txt.includes('2.');
                    });
                    if (fileLink) fileLink.click();
                  }
                });
                
                const download = await downloadPromise;
                if (download) {
                  const suggestedName = download.suggestedFilename() || docLink.text || `Attachment_${d+1}.pdf`;
                  const lowerName = suggestedName.toLowerCase();
                  let ext = path.extname(suggestedName).toLowerCase() || '.pdf';

                  // Save permanently in the rfq docs folder instead of a temp directory
                  const fileName = `${suggestedName.replace(/[^a-zA-Z0-9\.\-_]/g, '_')}`;
                  const persistentFilePath = path.join(rfqDocsDir, fileName);
                  await download.saveAs(persistentFilePath);

                  // ── Dedup by resolved file path: skip if same file already extracted ──
                  if (seenFilePaths.has(persistentFilePath)) {
                    console.log(`      [Dedup] Skipping duplicate file: "${fileName}" (already extracted)`);
                  } else {
                    seenFilePaths.add(persistentFilePath);

                    // Only add to attachments list once per unique file
                    attachmentsList.push({
                      name: suggestedName,
                      file_name: fileName,
                      file_path: persistentFilePath,
                      type: ext.substring(1)
                    });

                    let extractedText = '';
                    try {
                      if (ext === '.pdf') {
                        const pdfParseModule = require('pdf-parse');
                        const pdfBuffer = fs.readFileSync(persistentFilePath);
                        if (typeof pdfParseModule === 'function') {
                          const pdfData = await pdfParseModule(pdfBuffer);
                          extractedText = pdfData.text;
                        } else if (pdfParseModule.PDFParse) {
                          const p = new pdfParseModule.PDFParse(new Uint8Array(pdfBuffer));
                          const pdfData = await p.getText();
                          extractedText = pdfData.text;
                        } else if (pdfParseModule.default) {
                          const pdfData = await pdfParseModule.default(pdfBuffer);
                          extractedText = pdfData.text;
                        }
                      } else if (ext === '.xlsx' || ext === '.xls') {
                        const XLSX = require('xlsx');
                        const workbook = XLSX.readFile(persistentFilePath);
                        workbook.SheetNames.forEach(sheetName => {
                          const sheet = workbook.Sheets[sheetName];
                          const csv = XLSX.utils.sheet_to_csv(sheet);
                          if (csv && csv.trim()) {
                            extractedText += `\n--- Sheet: ${sheetName} ---\n${csv}\n`;
                          }
                        });
                        if (ext === '.xlsx') {
                          const excelOcrText = await extractAndOcrExcelImages(persistentFilePath, rfqDocsDir);
                          if (excelOcrText) extractedText += excelOcrText;

                          // Run native parser
                          // Native Excel Parsing removed per user request (relying on AI)
                        }
                      } else if (ext === '.docx' || ext === '.doc') {
                        if (ext === '.docx') {
                          const mammoth = require('mammoth');
                          const result = await mammoth.extractRawText({ path: persistentFilePath });
                          extractedText = result.value;
                        }
                      } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
                        console.log(`      [Image Attachment] Running OCR on image file: "${suggestedName}"...`);
                        extractedText = await performOcr(persistentFilePath);
                      }
                    } catch (docErr) {
                      console.error(`         ⚠️ Failed to parse document ${docDisplayName}: ${docErr.message}`);
                    }
                    results.push({ text: extractedText, name: suggestedName || docDisplayName });
                  }
                }
              }

              // Content-Based & AI Attachment Classification:
              // Classifies document text using AI & Structural content analysis to determine if it is a commercial item list or a technical manual/catalog/drawing.
              const aiClient = require('../shared/ai-client.js');
              const validItemDocs = [];
              for (const res of results) {
                if (res && res.text) {
                  const classification = await aiClient.classifyAttachmentContent(res.text, res.name);
                  if (classification.isItemList) {
                    validItemDocs.push(res);
                  } else {
                    console.log(`      [Smart AI Filter] Classified "${res.name}" as ${classification.type} (Ignored for item extraction).`);
                  }
                }
              }

              const docsToProcess = validItemDocs;

              docsToProcess.forEach(res => {
                if (res && res.text && res.text.trim().length > 0) {
                  combinedRawText += `\n--- Document: ${res.name} ---\n` + res.text + `\n`;
                }
              });
              
              if (results.length > docsToProcess.length) {
                 console.log(`      [Smart AI Filter] Ignored ${results.length - docsToProcess.length} technical reference attachment(s) (catalogs/specs/drawings).`);
              }
          }

          // Download inline notice images if present (e.g. Nameplate photos, embedded technical photos)
          if (inlineImages && inlineImages.length > 0) {
            console.log(`      Found ${inlineImages.length} inline notice image(s). Downloading...`);
            for (let imgIdx = 0; imgIdx < inlineImages.length; imgIdx++) {
              const imgInfo = inlineImages[imgIdx];
              try {
                const imgData = await page.evaluate(async (src) => {
                  const resp = await fetch(src);
                  const blob = await resp.blob();
                  return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                  });
                }, imgInfo.src).catch(() => null);

                if (imgData && imgData.includes('base64,')) {
                  const base64Data = imgData.split('base64,')[1];
                  const extMatch = imgInfo.src.match(/\.(jpg|jpeg|png|gif|webp)/i);
                  const ext = extMatch ? extMatch[1] : 'jpg';
                  const imgFileName = `Notice_Photo_${imgIdx + 1}.${ext}`;
                  const imgSavedPath = path.join(rfqDocsDir, imgFileName);
                  fs.writeFileSync(imgSavedPath, Buffer.from(base64Data, 'base64'));
                  console.log(`      📸 Downloaded inline notice photo: ${imgFileName}`);

                  const serverUrl = `/api/attachments/rfq_${bid.rfq_no}/${encodeURIComponent(imgFileName)}`;
                  attachmentsList.push({
                    file_name: imgFileName,
                    file_path: imgSavedPath,
                    url: serverUrl
                  });
                }
              } catch (err) {
                console.warn(`      ⚠️ Failed to download inline image ${imgIdx + 1}: ${err.message}`);
              }
            }
          }

          bid.attachments = attachmentsList;

          // Send combined text (Notice text + PDF text) to Ollama
          if (combinedRawText && combinedRawText.trim().length > 50) {
            const aiClient = require('../shared/ai-client.js');
            const capability = await aiClient.checkAICapability();
            const aiName = capability.detail || 'AI';
            reportProgress(percent, `[Page ${currentPage}] AI extracting item list with ${aiName} for RFQ ${bid.rfq_no}...`);
            console.log(`      Total combined text size: ${combinedRawText.length} characters. Sending to ${aiName}...`);
            const parsedItems = await parsePdfWithOllama(combinedRawText);
            let aiSuccess = false;
            if (parsedItems && Array.isArray(parsedItems) && parsedItems.length > 0) {
              console.log(`      🚀 AI parsed ${parsedItems.length} items from PDF successfully!`);
              items = parsedItems;
              aiSuccess = true;
            }
            if (!aiSuccess) {
              console.log('      🤖 AI returned no items, falling back to regex parser...');
              const regexItems = parsePdfTableRegex(combinedRawText);
              if (regexItems && regexItems.length > 0) {
                console.log(`      📊 Regex parser extracted ${regexItems.length} items.`);
                items = regexItems;
              }
            }
          }

          // 2. Extract items from the HTML table on the web page first to compare or use as fallback
          let evaluatedHtmlItems = [];
          try {
            evaluatedHtmlItems = await page.evaluate(() => {
              const tables = Array.from(document.querySelectorAll('table'));
              // Consider all tables (including nested) for item extraction
              const itemTable = tables.find(t => {
                const text = t.textContent.toLowerCase();
                return (text.includes('description') || text.includes('item') || text.includes('material')) &&
                       (text.includes('qty') || text.includes('quantity') || text.includes('uom') || text.includes('unit'));
              });
              
              if (!itemTable) return [];
              
              const rows = Array.from(itemTable.querySelectorAll('tr'));
              const headerRow = rows.find(r => {
                const text = r.textContent.toLowerCase();
                return (text.includes('description') || text.includes('item') || text.includes('material')) &&
                       (text.includes('qty') || text.includes('quantity') || text.includes('uom') || text.includes('unit'));
              });
              
              // Handle tables without explicit header rows.
              const dataRows = headerRow ? rows.filter(r => r !== headerRow && r.querySelectorAll('td').length >= 3) : rows.filter(r => r.querySelectorAll('td').length >= 3);
              const headerCells = headerRow ? Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim().toLowerCase()) : [];

              // Determine column indices; if no header, use positional defaults.
              let itemNoIdx = headerCells.findIndex(h => h.includes('no') || h.includes('item'));
              let descIdx = headerCells.findIndex(h => h.includes('desc') || h.includes('material') || h.includes('subject') || h.includes('specification'));
              let uomIdx = headerCells.findIndex(h => h.includes('unit') || h.includes('uom'));
              let qtyIdx = headerCells.findIndex(h => h.includes('qty') || h.includes('quantity') || h.includes('qty'));
              let partIdx = headerCells.findIndex(h => h.includes('part') && h.includes('number'));
              let manufIdx = headerCells.findIndex(h => h.includes('manufact') || h.includes('brand'));

              // If header not detected, assume standard column order: description, uom, qty, part_number, manufacturer.
              if (headerCells.length === 0) {
                itemNoIdx = -1; // will default to '1'
                descIdx = 0;
                uomIdx = 1;
                qtyIdx = 2;
                partIdx = 3;
                manufIdx = 4;
              }

              return dataRows.map(row => {
                const cols = row.querySelectorAll('td');
                const getValue = (idx, fallbackVal = '') => (idx !== -1 && cols[idx]) ? cols[idx].textContent.trim() : fallbackVal;

                return {
                  item_no: getValue(itemNoIdx, '1'),
                  description: getValue(descIdx, 'Item Description'),
                  uom: getValue(uomIdx, 'EA'),
                  qty: getValue(qtyIdx, '1'),
                  part_number: getValue(partIdx, ''),
                  manufacturer: getValue(manufIdx, '')
                };
              });
            });
            
            if (evaluatedHtmlItems && evaluatedHtmlItems.length > 0) {
              htmlTableItems = evaluatedHtmlItems;
            }
            
            // Smart Prioritization using AI & Semantic Content Classification:
            const aiClient = require('../shared/ai-client.js');
            const hasRealHtmlItems = aiClient.isRealMaterialItemTable(htmlTableItems);

            if (hasRealHtmlItems) {
              console.log(`      💡 HTML table contains ${htmlTableItems.length} real material item(s). Prioritizing HTML table.`);
              items = htmlTableItems;
            } else if (items.length > 0) {
              console.log(`      💡 HTML table is placeholder/generic terms or missing. Prioritizing ${items.length} items parsed from RFQ item attachment.`);
            }
          } catch (htmlErr) {
            console.warn(`      ⚠️ Failed to parse HTML table: ${htmlErr.message}`);
          }

          // 3. Last Fallback: Single item matching subject
          if (items.length === 0) {
            console.log('      No items found in HTML table. Falling back to subject line...');
            const cleanDesc = bid.subject.replace(/RFQ\s+\d+_+/, '').replace(/_/g, ' ');
            items = [
              { item_no: "1", description: cleanDesc, uom: "EA", qty: "1" }
            ];
          }

          // 4. Apply AI cleaning/structuring on HTML-scraped or fallback items to extract brand/manufacturer and part number
          const needsCleaning = items.length > 0 && items.every(item => !item.manufacturer && !item.part_number);
          if (needsCleaning) {
            const aiClient = require('../shared/ai-client.js');
            const capability = await aiClient.checkAICapability();
            const aiName = capability.detail || 'AI';
            reportProgress(percent, `[Page ${currentPage}] AI extracting brand and part number with ${aiName} for RFQ ${bid.rfq_no}...`);
            console.log(`      Applying ${aiName} to extract manufacturer/brand and part number from descriptions...`);
            const cleanedItems = await cleanItemsWithOllama(items);
            if (cleanedItems && Array.isArray(cleanedItems) && cleanedItems.length > 0) {
              console.log(`      🚀 AI structured and cleaned items successfully!`);
              items = cleanedItems;
            }
          }

          // Clean up common literal placeholders and extract manufacturer/part_number via deterministic regex if blank
          const { parseItemDescription } = require('../shared/parser');
          items = items.map(item => {
            const cleanField = (val) => {
              if (!val) return '';
              const cleanVal = String(val).trim().toLowerCase();
              if (['must', 'required', 'n/a', 'none', 'null', 'yes', 'no', 'tbd', 'to be decided', 'to be advised', 'tba', 'item description', 'description'].includes(cleanVal)) {
                return '';
              }
              if (cleanVal.includes('origin') || cleanVal.includes('acceptable') || cleanVal.includes('non-china') || cleanVal.includes('preference') || cleanVal.includes('certificate')) {
                return '';
              }
              return String(val).trim();
            };
            let extractedPn = cleanField(item.part_number);
            let extractedMfr = cleanField(item.manufacturer);

            if ((!extractedPn || !extractedMfr) && item.description) {
              const parsed = parseItemDescription(item.description);
              if (!extractedPn && parsed.part_number) extractedPn = parsed.part_number;
              if (!extractedMfr && parsed.manufacturer) extractedMfr = parsed.manufacturer;
            }

            return {
              ...item,
              part_number: extractedPn,
              manufacturer: extractedMfr
            };
          });

          bid.items = items;
          allActiveBids.push(bid);
          
          if (bid.rfq_no === '5000042461') {
             console.log('🚨 FOUND TEST RFQ! Terminating crawl immediately.');
             keepCrawling = false;
          }

        } catch (err) {
          console.error(`      ⚠️ Failed to scrape detail page for RFQ ${bid.rfq_no}: ${err.message}`);
        } finally {
          console.log('      ⬅️ Returning to RFQ list page...');
          // Go back in history
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
            console.warn('      ⚠️ page.goBack() failed, re-navigating to list URL...');
            await page.goto('https://gw.poscointl-enp.com/WebSite/Basic/Board/BoardList.aspx?system=Board.PROCUREMENT&fdid=1277&fdalias=epro_Notice', { waitUntil: 'domcontentloaded', timeout: 45000 });
          });

          // Wait for the table to load on list page
          await page.waitForSelector('table', { timeout: 15000 }).catch(() => null);
          
          // Verify that we are on the correct page. If the page input value is different from currentPage, re-click the page number!
          const actualPage = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
            const pageInput = inputs.find(input => {
              const val = input.value;
              return !isNaN(val) && val.trim() !== '' && input.offsetWidth < 60;
            });
            return pageInput ? parseInt(pageInput.value, 10) : 1;
          });

          if (actualPage !== currentPage) {
            console.log(`      ⏳ Restoring list view to Page ${currentPage}...`);
            const navSuccess = await page.evaluate((targetPage) => {
              const pageLinks = Array.from(document.querySelectorAll('a, button, span'));
              const directLink = pageLinks.find(el => el.textContent.trim() === String(targetPage) || el.textContent.trim() === `[${targetPage}]`);
              if (directLink) {
                directLink.click();
                return true;
              }
              return false;
            }, currentPage);
            
            if (navSuccess) {
              await page.waitForTimeout(2000); // Wait for AJAX load
            }
          }
        }
      }

      // Pagination Termination Check:
      // Note: If in Target Search mode, we intentionally paginate through ALL search results instead of breaking early.

      // If not searching for a specific target, and all RFQs on this page are expired, stop.
      if (!targetRfqNo && pageExpiredCount > 0 && pageActiveCount === 0) {
        console.log('\n🛑 All RFQs on this page are expired. Stopping crawl.');
        keepCrawling = false;
        break;
      }

      // Check if there is a next page
      if (currentPage < pageBids.totalPages) {
        const nextPage = currentPage + 1;
        console.log(`\n➡️ Navigating to Page ${nextPage}...`);
        
        // Use browser-side script with Dual-Strategy Pagination
        const success = await page.evaluate((targetPage) => {
          // Strategy A: Direct click on page number link
          const pageLinks = Array.from(document.querySelectorAll('a, button, span'));
          const directLink = pageLinks.find(el => {
            const text = el.textContent.trim();
            // Match exact page number or common formats
            return text === String(targetPage) || text === `[${targetPage}]`;
          });

          if (directLink) {
            directLink.click();
            return true;
          }

          // Strategy B: Fallback to input text + Go button
          const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
          const pageInput = inputs.find(input => {
            const val = input.value;
            return !isNaN(val) && val.trim() !== '' && input.offsetWidth < 60;
          });
          
          if (!pageInput) return false;
          
          pageInput.value = targetPage;
          pageInput.dispatchEvent(new Event('change', { bubbles: true }));
          
          const parent = pageInput.parentElement;
          const goBtn = Array.from(parent.querySelectorAll('a, input, button')).find(el => {
            const text = el.textContent.toLowerCase() || el.value.toLowerCase() || '';
            return text.includes('go');
          });
          
          if (goBtn) {
            goBtn.click();
            return true;
          }
          return false;
        }, nextPage);

        if (success) {
          console.log(`⏳ Waiting for Page ${nextPage} to load...`);
          // Wait for the page input value to update to the target page to ensure AJAX postback is complete
          await page.waitForFunction((expectedPage) => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
            const pageInput = inputs.find(input => {
              const val = input.value;
              return !isNaN(val) && val.trim() !== '' && input.offsetWidth < 60;
            });
            return pageInput && parseInt(pageInput.value, 10) === expectedPage;
          }, nextPage, { timeout: 15000 }).catch(() => {
            console.log('⚠️ Timeout waiting for page input value to update, proceeding anyway...');
          });

          await page.waitForTimeout(2000); // Extra buffer to ensure all table rows are fully rendered
          currentPage = nextPage;
        } else {
          console.log('⚠️ Failed to navigate to next page using the pagination controls.');
          keepCrawling = false;
        }
      } else {
        console.log('\n🏁 Reached the last page.');
        keepCrawling = false;
      }
    }

    const activeBids = forceMock ? pageBids : allActiveBids;

    console.log(`\n📥 Successfully crawled ${activeBids.length} active item(s) from POSCO Portal:`);
    console.table(activeBids);

    // Identify newly crawled RFQs that were NOT in the initial cache
    const newlyScrapedRfqs = [];
    if (!forceMock) {
      activeBids.forEach(bid => {
        if (bid.rfq_no && !rfqCache[bid.rfq_no]) {
          newlyScrapedRfqs.push(bid);
        }
      });
    }

    // Save newly crawled active RFQs to the persistent cache
    if (!forceMock && activeBids.length > 0) {
      const newCache = {};
      activeBids.forEach(bid => {
        if (bid.rfq_no) {
          newCache[bid.rfq_no] = bid;
        }
      });
      try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(newCache, null, 2));
        console.log(`💾 Saved ${Object.keys(newCache).length} active RFQ(s) to cache file: ${path.basename(CACHE_PATH)}`);
      } catch (e) {
        console.error(`⚠️ Failed to save RFQ Cache file: ${e.message}`);
      }
    }

    // ✉️ Send Email Notifications for Genuinely New RFQs
    if (newlyScrapedRfqs.length > 0) {
      console.log(`\n✉️ Detected ${newlyScrapedRfqs.length} newly scraped RFQ(s). Initiating email alerts...`);
      try {
        const { sendRfqEmailNotification } = require('../shared/notifier');
        await sendRfqEmailNotification(newlyScrapedRfqs, 'POSCO Myanmar');
      } catch (mailErr) {
        console.error(`⚠️ Notification System Error: ${mailErr.message}`);
      }
    }

    // Save output
    if (fs.existsSync(OUTPUT_DIR)) {
      const files = fs.readdirSync(OUTPUT_DIR);
      files.forEach(file => {
        if (file.startsWith('posco_rfqs_') && file.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(OUTPUT_DIR, file));
          } catch (e) {
            console.error(`Failed to delete old file ${file}: ${e.message}`);
          }
        }
      });
    }

    const outputFilename = `posco_rfqs_${Date.now()}.json`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    fs.writeFileSync(outputPath, JSON.stringify(activeBids, null, 2));
    console.log(`\n💾 POSCO crawled catalog saved: ${outputPath}`);
    reportProgress(100, `Successfully crawled ${activeBids.length} active RFQ(s). Saved catalog to output.`);
    
    return activeBids;

  } catch (error) {
    console.error(`\n❌ Scraper error: ${error.message}`);
    throw error;
  } finally {
    console.log('🚪 Closing browser...');
    await browser.close();
    console.log('👋 Done.');
  }
}

// CLI Execution Support
if (require.main === module) {
  const args = process.argv.slice(2);
  const forceLogin = args.includes('--login');
  const forceMock = args.includes('--mock');
  runScraper(forceLogin, forceMock).catch(err => {
    console.error('Fatal Scraper error:', err);
    process.exit(1);
  });
}

module.exports = { runScraper };
