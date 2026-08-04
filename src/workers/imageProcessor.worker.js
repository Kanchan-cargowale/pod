'use strict';

const path = require('path');
const fs = require('fs/promises');
const { parentPort } = require('worker_threads');

const ocrService = require('../services/ocr.service');
const imageEditor = require('../services/imageEditor.service');
const { shouldTryQuarterTurns } = require('../services/imageOrientation.service');
const {
  findShipmentId,
  findShipmentIdInFilename,
  findWeightAnchors,
  findWeightValueRegions,
  formatReplacementWeight,
  buildMergedNumericCandidates,
} = require('../services/labelMatcher.service');
const config = require('../config');
const sharp = require('sharp');

if (!parentPort) {
  throw new Error('imageProcessor.worker.js must be run as a worker_thread');
}

const { NON_DIGIT } = require('../constants/regex');

/**
 * Pulls out numeric-looking tokens that could plausibly be a shipment ID
 * (4+ digits, reasonably confident OCR reads), for surfacing in the UI
 * when no match was found - so the operator can see what was actually
 * read on the page and compare it against their mapping sheet, instead
 * of "unmatched" being a dead end.
 */
function extractCandidateIds(words, minConfidence) {
  const seen = new Set();
  const candidates = [];
  for (const word of words) {
    if (word.confidence < minConfidence) continue;
    const digits = word.text.replace(NON_DIGIT, '');
    if (digits.length < 4 || digits.length > 18) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    candidates.push(digits);
    if (candidates.length >= 15) break;
  }

  // Also surface the longest reconstructed multi-fragment candidates
  // (e.g. a barcode ID Tesseract split across several words) so the
  // operator can see whether the ID is present but fragmented, rather
  // than genuinely absent from the page.
  const merged = buildMergedNumericCandidates(words)
    .filter((c) => c.confidence >= minConfidence && c.text.length >= 6)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 5)
    .map((c) => c.text)
    .filter((t) => !seen.has(t));

  return [...candidates, ...merged];
}

/**
 * Processes a single label image:
 *   1. OCR the whole page.
 *   2. Identify which shipment ID (from the mapping) is printed on it.
 *   3. Locate the weight value cell(s) belonging to that label.
 *   4. Overwrite just those pixels with the new weight, byte-for-byte
 *      preserving everything else, and write the result to disk.
 */
