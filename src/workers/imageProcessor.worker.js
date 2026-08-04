'use strict';

const path = require('path');
const fs = require('fs/promises');
const { parentPort } = require('worker_threads');

const ocrService = require('../services/ocr.service');
const imageEditor = require('../services/imageEditor.service');
const { shouldTryQuarterTurns } = require('../services/imageOrientation.service');
const { inferActualSiblingRegion } = require('../services/weightRegionFallback.service');
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

  if (regions.length === 1) {
    const inferredRegions = await inferActualSiblingRegion(
      processingInput,
      anchors,
      regions,
      analysis.meta
    );
    regions = [...inferredRegions, ...regions];
  }

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

  const replacements = regions.map((region) => {
    const regionWidth = region.bbox.x1 - region.bbox.x0;
    const regionHeight = region.bbox.y1 - region.bbox.y0;
    const replacementText = formatReplacementWeight(newWeight, region.originalText);
    const originalTextIsReliable = /^\d{1,6}(?:\.\d{1,3})?$/.test(region.originalText);
    const usesTinyScanFallback = regionHeight <= 12 && !originalTextIsReliable;
    const clearBbox =
      usesTinyScanFallback
        ? {
            // Never expand left: these low-resolution OCR boxes begin only
            // one pixel inside the table's vertical border.
            x0: region.bbox.x0,
            y0: Math.max(0, region.bbox.y0 - 1),
            x1: Math.min(
              analysis.meta.width,
              region.bbox.x1 + Math.max(4, regionWidth * 0.4)
            ),
            y1: Math.min(analysis.meta.height, region.bbox.y1 + 2),
          }
        : undefined;
    return {
      bbox: region.bbox,
      clearBbox,
      replacementText,
      originalText: region.originalText,
      styleReferenceText: usesTinyScanFallback
        ? replacementText.replace(/\d/g, '0')
        : region.originalText,
      fontScale: usesTinyScanFallback ? 0.82 : 1,
      textLeftPaddingRatio: usesTinyScanFallback ? 0.03 : undefined,
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
