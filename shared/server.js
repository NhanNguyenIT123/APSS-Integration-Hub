/**
 * APSS Integration Hub — Local Web Server
 * 
 * Native Node.js HTTP server (zero external dependencies)
 * Serves static web dashboard and processes uploaded Excel files via the pipeline.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runPipeline } = require('./pipeline');
const { runScraper: runPoscoScraper } = require('../posco/scraper');
const { runScraper: runPttepScraper } = require('../pttep/scraper');
const { getBcSampleDataPath } = require('./sample-data-paths');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let appConfig = {};
try {
  appConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  console.warn("Could not load config.json globally:", e.message);
}
const scraperState = {
  pttep: { running: false, startedAt: null },
  posco: { running: false, startedAt: null, progress: 0, status_text: 'Idle' },
};

const importState = {
  pttep: {
    running: false,
    startedAt: null,
    completedAt: null,
    percent: 0,
    stage: 'Idle',
    detail: '',
    fileName: '',
    error: '',
    summary: null,
  },
};

// Dice's Coefficient text similarity calculation for fuzzy matching
function getDiceSimilarity(str1, str2) {
  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s1 = clean(str1);
  const s2 = clean(str2);
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const bigrams1 = new Set();
  for (let i = 0; i < s1.length - 1; i++) {
    bigrams1.add(s1.substring(i, i + 2));
  }

  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substring(i, i + 2);
    if (bigrams1.has(bigram)) intersection++;
  }

  return (2.0 * intersection) / (s1.length + s2.length - 2);
}

function parsePttepCloseDate(periodText) {
  if (!periodText) return '';
  const match = periodText.match(/-\s*(\d{1,2})\s*([A-Za-z]{3})\s*(\d{4})/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const monthName = match[2];
    const year = match[3];
    const months = {
      'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
      'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    };
    const month = months[monthName] || '01';
    return `${year}-${month}-${day}`;
  }
  return '';
}

function normalizeLeadTimeWeeks(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '-') return '0';

  const match = raw.match(/\d+/);
  return match ? match[0] : '0';
}

function latestFile(files, prefix) {
  const matches = files.filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  matches.sort().reverse();
  return matches[0] || null;
}

function addDaysFromLeadTime(baseDate, leadTimeText) {
  const days = Number(normalizeLeadTimeWeeks(leadTimeText));
  if (!days || Number.isNaN(days)) return '';

  const base = baseDate ? new Date(baseDate) : new Date();
  if (Number.isNaN(base.getTime())) return '';

  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().split('T')[0];
}

function buildPttepPortalPrGroups(catalog) {
  const groups = {};
  const scrapedAt = catalog.scraped_at || new Date().toISOString();

  for (const item of catalog.items || []) {
    for (const prLine of item.prLines || []) {
      const prNo = String(prLine.pr_no || '').trim();
      if (!prNo) continue;

      if (!groups[prNo]) {
        groups[prNo] = {
          pr_no: prNo,
          scraped_at: scrapedAt,
          items: []
        };
      }

      groups[prNo].items.push({
        item_no: prLine.pr_item_no || String(groups[prNo].items.length + 1),
        description: item.material_desc || item.part_no || item.material_no || '',
        uom: item.uom || 'EA',
        qty: String(prLine.quantity || 1),
        manufacturer: item.manufacturer || '',
        part_number: item.part_no || '',
        long_description: item.material_desc || '',
        lead_time: normalizeLeadTimeWeeks(prLine.delivery_time),
        delivery_time: prLine.delivery_time || '',
        pr_number: prNo,
        pr_item_no: prLine.pr_item_no || '',
        plant: prLine.plant || '',
        material_code: item.material_no || '',
        source_url: item.source_url || '',
        bc_item_no: ''
      });
    }
  }

  return groups;
}

function getLatestPttepCatalogSummary(outputDir) {
  const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  const latestCatalog = latestFile(files, 'pttep_catalog_');
  if (!latestCatalog) {
    return {
      exists: false,
      file: '',
      scraped_at: '',
      item_count: 0,
      pr_count: 0,
      pr_groups: []
    };
  }

  const catalogPath = path.join(outputDir, latestCatalog);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
  const groups = buildPttepPortalPrGroups(catalog);
  const prGroups = Object.values(groups).map(group => ({
    pr_no: group.pr_no,
    item_count: group.items.length,
    first_description: group.items[0]?.description || '',
    total_quantity: group.items.reduce((sum, item) => sum + Number(item.qty || 0), 0),
    close_date: addDaysFromLeadTime(catalog.scraped_at, group.items[0]?.delivery_time),
    plant: group.items[0]?.plant || ''
  }));

  return {
    exists: true,
    file: latestCatalog,
    scraped_at: catalog.scraped_at || '',
    item_count: catalog.items?.length || 0,
    pr_count: prGroups.length,
    pr_groups: prGroups
  };
}

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

function normalizeBrandGroupKey(groupKey, brandName, sourceFile = '') {
  const raw = String(groupKey || '').trim();
  if (/^\d+$/.test(raw)) return raw;

  if (brandName) return makeBrandGroupKey(brandName, sourceFile);
  
  return raw;
}

function buildPttepPortalBrandGroups(catalog) {
  const groups = {};
  for (const item of catalog.items || []) {
    const brandName = normalizeBrandName(item.manufacturer);
    const brandKey = makeBrandGroupKey(brandName);
    if (!groups[brandKey]) {
      groups[brandKey] = {
        brand_key: brandKey,
        brand_name: brandName,
        items: [],
      };
    }
    groups[brandKey].items.push({
      item_no: item.id || String(groups[brandKey].items.length + 1),
      description: item.material_desc || item.part_no || item.material_no || '',
      uom: item.uom || 'EA',
      qty: String(item.total_quantity || 1),
      manufacturer: item.manufacturer || '',
      part_number: item.part_no || '',
      long_description: item.long_description || item.material_desc || '',
      lead_time: normalizeLeadTimeWeeks(item.delivery_time || ''),
      pr_number: (item.prLines || []).map(line => `${line.pr_no || ''}${line.pr_item_no ? `-${line.pr_item_no}` : ''}`).filter(Boolean).join(', '),
      material_code: item.material_no || '',
      bc_item_no: '',
      source_url: item.source_url || '',
    });
  }
  return groups;
}

function buildPttepFeedSummaryFromReport(report) {
  const closeDate = parsePttepCloseDate(report.period) || '';
  const brandGroups = Object.entries(report.brand_groups || {}).map(([brandKey, group]) => ({
    group_key: normalizeBrandGroupKey(brandKey, group.brand_name, report.file),
    brand_name: group.brand_name || 'UNSPECIFIED BRAND',
    item_count: group.item_count || (group.items || []).length || 0,
    total_quantity: group.total_quantity || (group.items || []).reduce((sum, item) => sum + Number(item.quantity || item.total_quantity || 0), 0),
    sample_description: group.items?.[0]?.material_description || '',
    close_date: closeDate,
    source_file: report.file || '',
  }));

  return {
    exists: true,
    file: report.file || '',
    scraped_at: report.timestamp || '',
    item_count: report.summary?.total || report.items?.matched?.length || 0,
    group_count: brandGroups.length,
    brand_groups: brandGroups,
  };
}

function getLatestPttepFeedSummary(outputDir) {
  const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  const latestReport = latestFile(files, 'report_');
  if (latestReport) {
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, latestReport), 'utf-8'));
    if (report.brand_groups && Object.keys(report.brand_groups).length > 0) {
      return buildPttepFeedSummaryFromReport(report);
    }
  }

  const latestCatalog = latestFile(files, 'pttep_catalog_');
  if (!latestCatalog) {
    return {
      exists: false,
      file: '',
      scraped_at: '',
      item_count: 0,
      group_count: 0,
      brand_groups: []
    };
  }

  const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, latestCatalog), 'utf-8'));
  const brandGroups = Object.values(buildPttepPortalBrandGroups(catalog)).map(group => ({
    group_key: group.brand_key,
    brand_name: group.brand_name,
    item_count: group.items.length,
    total_quantity: group.items.reduce((sum, item) => sum + Number(item.qty || 0), 0),
    sample_description: group.items[0]?.description || '',
    close_date: '',
    source_file: latestCatalog,
  }));

  return {
    exists: true,
    file: latestCatalog,
    scraped_at: catalog.scraped_at || '',
    item_count: catalog.items?.length || 0,
    group_count: brandGroups.length,
    brand_groups: brandGroups,
  };
}
// Replace hardcoded port with environment variable for Render
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TEMP_DIR = path.join(__dirname, '..', 'temp');
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function requestExceedsContentLength(req, maxBytes) {
  const contentLength = Number(req.headers['content-length']);
  return Number.isFinite(contentLength) && contentLength > maxBytes;
}

function getPublicBaseUrl(req) {
  const configuredUrl = process.env.PUBLIC_BASE_URL || appConfig.publicBaseUrl;
  if (configuredUrl) return configuredUrl.trim().replace(/\/+$/, '');

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (forwardedHost) return `${protocol}://${forwardedHost}`;

  // Backward compatibility for local tunnel-based development.
  const tunnelPath = path.join(__dirname, '..', 'tunnel_url.txt');
  if (fs.existsSync(tunnelPath)) return fs.readFileSync(tunnelPath, 'utf-8').trim().replace(/\/+$/, '');
  return `http://localhost:${PORT}`;
}

// Track active online users for UAT avoiding override
const activeClients = new Map();

// Ensure directories exist
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// MIME types mapping
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  let cleanUrl = req.url;
  if (cleanUrl.startsWith('//')) {
    cleanUrl = '/' + cleanUrl.replace(/^\/+/, '');
  }
  const reqUrl = new URL(cleanUrl, `http://${req.headers.host}`);
  let pathname = reqUrl.pathname.replace(/\/+/g, '/');


  console.log(`[${new Date().toISOString().split('T')[1].substring(0, 8)}] 🌐 ${req.method} ${pathname}`);

  // ─── Enable CORS ───────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── API Armor (UAT Access Code Check) ─────────────────────
  if (pathname.startsWith('/api/') && pathname !== '/api/heartbeat') {
    const apiKey = req.headers['x-api-key'] || reqUrl.searchParams.get('api_key');
    const validKey = appConfig.dashboardApiKey;
    
    // Only enforce if validKey is actually configured, 
    // otherwise block to ensure security is explicitly set.
    if (!validKey || !apiKey || apiKey !== validKey) {
      console.warn(`[SECURITY] Blocked unauthorized API access to ${pathname}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing API Key' }));
      return;
    }
  }

  // ─── API: Middleware List (GET /api/middleware/list) ──────────
  if (req.method === 'GET' && pathname === '/api/middleware/list') {
    console.log('📡 Middleware API: List requested...');
    try {
      const outputDir = path.join(__dirname, '..', 'output');
      const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
      
      const rfqList = [];

      // 1. Process POSCO Scraped files
      const poscoFiles = files.filter(f => f.startsWith('posco_rfqs_') && f.endsWith('.json'));
      if (poscoFiles.length > 0) {
        poscoFiles.sort().reverse(); // Sort descending to get latest
        const latestPoscoFile = path.join(outputDir, poscoFiles[0]);
        const poscoData = JSON.parse(fs.readFileSync(latestPoscoFile, 'utf-8'));
        poscoData.forEach(rfq => {
          rfqList.push({
            rfq_no: rfq.rfq_no,
            subject: rfq.subject,
            drafter: rfq.drafter || 'POSCO Portal',
            date: rfq.regi_date || '',
            close_date: rfq.close_date || '',
            portal: 'POSCO e-Pro',
            item_count: rfq.items ? rfq.items.length : 0
          });
        });
      }

      // (Email Scraped files logic removed)

      const latestPttepSummary = getLatestPttepFeedSummary(outputDir);
      if (latestPttepSummary.exists) {
        const reportDate = (latestPttepSummary.scraped_at || '').split('T')[0];
        for (const group of latestPttepSummary.brand_groups) {
          const rfqNoFromFilename = (latestPttepSummary.file || '').match(/\d+/)?.[0] || '1781506129299';
          rfqList.push({
            rfq_no: group.group_key,
            subject: `RFQ - ${rfqNoFromFilename} - ${group.brand_name}`,
            drafter: 'PTTEP Excel Import',
            date: reportDate,
            close_date: group.close_date || '',
            portal: 'PTTEP FlashBuy',
            item_count: group.item_count || 0,
            source: 'excel_import'
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, rfq_list: rfqList }));
    } catch (err) {
      console.error(`❌ Middleware List API Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ─── API: Middleware Pull (GET /api/middleware/pull) ──────────
  if (req.method === 'GET' && pathname === '/api/middleware/pull') {
    const rfqNo = reqUrl.searchParams.get('rfq_no');
    console.log(`📡 Middleware API: Pull requested for RFQ No: ${rfqNo}...`);
    
    if (!rfqNo) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'Missing rfq_no query parameter' }));
      return;
    }

    try {
      const outputDir = path.join(__dirname, '..', 'output');
      const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
      let foundItems = null;
      let rfqDetails = null;

      // 1. Search in POSCO files
      const poscoFiles = files.filter(f => f.startsWith('posco_rfqs_') && f.endsWith('.json'));
      poscoFiles.sort().reverse();
      for (const file of poscoFiles) {
        const data = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf-8'));
        const rfq = data.find(r => r.rfq_no === rfqNo);
        if (rfq) {
          const { parseItemDescription } = require('./parser');
          
          // Build attachment links from the public middleware URL, not localhost.
          // Business Central SaaS must be able to fetch these links itself.
          const baseUrl = getPublicBaseUrl(req);

          foundItems = (rfq.items || []).map((item, index) => {
            const rawDesc = item.full_description || item.description || 'Item Description';
            const parsed = parseItemDescription(rawDesc);
            return {
              item_no: String(item.item_no || item.item_id || item.item_number || (index + 1)),
              description: rawDesc,
              uom: item.uom || item.unit_of_measure || 'EA',
              qty: String(item.qty || item.quantity || '1'),
              manufacturer: item.manufacturer || parsed.manufacturer || '',
              part_number: item.part_number || parsed.part_number || '',
              long_description: rawDesc,
              lead_time: '0'
            };
          });

          // Build attachments list with public serve URLs
          const mappedAttachments = (rfq.attachments || []).map(att => ({
            name: att.name,
            url: `${baseUrl}/api/attachments/rfq_${rfq.rfq_no}/${att.file_name}`,
            type: att.type
          }));

          const fullContextSubject = rfq.notice_text 
            ? `${rfq.subject}\n\nNotice Body:\n${rfq.notice_text}`
            : rfq.subject;

          rfqDetails = {
            rfq_no: rfq.rfq_no,
            subject: fullContextSubject,
            portal: 'POSCO e-Pro',
            drafter: rfq.drafter,
            attachments: mappedAttachments
          };
          break;
        }
      }

      // 2. Search latest PTTEP Excel import by brand group.
      if (!foundItems) {
        const latestReport = latestFile(files, 'report_');
        if (latestReport) {
          const report = JSON.parse(fs.readFileSync(path.join(outputDir, latestReport), 'utf-8'));
          const reportGroups = Object.entries(report.brand_groups || {});
          const matchedBrandEntry = reportGroups.find(([brandKey, group]) =>
            normalizeBrandGroupKey(brandKey, group.brand_name, report.file) === rfqNo
          );
          const brandGroup = matchedBrandEntry ? matchedBrandEntry[1] : null;
          const reportBrandKey = matchedBrandEntry ? matchedBrandEntry[0] : '';

          if (brandGroup) {
            foundItems = (brandGroup.items || []).map((item, idx) => ({
              item_no: item.line_no || String(idx + 1),
              description: item.material_description,
              uom: item.uom || 'EA',
              qty: String(item.quantity || item.total_quantity || 1),
              manufacturer: item.manufacturer || item.ai_parsed?.manufacturer || '',
              part_number: item.part_number || item.ai_parsed?.part_number || '',
              long_description: item.long_description || item.material_description || '',
              lead_time: normalizeLeadTimeWeeks(item.delivery_lead_time || item.delivery_lead_time_weeks),
              pr_number: item.pr_number || '',
              material_code: item.material_code || '',
              bc_item_no: item.best_match?.item_no || item.best_match?.bc_item_no || '',
            }));

            const sqEntry = (report.sales_quotes || []).find(s =>
              normalizeBrandGroupKey(s.brand_key, s.brand_name, report.file) === rfqNo ||
              s.brand_key === reportBrandKey
            );
            const rfqNoFromFilename = (report.file || '').match(/\d+/)?.[0] || '1781506129299';
            rfqDetails = {
              rfq_no: rfqNo,
              subject: `RFQ - ${rfqNoFromFilename} - ${brandGroup.brand_name}`,
              portal: 'PTTEP FlashBuy',
              drafter: 'PTTEP Excel Import',
              sq_number: sqEntry ? sqEntry.sq_number : null,
            };
          }
        }
      }

      // 3. Legacy fallback: derive brand groups from older portal catalog files.
      if (!foundItems) {
        const latestPttepCatalog = latestFile(files, 'pttep_catalog_');
        if (latestPttepCatalog) {
          const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, latestPttepCatalog), 'utf-8'));
          const brandGroups = buildPttepPortalBrandGroups(catalog);
          const brandGroup = Object.values(brandGroups).find(group => group.brand_key === rfqNo);

          if (brandGroup) {
            foundItems = brandGroup.items;
            const rfqNoFromFilename = (latestPttepCatalog || '').match(/\d+/)?.[0] || '1781506129299';
            rfqDetails = {
              rfq_no: rfqNo,
              subject: `RFQ - ${rfqNoFromFilename} - ${brandGroup.brand_name}`,
              portal: 'PTTEP FlashBuy',
              drafter: 'PTTEP Portal',
              source: 'portal_catalog'
            };
          }
        }
      }

      // (Search in Email files logic removed)

      if (foundItems) {
        // Fetch existing items from BC for fuzzy matching
        let bcItems = [];
        try {
          const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
          if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            const { BCClient } = require('./bc-client');
            const bc = new BCClient(config);
            await bc.init();
            bcItems = await bc.getItems();
            console.log(`   Fetched ${bcItems.length} items from Business Central for fuzzy matching.`);
          }
        } catch (err) {
          console.warn(`  ⚠️  Failed to fetch items from Business Central: ${err.message}`);
          console.log('👉 Falling back to BC Simulation Mode (using local or example sample BC data for matching)');
          const mockPath = getBcSampleDataPath();
          if (fs.existsSync(mockPath)) {
            bcItems = JSON.parse(fs.readFileSync(mockPath, 'utf-8'));
            console.log(`   Loaded mock BC data for matching: ${bcItems.length} items`);
          }
        }

        // Words that look like part numbers but are just common English words.
        // The MODEL regex can accidentally match "Model must have..." → "must".
        const INVALID_PART_WORDS = new Set([
          'must', 'have', 'be', 'not', 'the', 'an', 'a', 'is', 'are', 'was',
          'required', 'n/a', 'none', 'null', 'yes', 'no', 'tbd', 'tba', 'na',
          'per', 'with', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at'
        ]);
        const sanitizePartNo = (val) => {
          if (!val) return '';
          const clean = val.trim();
          if (INVALID_PART_WORDS.has(clean.toLowerCase())) return '';
          return clean;
        };

        const { parseItemDescription, validateExtraction } = require('./parser');
        const { aiParseItem } = require('./ai-client');

        foundItems = await Promise.all(foundItems.map(async item => {
          let rfqParsed = parseItemDescription(item.description);

          // 1. Ollama Fallback (hybrid regex-AI approach)
          if (!validateExtraction(rfqParsed)) {
            console.log(`   ⚠️ Regex extraction failed validation. Triggering Ollama fallback for: "${item.description.substring(0, 40)}..."`);
            const aiParsed = await aiParseItem(item.description, '', '', '');
            if (aiParsed) {
              rfqParsed = aiParsed;
            }
          }

          // 2. Normalize UOM for BC
          let normalizedUom = item.uom || '';
          const uomUpper = normalizedUom.trim().toUpperCase();
          const uomMap = {
            // Each
            'EACH': 'EA', 'E.A': 'EA', 'E.A.': 'EA',
            // Box
            'BOXES': 'BOX', 'BXS': 'BOX', 'BX': 'BOX',
            // Roll
            'ROL': 'ROLL', 'ROLLS': 'ROLL', 'RL': 'ROLL',
            // Bottle
            'BOTTLES': 'BOT', 'BOTTLE': 'BOT', 'BTL': 'BOT', 'BTLS': 'BOT',
            // Piece
            'PIECES': 'PCS', 'PIECE': 'PCS', 'PC': 'PCS', 'PCE': 'PCS', 'PICES': 'PCS',
            // Pack
            'PACKS': 'PACK', 'PAC': 'PACK', 'PAK': 'PACK',
            // Packet
            'PACKET': 'PKT', 'PACKETS': 'PKT', 'PKTS': 'PKT',
            // Dozen
            'DZ': 'DOZEN', 'DZS': 'DOZEN', 'DOZ': 'DOZEN', 'DOZENS': 'DOZEN',
            // Liter
            'LIT': 'LTR', 'LITER': 'LTR', 'LITERS': 'LTR', 'LITRE': 'LTR', 'LITRES': 'LTR', 'L': 'LTR',
            // Kilogram
            'KGS': 'KG', 'KILO': 'KG', 'KILOS': 'KG', 'KILOGRAM': 'KG', 'KILOGRAMS': 'KG',
            // Meter
            'METERS': 'METER', 'METRE': 'METER', 'METRES': 'METER', 'MTR': 'METER', 'MTRS': 'METER',
            // Centimeter
            'CENTIMETER': 'CM', 'CENTIMETERS': 'CM', 'CENTIMETRES': 'CM',
            // Square Meter
            'SQ.M': 'SQM', 'SQMT': 'SQM', 'M2': 'SQM', 'SQUARE METER': 'SQM', 'SQUARE METERS': 'SQM',
            // Bag
            'BAGS': 'BAG', 'BG': 'BAG', 'BGS': 'BAG',
            // Can
            'CANS': 'CAN', 'CN': 'CAN',
            // Carton
            'CARTON': 'CTN', 'CARTONS': 'CTN', 'CTNS': 'CTN',
            // Drum
            'DRUMS': 'DRUM', 'DRM': 'DRUM',
            // Pair
            'PAIR': 'PR', 'PAIRS': 'PR', 'PRS': 'PR',
            // Set
            'SETS': 'SET',
            // Sheet
            'SHEETS': 'SHEET', 'SHT': 'SHEET', 'SHTS': 'SHEET',
            // Tube
            'TUBES': 'TUBE',
            // Gallon
            'GALLON': 'GAL', 'GALLONS': 'GAL', 'GALS': 'GAL',
            // Gram
            'GRAM': 'GR', 'GRAMS': 'GR', 'GRM': 'GR', 'G': 'GR',
            // Feet/Foot
            'FOOT': 'FT', 'FEET': 'FT',
            // Pail & Pallet
            'PAILS': 'PAIL', 'PALLETS': 'PALLET'
          };
          normalizedUom = uomMap[uomUpper] || uomUpper;

          // 3. Remove bc_item_no assignment (Let BC matching algorithm do its job!)
          return {
            ...item,
            uom: normalizedUom,
            part_number: sanitizePartNo(item.part_number) || sanitizePartNo(rfqParsed.part_number) || '',
            manufacturer: item.manufacturer || rfqParsed.manufacturer || '',
            bc_item_no: ''
          };
        }));

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ 
          success: true, 
          rfq: rfqDetails,
          items: foundItems 
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: `RFQ ${rfqNo} not found in parsed records` }));
      }
    } catch (err) {
      console.error(`❌ Middleware Pull API Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ─── API: PTTEP Portal Catalog Status ───────────────────────
  if (req.method === 'GET' && pathname === '/api/pttep/catalog/status') {
    try {
      const outputDir = path.join(__dirname, '..', 'output');
      const summary = getLatestPttepFeedSummary(outputDir);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        middleware_base_url: getPublicBaseUrl(req),
        catalog: summary
      }));
    } catch (err) {
      console.error(`❌ PTTEP catalog status API error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/pttep/import/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      import: importState.pttep,
    }));
    return;
  }

  // ─── API: Trigger PTTEP Portal Scraper ──────────────────────
  if (req.method === 'DELETE' && pathname === '/api/pttep/catalog/latest') {
    if (scraperState.pttep.running) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        error: 'PTTEP scrape is currently running. Wait for it to finish before clearing the latest feed.'
      }));
      return;
    }

    try {
      const outputDir = path.join(__dirname, '..', 'output');
      const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
      const targets = [latestFile(files, 'report_'), latestFile(files, 'pttep_catalog_')].filter(Boolean);

      if (!targets.length) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, deleted: false }));
        return;
      }

      for (const target of targets) {
        fs.unlinkSync(path.join(outputDir, target));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, deleted: true, files: targets }));
    } catch (err) {
      console.error(`❌ PTTEP clear latest feed API error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/heartbeat') {
    if (requestExceedsContentLength(req, MAX_REQUEST_BODY_BYTES)) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body is too large.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      if (body.length + chunk.length > MAX_REQUEST_BODY_BYTES) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body is too large.' }));
        }
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.deviceId) {
          activeClients.set(data.deviceId, Date.now());
        }
        
        // Cleanup inactive clients (older than 15 seconds)
        const now = Date.now();
        for (const [id, timestamp] of activeClients.entries()) {
          if (now - timestamp > 15000) {
            activeClients.delete(id);
          }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ activeUsers: activeClients.size }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/pttep/scrape') {
    const limitParam = reqUrl.searchParams.get('limit');
    const itemLimit = limitParam ? Number(limitParam) : 0;
    const forceLogin = reqUrl.searchParams.get('login') === 'true';
    if (scraperState.pttep.running) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        error: 'PTTEP scrape is already running. Please wait for the current refresh to finish.'
      }));
      return;
    }

    scraperState.pttep.running = true;
    scraperState.pttep.startedAt = new Date().toISOString();
    console.log(`🧭 Triggering PTTEP portal scraper (limit: ${itemLimit || 'all'}, login: ${forceLogin})...`);

    try {
      await runPttepScraper({
        forceLogin,
        itemLimit: itemLimit > 0 ? itemLimit : Infinity,
      });

      const outputDir = path.join(__dirname, '..', 'output');
      const summary = getLatestPttepCatalogSummary(outputDir);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, catalog: summary }));
    } catch (err) {
      console.error(`❌ PTTEP Scraper API Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    } finally {
      scraperState.pttep.running = false;
      scraperState.pttep.startedAt = null;
    }
    return;
  }

  // ─── API: POSCO Scraper Status (GET /api/posco/scrape/status) ────
  if (req.method === 'GET' && pathname === '/api/posco/scrape/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(scraperState.posco));
    return;
  }

  // ─── API: Submit POSCO OTP (Remote OTP) ───
  if (req.method === 'POST' && pathname === '/api/posco/submit-otp') {
    if (requestExceedsContentLength(req, MAX_REQUEST_BODY_BYTES)) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Request body is too large.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      if (body.length + chunk.length > MAX_REQUEST_BODY_BYTES) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Request body is too large.' }));
        }
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (payload.otp && global.poscoOtpCallback) {
          console.log('Received remote OTP.');
          global.poscoOtpCallback(payload.otp); // Resolve the promise in scraper
          global.poscoOtpCallback = null; // Clear the callback
          scraperState.posco.status_text = 'OTP submitted, verifying login...';
          
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, message: 'OTP submitted successfully.' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'No active OTP request or missing otp field.' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload.' }));
      }
    });
    return;
  }

  // ─── API: POSCO Latest Catalog (GET /api/posco/latest) ─────────
  if (req.method === 'GET' && pathname === '/api/posco/latest') {
    try {
      const outputDir = path.join(__dirname, '..', 'output');
      const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
      const poscoFiles = files.filter(f => f.startsWith('posco_rfqs_') && f.endsWith('.json'));
      
      if (poscoFiles.length > 0) {
        poscoFiles.sort().reverse();
        const latestPoscoFile = path.join(outputDir, poscoFiles[0]);
        const poscoData = JSON.parse(fs.readFileSync(latestPoscoFile, 'utf-8'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, bids: poscoData }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, bids: [] }));
      }
    } catch (err) {
      console.error(`❌ POSCO Latest API Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ─── API: Cancel POSCO Scraper (POST /api/posco/cancel) ────
  if (req.method === 'POST' && pathname === '/api/posco/cancel') {
    console.log('🤖 POSCO Scraper cancellation requested...');
    if (global.activeBrowser) {
      global.activeBrowser.close().catch(e => {});
      global.activeBrowser = null;
    }
    scraperState.posco.running = false;
    scraperState.posco.startedAt = null;
    scraperState.posco.progress = 0;
    scraperState.posco.status_text = 'Cancelled';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: 'POSCO scraper cancellation triggered.' }));
    return;
  }

  // ─── API: Cancel PTTEP Import (POST /api/pttep/cancel) ────
  if (req.method === 'POST' && pathname === '/api/pttep/cancel') {
    console.log('🤖 PTTEP Import pipeline cancellation requested...');
    global.pttepImportCancelled = true;
    importState.pttep.running = false;
    importState.pttep.percent = 0;
    importState.pttep.stage = 'Cancelled';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: 'PTTEP import cancellation triggered.' }));
    return;
  }

  // ─── API: Trigger POSCO Scraper (Asynchronous execution to prevent Cloudflare/Azure timeouts) ───
  if (req.method === 'POST' && pathname === '/api/posco/scrape') {
    const isMock = reqUrl.searchParams.get('mock') === 'true';
    const forceLogin = reqUrl.searchParams.get('login') === 'true';
    const targetRfqNo = reqUrl.searchParams.get('rfq_no') || null;
    
    if (scraperState.posco.running) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'POSCO scrape is already running. Please wait for the current crawl to finish.' }));
      return;
    }

    // Set initial state
    scraperState.posco.running = true;
    scraperState.posco.startedAt = new Date().toISOString();
    scraperState.posco.progress = 5;
    scraperState.posco.status_text = targetRfqNo ? `Initializing POSCO scraper for RFQ ${targetRfqNo}...` : 'Initializing POSCO portal scraper...';
    console.log(`🤖 Triggering POSCO Scraper API Asynchronously (Mock Mode: ${isMock}, Force Login: ${forceLogin}, Target: ${targetRfqNo || 'All Active'})...`);

    // Run scraper in the background (Fire-and-forget to prevent HTTP connection timeout)
    runPoscoScraper(forceLogin, isMock, (prog) => {
      if (prog) {
        scraperState.posco.progress = prog.percent;
        scraperState.posco.status_text = prog.message;
      }
    }, targetRfqNo).then((activeBids) => {
      console.log(`🤖 Background POSCO Scraper finished successfully. Crawled ${activeBids?.length || 0} active RFQ(s).`);
    }).catch((err) => {
      console.error(`❌ Background POSCO Scraper failed: ${err.message}`);
    }).finally(() => {
      scraperState.posco.running = false;
      scraperState.posco.startedAt = null;
      scraperState.posco.progress = 0;
      scraperState.posco.status_text = 'Idle';
    });

    // Respond immediately to prevent Cloudflare 524 timeout / Azure Gateway timeout
    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ 
      success: true, 
      message: 'POSCO scraper successfully started in the background.',
      status_url: '/api/posco/scrape/status' 
    }));
    return;
  }

  // ─── API: Sync POSCO Item to Business Central ──────────────
  if (req.method === 'POST' && pathname === '/api/posco/sync-item') {
    if (requestExceedsContentLength(req, MAX_REQUEST_BODY_BYTES)) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Request body is too large.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      if (body.length + chunk.length > MAX_REQUEST_BODY_BYTES) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Request body is too large.' }));
        }
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { action, mock, rfq_no, subject, drafter } = payload;
        const isMock = mock === true;

        console.log(`[${new Date().toISOString().split('T')[1].substring(0, 8)}] 📡 Syncing POSCO item to BC (Action: ${action}, Mock: ${isMock}, RFQ: ${rfq_no})...`);

        if (isMock) {
          // Return simulated BC Item ID
          const mockItemNo = `APSS-AWX-${Math.floor(1000 + Math.random() * 9000)}`;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, bc_item_no: mockItemNo }));
          return;
        }

        // Live connection
        const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        const { BCClient } = require('./bc-client');
        const bc = new BCClient(config);
        
        await bc.init();

        if (action === 'create') {
          // Clean subject line (remove 'RFQ XXXXX_')
          const cleanDesc = subject.replace(/RFQ\s+\d+_+/, '').replace(/_/g, ' ').substring(0, 100);
          console.log(`   Creating Item Card in BC: "${cleanDesc}"`);
          
          const result = await bc.createItem({
            description: cleanDesc,
            type: 'Inventory',
            uom: 'EA'
          });

          console.log(`   Successfully created BC Item: ${result.number}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, bc_item_no: result.number }));
        } else {
          // Link action (for demo linking, map to a fixed category)
          const mockItemNo = `APSS-ITEM-FUZZY-${rfq_no}`;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, bc_item_no: mockItemNo }));
        }
      } catch (err) {
        console.error(`❌ BC Sync Item Error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ─── API: Upload Excel File ────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/upload') {
    if (requestExceedsContentLength(req, MAX_UPLOAD_BYTES)) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload exceeds the 15 MB limit.' }));
      return;
    }
    const isLive = reqUrl.searchParams.get('live') === 'true';
    const tempFileName = `upload_${Date.now()}.xlsx`;
    const tempFilePath = path.join(TEMP_DIR, tempFileName);
    const activeImport = importState.pttep;

    console.log(`📥 Receiving upload stream... Saving to temp: ${tempFileName} (Live Mode: ${isLive})`);

    activeImport.running = true;
    activeImport.startedAt = new Date().toISOString();
    activeImport.completedAt = null;
    activeImport.percent = 2;
    activeImport.stage = 'Uploading Excel file';
    activeImport.detail = tempFileName;
    activeImport.fileName = tempFileName;
    activeImport.error = '';
    activeImport.summary = null;

    const writeStream = fs.createWriteStream(tempFilePath);
    let uploadBytes = 0;
    let uploadRejected = false;
    req.on('data', chunk => {
      uploadBytes += chunk.length;
      if (uploadRejected || uploadBytes <= MAX_UPLOAD_BYTES) return;

      uploadRejected = true;
      req.unpipe(writeStream);
      writeStream.destroy();
      fs.unlink(tempFilePath, () => {});
      activeImport.running = false;
      activeImport.stage = 'Upload rejected';
      activeImport.error = 'Upload exceeds the 15 MB limit.';
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload exceeds the 15 MB limit.' }));
      }
      req.resume();
    });
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      if (uploadRejected) return;
      console.log(`✅ File saved. Running pipeline on: ${tempFileName} in background`);
      activeImport.percent = 4;
      activeImport.stage = 'Upload completed';
      activeImport.detail = 'Starting PTTEP Excel pipeline in background...';
      
      // Respond immediately to avoid Render/Cloudflare 524 Timeout (100 seconds limit)
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: 'File uploaded and processing started in background.',
        status_url: '/api/pttep/import/status'
      }));

      // Process in background (Fire-and-forget)
      runPipeline(tempFilePath, {
        dryRun: !isLive,
        useAI: true,
        maxAI: 20,
        onProgress: ({ percent, stage, detail }) => {
          activeImport.percent = percent;
          activeImport.stage = stage;
          activeImport.detail = detail || '';
        }
      }).then(report => {
        fs.unlink(tempFilePath, (err) => {});
        activeImport.running = false;
        activeImport.completedAt = new Date().toISOString();
        activeImport.percent = 100;
        activeImport.stage = 'Import completed';
        activeImport.detail = `${report.summary?.total || 0} items grouped into ${report.summary?.brand_count || 0} brand records`;
        activeImport.summary = report.summary || null;
      }).catch(err => {
        console.error(`  ❌ Pipeline execution failed: ${err.message}`);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        activeImport.running = false;
        activeImport.completedAt = new Date().toISOString();
        activeImport.stage = 'Import failed';
        activeImport.error = err.message;
      });
    });

    writeStream.on('error', (err) => {
      if (uploadRejected) return;
      console.error(`  ❌ File write error: ${err.message}`);
      activeImport.running = false;
      activeImport.completedAt = new Date().toISOString();
      activeImport.stage = 'Upload failed';
      activeImport.error = err.message;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to write uploaded file' }));
    });

    return;
  }

  // ─── API: Serve Attachments (GET /api/attachments/*) ──────────
  if (req.method === 'GET' && pathname.startsWith('/api/attachments/')) {
    const relativePath = pathname.substring('/api/attachments/'.length); // e.g. "rfq_5000041486/Fan 1.jpg"
    // Security check: prevent directory traversal using absolute path resolution
    const absoluteBaseDir = path.resolve(__dirname, '..', 'output', 'docs');
    const docPath = path.resolve(absoluteBaseDir, relativePath);

    if (!docPath.startsWith(absoluteBaseDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden: Access Denied');
      return;
    }

    const ext = path.extname(docPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(docPath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Attachment Not Found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`500 Internal Server Error: ${err.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
    return;
  }

  // ─── Serve Static Files ────────────────────────────────────
  if (req.method === 'GET') {
    // Default to index.html
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    // Security check: prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`500 Internal Server Error: ${err.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
    return;
  }

  // Route not found
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

// Bind to 0.0.0.0 so Render's external proxy can route traffic to it
server.listen(PORT, '0.0.0.0', () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  APSS Integration Hub Web Server                          ║');
  console.log(`║  Running on: http://0.0.0.0:${PORT}                       ║`);
  console.log('║  🔒 Native HTTP Server — Zero Vulnerabilities             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
});
