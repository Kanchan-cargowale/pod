'use strict';

const {
  NUMERIC_TOKEN,
  WEIGHT_ANCHOR,
  WEIGHT_COLUMN_QUALIFIER,
  NON_DIGIT,
} = require('../constants/regex');
const { levenshtein } = require('../utils/levenshtein');

function normalizeHeaderText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[|1l]/g, 'i')
    .replace(/[^a-z]/g, '');
}

function normalizeQualifierText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function containsFuzzyWord(text, target, maxDistance = 1) {
  const normalized = normalizeHeaderText(text);
  if (!normalized) return false;
  if (normalized.includes(target)) return true;

  const minLength = Math.max(1, target.length - maxDistance);
  const maxLength = Math.min(normalized.length, target.length + maxDistance);
  for (let length = minLength; length <= maxLength; length += 1) {
    for (let start = 0; start <= normalized.length - length; start += 1) {
      if (levenshtein(normalized.slice(start, start + length), target) <= maxDistance) {
        return true;
      }
    }
  }
  return false;
}

function isWeightAnchorText(text) {
  const normalized = normalizeHeaderText(text);
  // "Freight Payment" is common immediately above the real weight table and
  // differs from "weight" by only one leading character.
  if (normalized.includes('freight') || containsFuzzyWord(text, 'freight', 1)) return false;
  return WEIGHT_ANCHOR.test(String(text || '')) || containsFuzzyWord(text, 'weight');
}

function isWeightQualifierText(text) {
  if (WEIGHT_COLUMN_QUALIFIER.test(String(text || '').trim())) return true;
  const normalized = normalizeQualifierText(text);
  if (!normalized) return false;

  // Product descriptions often contain "Charger"; it is one character away
  // from "charged", but it is not a weight column header.
  if (/^chargers?$/.test(normalized)) return false;

  // Tesseract frequently drops the leading A on ACTUAL in skewed/scanned
  // labels ("CTUAL"). Accept that specific damage pattern.
  if (normalized === 'ctual') return true;

  return ['actual', 'charged', 'chargeable'].some((target) => {
    if (target === 'charged' && /^charger/.test(normalized)) return false;
    return (
      Math.abs(normalized.length - target.length) <= 1 &&
      levenshtein(normalized, target) <= 1
    );
  });
}

/**
 * @typedef {Object} OcrWord
 * @property {string} text
 * @property {number} confidence 0-100
 * @property {{x0:number,y0:number,x1:number,y1:number}} bbox
 */

/**
 * Builds candidate ID strings by merging nearby numeric OCR fragments in
 * left-to-right order. Real-world phone photos of large, bold barcode
 * numbers are frequently split by Tesseract into several word tokens
 * (e.g. "30", "903", "0", "935" instead of "309030935") - especially when
 * the photo is slightly rotated/skewed. This reconstructs plausible full
 * ID strings by chaining fragments that sit close together, so a genuine
 * ID isn't missed just because OCR fragmented it.
 *
 * @param {OcrWord[]} words
 * @returns {Array<{ text: string, confidence: number, words: OcrWord[] }>}
 */
