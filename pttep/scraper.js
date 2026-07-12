const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, 'session.json');
const PROFILE_PATH = path.join(__dirname, '.browser-profile');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let appConfig = {};
try {
  appConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  console.warn("Could not load config.json:", e.message);
}

const PTTEP_BASE = 'https://marketplace.apps.pttep.com';
const FLASHBUY_URL = `${PTTEP_BASE}/vendor/product-catalog/general-market/flash-buy`;
const API_BASE = 'https://endpoint.api.pttep.com/scm-marketplace/v1';
const DEFAULT_SERVICE_NAME = 'scm-marketplace';
const PAGE_SIZE = 12;
const ITEM_CONCURRENCY = 8;
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isLoginScreenText(text) {
  const body = String(text || '').toLowerCase();
  return (
    body.includes('login with pttep') ||
    body.includes('login with non-pttep') ||
    body.includes('welcome to scm marketplace')
  );
}

function looksLikeFlashBuyPage(text) {
  return String(text || '').toLowerCase().includes('flash buy');
}

function normalizeToken(rawToken) {
  const value = String(rawToken || '').trim();
  if (!value) return '';
  return value.toLowerCase().startsWith('bearer ') ? value : `Bearer ${value}`;
}

function extractPartNumber(description) {
  const text = String(description || '');
  const patterns = [
    /P\/N\.?\s*([A-Z0-9\-./]+)/i,
    /PART\s*NO\.?\s*([A-Z0-9\-./]+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }

  return '';
}

function formatDeliveryTime(daysUntilDeliveryDate, deliveryDate) {
  if (daysUntilDeliveryDate !== undefined && daysUntilDeliveryDate !== null && daysUntilDeliveryDate !== '') {
    return `${daysUntilDeliveryDate} Days`;
  }
  return deliveryDate ? String(deliveryDate) : '';
}

function dedupePrLines(prLines) {
  const seen = new Set();
  const output = [];

  for (const line of prLines || []) {
    const key = [
      line.pr_no || '',
      line.pr_item_no || '',
      line.plant || '',
      line.quantity || '',
      line.delivery_time || ''
    ].join('|');

    if (seen.has(key)) continue;
    seen.add(key);
    output.push(line);
  }

  return output;
}

function summarizeCatalogRow(row = {}) {
  return {
    id: row.id !== undefined && row.id !== null ? String(row.id) : '',
    code: row.code ? String(row.code) : '',
    description: row.description ? String(row.description) : '',
    total_quantity: row.totalQuantity !== undefined && row.totalQuantity !== null ? String(row.totalQuantity) : '',
    priority: row.priority ? String(row.priority) : '',
    required_certification: row.requiredCertification === true ? 'Y' : row.requiredCertification === false ? 'N' : '',
    required_shelf_life: row.requiredShelfLife === true ? 'Y' : row.requiredShelfLife === false ? 'N' : '',
  };
}

function dedupeCatalogRowsById(rows) {
  const seen = new Map();
  const dedupedRows = [];
  const duplicateGroups = new Map();

  for (const row of rows || []) {
    const id = row && row.id !== undefined && row.id !== null ? String(row.id) : '';

    if (!id) {
      dedupedRows.push(row);
      continue;
    }

    if (!seen.has(id)) {
      seen.set(id, row);
      dedupedRows.push(row);
      continue;
    }

    const existing = seen.get(id);
    if (!duplicateGroups.has(id)) {
      duplicateGroups.set(id, [existing]);
    }
    duplicateGroups.get(id).push(row);
  }

  return {
    dedupedRows,
    duplicateGroups: Array.from(duplicateGroups.entries()).map(([id, group]) => ({
      id,
      count: group.length,
      rows: group.map(summarizeCatalogRow)
    }))
  };
}

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => runWorker()
  );

  await Promise.all(workers);
  return results;
}

async function readPageText(page) {
  return page.evaluate(() => document.body?.innerText || '');
}

