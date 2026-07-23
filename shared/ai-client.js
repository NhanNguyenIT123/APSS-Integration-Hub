/**
 * APSS Integration Hub — Unified AI Client
 * 
 * Auto-switches between Azure OpenAI, OpenRouter, and Local Ollama (Qwen2.5)
 * depending on config.json settings.
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Try loading local Ollama client (if available)
let ollamaClient = null;
try {
  ollamaClient = require('./ollama-client');
} catch (e) {
  console.warn('⚠️  Could not load local ollama-client.js');
}

// Load configurations
let aiConfig = { provider: 'ollama', config: null };

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    aiConfig.provider = config.ai_provider || 'ollama';
    aiConfig.aiEndpointUrl = config.aiEndpointUrl || '';
    
    if (aiConfig.provider === 'azure' && config.azure) {
      aiConfig.config = config.azure;
    } else if (aiConfig.provider === 'openrouter' && config.openrouter) {
      aiConfig.config = config.openrouter;
    } 
  } catch (err) {
    console.error('⚠️  Failed to parse config.json for AI credentials:', err.message);
  }
}

// Support Environment Variables for easy Docker/VPS/Azure deployment without exposing keys in config.json
if (process.env.AI_PROVIDER) {
  aiConfig.provider = process.env.AI_PROVIDER;
}
if (process.env.OLLAMA_ENDPOINT_URL) {
  aiConfig.aiEndpointUrl = process.env.OLLAMA_ENDPOINT_URL;
}

if (aiConfig.provider === 'azure') {
  if (!aiConfig.config) aiConfig.config = {};
  if (process.env.AZURE_OPENAI_ENDPOINT) aiConfig.config.endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (process.env.AZURE_OPENAI_API_KEY) aiConfig.config.apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (process.env.AZURE_OPENAI_DEPLOYMENT) aiConfig.config.deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT;
} else if (aiConfig.provider === 'openrouter') {
  if (!aiConfig.config) aiConfig.config = {};
  if (process.env.OPENROUTER_API_KEY) aiConfig.config.apiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_MODEL) aiConfig.config.model = process.env.OPENROUTER_MODEL;
}

/**
 * Check active AI capability mode
 */
async function checkAICapability() {
  if (aiConfig.provider === 'azure' && aiConfig.config) {
    return { running: true, mode: 'AZURE', detail: `Azure OpenAI (${aiConfig.config.deploymentName})` };
  }
  
  if (aiConfig.provider === 'openrouter' && aiConfig.config) {
    return { running: true, mode: 'OPENROUTER', detail: `OpenRouter (${aiConfig.config.model})` };
  }

  if (aiConfig.provider === 'fable' && aiConfig.config) {
    return { running: true, mode: 'FABLE', detail: `Fable AI (${aiConfig.config.model || 'fable-5'})` };
  }

  if (ollamaClient) {
    const ollamaStatus = await ollamaClient.checkOllama();
    if (ollamaStatus.running) {
      return { running: true, mode: 'OLLAMA', detail: `Local Ollama (${ollamaClient.DEFAULT_MODEL})` };
    }
  }

  return { running: false, mode: 'REGEX', detail: 'Regex Fallback (No AI connection active)' };
}

/**
 * Core Text Generation - Routes to active provider
 * Returns object: { text, prompt_tokens, completion_tokens }
 */