function buildMergedNumericCandidates(words) {
  const fragments = words
    .map((w) => ({ word: w, digits: w.text.replace(NON_DIGIT, '') }))
    .filter((f) => f.digits.length >= 1)
    .sort((a, b) => a.word.bbox.x0 - b.word.bbox.x0);

  const candidates = [];

  for (let i = 0; i < fragments.length; i += 1) {
    const start = fragments[i];
    let text = start.digits;
    let minConfidence = start.word.confidence;
    let chainWords = [start.word];
    let lastX1 = start.word.bbox.x1;
    let avgHeight = start.word.bbox.y1 - start.word.bbox.y0;
    let centerY = (start.word.bbox.y0 + start.word.bbox.y1) / 2;

    candidates.push({ text, confidence: minConfidence, words: [...chainWords] });

    for (let j = i + 1; j < fragments.length; j += 1) {
      const next = fragments[j];
      const gapX = next.word.bbox.x0 - lastX1;
      const nextCenterY = (next.word.bbox.y0 + next.word.bbox.y1) / 2;
      const verticalDrift = Math.abs(nextCenterY - centerY);

      // Allow generous tolerance: skewed/rotated phone photos can drift
      // vertically as they move horizontally across a line of text.
      if (gapX > avgHeight * 5 || gapX < -avgHeight * 0.8) continue;
      if (verticalDrift > avgHeight * 2.0) continue;
      if (text.length >= 20) break;

      text += next.digits;
      minConfidence = Math.min(minConfidence, next.word.confidence);
      chainWords = [...chainWords, next.word];
      lastX1 = Math.max(lastX1, next.word.bbox.x1);
      avgHeight = (avgHeight + (next.word.bbox.y1 - next.word.bbox.y0)) / 2;
      centerY = nextCenterY;

      candidates.push({ text, confidence: minConfidence, words: [...chainWords] });
    }
  }

  return candidates;
}

function numericTokenVariants(text) {
  const raw = String(text || '').trim();
  const digitsOnly = raw.replace(NON_DIGIT, '');
  const variants = new Set(digitsOnly ? [digitsOnly] : []);
  const compact = raw.replace(/[^a-z0-9|]/gi, '');
  const letters = (compact.match(/[a-z]/gi) || []).length;

  // Barcode-header IDs often contain a small number of OCR glyph confusions.
  // Restrict repair to long, overwhelmingly numeric tokens so page prose can
  // never become a fabricated shipment number.
  if (compact.length >= 7 && letters <= 2) {
    const corrected = compact
      .toUpperCase()
      .replace(/[OQD]/g, '0')
      .replace(/[IL|]/g, '1')
      .replace(/Z/g, '2')
      .replace(/S/g, '5')
      .replace(/G/g, '6')
      .replace(/B/g, '8')
      .replace(/\D/g, '');
    if (corrected) variants.add(corrected);
  }

  return [...variants];
}

function candidatePositionScore(candidate, opts, medianWordHeight) {
  const imageWidth = Number(opts.imageWidth) || 0;
  const imageHeight = Number(opts.imageHeight) || 0;
  const words = candidate.words || [];
  if (!imageWidth || !imageHeight || !words.length) return 0;

  const x0 = Math.min(...words.map((word) => word.bbox.x0));
  const x1 = Math.max(...words.map((word) => word.bbox.x1));
  const y0 = Math.min(...words.map((word) => word.bbox.y0));
  const y1 = Math.max(...words.map((word) => word.bbox.y1));
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;
  const height = y1 - y0;
  let score = 0;

  // This POD family prints the primary ID in the upper barcode/header band.
  if (centerY <= imageHeight * 0.22) score += 30;
  else if (centerY <= imageHeight * 0.34) score += 12;
  if (centerX >= imageWidth * 0.38) score += 12;
  if (height >= medianWordHeight * 1.35) score += 8;
  return score;
}

/**
 * Finds the shipment ID present on a label out of a known set of IDs
 * (the keys of the uploaded Excel mapping). Matching order:
 *   1. Exact match on a single OCR word's normalized digit string.
 *   2. Exact match on a *reconstructed* candidate - chains of nearby
 *      numeric fragments merged in reading order (handles IDs that
 *      Tesseract split into several words).
 *   3. Fuzzy match (bounded Levenshtein distance) over the same
 *      candidate pool, as a fallback for OCR misreads.
 *
 * @param {OcrWord[]} words
 * @param {Set<string>} idSet known shipment IDs from the mapping sheet
 * @param {{ minConfidence?: number, fuzzyMaxDistance?: number }} [opts]
 */