async function waitForPortalReady(page, headedMode) {
  await page.goto(FLASHBUY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  let firstText = await readPageText(page);
  if (!isLoginScreenText(firstText) && looksLikeFlashBuyPage(firstText)) return;

  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    const body = text.toLowerCase();
    return (
      body.includes('flash buy') ||
      body.includes('login with pttep') ||
      body.includes('login with non-pttep') ||
      body.includes('welcome to scm marketplace')
    );
  }, { timeout: 20000 }).catch(() => {});

  firstText = await readPageText(page);
  if (!isLoginScreenText(firstText) && looksLikeFlashBuyPage(firstText)) return;

  if (!headedMode) {
    throw new Error(
      'PTTEP session expired. Re-run with a headed login so the profile can be refreshed.'
    );
  }

  console.log('');
  console.log('ACTION REQUIRED');
  console.log('1. Login in the opened PTTEP browser window.');
  console.log('2. Land on the Flash Buy catalog page.');
  console.log('3. The scraper will continue automatically once Flash Buy is visible.');
  console.log('');

  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    const body = text.toLowerCase();
    const isLogin =
      body.includes('login with pttep') ||
      body.includes('login with non-pttep') ||
      body.includes('welcome to scm marketplace');
    return !isLogin && body.includes('flash buy');
  }, { timeout: 300000 });

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

function captureApiHeadersFromRequest(request, state) {
  const url = request.url();
  if (!url.startsWith(API_BASE)) return;

  const headers = request.headers();
  const auth = headers.authorization || headers.Authorization;
  const apiKey = headers['x-apikey'] || headers['X-ApiKey'];
  const serviceName = headers['x-service-name'] || headers['X-Service-Name'];

  if (!auth && !apiKey && !serviceName) return;

  state.authorization = state.authorization || auth || '';
  state.apiKey = state.apiKey || apiKey || '';
  state.serviceName = state.serviceName || serviceName || '';
  state.userAgent = state.userAgent || headers['user-agent'] || '';
}

async function extractTokenFromStorage(page) {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage);

    const readToken = tokenKey => {
      if (!tokenKey) return '';
      try {
        const raw = localStorage.getItem(tokenKey);
        const parsed = JSON.parse(raw);
        return parsed.secret || parsed.access_token || parsed.id_token || raw || '';
      } catch (_) {
        return localStorage.getItem(tokenKey) || '';
      }
    };

    const accessTokenKey = keys.find(key => key.includes('-accesstoken-'));
    const idTokenKey = keys.find(key => key.includes('-idtoken-'));

    return {
      accessTokenKey,
      idTokenKey,
      accessToken: readToken(accessTokenKey),
      idToken: readToken(idTokenKey)
    };
  });
}

async function resolveApiHeaders(page, capturedHeaders) {
  let headers = {
    accept: 'application/json, text/plain, */*',
    authorization: capturedHeaders.authorization || '',
    'x-apikey': capturedHeaders.apiKey || '',
    'x-service-name': capturedHeaders.serviceName || 'scm-marketplace'
  };

  if (!headers.authorization) {
    const tokenInfo = await extractTokenFromStorage(page);
    headers.authorization = tokenInfo.accessToken || tokenInfo.idToken || '';
  }

  if (!headers.authorization) {
    throw new Error('Could not resolve PTTEP authorization token from the browser session.');
  }

  if (capturedHeaders.userAgent) {
    headers['user-agent'] = capturedHeaders.userAgent;
  }

  return headers;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} for ${url}\n${errorText.slice(0, 400)}`);
  }
  return response.json();
}

async function fetchCatalogPage(pageNumber, headers) {
  const url = `https://endpoint.api.pttep.com/scm-marketplace/v1/vendor/products/flash-buys?market_type=GENERAL&page=${pageNumber}&limit=12`;
  return fetchJson(url, headers);
}

async function fetchProductDetail(productId, headers) {
  const url = `${API_BASE}/vendor/products/${productId}`;
  return fetchJson(url, headers);
}

async function fetchPurchaseRequests(productCode, headers) {
  const url = `${API_BASE}/vendor/products/purchase-requests?product_code=${encodeURIComponent(productCode)}`;
  return fetchJson(url, headers);
}