async function aiGenerateText(prompt, systemMessage = "You are a helpful assistant.", temperature = 0.1) {
  const provider = aiConfig.provider;
  
  // AZURE OPENAI ROUTE
  if (provider === 'azure' && aiConfig.config) {
    const openai = new OpenAI({
      apiKey: aiConfig.config.apiKey,
      baseURL: `${aiConfig.config.endpoint.replace(/\/+$/, '')}/openai/deployments/${aiConfig.config.deploymentName}`,
      defaultQuery: { 'api-version': '2024-02-15-preview' },
      defaultHeaders: { 'api-key': aiConfig.config.apiKey }
    });
    
    try {
      const response = await openai.chat.completions.create({
        model: aiConfig.config.deploymentName,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt }
        ],
        temperature: temperature,
        max_tokens: 8000
      });
      return {
        text: response.choices[0].message.content,
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0
      };
    } catch (err) {
      console.error(`  ⚠️  Azure OpenAI generation failed: ${err.message}`);
      throw err;
    }
  }
  
  // OPENROUTER ROUTE
  if (provider === 'openrouter' && aiConfig.config) {
    const openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: aiConfig.config.apiKey,
    });
    
    try {
      const response = await openai.chat.completions.create({
        model: aiConfig.config.model,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt }
        ],
        temperature: temperature,
        max_tokens: 8000
      });
      return {
        text: response.choices[0].message.content,
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0
      };
    } catch (err) {
      console.error(`  ⚠️  OpenRouter generation failed: ${err.message}`);
      throw err;
    }
  }

  // FABLE ROUTE
  if (provider === 'fable' && aiConfig.config) {
    const openai = new OpenAI({
      baseURL: aiConfig.config.endpoint || 'https://api.fable.ai/v1',
      apiKey: aiConfig.config.apiKey,
    });
    
    try {
      const response = await openai.chat.completions.create({
        model: aiConfig.config.model || 'fable-5',
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt }
        ],
        temperature: temperature,
        max_tokens: 8000
      });
      return {
        text: response.choices[0].message.content,
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0
      };
    } catch (err) {
      console.error(`  ⚠️  Fable AI generation failed: ${err.message}`);
      throw err;
    }
  }
  
  // OLLAMA ROUTE (Default / Fallback)
  if (ollamaClient) {
    try {
       const fetchFn = typeof fetch === 'function' ? fetch : (...args) => import('node-fetch').then(({default: f}) => f(...args));
       const customUrl = aiConfig.aiEndpointUrl;
       const aiUrl = customUrl ? `${customUrl}/api/generate` : 'http://127.0.0.1:11434/api/generate';
       
       const responseOllama = await fetchFn(aiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaClient.DEFAULT_MODEL,
            prompt: `System: ${systemMessage}\n\nUser: ${prompt}`,
            stream: false,
            options: { temperature: temperature, num_predict: 8000 }
          })
       });
       
       if (!responseOllama.ok) throw new Error(`HTTP error! status: ${responseOllama.status}`);
       const resJson = await responseOllama.json();
       
       return {
         text: resJson.response,
         prompt_tokens: resJson.prompt_eval_count || 0,
         completion_tokens: resJson.eval_count || 0
       };
    } catch (err) {
      console.error(`  ⚠️  Ollama generation failed: ${err.message}`);
      throw err;
    }
  }
  
  throw new Error('No AI provider configured or available.');
}

/**
 * Backward compatibility logic for PTTEP
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
  "item_type": "<main category>",
  "sub_type": "<specific type>",
  "part_number": "<extracted part number>",
  "manufacturer": "<manufacturer name>",
  "model": "<model number>",
  "size": "<size/dimension>",
  "material": "<material specification>",
  "pressure_rating": "<pressure/class rating>",
  "short_description": "<clean 1-line description, max 50 chars>",
  "keywords": ["<keyword1>", "<keyword2>"]
}`;

  try {
    const response = await aiGenerateText(prompt);
    const jsonMatch = response.text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (err) {
     console.error(`  ⚠️  AI Parse failed: ${err.message}`);
  }
  return null;
}

async function aiMatchItem(pttepItem, bcItems) {
  if (bcItems.length === 0) return null;
  const bcList = bcItems.map((item, i) => `${i + 1}. ${item.item_no} — ${item.description} ${item.description_2 || ''}`).join('\n');
  const prompt = `You are matching procurement items. Given a PTTEP portal item, find the best match from our BC database.
PTTEP ITEM:
- Description: ${pttepItem.material_description}
- Part Number: ${pttepItem.part_number || 'N/A'}
- Manufacturer: ${pttepItem.manufacturer || 'N/A'}
BC DATABASE ITEMS:
${bcList}
OUTPUT (JSON only):
{ "best_match_index": <1-based index or 0>, "confidence": <0.0 to 1.0>, "reason": "<brief explanation>" }`;

  try {
    const response = await aiGenerateText(prompt);
    const jsonMatch = response.text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (err) {
     console.error(`  ⚠️  AI Match failed: ${err.message}`);
  }
  return null;
}

/**
 * Classify whether document text extracted from an attachment is a commercial RFQ item list to be quoted,
 * or a technical specification document / catalogue / drawing / manual.
 */