function findShipmentId(words, idSet, opts = {}) {
  const minConfidence = opts.minConfidence ?? 40;
  const fuzzyMaxDistance = opts.fuzzyMaxDistance ?? 2;

  const wordHeights = words
    .map((word) => word.bbox.y1 - word.bbox.y0)
    .filter((height) => height > 0)
    .sort((a, b) => a - b);
  const medianWordHeight = wordHeights[Math.floor(wordHeights.length / 2)] || 1;

  const singleWordCandidates = words
    .filter((w) => w.confidence >= minConfidence)
    .flatMap((w) => numericTokenVariants(w.text).map((text) => ({
      text,
      confidence: w.confidence,
      words: [w],
      source: text === w.text.replace(NON_DIGIT, '') ? 'ocr' : 'ocr_confusion_repair',
    })))
    .filter((c) => c.text.length >= 4);

  const mergedCandidates = buildMergedNumericCandidates(words).filter(
    (c) => c.confidence >= minConfidence && c.text.length >= 4
  );

  // Single-word candidates first (cheapest, most reliable), then merged
  // reconstructions - so a clean single-token read is always preferred
  // over a multi-fragment reconstruction when both are available.
  const allCandidates = [...singleWordCandidates, ...mergedCandidates];

  let best = null;
  for (const candidate of allCandidates) {
    if (idSet.has(candidate.text)) {
      const score = candidate.confidence + candidatePositionScore(candidate, opts, medianWordHeight);
      if (!best || score > best.score) {
        best = {
          id: candidate.text,
          word: candidate.words[0],
          words: candidate.words,
          distance: 0,
          confidence: candidate.confidence,
          score,
          source: candidate.source || (candidate.words.length > 1 ? 'ocr_fragments' : 'ocr'),
        };
      }
    }
  }
  if (best) return best;

  // Fuzzy fallback: only runs if no exact match was found anywhere on the page.
  // Allow up to 2 character differences for heavily degraded scans.
  for (const candidate of allCandidates) {
    for (const id of idSet) {
      if (Math.abs(id.length - candidate.text.length) > fuzzyMaxDistance) continue;
      const distance = levenshtein(id, candidate.text);
      const score = candidate.confidence + candidatePositionScore(candidate, opts, medianWordHeight) - distance * 35;
      if (distance <= fuzzyMaxDistance && (!best || score > best.score)) {
        best = {
          id,
          word: candidate.words[0],
          words: candidate.words,
          distance,
          confidence: candidate.confidence,
          score,
          source: 'ocr_fuzzy',
        };
      }
    }
  }

  return best;
}

/**
 * Groups adjacent OCR word tokens that together form a "WEIGHT" style
 * header (e.g. the words "CHARGED" and "WEIGHT" printed side by side)
 * into a single anchor bounding box per column.
 *
 * @param {OcrWord[]} words
 */