async function processImage({ filePath, outputPath, idWeightMap }) {
  const idSet = new Set(idWeightMap.keys());
  const originalMeta = await sharp(filePath).metadata();
  const needsAutoOrientation = Boolean(originalMeta.orientation && originalMeta.orientation !== 1);
  // Sharp's rotate() with no angle applies the EXIF transform and removes the
  // tag. OCR and editing must use these same normalized pixels/coordinates.
  const initialInput = needsAutoOrientation
    ? await sharp(filePath).rotate().toBuffer()
    : filePath;
  const initialMeta = needsAutoOrientation ? await sharp(initialInput).metadata() : originalMeta;
  const filenameMatch = findShipmentIdInFilename(path.basename(filePath), idSet);

  function buildAnalysis(input, meta, rotation, words) {
    const ocrMatch = findShipmentId(words, idSet, {
      minConfidence: config.ocrMinConfidence,
      fuzzyMaxDistance: config.matching.idFuzzyMaxDistance,
    });
    const match = ocrMatch?.distance === 0 ? ocrMatch : filenameMatch || ocrMatch;
    const anchors = findWeightAnchors(words);
    const regions = findWeightValueRegions(words, anchors, {
      imageHeight: meta.height,
      verticalWindowRatio: config.matching.verticalSearchWindowRatio,
      horizontalTolerancePx: config.matching.horizontalTolerancePx,
    });
    return { input, meta, rotation, words, match, anchors, regions };
  }

  function isBetterAnalysis(candidate, current) {
    return (
      (candidate.match && !current.match) ||
      (Boolean(candidate.match) === Boolean(current.match) &&
        (candidate.regions.length > current.regions.length ||
          (candidate.regions.length === current.regions.length &&
            candidate.anchors.length > current.anchors.length)))
    );
  }

  function mapOcrWords(words, scale, offsetX = 0, offsetY = 0) {
    return words.map((word) => ({
      ...word,
      bbox: {
        x0: word.bbox.x0 / scale + offsetX,
        y0: word.bbox.y0 / scale + offsetY,
        x1: word.bbox.x1 / scale + offsetX,
        y1: word.bbox.y1 / scale + offsetY,
      },
    }));
  }

  async function inspectOrientation(input, meta, rotation) {
    const { words } = await ocrService.recognize(input);
    let result = buildAnalysis(input, meta, rotation, words);

    if (result.regions.length < 2) {
      // Faint scans can preserve readable values while Tesseract drops the
      // light-gray header or one of two adjacent weight columns. Enlarge a
      // temporary OCR-only copy, then map every detected coordinate back to
      // the untouched source image. A true single-column label remains a
      // single result after this pass.
      const enhancedScale = 3;
      const enhancedInput = await sharp(input)
        .resize({
          width: Math.round(meta.width * enhancedScale),
          height: Math.round(meta.height * enhancedScale),
        })
        .greyscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      const enhanced = await ocrService.recognize(enhancedInput);
      const enhancedWords = mapOcrWords(enhanced.words, enhancedScale);
      const enhancedResult = buildAnalysis(input, meta, rotation, enhancedWords);
      if (isBetterAnalysis(enhancedResult, result)) result = enhancedResult;
    }

    if (!result.regions.length && meta.height > meta.width * 1.1) {
      // Portrait phone photos often contain a small label in the upper part of
      // a mostly blank page. A focused tile gives its 4-5px text enough detail
      // for OCR without processing the blank canvas at extreme resolution.
      const crop = {
        left: Math.round(meta.width * 0.164),
        top: Math.round(meta.height * 0.103),
        width: Math.round(meta.width * 0.41),
        height: Math.round(meta.height * 0.186),
      };
      crop.width = Math.min(crop.width, meta.width - crop.left);
      crop.height = Math.min(crop.height, meta.height - crop.top);
      const tileScale = 6;
      const tileInput = await sharp(input)
        .extract(crop)
        .resize({ width: crop.width * tileScale, height: crop.height * tileScale })
        .greyscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      const tile = await ocrService.recognize(tileInput);
      const tileWords = mapOcrWords(tile.words, tileScale, crop.left, crop.top);
      const tileResult = buildAnalysis(input, meta, rotation, tileWords);
      if (isBetterAnalysis(tileResult, result)) result = tileResult;
    }

    return result;
  }

  let analysis = await inspectOrientation(initialInput, initialMeta, 0);

  // A tall image may be an upright portrait scan or a sideways landscape
  // label. Never reject it from dimensions alone. If the uploaded orientation
  // cannot locate a weight, let OCR decide whether either quarter-turn is
  // materially better and use that orientation for both editing and output.
  if (shouldTryQuarterTurns(initialMeta) && !analysis.regions.length) {
    for (const rotation of [90, 270]) {
      // eslint-disable-next-line no-await-in-loop
      const rotatedInput = await sharp(initialInput).rotate(rotation).toBuffer();
      // eslint-disable-next-line no-await-in-loop
      const rotatedMeta = await sharp(rotatedInput).metadata();
      // eslint-disable-next-line no-await-in-loop
      const candidate = await inspectOrientation(rotatedInput, rotatedMeta, rotation);

      if (isBetterAnalysis(candidate, analysis)) analysis = candidate;
    }
  }

  const { input: processingInput, words, match, anchors } = analysis;
  let { regions } = analysis;

  if (!match) {
    return {
      status: 'unmatched',
      reason: 'No shipment ID from the mapping sheet was found in the label text or filename',
      detectedNumbers: extractCandidateIds(words, config.ocrMinConfidence),
    };
  }

  const newWeight = idWeightMap.get(match.id);

  if (!regions.length) {
    return {
      status: 'id_matched_no_weight_region',
      shipmentId: match.id,
      newWeight,
      reason: 'Shipment ID matched but no "WEIGHT" column value could be located',
      detectedWeightAnchors: anchors.map((a) => a.words.map((w) => w.text).join(' ')),
    };
  }

  const regionHeights = regions
    .map((region) => region.bbox.y1 - region.bbox.y0)
    .filter((height) => height > 0)
    .sort((a, b) => a - b);
  const hasSharedWeightRow = regions.length > 1;
  // The shortest detected box is the most reliable glyph-height signal when
  // OCR has merged a value with header/rule ink into one abnormally tall box.
  const rowHeight = hasSharedWeightRow
    ? Math.max(8, regionHeights[0])
    : regionHeights[0];
  const plausibleRegions = regions.filter((region) => {
    const height = region.bbox.y1 - region.bbox.y0;
    return height <= rowHeight * 1.8;
  });
  const baselineSource = plausibleRegions.length ? plausibleRegions : regions;
  const sharedBottom = hasSharedWeightRow
    ? baselineSource
        .map((region) => region.bbox.y1)
        .sort((a, b) => a - b)[Math.floor((baselineSource.length - 1) / 2)]
    : null;

  const sortedRegionCenters = regions
    .map((region) => (region.bbox.x0 + region.bbox.x1) / 2)
    .sort((a, b) => a - b);

  const replacements = regions.map((region) => {
    const rawHeight = region.bbox.y1 - region.bbox.y0;
    const regionCenterX = (region.bbox.x0 + region.bbox.x1) / 2;
    const centerIndex = sortedRegionCenters.indexOf(regionCenterX);
    const previousCenter = sortedRegionCenters[centerIndex - 1];
    const nextCenter = sortedRegionCenters[centerIndex + 1];
    // Midpoints between independently confirmed weight columns are hard cell
    // limits. A single confirmed region gets conservative local limits only;
    // it must never expand into SAID TO CONTAIN or another neighbouring cell.
    const cellLeft = previousCenter == null
      ? Math.max(0, region.bbox.x0 - Math.max(3, rawHeight * 0.35))
      : (previousCenter + regionCenterX) / 2;
    const cellRight = nextCenter == null
      ? Math.min(analysis.meta.width, region.bbox.x1 + Math.max(8, rawHeight * 2.8))
      : (regionCenterX + nextCenter) / 2;
    const safeInset = Math.max(2, Math.round(rawHeight * 0.18));
    const replacementText = formatReplacementWeight(newWeight, region.originalText);
    const originalTextIsReliable = /^\d{1,6}(?:\.\d{1,3})?$/.test(region.originalText);
    const targetCenterY = hasSharedWeightRow
      ? sharedBottom - rowHeight / 2
      : (region.bbox.y0 + region.bbox.y1) / 2;
    // OCR may split an old value such as "1.40" into "1" and "i.". Recover
    // immediately adjacent numeric fragments so clearing starts at the true
    // original left edge instead of leaving the leading digit visible.
    const adjacentFragments = words.filter((word) => {
      const text = String(word.text || '').trim();
      if (!word.bbox || word.bbox === region.bbox || !/^[\d.,|]+$/.test(text)) return false;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      const horizontalGap = Math.max(
        0,
        Math.max(region.bbox.x0, word.bbox.x0) - Math.min(region.bbox.x1, word.bbox.x1)
      );
      return (
        Math.abs(centerY - targetCenterY) <= rowHeight * 0.65 &&
        horizontalGap <= rowHeight * 0.45
      );
    });
    const recoveredX0 = Math.min(
      region.bbox.x0,
      ...adjacentFragments.map((word) => word.bbox.x0)
    );
    const recoveredX1 = Math.max(
      region.bbox.x1,
      ...adjacentFragments.map((word) => word.bbox.x1)
    );
    const rawWidth = recoveredX1 - recoveredX0;
    const normalizedBbox = hasSharedWeightRow
      ? {
          x0: recoveredX0,
          y0: sharedBottom - rowHeight,
          x1: Math.max(
            recoveredX1,
            recoveredX0 + rowHeight * Math.max(2.2, replacementText.length * 0.62)
          ),
          y1: sharedBottom,
        }
      : { ...region.bbox, x0: recoveredX0, x1: recoveredX1 };
    const estimatedOldLength = originalTextIsReliable
      ? region.originalText.length
      : Math.max(4, replacementText.length);
    const clearWidth = Math.max(
      rawWidth,
      rowHeight * Math.max(2.2, estimatedOldLength * 0.68)
    );
    normalizedBbox.x0 = Math.max(normalizedBbox.x0, cellLeft + safeInset);
    normalizedBbox.x1 = Math.min(normalizedBbox.x1, cellRight - safeInset);
    const clearBbox = {
      x0: Math.max(cellLeft + safeInset, normalizedBbox.x0 - 1),
      y0: Math.max(0, normalizedBbox.y0 - 2),
      x1: Math.min(
        cellRight - safeInset,
        normalizedBbox.x0 + clearWidth + Math.max(2, rowHeight * 0.35)
      ),
      y1: Math.min(analysis.meta.height, normalizedBbox.y1 + 2),
    };

    const styleReference = words
      .filter((word) => {
        const text = String(word.text || '').trim();
        if (
          !word.bbox ||
          !/\d/.test(text) ||
          word.bbox.x1 > normalizedBbox.x0 - rowHeight
        ) return false;
        const height = word.bbox.y1 - word.bbox.y0;
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        return (
          height >= rowHeight * 0.55 &&
          height <= rowHeight * 1.8 &&
          Math.abs(centerY - targetCenterY) <= rowHeight * 1.1
        );
      })
      .sort((a, b) => b.bbox.x1 - a.bbox.x1)[0];
    const useExternalStyle = !originalTextIsReliable || rawHeight > rowHeight * 1.8;

    return {
      bbox: normalizedBbox,
      clearBbox,
      replacementText,
      originalText: region.originalText,
      styleReferenceText: useExternalStyle && styleReference
        ? styleReference.text
        : originalTextIsReliable
          ? region.originalText
          : replacementText.replace(/\d/g, '0'),
      styleReferenceBbox: useExternalStyle && styleReference
        ? styleReference.bbox
        : region.bbox,
      fontScale: 1,
      textLeftPaddingRatio: 0.03,
    };
  });

  const editedBuffer = await imageEditor.replaceWeightRegions(processingInput, replacements);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, editedBuffer);

  return {
    status: 'ok',
    shipmentId: match.id,
    shipmentIdSource: match.source || 'ocr',
    appliedRotation: analysis.rotation,
    newWeight,
    replacedRegions: replacements.map((r) => ({
      originalText: r.originalText,
      newText: r.replacementText,
      bbox: r.bbox,
    })),
  };
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'shutdown') {
    await ocrService.terminate();
    process.exit(0);
    return;
  }

  if (msg.type === 'task') {
    const { taskId } = msg;
    try {
      const result = await processImage(msg.payload);
      parentPort.postMessage({ taskId, ok: true, result });
    } catch (err) {
      parentPort.postMessage({
        taskId,
        ok: false,
        error: { message: err.message, stack: err.stack },
      });
    }
  }
});
