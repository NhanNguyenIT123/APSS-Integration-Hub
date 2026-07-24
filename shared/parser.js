/**
 * PTTEP Portal Item Description Parser
 * 
 * Extracts structured data from raw item descriptions like:
 * "VALVE: BALL, 2 INCH, 150LB, RF, FULL PORT, P/N: BV-200-150, MFGR: CAMERON"
 * 
 * Into:
 * {
 *   item_type: "VALVE",
 *   sub_type: "BALL",
 *   part_number: "BV-200-150",
 *   manufacturer: "CAMERON",
 *   size: "2 INCH",
 *   specs: ["150LB", "RF", "FULL PORT", "CF8M BODY", "316SS TRIM"]
 * }
 */

// Common patterns in oil & gas item descriptions
const PART_NUMBER_PATTERNS = [
  /VENDOR\s*MODEL[:\s]+([A-Z0-9\s\-\/\.]+?)(?=\n|\r|$|,|SIGHT|GLASS|BODY|COVER|STUD|TAG|MFR|VENDOR)/i,
  /MODEL\s*(?:NO|NUMBER|#)?[:\s]+([A-Z0-9\s\-\/\.]+?)(?=\n|\r|$|,|SIGHT|GLASS|BODY|COVER|STUD|TAG|MFR|VENDOR)/i,
  /P\/N[:\s]+([A-Z0-9\-\/\.]+?)(?=(?:MFR(?:[:#]|\s)|MFG(?:[:#]|\s)|BRAND(?:[:#]|\s)|QTY|,|\n|$))/i,
  /PART\s*(?:NO|NUMBER|#)[:\s]+([A-Z0-9\-\/\.]+?)(?=(?:MFR(?:[:#]|\s)|MFG(?:[:#]|\s)|BRAND(?:[:#]|\s)|QTY|,|\n|$))/i,
  /MFR(?:[:#]|\s)+([A-Z0-9\-\/\.\s]*\d+[A-Z0-9\-\/\.\s]*?)(?=(?:MFR(?:[:#]|\s)|MFG(?:[:#]|\s)|MODEL|PART|P\/N|QTY|[, \n]|$))/i,
];

const MANUFACTURER_PATTERNS = [
  /MFR(?:[:#]|\s)+([A-Z0-9\s\/&]+?)(?=\n|\r|$|,|VENDOR|MODEL|P\/N|TAG|GLASS|BODY|COVER)/i,
  /MFGR(?:[:#]|\s)+([A-Z0-9\s\/&]+?)(?=\n|\r|$|,|MFR|MFG|MODEL|P\/N|PART\s*NO|QTY|\n|$)/i,
  /MFG(?:[:#]|\s)+([A-Z0-9\s\/&]+?)(?=\n|\r|$|,|MFR|MFG|MODEL|P\/N|PART\s*NO|QTY|\n|$)/i,
  /MANUFACTURER(?:[:#]|\s)+([A-Z0-9\s\/&]+?)(?=\n|\r|$|,|MFR|MFG|MODEL|P\/N|PART\s*NO|QTY|\n|$)/i,
  /BRAND\s*(?:NAME)?\s*[:#]\s*([A-Z0-9\-\/\.\s&]+?)(?=(?:MODEL|P\/N|PART|MFR|MFG|QTY|,|\n|$))/i,
  /VENDOR\s*:\s*([A-Z0-9\s\/&]+?)(?=\n|\r|$|,|MODEL|P\/N|TAG|GLASS|BODY|COVER)/i
];

const SIZE_PATTERNS = [
  /(\d+(?:\.\d+)?\s*(?:INCH|"|IN))/i,
  /(\d+(?:\.\d+)?\s*MM)/i,
  /BORE[:\s]*(\d+(?:\.\d+)?\s*MM)/i,
  /OD[:\s]*(\d+(?:\.\d+)?\s*MM)/i,
];

const PRESSURE_PATTERNS = [
  /(\d+\s*(?:LB|PSI|BAR|KPA))/i,
  /(\d+\s*(?:CLASS|CL))/i,
];

/**
 * Parse a raw item description into structured fields
 */
function parseItemDescription(rawDescription) {
  const desc = rawDescription.trim();
  
  // Extract item type (first word before colon)
  const typeMatch = desc.match(/^([A-Z\s]+?)[:]/i);
  const itemType = typeMatch ? typeMatch[1].trim() : null;
  
  // Extract sub-type (word after colon, before first comma)
  const subTypeMatch = desc.match(/^[A-Z\s]+?:\s*([A-Z\s]+?)(?:,|$)/i);
  const subType = subTypeMatch ? subTypeMatch[1].trim() : null;
  
  // Extract part number
  let partNumber = null;
  for (const pattern of PART_NUMBER_PATTERNS) {
    const match = desc.match(pattern);
    if (match) {
      partNumber = match[1].trim();
      break;
    }
  }
  
  // Extract manufacturer
  let manufacturer = null;
  for (const pattern of MANUFACTURER_PATTERNS) {
    const match = desc.match(pattern);
    if (match) {
      manufacturer = match[1].trim();
      break;
    }
  }
  
  // Extract sizes
  const sizes = [];
  for (const pattern of SIZE_PATTERNS) {
    const matches = desc.matchAll(new RegExp(pattern.source, 'gi'));
    for (const match of matches) {
      sizes.push(match[1].trim());
    }
  }
  
  // Extract pressure/rating
  let pressureRating = null;
  for (const pattern of PRESSURE_PATTERNS) {
    const match = desc.match(pattern);
    if (match) {
      pressureRating = match[1].trim();
      break;
    }
  }
  
  // Extract standards (ASME, API, etc.)
  const standardMatch = desc.match(/((?:ASME|API|ASTM|ISO|DIN)\s*[A-Z0-9\.\-]+)/gi);
  const standards = standardMatch || [];
  
  // Extract material specs
  const materialPatterns = /\b(A105|A182|A216|A352|CF8M|CF8|CF3M|316SS|304SS|CS|SS316|SS304|CARBON STEEL|STAINLESS STEEL)\b/gi;
  const materialMatches = desc.matchAll(materialPatterns);
  const materials = [...materialMatches].map(m => m[1].toUpperCase());
  
  // Build keywords for matching (remove common words, keep meaningful terms)
  const stopWords = new Set([
    'THE', 'A', 'AN', 'AND', 'OR', 'FOR', 'WITH', 'IN', 'OF', 'TO',
    'P/N', 'MFGR', 'MFG', 'MODEL', 'TYPE', 'INCH', 'MM', 'LB', 'PSI',
    'PART', 'NO', 'NUMBER', 'INCLUDES', 'EACH', 'PER', 'SET'
  ]);
  
  const keywords = desc
    .replace(/[,;:()]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w.toUpperCase()) && !/^\d+$/.test(w))
    .map(w => w.toUpperCase());
  
  return {
    raw_description: desc,
    item_type: itemType,
    sub_type: subType,
    part_number: partNumber,
    manufacturer: manufacturer,
    sizes: [...new Set(sizes)],
    pressure_rating: pressureRating,
    standards: [...new Set(standards)],
    materials: [...new Set(materials)],
    keywords: [...new Set(keywords)],
  };
}

function parsePdfTableRegex(rawText) {
  const items = [];
  if (!rawText) return items;
  const lines = rawText.split(/\r?\n/);
  
  const startLineRegex = /^\s*(\d+)(?:\s+(.*))?$/;
  const endRegex1 = /(?:^|\s+)(\d+)\s+([A-Za-z]+)\s*$/; // e.g., "3 PAC" or "3 EA"
  const endRegex2 = /(?:^|\s+)([A-Za-z]+)\s+(\d+)\s*$/; // e.g., "PAC 3" or "EA 5"
  
  let currentItem = null;
  
  const validUomRegex = /^(?:EA|EACH|PCS|PCE|PIECE|PIECES|SET|SETS|ROL|ROLL|ROLLS|CAN|CANS|BOX|BOXES|LOT|BAG|BAGS|CTN|CARTON|DRUM|DRUMS|MTR|METER|METERS|FT|FEET|FOOT|KG|LTR|LITER|LITRE|UNIT|UNITS|PK|PACK|PACKET|PAIL|PL|TUBE|BOT|BT|BOTTLE|KIT|JOB|AU|ASSY|BARREL|CARBOY|CARD|CASE|CS|COIL|CRT|CYLINDER|DAY|HOUR|HUR|IBC|JERRYCAN|KM|KMT|LB|LGT|LGTH|M2|MONTH|MT|NOS|NUM|PAA|PAD|PAK|PALLET|PANEL|PINT|PKT|PLATE|POLE|PR|PRS|PAIR|PAIRS|QUART|REAM|RL|RMS|SACKS|SHEET|SQM|ST|SYSTEM|TANK|TIN|TONNE|TONS|TRAY|TRIP|USER|WARP|YARD|YD)$/i;

  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;
    
    // Check if line is a quantity & UOM line for the active item (e.g. "40 Ea for grating replacement activity" or "40 Can")
    const qtyUomLineMatch = trimmedLine.match(/^\s*(\d+)\s+([A-Za-z]+)(?:\s+(.*))?$/);
    if (currentItem && qtyUomLineMatch && validUomRegex.test(qtyUomLineMatch[2])) {
      currentItem.qty = qtyUomLineMatch[1];
      currentItem.uom = qtyUomLineMatch[2].toUpperCase();
      if (qtyUomLineMatch[3] && !qtyUomLineMatch[3].toLowerCase().includes('posco')) {
        currentItem.description += " (" + qtyUomLineMatch[3].trim() + ")";
      }
      items.push(currentItem);
      currentItem = null;
      return;
    }

    const startMatch = trimmedLine.match(startLineRegex);
    
    if (startMatch) {
      if (currentItem && currentItem.description) {
        items.push(currentItem);
      }
      
      const itemNo = startMatch[1];
      const rest = startMatch[2] ? startMatch[2].trim() : "";
      
      let endMatch = rest ? rest.match(endRegex1) : null;
      if (rest && !endMatch) endMatch = rest.match(endRegex2);
      
      let qty = "1";
      let uom = "EA";
      let matchedText = "";
      
      if (endMatch) {
        const candidateText = endMatch[0];
        const qtyOrUom = endMatch[1].trim();
        const uomOrQty = endMatch[2].trim();
        const candQty = isNaN(Number(qtyOrUom)) ? uomOrQty : qtyOrUom;
        const candUom = isNaN(Number(qtyOrUom)) ? qtyOrUom : uomOrQty;
        
        if (validUomRegex.test(candUom)) {
          qty = candQty;
          uom = candUom;
          matchedText = candidateText;
        } else {
          endMatch = null;
        }
      }

      if (endMatch) {
        const description = rest.substring(0, rest.lastIndexOf(matchedText)).trim();
        
        items.push({
          item_no: itemNo,
          description: description,
          uom: uom,
          qty: qty,
          part_number: "",
          manufacturer: ""
        });
        currentItem = null;
      } else {
        currentItem = {
          item_no: itemNo,
          description: rest,
          uom: "EA",
          qty: "1",
          part_number: "",
          manufacturer: ""
        };
      }
    } else {
      if (currentItem) {
        let endMatch = trimmedLine.match(endRegex1);
        if (!endMatch) endMatch = trimmedLine.match(endRegex2);
        
        let qty = "";
        let uom = "";
        let matchedText = "";
        
        if (endMatch) {
          const candidateText = endMatch[0];
          const qtyOrUom = endMatch[1].trim();
          const uomOrQty = endMatch[2].trim();
          const candQty = isNaN(Number(qtyOrUom)) ? uomOrQty : qtyOrUom;
          const candUom = isNaN(Number(qtyOrUom)) ? qtyOrUom : uomOrQty;
          
          if (validUomRegex.test(candUom)) {
            qty = candQty;
            uom = candUom;
            matchedText = candidateText;
          } else {
            endMatch = null;
          }
        }

        if (endMatch) {
          const extraDesc = trimmedLine.substring(0, trimmedLine.lastIndexOf(matchedText)).trim();
          
          currentItem.description = (currentItem.description + " " + extraDesc).trim();
          currentItem.qty = qty;
          currentItem.uom = uom;
          
          items.push(currentItem);
          currentItem = null;
        } else {
          currentItem.description = (currentItem.description + " " + trimmedLine).trim();
        }
      }
    }
  });
  
  if (currentItem && currentItem.description) {
    items.push(currentItem);
  }
  
  return items;
}

/**
 * Validate extracted data to detect Regex extraction failures.
 * Returns false if extraction is suspiciously bad (triggering Ollama fallback).
 */
function validateExtraction(parsedData) {
  const pn = (parsedData.part_number || '').trim().toUpperCase();
  const mfr = (parsedData.manufacturer || '').trim().toUpperCase();
  const raw = (parsedData.raw_description || '').toUpperCase();
  
  // 1. Blacklist check
  const blacklist = ['NUMBER', 'PART', 'MODEL', 'MFR', 'MFG', 'N/A'];
  if (pn && blacklist.includes(pn)) return false;
  if (mfr && blacklist.includes(mfr)) return false;
  
  // 2. Length check
  if (pn && (pn.length < 3 || pn.length > 30)) return false;
  
  // 3. Merged string check (Catch strings like ECV-01MMFR where MFR/BRAND got merged into the part number)
  if (pn && (pn.includes('MMFR') || pn.includes('MMFG') || pn.includes('MBRAND') || pn.endsWith('MFR') || pn.endsWith('MFG'))) {
    return false;
  }
  
  if (pn && !mfr && (raw.includes('MFR') || raw.includes('BRAND'))) {
    if (pn.includes('MFR') || pn.includes('MFG')) return false;
  }
  
  // 4. Format check (comma in part number)
  if (pn && pn.includes(',')) return false;
  
  return true;
}

module.exports = { parseItemDescription, parsePdfTableRegex, validateExtraction };