function findWeightAnchors(words) {
  const anchorWordSet = new Set(
    words.filter((word) => isWeightAnchorText(word.text) || isWeightQualifierText(word.text))
  );

  // Tesseract can split a damaged header into tokens such as "WEI" + "GHT".
  // Rejoin only close, same-line neighbours so unrelated page words cannot
  // accidentally become a weight header.
  const splitCandidates = words.filter((word) => {
    const normalized = normalizeHeaderText(word.text);
    return normalized.length >= 1 && normalized.length <= 7;
  });
  for (let i = 0; i < splitCandidates.length; i += 1) {
    for (let j = i + 1; j < splitCandidates.length; j += 1) {
      const first = splitCandidates[i];
      const second = splitCandidates[j];
      const firstHeight = first.bbox.y1 - first.bbox.y0;
      const secondHeight = second.bbox.y1 - second.bbox.y0;
      const maxHeight = Math.max(firstHeight, secondHeight);
      const firstCenterY = (first.bbox.y0 + first.bbox.y1) / 2;
      const secondCenterY = (second.bbox.y0 + second.bbox.y1) / 2;
      if (Math.abs(firstCenterY - secondCenterY) > maxHeight * 0.7) continue;

      const left = first.bbox.x0 <= second.bbox.x0 ? first : second;
      const right = left === first ? second : first;
      const gap = right.bbox.x0 - left.bbox.x1;
      if (gap < -maxHeight * 0.5 || gap > maxHeight * 1.2) continue;

      const combinedText = normalizeHeaderText(`${left.text}${right.text}`);
      const isSplitWeight =
        Math.abs(combinedText.length - 'weight'.length) <= 1 &&
        levenshtein(combinedText, 'weight') <= 1;
      if (isSplitWeight) {
        anchorWordSet.add(left);
        anchorWordSet.add(right);
      }
    }
  }

  const anchorWords = [...anchorWordSet];
  if (!anchorWords.length) return [];

  // Sort by reading order (top-to-bottom, then left-to-right).
  anchorWords.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  const groups = [];
  for (const word of anchorWords) {
    const group = groups.find((g) => {
      const groupWidth = g.bbox.x1 - g.bbox.x0;
      const wordWidth = word.bbox.x1 - word.bbox.x0;
      const wordHeight = word.bbox.y1 - word.bbox.y0;
      const maxHeight = Math.max(g.bbox.height, wordHeight);
      const groupCenterY = (g.bbox.y0 + g.bbox.y1) / 2;
      const wordCenterY = (word.bbox.y0 + word.bbox.y1) / 2;
      const sameLine = Math.abs(groupCenterY - wordCenterY) <= maxHeight * 0.8;

      const horizontalOverlap =
        Math.min(g.bbox.x1, word.bbox.x1) - Math.max(g.bbox.x0, word.bbox.x0);
      const stackedInSameColumn =
        horizontalOverlap >= Math.min(groupWidth, wordWidth) * 0.25 &&
        Math.max(g.bbox.y0, word.bbox.y0) - Math.min(g.bbox.y1, word.bbox.y1) <= maxHeight * 1.5;

      const horizontalGap = Math.max(
        0,
        Math.max(g.bbox.x0, word.bbox.x0) - Math.min(g.bbox.x1, word.bbox.x1)
      );
      const adjacentOnSameLine = sameLine && horizontalGap <= maxHeight * 1.5;

      return stackedInSameColumn || adjacentOnSameLine;
    });

    if (group) {
      group.bbox.x0 = Math.min(group.bbox.x0, word.bbox.x0);
      group.bbox.y0 = Math.min(group.bbox.y0, word.bbox.y0);
      group.bbox.x1 = Math.max(group.bbox.x1, word.bbox.x1);
      group.bbox.y1 = Math.max(group.bbox.y1, word.bbox.y1);
      group.bbox.height = group.bbox.y1 - group.bbox.y0;
      group.words.push(word);
    } else {
      const height = word.bbox.y1 - word.bbox.y0;
      groups.push({
        bbox: { ...word.bbox, height },
        words: [word],
      });
    }
  }

  const makeAnchor = (groupWords) => {
    const x0 = Math.min(...groupWords.map((word) => word.bbox.x0));
    const y0 = Math.min(...groupWords.map((word) => word.bbox.y0));
    const x1 = Math.max(...groupWords.map((word) => word.bbox.x1));
    const y1 = Math.max(...groupWords.map((word) => word.bbox.y1));
    const anchor = { bbox: { x0, y0, x1, y1, height: y1 - y0 }, words: groupWords };
    return narrowCompositeWeightAnchor(anchor);
  };

  function narrowCompositeWeightAnchor(anchor) {
    const text = anchor.words.map((word) => String(word.text || '')).join(' ');
    const normalized = normalizeQualifierText(text);
    const mentionsWeight = /weight|weigh/.test(normalizeHeaderText(text));
    const spillsIntoProductColumn = /said|contain/.test(normalized);
    if (!mentionsWeight || !spillsIntoProductColumn) return anchor;

    const width = anchor.bbox.x1 - anchor.bbox.x0;
    if (width <= 0) return anchor;

    // Some low-contrast scans are OCR'd as one long token such as
    // "[ACTUAL WEIGHT(kg)___|SAID". Keep the physical left-side weight
    // header and discard the neighbouring SAID TO CONTAIN text from the
    // anchor, otherwise value search moves into the product column.
    const isActualOnly = /actual|ctual/.test(normalized) && !/charg|chargeable/.test(normalized);
    if (!isActualOnly) return anchor;

    const narrowedWidth = Math.max(width * 0.32, Math.min(width * 0.52, anchor.bbox.height * 3.4));
    return {
      ...anchor,
      bbox: {
        ...anchor.bbox,
        x1: anchor.bbox.x0 + narrowedWidth,
        height: anchor.bbox.y1 - anchor.bbox.y0,
      },
    };
  }

  // Base + enhanced OCR can create a bridge of overlapping duplicate words
  // that merges ACTUAL and CHARGED into one very wide anchor. Split only at a
  // pronounced inter-column gap where both halves independently contain
  // weight-header evidence; ordinary "CHARGED WEIGHT" remains one anchor.
  const splitGroups = groups.flatMap((group) => {
    if (group.words.length < 2) return [group];
    const sorted = [...group.words].sort((a, b) => {
      const ax = (a.bbox.x0 + a.bbox.x1) / 2;
      const bx = (b.bbox.x0 + b.bbox.x1) / 2;
      return ax - bx;
    });
    const heights = sorted
      .map((word) => word.bbox.y1 - word.bbox.y0)
      .filter((height) => height > 0)
      .sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || group.bbox.height;
    let splitIndex = -1;
    let largestGap = 0;
    for (let index = 1; index < sorted.length; index += 1) {
      const previousCenter = (sorted[index - 1].bbox.x0 + sorted[index - 1].bbox.x1) / 2;
      const center = (sorted[index].bbox.x0 + sorted[index].bbox.x1) / 2;
      const gap = center - previousCenter;
      if (gap > largestGap) {
        largestGap = gap;
        splitIndex = index;
      }
    }
    if (splitIndex < 1 || largestGap < Math.max(18, medianHeight * 2.2)) return [group];
    const leftWords = sorted.slice(0, splitIndex);
    const rightWords = sorted.slice(splitIndex);
    const hasEvidence = (candidateWords) => candidateWords.some((word) =>
      isWeightAnchorText(word.text) || isWeightQualifierText(word.text)
    );
    if (!hasEvidence(leftWords) || !hasEvidence(rightWords)) return [group];
    const leftText = leftWords.map((word) => normalizeQualifierText(word.text)).join('');
    const rightText = rightWords.map((word) => normalizeQualifierText(word.text)).join('');
    const rightMinX = Math.min(...rightWords.map((word) => word.bbox.x0));
    const rightMaxX = Math.max(...rightWords.map((word) => word.bbox.x1));
    const externalChargedEvidence = groups.some((otherGroup) =>
      otherGroup !== group &&
      otherGroup.words.some((word) => /charg/.test(normalizeQualifierText(word.text))) &&
      Math.min(rightMaxX, otherGroup.bbox.x1) - Math.max(rightMinX, otherGroup.bbox.x0) > 0
    );
    // "ACTUAL WEIGHT" can be two horizontally adjacent tokens inside one
    // wide cell. A true inter-column split has CHARGED evidence on the right
    // (or no ACTUAL qualifier on the left due to damaged OCR).
    if (/actual|ctual/.test(leftText) && !/charg/.test(rightText) && !externalChargedEvidence) {
      return [group];
    }
    return [makeAnchor(leftWords), makeAnchor(rightWords)];
  });

  const consolidated = [];
  for (const anchor of splitGroups.sort((a, b) => a.bbox.x0 - b.bbox.x0 || a.bbox.y0 - b.bbox.y0)) {
    const width = anchor.bbox.x1 - anchor.bbox.x0;
    const height = anchor.bbox.y1 - anchor.bbox.y0;
    const existing = consolidated.find((candidate) => {
      const candidateWidth = candidate.bbox.x1 - candidate.bbox.x0;
      const candidateHeight = candidate.bbox.y1 - candidate.bbox.y0;
      const overlapX = Math.min(anchor.bbox.x1, candidate.bbox.x1) -
        Math.max(anchor.bbox.x0, candidate.bbox.x0);
      const verticalGap = Math.max(
        0,
        Math.max(anchor.bbox.y0, candidate.bbox.y0) - Math.min(anchor.bbox.y1, candidate.bbox.y1)
      );
      return overlapX >= Math.min(width, candidateWidth) * 0.45 &&
        verticalGap <= Math.max(height, candidateHeight) * 1.5;
    });
    if (existing) {
      existing.words.push(...anchor.words.filter((word) => !existing.words.includes(word)));
      const rebuilt = makeAnchor(existing.words);
      existing.bbox = rebuilt.bbox;
    } else {
      consolidated.push(anchor);
    }
  }
  return consolidated.map(narrowCompositeWeightAnchor);
}

