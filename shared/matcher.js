/**
 * Item Matcher — Fuzzy matching PTTEP items against BC Item Cards
 * 
 * Matching strategy (in priority order):
 * 1. Exact Part Number match (highest confidence)
 * 2. Manufacturer + Part Number match
 * 3. Keyword similarity match (fuzzy)
 */

/**
 * Calculate similarity between two strings (Dice coefficient)
 * Returns 0.0 to 1.0
 */
function stringSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const s1 = str1.toUpperCase().trim();
  const s2 = str2.toUpperCase().trim();
  
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0;
  
  // Create bigrams
  const bigrams1 = new Set();
  for (let i = 0; i < s1.length - 1; i++) {
    bigrams1.add(s1.substring(i, i + 2));
  }
  
  const bigrams2 = new Set();
  for (let i = 0; i < s2.length - 1; i++) {
    bigrams2.add(s2.substring(i, i + 2));
  }
  
  // Count common bigrams
  let common = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) common++;
  }
  
  return (2.0 * common) / (bigrams1.size + bigrams2.size);
}

/**
 * Calculate keyword overlap between parsed item and BC item
 */
function keywordOverlap(parsedKeywords, bcDescription) {
  if (!parsedKeywords.length || !bcDescription) return 0;
  
  const bcWords = bcDescription
    .toUpperCase()
    .replace(/[,;:()]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
  
  const bcWordSet = new Set(bcWords);
  
  let matches = 0;
  for (const keyword of parsedKeywords) {
    if (bcWordSet.has(keyword)) {
      matches++;
    }
  }
  
  return parsedKeywords.length > 0 ? matches / parsedKeywords.length : 0;
}

/**
 * Match a parsed PTTEP item against BC existing items
 * Returns array of matches sorted by confidence (best first)
 */
function matchItem(parsedItem, bcItems) {
  const results = [];
  
  for (const bcItem of bcItems) {
    let confidence = 0;
    let matchReason = [];
    
    // Strategy 1: Exact Part Number match via item_references
    if (parsedItem.part_number) {
      for (const ref of (bcItem.item_references || [])) {
        if (ref.reference_no.toUpperCase() === parsedItem.part_number.toUpperCase()) {
          confidence = Math.max(confidence, 0.95);
          matchReason.push(`Part number exact match: ${parsedItem.part_number}`);
        }
      }
    }
    
    // Strategy 2: Manufacturer match in description_2
    if (parsedItem.manufacturer && bcItem.description_2) {
      const mfrSim = stringSimilarity(parsedItem.manufacturer, bcItem.description_2);
      if (mfrSim > 0.5) {
        const mfrScore = 0.3 + (mfrSim * 0.3); // 0.3 - 0.6 range
        confidence = Math.max(confidence, mfrScore);
        matchReason.push(`Manufacturer match: ${parsedItem.manufacturer} ↔ ${bcItem.description_2} (${(mfrSim * 100).toFixed(0)}%)`);
      }
    }
    
    // Strategy 3: Description keyword similarity
    const fullBcDesc = `${bcItem.description} ${bcItem.description_2 || ''}`;
    const descSim = stringSimilarity(parsedItem.raw_description, fullBcDesc);
    if (descSim > 0.2) {
      confidence = Math.max(confidence, descSim * 0.8);
      matchReason.push(`Description similarity: ${(descSim * 100).toFixed(0)}%`);
    }
    
    // Strategy 4: Keyword overlap
    const kwOverlap = keywordOverlap(parsedItem.keywords, fullBcDesc);
    if (kwOverlap > 0.1) {
      const kwScore = kwOverlap * 0.7;
      confidence = Math.max(confidence, kwScore);
      matchReason.push(`Keyword overlap: ${(kwOverlap * 100).toFixed(0)}%`);
    }
    
    // Strategy 5: Item type match bonus
    if (parsedItem.item_type && bcItem.description) {
      const typeInDesc = bcItem.description.toUpperCase().includes(parsedItem.item_type.toUpperCase());
      if (typeInDesc) {
        confidence += 0.1; // Bonus for matching item type
        matchReason.push(`Item type "${parsedItem.item_type}" found in BC description`);
      }
    }
    
    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);
    
    if (confidence > 0.15) { // Only include if above minimum threshold
      results.push({
        bc_item_no: bcItem.item_no,
        bc_description: bcItem.description,
        bc_description_2: bcItem.description_2 || '',
        confidence: parseFloat(confidence.toFixed(3)),
        match_reasons: matchReason,
      });
    }
  }
  
  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);
  
  return results;
}

/**
 * Determine match status
 */
function getMatchStatus(matches) {
  if (matches.length === 0) {
    return { status: 'NO_MATCH', action: 'CREATE_BLANK_ITEM', best_match: null };
  }
  
  const best = matches[0];
  
  if (best.confidence >= 0.85) {
    return { status: 'HIGH_CONFIDENCE', action: 'AUTO_LINK', best_match: best };
  } else if (best.confidence >= 0.50) {
    return { status: 'MEDIUM_CONFIDENCE', action: 'REVIEW_REQUIRED', best_match: best };
  } else {
    return { status: 'LOW_CONFIDENCE', action: 'CREATE_BLANK_ITEM', best_match: best };
  }
}

module.exports = { matchItem, getMatchStatus, stringSimilarity };
