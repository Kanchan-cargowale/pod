'use strict';

const {
  NUMERIC_TOKEN,
  WEIGHT_ANCHOR,
  WEIGHT_COLUMN_QUALIFIER,
  NON_DIGIT,
} = require('../constants/regex');
const { levenshtein } = require('../utils/levenshtein');

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
      if (gapX > avgHeight * 4 || gapX < -avgHeight) continue;
      if (verticalDrift > avgHeight * 1.6) continue;
      if (text.length >= 18) break;

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
  const fuzzyMaxDistance = opts.fuzzyMaxDistance ?? 1;

  const singleWordCandidates = words
    .filter((w) => w.confidence >= minConfidence)
    .map((w) => ({ text: w.text.replace(NON_DIGIT, ''), confidence: w.confidence, words: [w] }))
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
      if (!best || candidate.confidence > best.confidence) {
        best = { id: candidate.text, word: candidate.words[0], words: candidate.words, distance: 0, confidence: candidate.confidence };
      }
    }
  }
  if (best) return best;

  // Fuzzy fallback: only runs if no exact match was found anywhere on the page.
  for (const candidate of allCandidates) {
    for (const id of idSet) {
      if (Math.abs(id.length - candidate.text.length) > fuzzyMaxDistance) continue;
      const distance = levenshtein(id, candidate.text);
      if (distance <= fuzzyMaxDistance && (!best || distance < best.distance)) {
        best = { id, word: candidate.words[0], words: candidate.words, distance, confidence: candidate.confidence };
      }
    }
  }

  return best;
}

/**
 * Finds an exact mapping-sheet ID embedded as a distinct token in the image
 * filename. Courier exports commonly name files like lm-pod-307869128-....jpg;
 * this is a reliable fallback when OCR cannot read the printed barcode ID.
 *
 * @param {string} filename
 * @param {Set<string>} idSet
 */
function findShipmentIdInFilename(filename, idSet) {
  const name = String(filename || '');
  const idsByLength = [...idSet].map(String).sort((a, b) => b.length - a.length);

  for (const id of idsByLength) {
    if (!id) continue;
    let fromIndex = 0;

    while (fromIndex <= name.length - id.length) {
      const index = name.indexOf(id, fromIndex);
      if (index === -1) break;

      const before = index > 0 ? name[index - 1] : '';
      const afterIndex = index + id.length;
      const after = afterIndex < name.length ? name[afterIndex] : '';
      const hasTokenBoundaries = !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);

      if (hasTokenBoundaries) {
        return {
          id,
          word: null,
          words: [],
          distance: 0,
          confidence: 100,
          source: 'filename',
        };
      }

      fromIndex = index + 1;
    }
  }

  return null;
}

/**
 * Groups adjacent OCR word tokens that together form a "WEIGHT" style
 * header (e.g. the words "CHARGED" and "WEIGHT" printed side by side)
 * into a single anchor bounding box per column.
 *
 * @param {OcrWord[]} words
 */
function findWeightAnchors(words) {
  const anchorWords = words.filter(
    (w) => WEIGHT_ANCHOR.test(w.text) || WEIGHT_COLUMN_QUALIFIER.test(w.text.trim())
  );
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

  return groups;
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

  const numericWords = words.filter((w) => NUMERIC_TOKEN.test(w.text.trim()));

  const regions = [];
  const claimed = new Set();

  for (const anchor of anchors) {
    const minX = anchor.bbox.x0 - horizontalTolerancePx;
    const maxX = anchor.bbox.x1 + horizontalTolerancePx;

    let bestCandidate = null;
    let bestGap = Infinity;

    for (const word of numericWords) {
      if (claimed.has(word)) continue;
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      if (centerX < minX || centerX > maxX) continue;

      const gap = word.bbox.y0 - anchor.bbox.y1;
      if (gap < 0 || gap > maxVerticalGap) continue;

      if (gap < bestGap) {
        bestGap = gap;
        bestCandidate = word;
      }
    }

    if (bestCandidate) {
      claimed.add(bestCandidate);
      regions.push({
        bbox: { ...bestCandidate.bbox },
        originalText: bestCandidate.text.trim(),
        anchorText: anchor.words.map((w) => w.text).join(' '),
      });
    }
  }

  return regions;
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

module.exports = {
  findShipmentId,
  findShipmentIdInFilename,
  findWeightAnchors,
  findWeightValueRegions,
  formatReplacementWeight,
  buildMergedNumericCandidates,
};
