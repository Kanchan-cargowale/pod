'use strict';

const path = require('path');
const fs = require('fs/promises');
const { parentPort } = require('worker_threads');

const ocrService = require('../services/ocr.service');
const imageEditor = require('../services/imageEditor.service');
const { findRotationIssue } = require('../services/imageOrientation.service');
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
  const processingInput = needsAutoOrientation
    ? await sharp(filePath).rotate().toBuffer()
    : filePath;
  const meta = needsAutoOrientation ? await sharp(processingInput).metadata() : originalMeta;

  const rotationIssue = findRotationIssue(meta);
  if (rotationIssue) {
    return {
      status: 'error',
      errorCode: rotationIssue.code,
      reason: rotationIssue.reason,
      detectedOrientation: originalMeta.orientation || rotationIssue.orientation,
    };
  }

  const { words } = await ocrService.recognize(processingInput);

  const ocrMatch = findShipmentId(words, idSet, {
    minConfidence: config.ocrMinConfidence,
    fuzzyMaxDistance: config.matching.idFuzzyMaxDistance,
  });
  const filenameMatch = findShipmentIdInFilename(path.basename(filePath), idSet);
  // Prefer a clean OCR exact match. When OCR found nothing or only a fuzzy
  // candidate, an exact ID token in the filename is safer.
  const match = ocrMatch?.distance === 0 ? ocrMatch : filenameMatch || ocrMatch;

  if (!match) {
    return {
      status: 'unmatched',
      reason: 'No shipment ID from the mapping sheet was found in the label text or filename',
      detectedNumbers: extractCandidateIds(words, config.ocrMinConfidence),
    };
  }

  const newWeight = idWeightMap.get(match.id);
  const anchors = findWeightAnchors(words);
  const regions = findWeightValueRegions(words, anchors, {
    imageHeight: meta.height,
    verticalWindowRatio: config.matching.verticalSearchWindowRatio,
    horizontalTolerancePx: config.matching.horizontalTolerancePx,
  });

  if (!regions.length) {
    return {
      status: 'id_matched_no_weight_region',
      shipmentId: match.id,
      newWeight,
      reason: 'Shipment ID matched but no "WEIGHT" column value could be located',
      detectedWeightAnchors: anchors.map((a) => a.words.map((w) => w.text).join(' ')),
    };
  }

  const replacements = regions.map((region) => ({
    bbox: region.bbox,
    replacementText: formatReplacementWeight(newWeight, region.originalText),
    originalText: region.originalText,
  }));

  const editedBuffer = await imageEditor.replaceWeightRegions(processingInput, replacements);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, editedBuffer);

  return {
    status: 'ok',
    shipmentId: match.id,
    shipmentIdSource: match.source || 'ocr',
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