function buildItemPayload(row, detail, prPayload) {
  const prLines = dedupePrLines(
    (prPayload.items || []).map(item => ({
      pr_no: item.number ? String(item.number) : '',
      pr_item_no: item.itemNumber !== undefined && item.itemNumber !== null ? String(item.itemNumber) : '',
      plant: item.plantNumber ? String(item.plantNumber) : '',
      quantity: item.quantity !== undefined && item.quantity !== null ? String(item.quantity) : '',
      delivery_time: formatDeliveryTime(item.daysUntilDeliveryDate, item.deliveryDate),
      delivery_date: item.deliveryDate || ''
    }))
  );

  const totalQuantity =
    prPayload.totalQuantity !== undefined && prPayload.totalQuantity !== null
      ? prPayload.totalQuantity
      : (row.totalQuantity !== undefined && row.totalQuantity !== null
        ? row.totalQuantity
        : prLines.reduce((sum, line) => sum + Number(line.quantity || 0), 0));

  return {
    id: row.id,
    material_no: detail.code || row.code || '',
    material_desc: detail.description || row.description || '',
    part_no: detail.partNo || extractPartNumber(detail.description || row.description || ''),
    manufacturer: detail.manufacturerName || '',
    uom: detail.uom || '',
    category: row.category || '',
    cert_required: detail.requiredCertification || row.requiredCertification ? 'Y' : 'N',
    shelf_life_required: detail.requiredShelfLife || row.requiredShelfLife ? 'Y' : 'N',
    total_quantity: String(totalQuantity),
    long_description: detail.detail || detail.description || row.description || '',
    priority: row.priority || '',
    source_url: `${FLASHBUY_URL}/${row.id}`,
    prLines
  };
}

