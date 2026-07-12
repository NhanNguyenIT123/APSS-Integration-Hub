/**
 * Ollama AI Client — Self-hosted LLM for item description parsing
 * 
 * Connects to local Ollama instance running Qwen2.5:7B
 * All data stays on your machine — ZERO data sent externally
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let appConfig = {};
try {
  appConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  console.warn("Could not load config.json:", e.message);
}

const OLLAMA_BASE_URL = appConfig.aiEndpointUrl || 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:7b-instruct';

/**
 * Call Ollama API
 */
function ollamaGenerate(model, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const { format, ...restOptions } = options;
    const payload = JSON.stringify({
      model: model || DEFAULT_MODEL,
      prompt,
      stream: false,
      format: format,
      options: {
        temperature: 0.1,      // Low temperature for consistent structured output
        num_predict: 1024,     // Max tokens
        ...restOptions,
      },
    });

    const url = new URL(`${OLLAMA_BASE_URL}/api/generate`);
    
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 120000, // 2 min timeout per request
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.response || '');
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Ollama connection failed: ${err.message}. Is Ollama running? Try: ollama serve`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama request timed out (120s)'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Parse a PTTEP item description using AI
 * Extracts structured data that regex might miss
 */
async function aiParseItem(materialDescription, longDescription, partNumber, manufacturer) {
  const prompt = `You are a procurement data parser for an oil & gas supply company. Extract structured information from this item.

INPUT:
Material Description: ${materialDescription}
Long Description: ${longDescription || 'N/A'}
Part Number: ${partNumber || 'N/A'}
Manufacturer: ${manufacturer || 'N/A'}

OUTPUT (JSON only, no other text):
{
  "item_type": "<main category e.g. VALVE, BEARING, MODULE, FILTER, CABLE>",
  "sub_type": "<specific type e.g. BALL, ROLLER, I/O, HYDRAULIC>",
  "part_number": "<extracted part number>",
  "manufacturer": "<manufacturer name>",
  "model": "<model number if any>",
  "size": "<size/dimension if any>",
  "material": "<material specification if any>",
  "pressure_rating": "<pressure/class rating if any>",
  "short_description": "<clean 1-line description for BC Item Card, max 50 chars>",
  "keywords": ["<keyword1>", "<keyword2>", "<keyword3>"]
}`;

  try {
    const response = await ollamaGenerate(DEFAULT_MODEL, prompt);
    
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return null;
  } catch (err) {
    console.error(`  ⚠️  AI parse failed: ${err.message}`);
    return null;
  }
}

/**
 * Use AI to compare a PTTEP item against BC items for better matching
 */
async function aiMatchItem(pttepItem, bcItems) {
  if (bcItems.length === 0) return null;
  
  const bcList = bcItems.map((item, i) => 
    `${i + 1}. ${item.item_no} — ${item.description} ${item.description_2 || ''}`
  ).join('\n');

  const prompt = `You are matching procurement items. Given a PTTEP portal item, find the best match from our BC database.

PTTEP ITEM:
- Description: ${pttepItem.material_description}
- Part Number: ${pttepItem.part_number || 'N/A'}
- Manufacturer: ${pttepItem.manufacturer || 'N/A'}

BC DATABASE ITEMS:
${bcList}

OUTPUT (JSON only, no other text):
{
  "best_match_index": <1-based index of best match, or 0 if no match>,
  "confidence": <0.0 to 1.0>,
  "reason": "<brief explanation>"
}`;

  try {
    const response = await ollamaGenerate(DEFAULT_MODEL, prompt);
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.error(`  ⚠️  AI match failed: ${err.message}`);
    return null;
  }
}

/**
 * Check if Ollama is running
 */
async function checkOllama() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_BASE_URL}/api/tags`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const models = json.models || [];
          resolve({
            running: true,
            models: models.map(m => m.name),
          });
        } catch {
          resolve({ running: true, models: [] });
        }
      });
    });
    req.on('error', () => resolve({ running: false, models: [] }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ running: false, models: [] }); });
  });
}

module.exports = { ollamaGenerate, aiParseItem, aiMatchItem, checkOllama, DEFAULT_MODEL };