async function classifyAttachmentContent(docText, docName = '') {
  if (!docText || docText.trim().length < 30) return { isItemList: false, type: 'EMPTY' };
  
  const lowerText = docText.toLowerCase();
  const lowerName = docName.toLowerCase();

  // Primary Check: Main RFQ / BOQ / Quotation documents are ALWAYS item lists!
  if (lowerName.includes('rfq') || lowerName.includes('boq') || lowerName.includes('quotation') || lowerName.includes('quote_form') || lowerName.includes('item_list') || lowerName.includes('material_list') || lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    return { isItemList: true, type: 'RFQ_DOCUMENT' };
  }

  // Fast Heuristic check for technical manuals / painting specs / drawings (0ms latency)
  const isTechDoc = lowerName.includes('catalogue') || lowerName.includes('catalog') || lowerName.includes('drawing') ||
                    lowerName.includes('painting') || lowerName.includes('manual') || lowerName.includes('instruction') ||
                    lowerName.includes('datasheet') || lowerName.includes('coating_system') ||
                    lowerText.includes('installation, operation and maintenance') || lowerText.includes('surface preparation') ||
                    lowerText.includes('minimum number of coats') || lowerText.includes('torque pattern') ||
                    lowerText.includes('general arrangement drawing');

  if (isTechDoc) {
    return { isItemList: false, type: 'TECHNICAL_REF' };
  }

  // Fast Heuristic check for structured Excel or tabular data
  if (lowerText.includes('--- sheet:') || (lowerText.includes('item') && lowerText.includes('qty') && (lowerText.includes('price') || lowerText.includes('uom')))) {
    return { isItemList: true, type: 'STRUCTURED_TABLE' };
  }

  // AI Classification for ambiguous documents
  const prompt = `Analyze the following text extracted from a procurement attachment (Filename/Title: "${docName}").

Text snippet:
"${docText.substring(0, 1200)}"

Is this document a COMMERCIAL ITEM LIST / QUOTATION SCHEDULE intended for suppliers to bid/quote prices on specific items?
Or is it a TECHNICAL SPECIFICATION, CATALOGUE, USER MANUAL, PAINTING GUIDE, or ENGINEERING DRAWING?

Reply in JSON format:
{
  "is_item_list": true or false,
  "reason": "<brief explanation>"
}`;

  try {
    const res = await aiGenerateText(prompt, "You are a procurement document classifier. Output JSON only.");
    const jsonMatch = res.text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { isItemList: !!parsed.is_item_list, type: parsed.is_item_list ? 'ITEM_LIST' : 'TECHNICAL_DOC' };
    }
  } catch (err) {
    console.warn('⚠️ AI document classification failed, using fallback:', err.message);
  }

  const hasItemStructure = lowerText.includes('qty') && (lowerText.includes('uom') || lowerText.includes('unit'));
  return { isItemList: hasItemStructure, type: hasItemStructure ? 'ITEM_LIST' : 'TECHNICAL_DOC' };
}

/**
 * Classify whether an HTML table on the web page contains actual commercial material items,
 * or is just a generic summary / terms placeholder (e.g. "General article", "Incoterms DDP").
 */
function isRealMaterialItemTable(items) {
  if (!items || items.length === 0) return false;
  
  const genericWords = ['general article', 'incoterm', 'refer to attach', 'see attach', 'as per attach', 'delivery term', 'payment term'];
  
  const hasOnlyGeneric = items.every(item => {
    const desc = (item.description || '').toLowerCase();
    return genericWords.some(gw => desc.includes(gw));
  });

  if (hasOnlyGeneric) return false;

  const materialKeywords = ['glass', 'valve', 'pump', 'pipe', 'gasket', 'bearing', 'flange', 'belt', 'regulator', 'bolt', 'nut', 'o-ring', 'seal', 'filter', 'cable', 'motor', 'gauge', 'sensor', 'fitting', 'spare', 'hose', 'coupling', 'elbow', 'tee', 'transformer', 'switch', 'breaker'];
  
  for (const item of items) {
    const desc = (item.description || '').toLowerCase();
    const pn = (item.part_number || '').toLowerCase();
    if (pn.length >= 3 && pn !== 'n/a') return true;
    if (materialKeywords.some(kw => desc.includes(kw))) return true;
  }

  return true;
}

module.exports = {
  aiParseItem,
  aiMatchItem,
  checkAICapability,
  aiGenerateText,
  classifyAttachmentContent,
  isRealMaterialItemTable
};