async function runScraper(options = {}) {
  const forceLogin = options.forceLogin === true;
  const itemLimit = Number.isFinite(options.itemLimit) ? options.itemLimit : Infinity;
  const hasSavedProfile = fs.existsSync(PROFILE_PATH);
  const headedMode = forceLogin || !hasSavedProfile;

  console.log('============================================================');
  console.log('APSS Integration Hub - PTTEP FlashBuy Portal Scraper');
  console.log('============================================================');
  console.log(`Browser mode: ${headedMode ? 'headed' : 'headless'}`);
  console.log(`Item limit: ${Number.isFinite(itemLimit) ? itemLimit : 'full catalog'}`);
  console.log('');

  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: !headedMode,
    slowMo: headedMode ? 30 : 0,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true
  });

  context.setDefaultTimeout(60000);

  const requestHeaders = {
    authorization: '',
    apiKey: '',
    serviceName: '',
    userAgent: ''
  };

  context.on('request', request => captureApiHeadersFromRequest(request, requestHeaders));

  const page = await context.newPage();

  try {
    console.log(`Opening portal: ${FLASHBUY_URL}`);
    await waitForPortalReady(page, headedMode);

    if (!requestHeaders.authorization || !requestHeaders.apiKey) {
      await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await sleep(2000);
    }

    const apiHeaders = await resolveApiHeaders(page, requestHeaders);
    console.log('API session captured successfully.');
    console.log(`Using API key: ${apiHeaders['x-apikey'].slice(0, 12)}...`);
    console.log('');

    console.log('Fetching FlashBuy catalog pages...');
    const firstPage = await fetchCatalogPage(1, apiHeaders);
    const totalRows = Number(firstPage.totalRows || 0);
    const totalPages = Number(firstPage.totalPages || 1);
    const allRows = Array.isArray(firstPage.rows) ? [...firstPage.rows] : [];

    const effectiveTotalPages = Number.isFinite(itemLimit)
      ? Math.min(totalPages, Math.ceil(itemLimit / PAGE_SIZE))
      : totalPages;

    console.log(`Catalog reports ${totalRows} items across ${totalPages} pages at ${PAGE_SIZE} per page.`);

    for (let pageNumber = 2; pageNumber <= effectiveTotalPages; pageNumber++) {
      const payload = await fetchCatalogPage(pageNumber, apiHeaders);
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      allRows.push(...rows);
      console.log(`  Page ${pageNumber}/${effectiveTotalPages}: +${rows.length} items (running total ${allRows.length})`);
    }

    const { dedupedRows, duplicateGroups } = dedupeCatalogRowsById(allRows);
    const targetRows = Number.isFinite(itemLimit) ? dedupedRows.slice(0, itemLimit) : dedupedRows;

    console.log('');
    console.log(`Catalog rows fetched from API: ${allRows.length}`);
    console.log(`Catalog rows after dedupe by portal item id: ${dedupedRows.length}`);
    console.log(`Duplicate rows removed: ${allRows.length - dedupedRows.length}`);
    if (duplicateGroups.length > 0) {
      console.log('');
      console.log('Duplicate catalog rows detected (deduped by portal item id):');
      for (const group of duplicateGroups) {
        console.log(`  Portal item id ${group.id}: ${group.count} row(s)`);
        group.rows.forEach((row, index) => {
          console.log(
            `    [${index + 1}] code=${row.code || '-'} | description=${(row.description || '-').substring(0, 80)} | total_qty=${row.total_quantity || '-'}`
          );
        });
      }
    }
    console.log(`Rows selected for detail expansion: ${targetRows.length}`);
    console.log('');

    let completed = 0;
    const scrapedItems = await mapLimit(targetRows, ITEM_CONCURRENCY, async row => {
      try {
        const [detail, purchaseRequests] = await Promise.all([
          fetchProductDetail(row.id, apiHeaders),
          fetchPurchaseRequests(row.code, apiHeaders)
        ]);

        completed += 1;
        if (completed === 1 || completed % 10 === 0 || completed === targetRows.length) {
          console.log(`  Expanded ${completed}/${targetRows.length}: ${row.code} (${row.description})`);
        }

        return buildItemPayload(row, detail, purchaseRequests);
      } catch (error) {
        completed += 1;
        console.warn(`  Failed ${completed}/${targetRows.length} for ${row.code || row.id}: ${error.message.split('\n')[0]}`);
        return buildItemPayload(row, row, { items: [], totalQuantity: row.totalQuantity || 0 });
      }
    });

    await context.storageState({ path: SESSION_PATH });

    const output = {
      scraped_at: new Date().toISOString(),
      source: 'PTTEP FlashBuy Portal',
      url: FLASHBUY_URL,
      total_items: scrapedItems.length,
      total_catalog_rows: totalRows,
      raw_catalog_rows_fetched: allRows.length,
      deduped_catalog_rows: dedupedRows.length,
      duplicate_catalog_rows_removed: allRows.length - dedupedRows.length,
      duplicate_catalog_row_groups: duplicateGroups,
      page_size: PAGE_SIZE,
      items: scrapedItems
    };

    fs.readdirSync(OUTPUT_DIR)
      .filter(file => file.startsWith('pttep_catalog_') && file.endsWith('.json'))
      .forEach(file => {
        try {
          fs.unlinkSync(path.join(OUTPUT_DIR, file));
        } catch (_) {
          // Ignore cleanup errors.
        }
      });

    const outputPath = path.join(OUTPUT_DIR, `pttep_catalog_${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    if (duplicateGroups.length > 0) {
      const duplicatePath = path.join(OUTPUT_DIR, `pttep_catalog_duplicates_${Date.now()}.json`);
      fs.writeFileSync(duplicatePath, JSON.stringify({
        scraped_at: output.scraped_at,
        source: output.source,
        raw_catalog_rows_fetched: allRows.length,
        deduped_catalog_rows: dedupedRows.length,
        duplicate_catalog_rows_removed: allRows.length - dedupedRows.length,
        duplicate_catalog_row_groups: duplicateGroups
      }, null, 2));
      console.log(`Duplicate debug file: ${path.basename(duplicatePath)}`);
    }

    const prCount = new Set(
      scrapedItems.flatMap(item => item.prLines.map(line => line.pr_no)).filter(Boolean)
    ).size;

    console.log('');
    console.log('------------------------------------------------------------');
    console.log('PTTEP scrape complete');
    console.log(`Items saved: ${scrapedItems.length}`);
    console.log(`Unique PR groups: ${prCount}`);
    console.log(`Output file: ${path.basename(outputPath)}`);
    console.log('------------------------------------------------------------');
    console.log('');

    return output;
  } catch (error) {
    console.error('');
    console.error(`PTTEP scraper failed: ${error.message}`);
    throw error;
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf('--limit');
  const parsedLimit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;

  runScraper({
    forceLogin: args.includes('--login'),
    itemLimit: Number.isFinite(parsedLimit) ? parsedLimit : Infinity
  }).catch(error => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { runScraper };