/**
 * For each "WEIGHT" column anchor, searches downward within the same
 * horizontal band for the nearest numeric token - that token is the
 * printed weight value belonging to that column.
 *
 * @param {OcrWord[]} words
 * @param {{ x0:number,y0:number,x1:number,y1:number,height:number }[]} anchors
 * @param {{ imageHeight: number, verticalWindowRatio?: number, horizontalTolerancePx?: number }} ctx
 */
function findWeightValueRegions(words, anchors, ctx) {
  const verticalWindowRatio = ctx.verticalWindowRatio ?? 0.18;
  const horizontalTolerancePx = ctx.horizontalTolerancePx ?? 120;
  const maxVerticalGap = ctx.imageHeight * verticalWindowRatio;

  const numericWords = words
    .map((word) => {
      const text = word.text.trim();
      if (NUMERIC_TOKEN.test(text)) return { word, strict: true };

      // At very low resolution Tesseract can read a value such as 80.09 as
      // "N.n". A short decimal-shaped token is still usable geometrically
      // when it sits directly below a confirmed weight header.
      const compact = text.replace(/\s/g, '');
      const letters = (compact.match(/[a-z]/gi) || []).length;
      const looksLikeDamagedDecimal =
        compact.length >= 2 &&
        compact.length <= 10 &&
        /[.,]/.test(compact) &&
        letters <= 3;
      return looksLikeDamagedDecimal ? { word, strict: false } : null;
    })
    .filter(Boolean);

  const regions = [];
  const claimed = new Set();

  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const anchor = anchors[anchorIndex];
    const anchorWidth = anchor.bbox.x1 - anchor.bbox.x0;
    const effectiveTolerance = Math.min(
      horizontalTolerancePx,
      Math.max(12, anchorWidth * 0.35)
    );
    const minX = anchor.bbox.x0 - effectiveTolerance;
    const maxX = anchor.bbox.x1 + effectiveTolerance;

    let bestCandidate = null;
    let bestGap = Infinity;

    for (const candidate of numericWords) {
      const { word } = candidate;
      if (claimed.has(word)) continue;
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      if (centerX < minX || centerX > maxX) continue;

      const gap = word.bbox.y0 - anchor.bbox.y1;
      const anchorCenterY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
      const wordCenterY = (word.bbox.y0 + word.bbox.y1) / 2;
      const maxOverlap = Math.max(3, anchor.bbox.height * 0.45);
      if (gap < -maxOverlap || gap > maxVerticalGap) continue;
      if (gap < 0 && wordCenterY <= anchorCenterY) continue;

      if (gap < bestGap || (gap === bestGap && candidate.strict && !bestCandidate?.strict)) {
        bestGap = gap;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) {
      const { word } = bestCandidate;
      claimed.add(word);
      regions.push({
        bbox: { ...word.bbox },
        originalText: word.text.trim(),
        anchorText: anchor.words.map((w) => w.text).join(' '),
        kind: classifyWeightRegion({ anchorText: anchor.words.map((w) => w.text).join(' ') }, anchorIndex, anchors),
      });
    }
  }

  if (regions.length <= 1) return regions;

  // Ignore isolated numeric text under later prose such as "final charged
  // weight can vary". Genuine ACTUAL/CHARGED values form one horizontal row.
  const rowTolerance = Math.max(20, ctx.imageHeight * 0.04);
  const sortedRegions = [...regions].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const rowGroups = [];
  for (const region of sortedRegions) {
    const group = rowGroups.find(
      (candidate) => Math.abs(candidate[0].bbox.y0 - region.bbox.y0) <= rowTolerance
    );
    if (group) group.push(region);
    else rowGroups.push([region]);
  }
  rowGroups.sort((a, b) => b.length - a.length || a[0].bbox.y0 - b[0].bbox.y0);
  return rowGroups[0];
}

function weightColumnKind(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^a-z]/g, '');
  if (/actual|ctual/.test(normalized)) return 'actual';
  if (/charged|chargeable|chargd/.test(normalized)) return 'charged';
  return null;
}

function classifyWeightRegion(region, anchorIndex, anchors) {
  const anchorText = region.anchorText || '';
  const kind = weightColumnKind(anchorText);
  if (kind) return kind;

  if (anchors.length >= 2 && anchorIndex < anchors.length) {
    const anchor = anchors[anchorIndex];
    const anchorWords = anchor.words.map((w) => w.text).join(' ');
    return weightColumnKind(anchorWords) || (anchorIndex === 0 ? 'actual' : 'charged');
  }

  return 'actual';
}

/**
 * Formats a replacement weight to visually match the decimal precision
 * of the value it is replacing, e.g. replacing "802.91" with 900 yields
 * "900.00" so column alignment/precision looks consistent. Whole-number
 * originals stay whole numbers.
 */
function formatReplacementWeight(newWeight, originalText) {
  const decimalMatch = originalText.match(/\.(\d+)/);
  if (decimalMatch) {
    return Number(newWeight).toFixed(decimalMatch[1].length);
  }
  return String(Math.round(Number(newWeight) * 100) / 100);
}

/**
 * Formats one shared replacement value for all detected weight columns on a
 * label. ACTUAL and CHARGED/CHARGEABLE are sibling fields; rendering one as
 * "40.00" and the other as "40" makes the edit visibly inconsistent. Use the
 * highest decimal precision already printed in any sibling weight value, then
 * apply it to every replacement on that page.
 */
function formatSharedReplacementWeight(newWeight, regions) {
  const newWeightDecimalMatch = String(newWeight).match(/\.(\d+)/);
  const newWeightDecimals = newWeightDecimalMatch ? newWeightDecimalMatch[1].length : 0;
  const maxDecimals = regions.reduce((max, region) => {
    const decimalMatch = String(region.originalText || '').match(/\.(\d+)/);
    return Math.max(max, decimalMatch ? decimalMatch[1].length : 0);
  }, newWeightDecimals);

  if (maxDecimals > 0) return Number(newWeight).toFixed(maxDecimals);
  return String(Math.round(Number(newWeight) * 100) / 100);
}

module.exports = {
  findShipmentId,
  findWeightAnchors,
  findWeightValueRegions,
  formatReplacementWeight,
  formatSharedReplacementWeight,
  buildMergedNumericCandidates,
  isWeightAnchorText,
  isWeightQualifierText,
  weightColumnKind,
  classifyWeightRegion,
};
