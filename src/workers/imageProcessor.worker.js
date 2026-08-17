'use strict';

const path = require('path');
const fs = require('fs/promises');
const { parentPort } = require('worker_threads');

const ocrService = require('../services/ocr.service');
const imageEditor = require('../services/imageEditor.service');
const { shouldTryQuarterTurns } = require('../services/imageOrientation.service');
const {
  inferActualSiblingRegion,
  inferSiblingFromTableRules,
  inferSingleWeightRegionFromAnchor,
  inferWeightRegionsFromAnchors,
  inferWeightRegionsFromTable,
  localizeWeightInkInCells,
} = require('../services/weightRegionFallback.service');
const {
  findShipmentId,
  findWeightAnchors,
  findWeightValueRegions,
  formatSharedReplacementWeight,
  buildMergedNumericCandidates,
} = require('../services/labelMatcher.service');
const config = require('../config');
const sharp = require('sharp');

if (!parentPort) {
  throw new Error('imageProcessor.worker.js must be run as a worker_thread');
}

const { NON_DIGIT } = require('../constants/regex');

const OCR_MAX_DIMENSION = Number(process.env.OCR_MAX_DIMENSION || 4800);
const OCR_MAX_PIXELS = Number(process.env.OCR_MAX_PIXELS || 16000000);

function boundedOcrScale(width, height, desiredScale) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const maxByDimension = OCR_MAX_DIMENSION / Math.max(safeWidth, safeHeight);
  const maxByPixels = Math.sqrt(OCR_MAX_PIXELS / (safeWidth * safeHeight));
  return Math.max(1, Math.min(desiredScale, maxByDimension, maxByPixels));
}

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

function detectImageShipmentId(words, meta, matchedId = null) {
  const candidates = [];
  for (const word of words) {
    const digits = String(word.text || '').replace(NON_DIGIT, '');
    if (digits.length < 7 || digits.length > 12) continue;
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    if (centerY > meta.height * 0.25) continue;
    candidates.push({
      id: digits,
      confidence: word.confidence || 0,
      bbox: word.bbox,
      source: 'image_header_ocr',
      centerX,
      centerY,
    });
  }
  for (const candidate of buildMergedNumericCandidates(words)) {
    if (candidate.text.length < 7 || candidate.text.length > 12 || !candidate.words?.length) continue;
    const x0 = Math.min(...candidate.words.map((word) => word.bbox.x0));
    const x1 = Math.max(...candidate.words.map((word) => word.bbox.x1));
    const y0 = Math.min(...candidate.words.map((word) => word.bbox.y0));
    const y1 = Math.max(...candidate.words.map((word) => word.bbox.y1));
    const centerX = (x0 + x1) / 2;
    const centerY = (y0 + y1) / 2;
    if (centerY > meta.height * 0.25) continue;
    candidates.push({
      id: candidate.text,
      confidence: candidate.confidence || 0,
      bbox: { x0, y0, x1, y1 },
      source: 'image_header_fragments',
      centerX,
      centerY,
    });
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  unique.forEach((candidate) => {
    const height = candidate.bbox.y1 - candidate.bbox.y0;
    candidate.score = candidate.confidence +
      (candidate.centerX >= meta.width * 0.38 ? 35 : 0) +
      (candidate.centerY <= meta.height * 0.16 ? 20 : 0) +
      (candidate.id.length >= 8 && candidate.id.length <= 10 ? 18 : 0) +
      Math.min(15, height) +
      (matchedId && candidate.id === matchedId ? 45 : 0);
  });
  return unique.sort((a, b) => b.score - a.score)[0] || null;
}

function buildWeightClearBbox(region, meta, anchors) {
  const width = region.bbox.x1 - region.bbox.x0;
  const height = region.bbox.y1 - region.bbox.y0;
  const originalLength = Math.max(4, String(region.originalText || '').length);
  const horizontalPad = Math.max(4, height * 0.35, width / originalLength);
  const verticalPad = Math.max(2, height * 0.18);

  let x0 = Math.max(0, region.bbox.x0 - Math.min(1, horizontalPad * 0.15));
  let y0 = Math.max(0, region.bbox.y0 - verticalPad);
  let x1 = Math.min(meta.width, region.bbox.x1 + Math.min(horizontalPad * 1.2, width * 0.35));
  let y1 = Math.min(meta.height, region.bbox.y1 + verticalPad);

  if (region.cellBounds) {
    // Geometry only clips the edit; it must never enlarge the OCR ink box.
    const guard = Math.max(2, Math.min(5, height * 0.25));
    x0 = Math.max(x0, region.cellBounds.x0 + guard);
    x1 = Math.min(x1, region.cellBounds.x1 - guard);
  }

  if (anchors.length) {
    const anchorBelow = anchors.filter((a) => a.bbox.y0 >= region.bbox.y1);
    const closestBelow = anchorBelow.sort((a, b) => a.bbox.y0 - b.bbox.y0)[0];
    if (closestBelow) {
      y1 = Math.min(y1, closestBelow.bbox.y0 - 1);
    }
    const anchorAbove = anchors.filter((a) => a.bbox.y1 <= region.bbox.y0);
    const closestAbove = anchorAbove.sort((a, b) => b.bbox.y1 - a.bbox.y1)[0];
    if (closestAbove) {
      y0 = Math.max(y0, closestAbove.bbox.y1 + 1);
    }
  }

  if (y1 <= y0) y1 = y0 + Math.max(4, height * 0.5);
  if (x1 <= x0) x1 = x0 + Math.max(4, width * 0.5);

  return { x0, y0, x1, y1 };
}

async function writeOutputNamedByShipmentId(outputPath, shipmentId, editedBuffer) {
  const outputDir = path.dirname(outputPath);
  const ext = path.extname(outputPath) || '.jpg';
  const safeShipmentId = String(shipmentId).replace(/[^a-z0-9_-]/gi, '_');

  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const suffix = attempt === 1 ? '' : `_${attempt}`;
    const outputFilename = `${safeShipmentId}${suffix}${ext}`;
    const candidatePath = path.join(outputDir, outputFilename);
    try {
      await fs.writeFile(candidatePath, editedBuffer, { flag: 'wx' });
      return { outputPath: candidatePath, outputFilename };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  throw new Error(`Could not create a unique output filename for shipment ID ${shipmentId}`);
}

function isActualQualifierToken(text) {
  const normalized = String(text || '').replace(/[^a-z]/gi, '').toLowerCase();
  if (/^(?:actual|ctual)$/.test(normalized)) return true;

  // Tesseract sometimes merges the dimensions heading and ACTUAL into one
  // token, for example `(L×W×H)[ACTUAL`. Accept only short header-like
  // suffix merges; table position checks remain responsible for ownership.
  return normalized.length > 'actual'.length &&
    normalized.length <= 14 &&
    normalized.endsWith('actual');
}

function isChargedQualifierToken(text) {
  const normalized = String(text || '').replace(/[^a-z]/gi, '').toLowerCase();
  // Do not accept product words such as "Charges", "Charger" or
  // "charging" from SAID TO CONTAIN as a business-column heading.
  return /^(?:charged|chargeable|chargd|chargeq|charget|cherged)$/.test(normalized);
}

function hasChargedHeaderEvidence(words, anchors, meta) {
  return anchors.some((anchor) =>
    anchor.words.some((word) => isChargedQualifierToken(word.text))
  ) || words.some((word) => {
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    return isChargedQualifierToken(word.text) &&
      centerX < meta.width * 0.62 && centerY > meta.height * 0.2 && centerY < meta.height * 0.72;
  });
}

function hasActualHeaderEvidence(words, anchors, meta) {
  return anchors.some((anchor) =>
    anchor.words.some((word) => isActualQualifierToken(word.text))
  ) || words.some((word) => {
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    return isActualQualifierToken(word.text) &&
      centerX < meta.width * 0.62 && centerY > meta.height * 0.2 && centerY < meta.height * 0.72;
  });
}

function findSaidToContainLeft(words, meta) {
  const candidates = words
    .filter((word) => /said|contain/i.test(String(word.text || '').replace(/[^a-z]/gi, '')))
    .filter((word) => {
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      return centerX > meta.width * 0.28 &&
        centerX < meta.width * 0.72 &&
        centerY > meta.height * 0.22 &&
        centerY < meta.height * 0.72;
    })
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return candidates[0]?.bbox.x0 ?? null;
}

function hasSaidToContainImmediatelyRight(words, region, meta) {
  const regionCenterY = (region.bbox.y0 + region.bbox.y1) / 2;
  const rightWords = words
    .filter((word) => {
      const normalized = String(word.text || '').replace(/[^a-z]/gi, '');
      if (!/^(?:said|contain|to)$/i.test(normalized)) return false;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      return word.bbox.x0 > region.bbox.x0 &&
        word.bbox.x0 - region.bbox.x0 <= meta.width * 0.22 &&
        Math.abs(centerY - regionCenterY) <= meta.height * 0.13;
    })
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const text = rightWords
    .slice(0, 4)
    .map((word) => String(word.text || '').replace(/[^a-z]/gi, '').toLowerCase())
    .join(' ');
  return /said/.test(text) || /contain/.test(text);
}

async function writeReviewOutput(outputPath, imageId, imageInput) {
  const buffer = Buffer.isBuffer(imageInput) ? imageInput : await fs.readFile(imageInput);
  if (imageId) return writeOutputNamedByShipmentId(outputPath, imageId, buffer);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const outputFilename = path.basename(outputPath);
  await fs.writeFile(outputPath, buffer);
  return { outputPath, outputFilename };
}

/**
 * Processes a single label image:
 *   1. OCR the whole page.
 *   2. Identify which shipment ID (from the mapping) is printed on it.
 *   3. Locate the weight value cell(s) belonging to that label.
 *   4. Overwrite just those pixels with the new weight, byte-for-byte
 *      preserving everything else, and write the result to disk.
 */
async function processImage({ filePath, outputPath, idWeightMap, preserveOnly = false, preserveReason = null }) {
  const startedAtMs = Date.now();
  const elapsedMs = () => Date.now() - startedAtMs;
  const idSet = new Set(idWeightMap.keys());
  // Upload filenames in this workflow normally contain the Delhivery ID.
  // Treat that only as a fallback and only when it is an exact key from the
  // uploaded sheet. This rescues scans whose header OCR is blank/noisy while
  // making it impossible for timestamps, row numbers or address digits to
  // become a fabricated match.
  const filenameDigits = path.basename(filePath).match(/\d{7,12}/g) || [];
  const filenameId = filenameDigits
    .filter((digits) => idSet.has(digits))
    .sort((a, b) => b.length - a.length)[0] || null;
  const filenameMatch = filenameId ? {
    id: filenameId,
    distance: 0,
    confidence: 100,
    score: 100,
    source: 'filename_exact_sheet_match',
    words: [],
  } : null;
  const originalMeta = await sharp(filePath).metadata();
  const needsAutoOrientation = Boolean(originalMeta.orientation && originalMeta.orientation !== 1);
  // Sharp's rotate() with no angle applies the EXIF transform and removes the
  // tag. OCR and editing must use these same normalized pixels/coordinates.
  const initialInput = needsAutoOrientation
    ? await sharp(filePath).rotate().toBuffer()
    : filePath;
  const initialMeta = needsAutoOrientation ? await sharp(initialInput).metadata() : originalMeta;

  if (preserveOnly) {
    // Recovery must be cheap. The previous path repeated the complete OCR and
    // orientation cascade merely to copy the original after an error, which
    // could consume another timeout slot and worsen a congested batch.
    const artifact = await writeReviewOutput(outputPath, filenameMatch?.id || null, initialInput);
    return {
      status: 'error',
      reason: preserveReason || 'Image editing failed; preserved original scan for review',
      shipmentId: filenameMatch?.id || null,
      shipmentIdSource: filenameMatch?.source || 'unavailable',
      detectedImageId: filenameMatch?.id || null,
      appliedRotation: needsAutoOrientation ? 'exif' : 0,
      processingMs: elapsedMs(),
      outputFilename: artifact.outputFilename,
      downloadable: true,
    };
  }

  function buildAnalysis(input, meta, rotation, words) {
    const ocrMatch = findShipmentId(words, idSet, {
      minConfidence: config.ocrMinConfidence,
      fuzzyMaxDistance: config.matching.idFuzzyMaxDistance,
      imageWidth: meta.width,
      imageHeight: meta.height,
    });
    // A clean exact OCR read remains first choice. Otherwise an exact
    // filename+sheet agreement outranks fuzzy/noisy OCR.
    const match = ocrMatch?.distance === 0 ? ocrMatch : (filenameMatch || ocrMatch);
    const anchors = findWeightAnchors(words);
    const regions = findWeightValueRegions(words, anchors, {
      imageHeight: meta.height,
      verticalWindowRatio: config.matching.verticalSearchWindowRatio,
      horizontalTolerancePx: config.matching.horizontalTolerancePx,
    });
    return { input, meta, rotation, words, match, anchors, regions };
  }

  function isBetterAnalysis(candidate, current) {
    const candidateDistance = candidate.match?.distance ?? Infinity;
    const currentDistance = current.match?.distance ?? Infinity;
    return (
      (candidate.match && !current.match) ||
      (candidate.match && current.match && candidateDistance < currentDistance) ||
      (Boolean(candidate.match) === Boolean(current.match) &&
        candidateDistance === currentDistance &&
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

  async function readShipmentIdZones(input, meta) {
    const zones = [
      { left: 0, top: 0, width: 1, height: 0.22, scale: 3 },
      { left: 0.42, top: 0, width: 0.58, height: 0.22, scale: 4 },
      { left: 0.32, top: 0, width: 0.38, height: 0.18, scale: 4 },
    ];
    const words = [];

    for (const zone of zones) {
      const crop = {
        left: Math.max(0, Math.floor(meta.width * zone.left)),
        top: Math.max(0, Math.floor(meta.height * zone.top)),
        width: Math.max(1, Math.round(meta.width * zone.width)),
        height: Math.max(1, Math.round(meta.height * zone.height)),
      };
      crop.width = Math.min(crop.width, meta.width - crop.left);
      crop.height = Math.min(crop.height, meta.height - crop.top);
      if (crop.width <= 0 || crop.height <= 0) continue;

      const scale = boundedOcrScale(crop.width, crop.height, zone.scale);
      // eslint-disable-next-line no-await-in-loop
      const zoneInput = await sharp(input)
        .extract(crop)
        .resize({
          width: Math.round(crop.width * scale),
          height: Math.round(crop.height * scale),
        })
        .greyscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      // eslint-disable-next-line no-await-in-loop
      const zoneOcr = await ocrService.recognize(zoneInput);
      words.push(...mapOcrWords(zoneOcr.words, scale, crop.left, crop.top));
    }

    return words;
  }

  function mergeWords(...wordGroups) {
    const seen = new Set();
    const merged = [];
    for (const word of wordGroups.flat()) {
      const key = [
        word.text,
        Math.round(word.bbox.x0),
        Math.round(word.bbox.y0),
        Math.round(word.bbox.x1),
        Math.round(word.bbox.y1),
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(word);
    }
    return merged;
  }

  async function inspectOrientation(input, meta, rotation, options = {}) {
    const allowFallbackOcr = options.allowFallbackOcr !== false;
    const { words } = await ocrService.recognize(input);
    let result = buildAnalysis(input, meta, rotation, words);
    let shipmentIdZoneWords = null;

    async function getShipmentIdZoneWords() {
      if (!shipmentIdZoneWords) {
        shipmentIdZoneWords = await readShipmentIdZones(input, meta);
      }
      return shipmentIdZoneWords;
    }

    if (!result.match || result.match.distance > 0) {
      const idZoneWords = await getShipmentIdZoneWords();
      if (idZoneWords.length) {
        const idZoneResult = buildAnalysis(
          input,
          meta,
          rotation,
          mergeWords(result.words, idZoneWords)
        );
        if (isBetterAnalysis(idZoneResult, result)) result = idZoneResult;
      }
    }

    if (allowFallbackOcr && result.regions.length < 2) {
      // Faint scans can preserve readable values while Tesseract drops the
      // light-gray header or one of two adjacent weight columns. Enlarge a
      // temporary OCR-only copy, then map every detected coordinate back to
      // the untouched source image. A true single-column label remains a
      // single result after this pass.
      const enhancedScale = boundedOcrScale(meta.width, meta.height, 3);
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
      const enhancedIdWords = result.match && result.match.distance === 0
        ? []
        : await getShipmentIdZoneWords();
      const mergedEnhancedWords = mergeWords(result.words, enhancedWords, enhancedIdWords);
      const enhancedResult = buildAnalysis(
        input,
        meta,
        rotation,
        // Keep the base OCR headers when enhanced OCR is needed for a faint
        // value. Replacing the word set entirely made one of the two column
        // headers disappear on scans such as 287980980.
        mergedEnhancedWords
      );
      if (isBetterAnalysis(enhancedResult, result)) {
        result = enhancedResult;
      } else {
        // Even when the enhanced pass does not increase the initial anchor or
        // region count, its tokens may contain the missing old value inside a
        // structurally proven cell. Retain those words for final row cleanup
        // and rebuild header evidence without replacing the better match.
        result = {
          ...result,
          words: mergedEnhancedWords,
          anchors: enhancedResult.anchors,
        };
      }
    }

    if (allowFallbackOcr && !result.regions.length) {
      // Whole-page OCR can completely miss 5-8px weight text on bright or
      // overexposed phone photos. Re-read only the stable left-side table
      // band at high resolution. Coordinates are mapped back to source pixels
      // before matching/editing, so the output image itself is never resized.
      const crop = {
        left: Math.max(0, Math.floor(meta.width * 0.01)),
        top: Math.max(0, Math.floor(meta.height * 0.24)),
        width: Math.max(1, Math.round(meta.width * 0.57)),
        height: Math.max(1, Math.round(meta.height * 0.42)),
      };
      crop.width = Math.min(crop.width, meta.width - crop.left);
      crop.height = Math.min(crop.height, meta.height - crop.top);
      const tableScale = boundedOcrScale(crop.width, crop.height, 5);
      const tableInput = await sharp(input)
        .extract(crop)
        .resize({
          width: Math.round(crop.width * tableScale),
          height: Math.round(crop.height * tableScale),
        })
        .greyscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      const tableOcr = await ocrService.recognize(tableInput);
      const tableWords = mapOcrWords(tableOcr.words, tableScale, crop.left, crop.top);
      const tableResult = buildAnalysis(
        input,
        meta,
        rotation,
        mergeWords(result.words, tableWords)
      );
      if (isBetterAnalysis(tableResult, result)) result = tableResult;
    }

    if (allowFallbackOcr && !result.regions.length && meta.height > meta.width * 1.1) {
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
      const tileScale = boundedOcrScale(crop.width, crop.height, 6);
      const tileInput = await sharp(input)
        .extract(crop)
        .resize({
          width: Math.round(crop.width * tileScale),
          height: Math.round(crop.height * tileScale),
        })
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

    result.fallbackOcrSkipped = !allowFallbackOcr;
    return result;
  }

  const mayNeedQuarterTurn = shouldTryQuarterTurns(initialMeta);
  let analysis = await inspectOrientation(initialInput, initialMeta, 0, {
    allowFallbackOcr: !mayNeedQuarterTurn,
  });

  // A tall image may be an upright portrait scan or a sideways landscape
  // label. Never reject it from dimensions alone. If the uploaded orientation
  // cannot locate a weight, let OCR decide whether either quarter-turn is
  // materially better and use that orientation for both editing and output.
  if (mayNeedQuarterTurn && !analysis.regions.length) {
    for (const rotation of [90, 270]) {
      // eslint-disable-next-line no-await-in-loop
      const rotatedInput = await sharp(initialInput).rotate(rotation).toBuffer();
      // eslint-disable-next-line no-await-in-loop
      const rotatedMeta = await sharp(rotatedInput).metadata();
      // eslint-disable-next-line no-await-in-loop
      const candidate = await inspectOrientation(rotatedInput, rotatedMeta, rotation, {
        allowFallbackOcr: false,
      });

      if (isBetterAnalysis(candidate, analysis)) analysis = candidate;
    }
  }

  if (analysis.fallbackOcrSkipped && analysis.regions.length < 2) {
    const fullAnalysis = await inspectOrientation(analysis.input, analysis.meta, analysis.rotation);
    if (isBetterAnalysis(fullAnalysis, analysis)) analysis = fullAnalysis;
  }

  const { input: processingInput, words, match, anchors } = analysis;
  let { regions } = analysis;
  let strictAlignedPairProven = false;
  let singleStructuralAttempt = [];
  // Once OCR has matched a mapping-sheet ID, that exact ID is authoritative.
  // A second generic header scan can otherwise outscore it with an address or
  // postal-number fragment and incorrectly rename an otherwise correct file.
  const detectedImageId = match
    ? { id: match.id, source: match.source || 'mapping_match' }
    : detectImageShipmentId(words, analysis.meta, null);

  async function reviewResult(details) {
    const artifact = await writeReviewOutput(
      outputPath,
      detectedImageId?.id || match?.id || null,
      processingInput
    );
    return {
      ...details,
      shipmentId: details.shipmentId || detectedImageId?.id || match?.id,
      shipmentIdSource: detectedImageId?.source || match?.source || 'unavailable',
      detectedImageId: detectedImageId?.id || null,
      appliedRotation: analysis.rotation,
      outputFilename: artifact.outputFilename,
      downloadable: true,
    };
  }

  // Base and enhanced OCR may return the same physical value as two distinct
  // word objects. Without spatial de-duplication each copy can be assigned to
  // a different header, falsely producing two replacements in the ACTUAL
  // cell while leaving CHARGED untouched.
  regions = [...regions]
    .sort((a, b) => a.bbox.x0 - b.bbox.x0)
    .filter((region, index, all) => {
      const width = Math.max(1, region.bbox.x1 - region.bbox.x0);
      const centerX = (region.bbox.x0 + region.bbox.x1) / 2;
      return !all.slice(0, index).some((previous) => {
        const previousWidth = Math.max(1, previous.bbox.x1 - previous.bbox.x0);
        const previousCenterX = (previous.bbox.x0 + previous.bbox.x1) / 2;
        const overlap = Math.max(
          0,
          Math.min(region.bbox.x1, previous.bbox.x1) - Math.max(region.bbox.x0, previous.bbox.x0)
        );
        return overlap >= Math.min(width, previousWidth) * 0.55 ||
          Math.abs(centerX - previousCenterX) < Math.min(width, previousWidth) * 0.6;
      });
    });

  function countWeightColumns(anchors, meta) {
    const weightAnchors = anchors
      .filter((anchor) => {
        const centerX = (anchor.bbox.x0 + anchor.bbox.x1) / 2;
        const centerY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
        return centerX < meta.width * 0.62 &&
          centerY > meta.height * 0.2 && centerY < meta.height * 0.68 &&
          anchor.words.some((word) => /weight|weigh|actual|ctual|charg|chargeable/i.test(word.text));
      })
      .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    if (!weightAnchors.length) return 1;

    const actualAnchors = weightAnchors.filter((anchor) =>
      anchor.words.some((word) => isActualQualifierToken(word.text))
    );
    const chargedAnchors = weightAnchors.filter((anchor) =>
      /charg|chargeable/i.test(anchor.words.map((word) => word.text).join(' '))
    );
    const explicitPair = actualAnchors.some((actualAnchor) =>
      chargedAnchors.some((chargedAnchor) => {
        if (actualAnchor === chargedAnchor) return false;
        const actualX = (actualAnchor.bbox.x0 + actualAnchor.bbox.x1) / 2;
        const chargedX = (chargedAnchor.bbox.x0 + chargedAnchor.bbox.x1) / 2;
        const actualY = (actualAnchor.bbox.y0 + actualAnchor.bbox.y1) / 2;
        const chargedY = (chargedAnchor.bbox.y0 + chargedAnchor.bbox.y1) / 2;
        return Math.abs(actualX - chargedX) >= meta.width * 0.045 &&
          Math.abs(actualY - chargedY) <= meta.height * 0.12;
      })
    );
    if (explicitPair) return 2;

    // On noisy photocopies Tesseract may recognize CHARGED but fail to join
    // it with the word WEIGHT, so it never becomes an anchor. The raw header
    // word is still decisive evidence of a second weight column when it sits
    // on the same table row and to the right of ACTUAL.
    const rawActualWords = words.filter((word) =>
      isActualQualifierToken(word.text) &&
      (word.bbox.x0 + word.bbox.x1) / 2 < meta.width * 0.62 &&
      (word.bbox.y0 + word.bbox.y1) / 2 > meta.height * 0.2 &&
      (word.bbox.y0 + word.bbox.y1) / 2 < meta.height * 0.68
    );
    const rawChargedWords = words.filter((word) =>
      /charg|chargeable/i.test(String(word.text || '')) &&
      (word.bbox.x0 + word.bbox.x1) / 2 < meta.width * 0.62 &&
      (word.bbox.y0 + word.bbox.y1) / 2 > meta.height * 0.2 &&
      (word.bbox.y0 + word.bbox.y1) / 2 < meta.height * 0.68
    );
    if (rawActualWords.some((actualWord) => rawChargedWords.some((chargedWord) => {
      const actualX = (actualWord.bbox.x0 + actualWord.bbox.x1) / 2;
      const chargedX = (chargedWord.bbox.x0 + chargedWord.bbox.x1) / 2;
      const actualY = (actualWord.bbox.y0 + actualWord.bbox.y1) / 2;
      const chargedY = (chargedWord.bbox.y0 + chargedWord.bbox.y1) / 2;
      return chargedX - actualX >= meta.width * 0.045 &&
        Math.abs(chargedY - actualY) <= meta.height * 0.04;
    }))) return 2;

    const groups = [];
    for (const anchor of weightAnchors) {
      const centerY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
      const height = anchor.bbox.y1 - anchor.bbox.y0;
      const group = groups.find((entry) =>
        Math.abs(entry.centerY - centerY) <= Math.max(entry.height, height) * 0.9
      );
      if (group) group.anchors.push(anchor);
      else groups.push({ centerY, height, anchors: [anchor] });
    }
    groups.sort((a, b) => b.anchors.length - a.anchors.length || a.centerY - b.centerY);
    const primary = groups[0].anchors;
    if (primary.length < 2) return 1;
    const centers = primary
      .map((anchor) => (anchor.bbox.x0 + anchor.bbox.x1) / 2)
      .sort((a, b) => a - b);
    return centers.some((center, index) =>
      index > 0 && center - centers[index - 1] >= meta.width * 0.045
    ) ? 2 : 1;
  }

  function isWeightRegion(region) {
    const text = (region.anchorText || '').toLowerCase();
    return /weight|weigh|actual|ctual|charg|chargeable|structural|inferred/.test(text);
  }

  function regionOverlapsAnchor(region, anchors) {
    const rx0 = region.bbox.x0;
    const rx1 = region.bbox.x1;
    const ry0 = region.bbox.y0;
    const ry1 = region.bbox.y1;
    const rWidth = rx1 - rx0;
    const rHeight = ry1 - ry0;
    const regionArea = rWidth * rHeight;
    if (regionArea <= 0) return false;
    return anchors.some((anchor) => {
      const ax0 = anchor.bbox.x0;
      const ax1 = anchor.bbox.x1;
      const ay0 = anchor.bbox.y0;
      const ay1 = anchor.bbox.y1;
      const overlapX = Math.max(0, Math.min(rx1, ax1) - Math.max(rx0, ax0));
      const overlapY = Math.max(0, Math.min(ry1, ay1) - Math.max(ry0, ay0));
      const overlapArea = overlapX * overlapY;
      const overlapRatioRegion = overlapArea / regionArea;
      return overlapRatioRegion >= 0.75;
    });
  }

  function sanitizeRegionBbox(region, anchors, meta) {
    const sanitized = { ...region, bbox: { ...region.bbox } };
    if (regionOverlapsAnchor(sanitized, anchors)) {
      const anchorBelow = anchors.filter((a) => a.bbox.y0 >= sanitized.bbox.y1);
      const closestBelow = anchorBelow.sort((a, b) => a.bbox.y0 - b.bbox.y0)[0];
      if (closestBelow) {
        sanitized.bbox.y1 = Math.min(sanitized.bbox.y1, closestBelow.bbox.y0 - 2);
      }
      const anchorAbove = anchors.filter((a) => a.bbox.y1 <= sanitized.bbox.y0);
      const closestAbove = anchorAbove.sort((a, b) => b.bbox.y1 - a.bbox.y1)[0];
      if (closestAbove) {
        sanitized.bbox.y0 = Math.max(sanitized.bbox.y0, closestAbove.bbox.y1 + 2);
      }
      if (sanitized.bbox.y1 <= sanitized.bbox.y0) {
        sanitized.bbox.y1 = sanitized.bbox.y0 + 10;
      }
    }
    return sanitized;
  }

  function clampTallNumericRegion(region, meta) {
    const digitCount = String(region.originalText || '').replace(/\D/g, '').length;
    if (digitCount < 2) return region;
    const height = region.bbox.y1 - region.bbox.y0;
    const safeHeight = Math.max(12, meta.height * 0.022);
    if (height <= safeHeight) return region;

    const centerY = (region.bbox.y0 + region.bbox.y1) / 2;
    const nextHeight = Math.min(height, safeHeight);
    return {
      ...region,
      bbox: {
        ...region.bbox,
        y0: Math.max(0, centerY - nextHeight / 2),
        y1: Math.min(meta.height, centerY + nextHeight / 2),
      },
    };
  }

  function extractWeightNumber(text) {
    const match = String(text || '').match(/\d{1,6}(?:[.,]\d{1,3})?/);
    return match ? match[0].replace(',', '.') : '';
  }

  function inferVisibleWeightValueRegions(words, anchors, meta) {
    const tableAnchors = anchors.filter((anchor) => {
      const centerX = (anchor.bbox.x0 + anchor.bbox.x1) / 2;
      const centerY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
      return centerX < meta.width * 0.62 &&
        centerY > meta.height * 0.22 &&
        centerY < meta.height * 0.72;
    });
    const headerBottom = tableAnchors.length
      ? Math.max(...tableAnchors.map((anchor) => anchor.bbox.y1))
      : null;

    const candidates = words
      .map((word) => {
        const numberText = extractWeightNumber(word.text);
        if (!numberText) return null;
        const digitCount = numberText.replace(/\D/g, '').length;
        const hasDecimal = /[.,]/.test(numberText);
        if (digitCount < 2 || (!hasDecimal && digitCount < 3)) return null;
        const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        const height = word.bbox.y1 - word.bbox.y0;
        if (centerX < meta.width * 0.025 || centerX > meta.width * 0.5) return null;
        if (centerY < meta.height * 0.28 || centerY > meta.height * 0.72) return null;
        if (height <= 0 || height > Math.max(34, meta.height * 0.06)) return null;
        if (headerBottom !== null) {
          const gap = word.bbox.y0 - headerBottom;
          if (gap < -Math.max(10, meta.height * 0.018) || gap > meta.height * 0.18) return null;
        }
        return {
          word,
          numberText,
          centerX,
          centerY,
          score: (hasDecimal ? 40 : 0) + Math.min(30, word.confidence || 0),
        };
      })
      .filter(Boolean);

    let bestPair = null;
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const left = candidates[i].centerX <= candidates[j].centerX ? candidates[i] : candidates[j];
        const right = left === candidates[i] ? candidates[j] : candidates[i];
        const separation = right.centerX - left.centerX;
        const rowDrift = Math.abs(right.centerY - left.centerY);
        if (separation < meta.width * 0.065 || separation > meta.width * 0.22) continue;
        if (rowDrift > Math.max(22, meta.height * 0.045)) continue;

        const score = left.score + right.score - rowDrift - Math.abs(separation - meta.width * 0.12) * 0.08;
        if (!bestPair || score > bestPair.score) bestPair = { left, right, score };
      }
    }

    if (!bestPair) return [];
    return [bestPair.left, bestPair.right].map((candidate, index) => ({
      bbox: { ...candidate.word.bbox },
      originalText: candidate.numberText,
      anchorText: index === 0
        ? 'visible ACTUAL WEIGHT value row'
        : 'visible CHARGED WEIGHT value row',
      kind: index === 0 ? 'actual' : 'charged',
    })).map((region) => clampTallNumericRegion(region, meta));
  }

  async function detectTemplateBoundaryKind(imageInput, meta) {
    const { data, info } = await sharp(imageInput)
      .greyscale()
      .normalize()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const y0 = Math.round(info.height * 0.34);
    const y1 = Math.round(info.height * 0.67);
    const x0 = Math.round(info.width * 0.02);
    const x1 = Math.round(info.width * 0.56);
    const samples = [];
    for (let y = y0; y < y1; y += 3) {
      for (let x = x0; x < x1; x += 3) samples.push(data[y * info.width + x]);
    }
    const paper = samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.75)] || 220;
    const darkLimit = Math.min(205, paper - 18);
    const bandHeight = Math.max(1, y1 - y0);
    const scored = [];
    for (let x = x0; x < x1; x += 1) {
      let count = 0;
      let run = 0;
      let bestRun = 0;
      for (let y = y0; y < y1; y += 1) {
        if (data[y * info.width + x] < darkLimit) {
          count += 1;
          run += 1;
          bestRun = Math.max(bestRun, run);
        } else {
          run = 0;
        }
      }
      const score = Math.max(count, bestRun * 2);
      if (count > bandHeight * 0.025 || bestRun > bandHeight * 0.025) scored.push({ x, score });
    }
    const groups = [];
    for (const entry of scored) {
      const current = groups[groups.length - 1];
      if (current && entry.x <= current[current.length - 1].x + 2) current.push(entry);
      else groups.push([entry]);
    }
    const borders = groups
      .map((group) => group.reduce((best, entry) => (entry.score > best.score ? entry : best)))
      .filter((entry) => entry.score > Math.max(12, bandHeight * 0.05))
      .map((entry) => entry.x / info.width);
    if (borders.some((x) => x >= 0.41 && x <= 0.46)) return 'two';
    if (borders.some((x) => x >= 0.33 && x <= 0.405)) return 'single';
    return null;
  }

  async function inferBoundedTemplateWeightRegions(imageInput, words, anchors, meta, countHint) {
    const actualEvidence = hasActualHeaderEvidence(words, anchors, meta);
    const chargedEvidence = hasChargedHeaderEvidence(words, anchors, meta);
    const boundaryKind = await detectTemplateBoundaryKind(imageInput, meta);
    // A template ratio is useful for locating a proven field, but must never
    // create a business field. When OCR loses ACTUAL completely, permit only
    // the unmistakable single-column rule signature; it yields one ACTUAL
    // edit and can never manufacture CHARGED or enter SAID TO CONTAIN.
    if (!actualEvidence && boundaryKind !== 'single') return [];
    const actualWord = words
      .filter((word) => isActualQualifierToken(word.text))
      .filter((word) => {
        const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        return centerX < meta.width * 0.55 && centerY > meta.height * 0.24 && centerY < meta.height * 0.7;
      })
      .sort((a, b) => b.confidence - a.confidence)[0];
    const chargedWord = words
      .filter((word) => /charg/i.test(String(word.text || '').replace(/[^a-z]/gi, '')))
      .filter((word) => !actualWord || word.bbox.x0 > actualWord.bbox.x0)
      .sort((a, b) => b.confidence - a.confidence)[0];
    const containWord = words
      .filter((word) => /contain/i.test(String(word.text || '').replace(/[^a-z]/gi, '')))
      .filter((word) => !actualWord || word.bbox.x0 > actualWord.bbox.x0)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];

    const actualX = actualWord
      ? actualWord.bbox.x0
      : Math.round(meta.width * 0.245);
    const columnStep = chargedWord
      ? chargedWord.bbox.x0 - actualX
      : containWord && countHint === 2
        ? (containWord.bbox.x0 - actualX) / 2
        : meta.width * 0.112;
    const normalizedStep = columnStep >= meta.width * 0.07 && columnStep <= meta.width * 0.18
      ? columnStep
      : meta.width * 0.112;

    const weakActualDigit = words.some((word) => {
      const digitCount = String(word.text || '').replace(/\D/g, '').length;
      if (!digitCount) return false;
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      return centerX > meta.width * 0.2 &&
        centerX < meta.width * 0.34 &&
        centerY > meta.height * 0.38 &&
        centerY < meta.height * 0.66;
    });
    const count = chargedEvidence ? 2 : 1;

    const headerBottom = Math.max(
      0,
      ...anchors.map((anchor) => anchor.bbox.y1),
      actualWord?.bbox.y1 || 0,
      chargedWord?.bbox.y1 || 0
    );
    const y0 = headerBottom
      ? Math.round(headerBottom + meta.height * 0.035)
      : Math.round(meta.height * 0.415);
    const height = Math.max(12, Math.round(meta.height * 0.023));
    const width = Math.max(34, Math.round(meta.width * 0.058));

    return Array.from({ length: count }, (_, index) => {
      const x0 = Math.round(actualX + normalizedStep * index);
      return {
        bbox: {
          x0,
          y0,
          x1: Math.min(meta.width, x0 + width),
          y1: Math.min(meta.height, y0 + height),
        },
        cellBounds: {
          x0: Math.max(0, x0 - width * 0.35),
          x1: Math.min(meta.width, x0 + width * 1.65),
        },
        originalText: '',
        anchorText: index === 0
          ? 'bounded ACTUAL WEIGHT template fallback'
          : 'bounded CHARGED WEIGHT template fallback',
        kind: index === 0 ? 'actual' : 'charged',
      };
    });
  }

  const explicitActualHeader = hasActualHeaderEvidence(words, anchors, analysis.meta);
  const explicitChargedHeader = hasChargedHeaderEvidence(words, anchors, analysis.meta);
  // Fail closed on column count. Two nearby WEIGHT-like anchors, two numeric
  // tokens, or two equal-width cells are not sufficient: all three patterns
  // also occur around BOXES & DIMENSION and SAID TO CONTAIN. A destructive
  // two-cell edit is allowed only when OCR independently identifies both
  // ACTUAL and CHARGED qualifiers. Later ruled-table recovery may locate the
  // cells, but it must not decide how many business fields exist.
  let expectedRegionCount = explicitActualHeader && explicitChargedHeader ? 2 : 1;

  // If CHARGED is the only qualifier OCR retained, its value can still prove
  // the normal two-column template when table rules find an equal-width cell
  // immediately to the left. This uses physical borders, not old value text.
  if (regions.length === 1 &&
      /charg/i.test(String(regions[0].anchorText || '')) &&
      hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    const ruledActual = await inferSiblingFromTableRules(
      processingInput,
      anchors,
      regions,
      analysis.meta
    );
    if (ruledActual.length === 1 && ruledActual[0].kind === 'actual') {
      regions = [...ruledActual, ...regions];
      expectedRegionCount = 2;
    }
  }

  if (regions.length > 1) {
    const minColumnSeparation = analysis.meta.width * 0.045;
    const maxRowDrift = Math.max(7, analysis.meta.height * 0.018);
    let bestPair = null;
    for (let i = 0; i < regions.length; i += 1) {
      for (let j = i + 1; j < regions.length; j += 1) {
        const firstCenterX = (regions[i].bbox.x0 + regions[i].bbox.x1) / 2;
        const secondCenterX = (regions[j].bbox.x0 + regions[j].bbox.x1) / 2;
        const firstCenterY = (regions[i].bbox.y0 + regions[i].bbox.y1) / 2;
        const secondCenterY = (regions[j].bbox.y0 + regions[j].bbox.y1) / 2;
        const separation = Math.abs(firstCenterX - secondCenterX);
        const rowDrift = Math.abs(firstCenterY - secondCenterY);
        if (separation < minColumnSeparation || rowDrift > maxRowDrift) continue;
        if (!bestPair || separation > bestPair.separation) {
          bestPair = { regions: [regions[i], regions[j]], separation };
        }
      }
    }
    if (bestPair) {
      regions = bestPair.regions;
    } else {
      regions = [[...regions].sort((a, b) => {
        const areaA = (a.bbox.x1 - a.bbox.x0) * (a.bbox.y1 - a.bbox.y0);
        const areaB = (b.bbox.x1 - b.bbox.x0) * (b.bbox.y1 - b.bbox.y0);
        return areaB - areaA;
      })[0]];
    }
  }

  regions = regions.filter((region) => !regionOverlapsAnchor(region, anchors));
  regions = regions.map((region) => sanitizeRegionBbox(region, anchors, analysis.meta));

  // Remove any regions that are not actually weight fields (e.g. container
  // description numbers that were picked up by OCR near a weight column).
  regions = regions.filter(isWeightRegion);

  const maxSafeValueHeight = Math.max(16, analysis.meta.height * 0.03);
  const hasUnsafeMergedRegion = regions.some(
    (region) => region.bbox.y1 - region.bbox.y0 > maxSafeValueHeight
  );

  // Never edit directly from a tall/merged OCR token when the printed table
  // can prove both cells and the value row. This is the primary path for
  // two-column PODs; OCR text remains useful for precision/style only.
  const structuralRegions = await inferWeightRegionsFromAnchors(
    processingInput,
    anchors,
    words,
    analysis.meta
  );
  const hasCompleteAlignedOcrPair = expectedRegionCount === 2 && regions.length === 2 &&
    regions.every((region) => /^\d{1,6}(?:[.,]\d{1,3})?$/.test(String(region.originalText || '').trim())) &&
    Math.abs(
      (regions[0].bbox.y0 + regions[0].bbox.y1) / 2 -
      (regions[1].bbox.y0 + regions[1].bbox.y1) / 2
    ) <= Math.max(8, analysis.meta.height * 0.018) &&
    Math.abs(
      (regions[0].bbox.x0 + regions[0].bbox.x1) / 2 -
      (regions[1].bbox.x0 + regions[1].bbox.x1) / 2
    ) >= analysis.meta.width * 0.045;
  if (structuralRegions.length === expectedRegionCount &&
      (!hasCompleteAlignedOcrPair &&
        (expectedRegionCount === 2 || regions.length < expectedRegionCount || hasUnsafeMergedRegion))) {
    const rawValueRegions = words
      .filter((word) => /^\d{1,6}(?:[.,]\d{1,3})?$/.test(String(word.text || '').trim()))
      .map((word) => ({
        bbox: word.bbox,
        originalText: String(word.text || '').trim().replace(',', '.'),
        ocrConfidence: Number(word.confidence) || 0,
      }));
    const ocrRegions = [...regions, ...rawValueRegions].filter((candidate, index, all) =>
      all.findIndex((other) =>
        Math.abs(other.bbox.x0 - candidate.bbox.x0) < 2 &&
        Math.abs(other.bbox.y0 - candidate.bbox.y0) < 2
      ) === index
    );
    const assignments = structuralRegions.map((structuralRegion) => {
      const structuralCenterX = structuralRegion.cellBounds
        ? structuralRegion.cellBounds.x0 +
          (structuralRegion.cellBounds.x1 - structuralRegion.cellBounds.x0) * 0.22
        : (structuralRegion.bbox.x0 + structuralRegion.bbox.x1) / 2;
      const structuralCenterY = (structuralRegion.bbox.y0 + structuralRegion.bbox.y1) / 2;
      const candidates = ocrRegions
        .filter((ocrRegion) => {
          const centerX = (ocrRegion.bbox.x0 + ocrRegion.bbox.x1) / 2;
          const centerY = (ocrRegion.bbox.y0 + ocrRegion.bbox.y1) / 2;
          const headerBottom = structuralRegion.anchorBbox?.y1 ||
            anchors
              .filter((anchor) => {
                const anchorCenterX = (anchor.bbox.x0 + anchor.bbox.x1) / 2;
                return Math.abs(anchorCenterX - structuralCenterX) < analysis.meta.width * 0.12;
              })
              .reduce((bottom, anchor) => Math.max(bottom, anchor.bbox.y1), 0);
          const minimumRowGap = Math.max(12, analysis.meta.height * 0.02);
          return (!structuralRegion.cellBounds ||
              (centerX > structuralRegion.cellBounds.x0 && centerX < structuralRegion.cellBounds.x1)) &&
            Math.abs(centerY - structuralCenterY) <= Math.max(16, analysis.meta.height * 0.05) &&
            ocrRegion.bbox.y0 - headerBottom >= minimumRowGap &&
            String(ocrRegion.originalText || '').replace(/\D/g, '').length >= 2;
        })
        .map((ocrRegion) => ({
          ocrRegion,
          distance: Math.abs((ocrRegion.bbox.x0 + ocrRegion.bbox.x1) / 2 - structuralCenterX),
          quality: /[.,]\d{1,3}$/.test(String(ocrRegion.originalText || '')) ? 0 : 1,
        }))
        .sort((a, b) => a.quality - b.quality || a.distance - b.distance);
      return { structuralRegion, candidates };
    });
    const usedOcrRegions = new Set();
    assignments
      .flatMap((assignment, structuralIndex) =>
        assignment.candidates.map((candidate) => ({ ...candidate, structuralIndex }))
      )
      .sort((a, b) => a.quality - b.quality || a.distance - b.distance)
      .forEach((candidate) => {
        const assignment = assignments[candidate.structuralIndex];
        if (assignment.match || usedOcrRegions.has(candidate.ocrRegion)) return;
        assignment.match = candidate.ocrRegion;
        usedOcrRegions.add(candidate.ocrRegion);
      });
    if (expectedRegionCount === 2 && hasChargedHeaderEvidence(words, anchors, analysis.meta) &&
        assignments.length === 2 && assignments.filter((assignment) => assignment.match).length === 1) {
      const sourceIndex = assignments[0].match ? 0 : 1;
      const targetIndex = sourceIndex === 0 ? 1 : 0;
      const source = assignments[sourceIndex];
      const target = assignments[targetIndex];
      const sourceCenter = (source.structuralRegion.bbox.x0 + source.structuralRegion.bbox.x1) / 2;
      const targetCenter = (target.structuralRegion.bbox.x0 + target.structuralRegion.bbox.x1) / 2;
      const shift = targetCenter - sourceCenter;
      target.match = {
        ...source.match,
        bbox: {
          x0: source.match.bbox.x0 + shift,
          y0: source.match.bbox.y0,
          x1: source.match.bbox.x1 + shift,
          y1: source.match.bbox.y1,
        },
        originalText: '',
      };
    }
    regions = assignments.map(({ structuralRegion, match: matchingOcrRegion }) => {
      if (!matchingOcrRegion) return structuralRegion;

      const ocrCenterX = (matchingOcrRegion.bbox.x0 + matchingOcrRegion.bbox.x1) / 2;
      const ocrHeight = matchingOcrRegion.bbox.y1 - matchingOcrRegion.bbox.y0;
      const insideOwnedCell = !structuralRegion.cellBounds ||
        (ocrCenterX > structuralRegion.cellBounds.x0 && ocrCenterX < structuralRegion.cellBounds.x1);
      const useOcrInkGeometry = insideOwnedCell && ocrHeight >= 3 && ocrHeight <= maxSafeValueHeight;

      return {
        ...structuralRegion,
        // A short OCR token inside the physically proven cell is the best
        // available description of the old ink itself. Keep its true x/y row
        // so erasure and replacement happen over the original value rather
        // than a guessed structural row. Unsafe merged/tall tokens still fall
        // back to table geometry.
        bbox: useOcrInkGeometry
          ? { ...matchingOcrRegion.bbox }
          : { ...structuralRegion.bbox },
        originalText: matchingOcrRegion.originalText,
        ocrConfidence: matchingOcrRegion.ocrConfidence,
      };
    });
  }

  if (anchors.length > 0 && regions.length < expectedRegionCount) {
    const tableRegions = await inferWeightRegionsFromTable(
      processingInput,
      analysis.meta,
      anchors
    );
    if (tableRegions.length === expectedRegionCount) regions = tableRegions;
  }

  // Damaged header OCR can count one column even though two equal ruled cells
  // and two printed values are present. Upgrade only when table geometry
  // independently proves two cells and its detected row agrees with the one
  // reliable OCR value; this cannot turn a single-ACTUAL template into two.
  if (regions.length === 1 && hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    const tablePair = await inferWeightRegionsFromTable(
      processingInput,
      analysis.meta,
      anchors
    );
    if (tablePair.length === 2) {
      const ocrCenterY = (regions[0].bbox.y0 + regions[0].bbox.y1) / 2;
      const pairCenterY = tablePair.reduce(
        (sum, region) => sum + (region.bbox.y0 + region.bbox.y1) / 2,
        0
      ) / tablePair.length;
      if (Math.abs(ocrCenterY - pairCenterY) <= Math.max(12, analysis.meta.height * 0.025)) {
        const sourceText = regions[0].originalText;
        regions = tablePair.map((region) => ({ ...region, originalText: sourceText }));
        expectedRegionCount = 2;
      }
    }
  }

  if (regions.length === 1 && hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    const source = regions[0];
    const sourceCenterX = (source.bbox.x0 + source.bbox.x1) / 2;
    const sourceCenterY = (source.bbox.y0 + source.bbox.y1) / 2;
    const sourceDigits = String(source.originalText || '').replace(/\D/g, '');
    const siblingWord = words
      .filter((word) => /^\d{1,6}(?:[.,]\d{1,3})?$/.test(String(word.text || '').trim()))
      .filter((word) => {
        const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        const separation = centerX - sourceCenterX;
        return separation >= analysis.meta.width * 0.07 &&
          separation <= analysis.meta.width * 0.16 &&
          Math.abs(centerY - sourceCenterY) <= Math.max(8, analysis.meta.height * 0.018) &&
          String(word.text || '').replace(/\D/g, '') === sourceDigits;
      })
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    if (siblingWord && sourceDigits.length >= 3) {
      const siblingText = String(siblingWord.text || '').trim().replace(',', '.');
      regions = [
        { ...source, kind: 'actual' },
        {
          ...source,
          bbox: { ...siblingWord.bbox },
          cellBounds: undefined,
          originalText: siblingText,
          anchorText: 'aligned OCR CHARGED WEIGHT sibling',
          kind: 'charged',
        },
      ];
      expectedRegionCount = 2;
    }
  }

  if (!regions.length && expectedRegionCount === 1) {
    const singleStructuralRegion = await inferSingleWeightRegionFromAnchor(
      processingInput,
      anchors,
      words,
      analysis.meta
    );
    singleStructuralAttempt = singleStructuralRegion;
    if (singleStructuralRegion.length === 1) regions = singleStructuralRegion;
  }

  // A normal printed value is a short, single text line. Enlarged OCR can
  // occasionally return a 30-40px box containing the two-line header plus the
  // value (observed as "1160"/"11168"). Such a box is never safe to erase.
  regions = regions.filter((region) => {
    const height = region.bbox.y1 - region.bbox.y0;
    if (height <= maxSafeValueHeight) return true;
    const closestHeaderBottom = anchors
      .filter((anchor) => anchor.bbox.y1 < region.bbox.y0)
      .reduce((bottom, anchor) => Math.max(bottom, anchor.bbox.y1), 0);
    const safelyBelowHeader = region.bbox.y0 - closestHeaderBottom >= Math.max(5, analysis.meta.height * 0.006);
    return safelyBelowHeader && height <= analysis.meta.height * 0.05;
  });

  // OCR can reduce a badly degraded CHARGED header to unrelated letters.
  // Probe the adjacent equal-width ruled cell even when text counting says
  // "one"; the fallback rejects SAID TO CONTAIN/product cells explicitly.
  if (expectedRegionCount === 1 && regions.length === 1 && regions[0].kind === 'actual' &&
      hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    const ruledSibling = await inferActualSiblingRegion(
      processingInput,
      anchors,
      regions,
      analysis.meta,
      words
    );
    if (ruledSibling.length === 1) {
      regions = [...regions, ...ruledSibling];
      expectedRegionCount = 2;
    }
  }

  const hasActualHeader = anchors.some((anchor) =>
    anchor.words.some((word) => isActualQualifierToken(word.text))
  );
  const hasChargedHeader = anchors.some((anchor) =>
    /charg|chargeable/i.test(anchor.words.map((word) => word.text).join(' '))
  );
  const hasReliableExistingValue = regions.some((region) =>
    /^\d{2,6}(?:[.,]\d{1,3})?$/.test(String(region.originalText || '')) &&
    String(region.originalText || '').replace(/\D/g, '').length >= 3
  );
  // A lone digit is almost always a rule intersection, box count, or damaged
  // header fragment. It is never sufficient evidence for a destructive edit.
  regions = regions.filter((region) => {
    const digitCount = String(region.originalText || '').replace(/\D/g, '').length;
    const regionWidth = region.bbox.x1 - region.bbox.x0;
    const regionHeight = region.bbox.y1 - region.bbox.y0;
    // On noisy scans Tesseract can read only the final digit even though the
    // structural probe has isolated the full, wide value band (for example
    // `459 8` becomes `8`). Keep that proven band; the later row-fragment
    // union clears all glyphs inside the ruled cell. A narrow lone digit is
    // still rejected as an unsafe rule/count false-positive.
    const wideStructuralBand = Boolean(region.cellBounds) &&
      regionWidth >= Math.max(18, regionHeight * 2.2);
    return digitCount >= 2 || (digitCount === 0 && Boolean(region.cellBounds)) ||
      (digitCount === 1 && wideStructuralBand);
  });
  if (expectedRegionCount === 1 && hasActualHeader && !hasChargedHeader && !hasReliableExistingValue) {
    const anchoredActualRegion = await inferSingleWeightRegionFromAnchor(
      processingInput,
      anchors,
      words,
      analysis.meta
    );
    if (anchoredActualRegion.length === 1) {
      singleStructuralAttempt = anchoredActualRegion;
      regions = anchoredActualRegion;
    }
  }

  // A tall merged OCR token may have prevented the earlier fallback from
  // running and is intentionally discarded above. Retry the anchored single
  // cell inference now that the unsafe token is gone.
  if (!regions.length && expectedRegionCount === 1) {
    singleStructuralAttempt = await inferSingleWeightRegionFromAnchor(
      processingInput,
      anchors,
      words,
      analysis.meta
    );
    if (singleStructuralAttempt.length === 1) regions = singleStructuralAttempt;
  }

  if (regions.length > 0 && regions.length < expectedRegionCount) {
    const inferredRegions = await inferActualSiblingRegion(
      processingInput,
      anchors,
      regions,
      analysis.meta,
      words
    );
    regions = [...inferredRegions, ...regions];
    regions = regions.filter((region) => !regionOverlapsAnchor(region, anchors));
    regions = regions.map((region) => sanitizeRegionBbox(region, anchors, analysis.meta));
    regions = regions.filter(isWeightRegion);
    regions = regions.filter((region) => {
      const height = region.bbox.y1 - region.bbox.y0;
      return height <= maxSafeValueHeight;
    });
  }

  if (expectedRegionCount === 2 && regions.length === 1 && regions[0].kind === 'actual' &&
      !hasChargedHeaderEvidence(words, anchors, analysis.meta) &&
      hasSaidToContainImmediatelyRight(words, regions[0], analysis.meta)) {
    expectedRegionCount = 1;
  }

  if (expectedRegionCount === 2 && regions.length === 1 && regions[0].kind === 'actual') {
    const containWord = words
      .filter((word) => /contain/i.test(String(word.text || '')))
      .filter((word) => (word.bbox.x0 + word.bbox.x1) / 2 > regions[0].bbox.x1)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    if (containWord && hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
      const actual = regions[0];
      const actualCenter = (actual.bbox.x0 + actual.bbox.x1) / 2;
      const containCenter = (containWord.bbox.x0 + containWord.bbox.x1) / 2;
      const shift = (containCenter - actualCenter) / 2;
      if (shift >= analysis.meta.width * 0.06 && shift <= analysis.meta.width * 0.15) {
        const actualCellBounds = actual.cellBounds || {
          x0: Math.max(0, actual.bbox.x0 - shift * 0.08),
          x1: actual.bbox.x0 + shift,
        };
        actual.cellBounds = actualCellBounds;
        regions.push({
          ...actual,
          bbox: {
            x0: actual.bbox.x0 + shift,
            y0: actual.bbox.y0,
            x1: actual.bbox.x1 + shift,
            y1: actual.bbox.y1,
          },
          cellBounds: {
            x0: actualCellBounds.x0 + shift,
            x1: actualCellBounds.x1 + shift,
          },
          originalText: '',
          anchorText: 'inferred CHARGED WEIGHT between ACTUAL and SAID TO CONTAIN',
          kind: 'charged',
        });
      }
    }
  }

  // Final destructive-action boundary. Fallbacks below the first validation
  // pass may reconstruct regions, so repeat the evidence check immediately
  // before any edit/status decision. A one-digit source is accepted only
  // when the structural detector isolated a full-width band inside one ruled
  // cell; otherwise it remains unsafe.
  regions = regions.filter((region) => {
    const digitCount = String(region.originalText || '').replace(/\D/g, '').length;
    const width = region.bbox.x1 - region.bbox.x0;
    const height = region.bbox.y1 - region.bbox.y0;
    const wideStructuralBand = Boolean(region.cellBounds) &&
      width >= Math.max(18, height * 2.2);
    return digitCount >= 2 || (digitCount === 0 && Boolean(region.cellBounds)) ||
      (digitCount === 1 && wideStructuralBand);
  });
  regions = regions.map((region) => clampTallNumericRegion(region, analysis.meta));

  // Recover the complete glyph box when an enhanced/structural pass retained
  // only the tail of a number. Use the same normalized digits, same row and a
  // very small horizontal neighbourhood, so ACTUAL can never jump to CHARGED.
  regions = regions.map((region) => {
    const digits = String(region.originalText || '').replace(/\D/g, '');
    if (digits.length < 3) return region;
    const centerX = (region.bbox.x0 + region.bbox.x1) / 2;
    const centerY = (region.bbox.y0 + region.bbox.y1) / 2;
    const matchingWord = words
      .filter((word) => String(word.text || '').replace(/\D/g, '') === digits)
      .filter((word) => {
        const wordCenterX = (word.bbox.x0 + word.bbox.x1) / 2;
        const wordCenterY = (word.bbox.y0 + word.bbox.y1) / 2;
        return Math.abs(wordCenterX - centerX) <= analysis.meta.width * 0.04 &&
          Math.abs(wordCenterY - centerY) <= Math.max(18, analysis.meta.height * 0.04);
      })
      .sort((a, b) =>
        (b.bbox.x1 - b.bbox.x0) - (a.bbox.x1 - a.bbox.x0)
      )[0];
    return matchingWord
      ? {
          ...region,
          bbox: {
            // A tall OCR token may include a rule/header. Its x span still
            // identifies all old digits, but the proven short row owns y.
            x0: matchingWord.bbox.x0,
            y0: region.bbox.y0,
            x1: matchingWord.bbox.x1,
            y1: region.bbox.y1,
          },
          originalText: String(matchingWord.text || '').trim().replace(',', '.'),
        }
      : region;
  });

  // Explicit header spacing is the final authority for the horizontal column
  // offset. On damaged scans OCR can put both numeric boxes in ACTUAL while
  // still reading both headers correctly. Shift CHARGED by the measured
  // ACTUAL->CHARGED header delta so it cannot remain in the wrong cell.
  if (regions.length === 2) {
    const actualHeader = anchors
      .filter((anchor) => anchor.words.some((word) => isActualQualifierToken(word.text)))
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    const chargedHeader = anchors
      .filter((anchor) => /charg|chargeable/i.test(anchor.words.map((word) => word.text).join(' ')))
      .filter((anchor) => !actualHeader || anchor.bbox.x0 > actualHeader.bbox.x0)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    if (actualHeader && chargedHeader) {
      const rawActual = words
        .filter((word) => isActualQualifierToken(word.text))
        .filter((word) => (word.bbox.x0 + word.bbox.x1) / 2 < analysis.meta.width * 0.62)
        .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)[0];
      const rawCharged = words
        .filter((word) => /charg|chargeable/i.test(String(word.text || '')))
        .filter((word) => !rawActual || word.bbox.x0 > rawActual.bbox.x0)
        .filter((word) => !rawActual ||
          word.bbox.x0 - rawActual.bbox.x0 >= analysis.meta.width * 0.07)
        .sort((a, b) => {
          const target = analysis.meta.width * 0.105;
          const ad = rawActual ? Math.abs((a.bbox.x0 - rawActual.bbox.x0) - target) : 0;
          const bd = rawActual ? Math.abs((b.bbox.x0 - rawActual.bbox.x0) - target) : 0;
          return ad - bd;
        })[0];
      const headerShift = rawActual && rawCharged
        ? rawCharged.bbox.x0 - rawActual.bbox.x0
        : chargedHeader.bbox.x0 - actualHeader.bbox.x0;
      const ordered = [...regions].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      const actual = ordered[0];
      const charged = ordered[1];
      const measuredShift = charged.bbox.x0 - actual.bbox.x0;
      if (headerShift >= analysis.meta.width * 0.06 &&
          headerShift <= analysis.meta.width * 0.17 &&
          Math.abs(measuredShift - headerShift) > analysis.meta.width * 0.025) {
        charged.bbox = {
          x0: actual.bbox.x0 + headerShift,
          y0: actual.bbox.y0,
          x1: actual.bbox.x1 + headerShift,
          y1: actual.bbox.y1,
        };
        charged.cellBounds = undefined;
      }
      actual.kind = 'actual';
      charged.kind = 'charged';
      regions = ordered;
    }
  }

  // Carry proven table bounds onto precise OCR regions. Placement remains the
  // OCR bbox; these bounds are used only for clipping and erase-only cleanup.
  for (const region of regions) {
    if (region.cellBounds) continue;
    const centerX = (region.bbox.x0 + region.bbox.x1) / 2;
    const structuralCell = structuralRegions
      .filter((candidate) => candidate.cellBounds)
      .find((candidate) =>
        centerX > candidate.cellBounds.x0 && centerX < candidate.cellBounds.x1
      );
    if (structuralCell) region.cellBounds = { ...structuralCell.cellBounds };
  }
  if (expectedRegionCount === 1 && regions.length === 1) {
    const region = regions[0];
    const containWord = words
      .filter((word) => /contain/i.test(String(word.text || '')))
      .filter((word) => word.bbox.x0 > region.bbox.x1)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    if (containWord) {
      const left = region.cellBounds?.x0 ?? Math.max(0, region.bbox.x0 - (region.bbox.x1 - region.bbox.x0) * 0.25);
      const right = containWord.bbox.x0 - Math.max(2, analysis.meta.width * 0.003);
      if (right - left >= analysis.meta.width * 0.07 && right <= analysis.meta.width * 0.62) {
        region.cellBounds = { x0: left, x1: right };
      }
    }
  }

  // Raw qualifier words can survive even when the anchor grouper combines or
  // drops one two-line heading. Their horizontal delta is a precise template
  // measurement, so use it to recover whichever value cell OCR missed. The
  // old values do not need to be equal (or readable) for this proof.
  if (hasActualHeaderEvidence(words, anchors, analysis.meta) &&
      hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    expectedRegionCount = 2;
  }
  if (expectedRegionCount === 2 && regions.length === 1) {
    const actualQualifier = words
      .filter((word) => isActualQualifierToken(word.text))
      .filter((word) => word.bbox.x0 < analysis.meta.width * 0.55)
      .sort((a, b) => b.confidence - a.confidence)[0] || anchors
        .filter((anchor) => anchor.words.some((word) => isActualQualifierToken(word.text)))
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    const chargedQualifier = words
      .filter((word) => /charg(?:ed|eable|d)?/i.test(String(word.text || '').replace(/[^a-z]/gi, '')))
      .filter((word) => !actualQualifier || word.bbox.x0 > actualQualifier.bbox.x0)
      .sort((a, b) => b.confidence - a.confidence)[0] || anchors
        .filter((anchor) => /charg|chargeable/i.test(anchor.words.map((word) => word.text).join(' ')))
        .filter((anchor) => !actualQualifier || anchor.bbox.x0 > actualQualifier.bbox.x0)
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    if (actualQualifier && chargedQualifier) {
      const shift = chargedQualifier.bbox.x0 - actualQualifier.bbox.x0;
      if (shift >= analysis.meta.width * 0.055 && shift <= analysis.meta.width * 0.18) {
        const source = regions[0];
        const sourceCenterX = (source.bbox.x0 + source.bbox.x1) / 2;
        const actualCenterX = (actualQualifier.bbox.x0 + actualQualifier.bbox.x1) / 2;
        const chargedCenterX = (chargedQualifier.bbox.x0 + chargedQualifier.bbox.x1) / 2;
        const sourceIsCharged = Math.abs(sourceCenterX - chargedCenterX) <
          Math.abs(sourceCenterX - actualCenterX);
        const siblingShift = sourceIsCharged ? -shift : shift;
        const sibling = {
          ...source,
          bbox: {
            x0: source.bbox.x0 + siblingShift,
            y0: source.bbox.y0,
            x1: source.bbox.x1 + siblingShift,
            y1: source.bbox.y1,
          },
          cellBounds: undefined,
          originalText: '',
          anchorText: sourceIsCharged
            ? 'inferred ACTUAL WEIGHT from qualifier spacing'
            : 'inferred CHARGED WEIGHT from qualifier spacing',
          kind: sourceIsCharged ? 'actual' : 'charged',
        };
        source.kind = sourceIsCharged ? 'charged' : 'actual';
        regions = sourceIsCharged ? [sibling, source] : [source, sibling];
      }
    }
  }

  // CHARGED is never a standalone column in this POD family. When ACTUAL OCR
  // is completely absent, the next SAID TO CONTAIN heading supplies the
  // charged-cell width and therefore the exact leftward column offset.
  if (regions.length === 1 && regions[0].kind === 'charged') {
    const source = regions[0];
    const containWord = words
      .filter((word) => /^(?:said|contain)$/i.test(String(word.text || '').replace(/[^a-z]/gi, '')))
      .filter((word) => word.bbox.x0 > source.bbox.x0)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
    const shift = containWord ? containWord.bbox.x0 - source.bbox.x0 : 0;
    if (shift >= analysis.meta.width * 0.055 && shift <= analysis.meta.width * 0.18) {
      regions = [{
        ...source,
        bbox: {
          x0: source.bbox.x0 - shift,
          y0: source.bbox.y0,
          x1: source.bbox.x1 - shift,
          y1: source.bbox.y1,
        },
        cellBounds: undefined,
        originalText: '',
        anchorText: 'inferred ACTUAL WEIGHT from CHARGED cell width',
        kind: 'actual',
      }, source];
      expectedRegionCount = 2;
    }
  }

  // Recover a two-field layout without qualifier OCR only when a strict,
  // same-value decimal pair agrees with the already located ACTUAL row and
  // one full Delhivery column step. This rescues washed-out ACTUAL/CHARGED
  // headers (for example 308200965) without treating BOXES numbers, different
  // legacy artifacts, or two tokens inside one cell as a second field.
  const recoverStrictAlignedPair = () => {
    if (regions.length !== 1) return;

    const source = regions[0];
    const sourceRegionCenterX = (source.bbox.x0 + source.bbox.x1) / 2;
    const sourceRegionCenterY = (source.bbox.y0 + source.bbox.y1) / 2;
    const decimalWords = words
      .map((word) => {
        const numericMatch = String(word.text || '').match(/\d{1,6}[.,]\d{1,3}/);
        return numericMatch
          ? { ...word, normalizedWeightText: numericMatch[0].replace(',', '.') }
          : null;
      })
      .filter(Boolean);
    const sourceWord = decimalWords
      .filter((word) => {
        const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        return Math.abs(centerX - sourceRegionCenterX) <= analysis.meta.width * 0.05 &&
          Math.abs(centerY - sourceRegionCenterY) <= Math.max(12, analysis.meta.height * 0.025);
      })
      .sort((a, b) => {
        const ax = (a.bbox.x0 + a.bbox.x1) / 2;
        const bx = (b.bbox.x0 + b.bbox.x1) / 2;
        return Math.abs(ax - sourceRegionCenterX) - Math.abs(bx - sourceRegionCenterX);
      })[0];
    if (!sourceWord) return;

    const sourceCenterX = (sourceWord.bbox.x0 + sourceWord.bbox.x1) / 2;
    const sourceCenterY = (sourceWord.bbox.y0 + sourceWord.bbox.y1) / 2;
    const sourceDigits = sourceWord.normalizedWeightText.replace(/\D/g, '');
    const siblingWord = decimalWords.find((word) => {
      if (word === sourceWord) return false;
      const siblingDigits = word.normalizedWeightText.replace(/\D/g, '');
      const exactValue = siblingDigits === sourceDigits;
      // A ruled left edge is occasionally OCR'd as a leading "1" (for
      // example 56.34 -> 156.34). Permit only that single-character repair,
      // and only on a low-confidence token in an otherwise strict pair.
      const leadingRuleArtifact = (
        sourceDigits === `1${siblingDigits}` && Number(sourceWord.confidence || 0) < config.ocrMinConfidence
      ) || (
        siblingDigits === `1${sourceDigits}` && Number(word.confidence || 0) < config.ocrMinConfidence
      );
      if (!exactValue && !leadingRuleArtifact) return false;
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      const separation = Math.abs(centerX - sourceCenterX);
      return separation >= analysis.meta.width * 0.07 &&
        separation <= analysis.meta.width * 0.16 &&
        Math.abs(centerY - sourceCenterY) <= Math.max(12, analysis.meta.height * 0.025);
    });
    if (!siblingWord || sourceDigits.length < 3 ||
        sourceCenterX < analysis.meta.width * 0.15 || sourceCenterX > analysis.meta.width * 0.42) {
      return;
    }

    const orderedWords = [sourceWord, siblingWord]
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const [actualWord, chargedWord] = orderedWords;
    const actualCenterX = (actualWord.bbox.x0 + actualWord.bbox.x1) / 2;
    const chargedCenterX = (chargedWord.bbox.x0 + chargedWord.bbox.x1) / 2;
    const columnStep = chargedCenterX - actualCenterX;
    const rowHeight = Math.max(6, Math.min(
      actualWord.bbox.y1 - actualWord.bbox.y0,
      chargedWord.bbox.y1 - chargedWord.bbox.y0
    ));
    const cellLeft = Math.max(0, actualWord.bbox.x0 - Math.max(3, rowHeight * 0.4));
    regions = [
      {
        ...source,
        bbox: { ...actualWord.bbox },
        cellBounds: { x0: cellLeft, x1: cellLeft + columnStep },
        originalText: actualWord.normalizedWeightText,
        anchorText: 'strict aligned ACTUAL WEIGHT value',
        kind: 'actual',
      },
      {
        bbox: { ...chargedWord.bbox },
        cellBounds: { x0: cellLeft + columnStep, x1: cellLeft + columnStep * 2 },
        originalText: chargedWord.normalizedWeightText,
        anchorText: 'strict aligned CHARGED WEIGHT value',
        kind: 'charged',
      },
    ];
    expectedRegionCount = 2;
    strictAlignedPairProven = true;
  };
  recoverStrictAlignedPair();

  // Do not recover a pair from arbitrary aligned numbers. Dimension values,
  // box counts, product quantities, and remnants from an earlier bad edit can
  // all satisfy that visual pattern. Header-qualified/ruled-cell paths above
  // are the only sources permitted to create weight regions.

  if (regions.length < expectedRegionCount || !regions.length) {
    const tableRegions = await inferWeightRegionsFromTable(
      processingInput,
      analysis.meta,
      anchors
    );
    const usableTableRegions = expectedRegionCount === 1 && !hasChargedHeaderEvidence(words, anchors, analysis.meta)
      ? tableRegions.slice(0, 1)
      : tableRegions;
    if (usableTableRegions.length &&
        (usableTableRegions.length > regions.length || usableTableRegions.length === expectedRegionCount)) {
      regions = usableTableRegions;
      expectedRegionCount = Math.max(expectedRegionCount, usableTableRegions.length);
    }
  }

  if (!regions.length) {
    const boundedTemplateRegions = await inferBoundedTemplateWeightRegions(
      processingInput,
      words,
      anchors,
      analysis.meta,
      expectedRegionCount
    );
    if (boundedTemplateRegions.length) {
      regions = boundedTemplateRegions;
      expectedRegionCount = Math.max(expectedRegionCount, boundedTemplateRegions.length);
    }
  }

  if (!strictAlignedPairProven) recoverStrictAlignedPair();

  const saidToContainLeft = findSaidToContainLeft(words, analysis.meta);
  if (saidToContainLeft !== null) {
    const rightEdgeGuard = Math.max(2, analysis.meta.width * 0.004);
    regions = regions.filter((region) =>
      (region.bbox.x0 + region.bbox.x1) / 2 < saidToContainLeft - rightEdgeGuard
    );
    if (expectedRegionCount === 2 &&
        !strictAlignedPairProven &&
        !hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
      expectedRegionCount = Math.min(expectedRegionCount, Math.max(1, regions.length));
    }
  }
  if (regions.length === 2 &&
      !strictAlignedPairProven &&
      !hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    const actualOnlyRegion = regions.find((region) => region.kind === 'actual') || regions[0];
    if (hasSaidToContainImmediatelyRight(words, actualOnlyRegion, analysis.meta)) {
      regions = [actualOnlyRegion];
      expectedRegionCount = 1;
    }
  }

  // Canonicalize once, immediately before the destructive boundary. Fallbacks
  // above may append reconstructed regions, so earlier de-duplication is not
  // sufficient. Keep exactly one region per proven business field and never
  // let a guessed sibling turn a single-ACTUAL label into two edits.
  const regionCenterX = (region) => (region.bbox.x0 + region.bbox.x1) / 2;
  const canonicalQualifierForKind = (kind) => words
    .filter((word) => kind === 'charged'
      ? isChargedQualifierToken(word.text)
      : isActualQualifierToken(word.text))
    .filter((word) => word.bbox.x0 < analysis.meta.width * 0.68)
    .sort((a, b) => b.confidence - a.confidence)[0];
  const regionEvidenceScore = (region, kind) => {
    const text = String(region.anchorText || '').toLowerCase();
    const original = String(region.originalText || '').trim();
    let score = 0;
    if (region.kind === kind) score += 80;
    if (kind === 'actual' && /actual|ctual/.test(text)) score += 70;
    if (kind === 'charged' && /charg/.test(text)) score += 70;
    if (region.cellBounds) score += 35;
    if (/^\d{2,6}(?:[.,]\d{1,3})?$/.test(original)) score += 25;
    if (/structural|table cell/.test(text)) score += 20;
    const qualifier = canonicalQualifierForKind(kind);
    if (qualifier) score -= Math.abs(regionCenterX(region) - regionCenterX({ bbox: qualifier.bbox })) /
      Math.max(1, analysis.meta.width * 0.01);
    return score;
  };
  const chooseRegion = (kind, candidates, excluded = null) => candidates
    .filter((region) => region !== excluded)
    .sort((a, b) => regionEvidenceScore(b, kind) - regionEvidenceScore(a, kind))[0] || null;

  // Explicit ACTUAL + CHARGED qualifiers are sufficient business-schema
  // proof even when their old values differ. If a later fallback collapsed
  // the pair, recover each value independently inside the header-owned cell.
  const finalActualQualifier = canonicalQualifierForKind('actual');
  const finalChargedQualifier = canonicalQualifierForKind('charged');
  if (regions.length < 2 && finalActualQualifier && finalChargedQualifier) {
    const headerShift = finalChargedQualifier.bbox.x0 - finalActualQualifier.bbox.x0;
    const saidLeft = findSaidToContainLeft(words, analysis.meta);
    if (headerShift >= analysis.meta.width * 0.055 &&
        headerShift <= analysis.meta.width * 0.18) {
      const separator = finalChargedQualifier.bbox.x0 - Math.max(2, analysis.meta.width * 0.003);
      const actualLeft = Math.max(
        0,
        finalActualQualifier.bbox.x0 - Math.max(4, analysis.meta.width * 0.012)
      );
      const chargedRight = saidLeft && saidLeft > separator
        ? saidLeft - Math.max(2, analysis.meta.width * 0.003)
        : separator + headerShift;
      const headerBottom = Math.max(finalActualQualifier.bbox.y1, finalChargedQualifier.bbox.y1);
      const numericWords = words
        .map((word) => {
          const match = String(word.text || '').match(/\d{1,6}(?:[.,]\d{1,3})/);
          return match ? { word, text: match[0].replace(',', '.') } : null;
        })
        .filter(Boolean)
        .filter(({ word }) => word.bbox.y0 >= headerBottom + 2 &&
          word.bbox.y0 <= headerBottom + analysis.meta.height * 0.09);
      const wordInCell = (left, right) => numericWords
        .filter(({ word }) => {
          const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
          return centerX > left && centerX < right;
        })
        .sort((a, b) => a.word.bbox.y0 - b.word.bbox.y0 ||
          a.word.bbox.x0 - b.word.bbox.x0)[0];
      const actualValue = wordInCell(actualLeft, separator);
      const chargedValue = wordInCell(separator, chargedRight);
      const existing = [...regions];
      const makeQualifiedRegion = (kind, value, cellBounds, fallbackShift) => {
        const qualifier = kind === 'actual' ? finalActualQualifier : finalChargedQualifier;
        const existingRegion = chooseRegion(kind, existing) || existing[0];
        const bbox = value
          ? { ...value.word.bbox }
          : existingRegion
            ? {
                x0: existingRegion.bbox.x0 + fallbackShift,
                y0: existingRegion.bbox.y0,
                x1: existingRegion.bbox.x1 + fallbackShift,
                y1: existingRegion.bbox.y1,
              }
            : null;
        if (!bbox) return null;
        return {
          ...(existingRegion || {}),
          bbox,
          cellBounds,
          originalText: value?.text || '',
          ocrConfidence: value ? Number(value.word.confidence) || 0 : undefined,
          anchorText: `header-qualified ${kind.toUpperCase()} WEIGHT value`,
          kind,
          anchorBbox: { ...qualifier.bbox },
        };
      };
      const actual = makeQualifiedRegion(
        'actual',
        actualValue,
        { x0: actualLeft, x1: separator },
        regions[0]?.kind === 'charged' ? -headerShift : 0
      );
      const charged = makeQualifiedRegion(
        'charged',
        chargedValue,
        { x0: separator, x1: chargedRight },
        regions[0]?.kind === 'actual' ? headerShift : 0
      );
      if (actual && charged) {
        regions = [actual, charged];
        expectedRegionCount = 2;
      }
    }
  }

  const orderedCandidates = [...regions].sort((a, b) => regionCenterX(a) - regionCenterX(b));
  const structurallyProvenPair = explicitChargedHeader && expectedRegionCount === 2 &&
    orderedCandidates.length >= 2 && orderedCandidates.some((region) => region.cellBounds) &&
    regionCenterX(orderedCandidates[orderedCandidates.length - 1]) - regionCenterX(orderedCandidates[0]) >=
      analysis.meta.width * 0.045;
  const hasProvenTwoFieldLayout = Boolean(finalActualQualifier && finalChargedQualifier) ||
    (explicitActualHeader && explicitChargedHeader) ||
    structurallyProvenPair || strictAlignedPairProven;
  if (hasProvenTwoFieldLayout) {
    let actualRegion = chooseRegion('actual', orderedCandidates);
    let chargedRegion = chooseRegion('charged', orderedCandidates, actualRegion);
    if (actualRegion && chargedRegion && regionCenterX(actualRegion) > regionCenterX(chargedRegion)) {
      [actualRegion, chargedRegion] = [chargedRegion, actualRegion];
    }
    regions = [actualRegion, chargedRegion].filter(Boolean).map((region, index) => ({
      ...region,
      bbox: { ...region.bbox },
      cellBounds: region.cellBounds ? { ...region.cellBounds } : undefined,
      kind: index === 0 ? 'actual' : 'charged',
    }));
    expectedRegionCount = 2;
  } else {
    const actualRegion = chooseRegion('actual', orderedCandidates);
    regions = actualRegion ? [{
      ...actualRegion,
      bbox: { ...actualRegion.bbox },
      cellBounds: actualRegion.cellBounds ? { ...actualRegion.cellBounds } : undefined,
      kind: 'actual',
    }] : [];
    expectedRegionCount = 1;
  }

  // Live header geometry replaces stale fallback bounds before duplicate-cell
  // rejection. This keeps explicit ACTUAL/CHARGED fields separate even when
  // their old values differ or an earlier structural pass reused one cell.
  if (regions.length === 2 && finalActualQualifier && finalChargedQualifier) {
    const ordered = [...regions].sort((a, b) => regionCenterX(a) - regionCenterX(b));
    const separator = finalChargedQualifier.bbox.x0 - Math.max(2, analysis.meta.width * 0.003);
    const saidLeft = findSaidToContainLeft(words, analysis.meta);
    const qualifierLeftInset = Math.max(2, Math.min(6, analysis.meta.width * 0.004));
    const qualifierDerivedLeft = finalActualQualifier.bbox.x0 - qualifierLeftInset;
    const structuralLeft = ordered[0].cellBounds?.x0;
    // The left rule is a hard boundary. Earlier code chose the leftmost of a
    // structural estimate and a generous qualifier estimate, which could put
    // the editable cell several pixels across the printed rule. Choose the
    // rightmost credible boundary instead; selective localization still finds
    // the old glyphs inside that protected cell.
    const actualLeft = Math.max(
      0,
      Number.isFinite(structuralLeft)
        ? Math.max(structuralLeft, qualifierDerivedLeft)
        : qualifierDerivedLeft
    );
    const chargedRight = saidLeft && saidLeft > separator
      ? saidLeft - Math.max(2, analysis.meta.width * 0.003)
      : separator + (finalChargedQualifier.bbox.x0 - finalActualQualifier.bbox.x0);
    ordered[0].cellBounds = { x0: actualLeft, x1: separator };
    ordered[1].cellBounds = { x0: separator, x1: chargedRight };
    ordered[0].kind = 'actual';
    ordered[1].kind = 'charged';
    regions = ordered;
    expectedRegionCount = 2;
  }

  // Reject a pair that still resolves to the same physical cell. This catches
  // duplicated base/enhanced OCR tokens and prevents rendering the same value
  // two or three times in one box.
  if (regions.length === 2) {
    const [left, right] = regions;
    const leftWidth = Math.max(1, left.bbox.x1 - left.bbox.x0);
    const rightWidth = Math.max(1, right.bbox.x1 - right.bbox.x0);
    const overlap = Math.max(0, Math.min(left.bbox.x1, right.bbox.x1) - Math.max(left.bbox.x0, right.bbox.x0));
    const sameCellBounds = left.cellBounds && right.cellBounds &&
      Math.abs(left.cellBounds.x0 - right.cellBounds.x0) < analysis.meta.width * 0.015 &&
      Math.abs(left.cellBounds.x1 - right.cellBounds.x1) < analysis.meta.width * 0.015;
    const distinctHeaderOwnedCells = hasProvenTwoFieldLayout &&
      left.cellBounds && right.cellBounds &&
      left.cellBounds.x1 <= right.cellBounds.x0 + Math.max(2, analysis.meta.width * 0.005) &&
      right.cellBounds.x0 - left.cellBounds.x0 >= analysis.meta.width * 0.045;
    // Overlapping OCR boxes are not a reason to discard CHARGED after ACTUAL
    // and CHARGED headers have assigned two distinct physical cells. The
    // per-cell OCR/pixel localization below will independently recover each
    // old value. Collapse only when ownership itself is duplicated.
    if (sameCellBounds ||
        (overlap >= Math.min(leftWidth, rightWidth) * 0.35 && !distinctHeaderOwnedCells)) {
      regions = [left];
    }
  }

  if (!match) {
    return reviewResult({
      status: 'unmatched',
      reason: 'No shipment ID from the mapping sheet was found in the scanned label text',
      detectedNumbers: extractCandidateIds(words, config.ocrMinConfidence),
      processingMs: elapsedMs(),
    });
  }

  // If OCR merged one value with a nearby rule/header but its sibling is a
  // clean value on the same proven Actual/Charged row, use the sibling's row
  // height. Horizontal ownership still comes from each separate column.
  if (regions.length === 2 && hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    const safeSibling = regions.find((region) =>
      region.bbox.y1 - region.bbox.y0 <= maxSafeValueHeight
    );
    if (safeSibling) {
      regions = regions.map((region) =>
        region.bbox.y1 - region.bbox.y0 > maxSafeValueHeight
          ? {
              ...region,
              bbox: {
                ...region.bbox,
                y0: safeSibling.bbox.y0,
                y1: safeSibling.bbox.y1,
              },
            }
          : region
      );
    }
  }

  const finalRegionsAreSafe = regions.every((region) =>
    region.bbox.y1 - region.bbox.y0 <= maxSafeValueHeight
  );
  const finalPairSeparation = regions.length === 2
    ? Math.abs(
        (regions[1].bbox.x0 + regions[1].bbox.x1) / 2 -
        (regions[0].bbox.x0 + regions[0].bbox.x1) / 2
      )
    : Infinity;
  const minimumProvenPairSeparation = hasChargedHeaderEvidence(words, anchors, analysis.meta)
    ? analysis.meta.width * 0.045
    : regions.some((region) => region.kind === 'charged' || region.cellBounds)
      ? analysis.meta.width * 0.045
      : analysis.meta.width * 0.07;
  if (!finalRegionsAreSafe ||
      (regions.length === 2 && finalPairSeparation < minimumProvenPairSeparation)) {
    return reviewResult({
      status: 'unsafe_weight_geometry',
      shipmentId: match.id,
      newWeight: idWeightMap.get(match.id),
      reason: 'Weight row or column geometry is ambiguous; original image preserved to protect table borders and neighbouring fields',
      detectedWeightRegions: regions.map((region) => ({
        text: region.originalText,
        kind: region.kind,
        bbox: region.bbox,
      })),
      processingMs: elapsedMs(),
    });
  }

  if (expectedRegionCount === 2 && regions.length < 2) {
    return reviewResult({
      status: 'partial_weight_detection',
      shipmentId: match.id,
      newWeight: idWeightMap.get(match.id),
      reason: `Label requires 2 weight fields but only ${regions.length} could be located`,
      detectedWeightAnchors: anchors.map((a) => a.words.map((w) => w.text).join(' ')),
      detectedWeightAnchorDetails: anchors.map((anchor) => ({
        text: anchor.words.map((word) => word.text).join(' '),
        bbox: anchor.bbox,
      })),
      detectedStructuralAttempt: singleStructuralAttempt,
      detectedWeightRegions: regions.map((region) => ({
        text: region.originalText,
        kind: region.kind,
        bbox: region.bbox,
      })),
      processingMs: elapsedMs(),
    });
  }

  // A damaged numeric OCR box can extend into BOXES/DIMENSION or SAID TO
  // CONTAIN even though the qualifier heading itself is clear. Before any
  // erase/render operation, snap an outlying box back to the left-aligned
  // value position directly beneath its own ACTUAL/CHARGED heading.
  const qualifierForKind = (kind) => words
    .filter((word) => kind === 'charged'
      ? isChargedQualifierToken(word.text)
      : isActualQualifierToken(word.text))
    .filter((word) => word.bbox.x0 < analysis.meta.width * 0.68)
    .sort((a, b) => b.confidence - a.confidence)[0];
  regions = regions.map((region) => {
    const qualifier = qualifierForKind(region.kind);
    if (!qualifier) return region;
    const regionWidth = Math.max(8, region.bbox.x1 - region.bbox.x0);
    const qualifierWidth = qualifier.bbox.x1 - qualifier.bbox.x0;
    const expectedX0 = qualifier.bbox.x0 + Math.max(0, qualifierWidth * 0.02);
    const deviation = Math.abs(region.bbox.x0 - expectedX0);
    const startsBeforeHeader = region.bbox.x0 < qualifier.bbox.x0 - Math.max(3, analysis.meta.width * 0.01);
    const centerBeforeHeader = (region.bbox.x0 + region.bbox.x1) / 2 <
      qualifier.bbox.x0 - Math.max(4, analysis.meta.width * 0.012);
    if (!startsBeforeHeader && !centerBeforeHeader &&
        deviation <= analysis.meta.width * 0.035 && regionWidth <= analysis.meta.width * 0.09) {
      return region;
    }
    const safeWidth = Math.min(regionWidth, analysis.meta.width * 0.055);
    return {
      ...region,
      bbox: {
        x0: expectedX0,
        y0: region.bbox.y0,
        x1: expectedX0 + safeWidth,
        y1: region.bbox.y1,
      },
      originalText: startsBeforeHeader || centerBeforeHeader ? '' : region.originalText,
      anchorText: startsBeforeHeader || centerBeforeHeader
        ? `${region.anchorText || 'weight'} corrected under ${region.kind || 'actual'} header`
        : region.anchorText,
    };
  });

  const actualHeaderQualifier = qualifierForKind('actual');
  const chargedHeaderQualifier = qualifierForKind('charged');
  const saidHeaderLeft = findSaidToContainLeft(words, analysis.meta);
  const headerCellBoundsForKind = (kind) => {
    const qualifier = kind === 'charged' ? chargedHeaderQualifier : actualHeaderQualifier;
    if (!qualifier) return null;
    const qualifierWidth = Math.max(10, qualifier.bbox.x1 - qualifier.bbox.x0);
    const qualifierCenterX = (qualifier.bbox.x0 + qualifier.bbox.x1) / 2;
    const separatorGuard = Math.max(2, Math.min(6, qualifierWidth * 0.08));
    const containingStructuralCell = structuralRegions
      .filter((candidate) => candidate.cellBounds)
      .find((candidate) =>
        qualifierCenterX > candidate.cellBounds.x0 &&
        qualifierCenterX < candidate.cellBounds.x1
      );
    // Header text is inset from the physical left rule. Prefer the structural
    // border that actually contains this qualifier; otherwise estimate that
    // inset from the qualifier width. Using qualifier.x0 directly clips the
    // first old digit and leaves it visible after replacement.
    const estimatedHeaderLeft = Math.max(
      0,
      qualifier.bbox.x0 - Math.max(separatorGuard, qualifierWidth * 0.28)
    );
    const chargedSharedSeparator = kind === 'charged' && chargedHeaderQualifier
      ? Math.max(0, chargedHeaderQualifier.bbox.x0 - separatorGuard)
      : null;
    const left = chargedSharedSeparator ?? (containingStructuralCell
      ? Math.min(containingStructuralCell.cellBounds.x0, estimatedHeaderLeft)
      : estimatedHeaderLeft);
    const nextQualifierLeft = kind === 'actual' ? chargedHeaderQualifier?.bbox.x0 : null;
    const rightBoundary = nextQualifierLeft && nextQualifierLeft > left
      ? nextQualifierLeft - separatorGuard
      : saidHeaderLeft && saidHeaderLeft > left
        ? saidHeaderLeft - Math.max(2, analysis.meta.width * 0.003)
        : containingStructuralCell?.cellBounds.x1 || null;
    if (!rightBoundary || rightBoundary - left < analysis.meta.width * 0.045) return null;
    return { x0: left, x1: rightBoundary };
  };

  regions = regions.map((region) => {
    const qualifier = qualifierForKind(region.kind);
    const qualifierCenterX = qualifier ? (qualifier.bbox.x0 + qualifier.bbox.x1) / 2 : null;
    const structuralCell = structuralRegions
      .filter((candidate) => candidate.cellBounds)
      .find((candidate) => candidate.kind === region.kind) ||
      (qualifierCenterX === null ? null : structuralRegions
        .filter((candidate) => candidate.cellBounds)
        .find((candidate) =>
          qualifierCenterX > candidate.cellBounds.x0 &&
          qualifierCenterX < candidate.cellBounds.x1
        ));
    // Header order is the final ownership authority. Earlier OCR/table
    // fallbacks may attach an ACTUAL region to the BOXES cell; retaining those
    // stale bounds is what moved correctly detected text back into dimensions.
    let cellBounds = headerCellBoundsForKind(region.kind) ||
      region.cellBounds || structuralCell?.cellBounds || null;

    if (!cellBounds && qualifier) {
      const qualifierWidth = Math.max(10, qualifier.bbox.x1 - qualifier.bbox.x0);
      const left = Math.max(0, qualifier.bbox.x0 - Math.max(4, qualifierWidth * 0.12));
      const right = saidHeaderLeft && saidHeaderLeft > left + analysis.meta.width * 0.045
        ? saidHeaderLeft - Math.max(3, analysis.meta.width * 0.004)
        : Math.min(analysis.meta.width, qualifier.bbox.x1 + Math.max(qualifierWidth * 0.85, analysis.meta.width * 0.055));
      cellBounds = { x0: left, x1: right };
    }

    if (!cellBounds) return region;

    const height = Math.max(8, region.bbox.y1 - region.bbox.y0);
    const lineGuard = Math.max(3, Math.min(6, height * 0.22));
    const safeLeft = cellBounds.x0 + lineGuard;
    const safeRight = cellBounds.x1 - lineGuard;
    if (safeRight <= safeLeft + 4) return { ...region, cellBounds };

    const width = Math.min(
      Math.max(10, region.bbox.x1 - region.bbox.x0),
      Math.max(10, safeRight - safeLeft),
      analysis.meta.width * 0.06
    );
    const x0 = Math.max(safeLeft, Math.min(region.bbox.x0, safeRight - width));
    return {
      ...region,
      bbox: {
        ...region.bbox,
        x0,
        x1: Math.min(safeRight, x0 + width),
      },
      cellBounds,
    };
  });

  const hasReliableRegionText = (region) =>
    /^\d{2,6}(?:[.,]\d{1,3})?$/.test(String(region.originalText || '').trim()) &&
    (region.ocrConfidence === undefined || region.ocrConfidence >= config.ocrMinConfidence);
  if (regions.length === 2 && actualHeaderQualifier && chargedHeaderQualifier) {
    const actual = regions.find((region) => region.kind === 'actual');
    const charged = regions.find((region) => region.kind === 'charged');
    const headerShift = chargedHeaderQualifier.bbox.x0 - actualHeaderQualifier.bbox.x0;
    const copySiblingInkGeometry = (source, target, shift) => {
      if (!source || !target || !hasReliableRegionText(source) || hasReliableRegionText(target)) return;
      if (Math.abs(shift) < analysis.meta.width * 0.055 ||
          Math.abs(shift) > analysis.meta.width * 0.18) return;
      const width = source.bbox.x1 - source.bbox.x0;
      let x0 = source.bbox.x0 + shift;
      if (target.cellBounds) {
        x0 = Math.max(target.cellBounds.x0 + 1, Math.min(x0, target.cellBounds.x1 - width - 2));
      }
      target.bbox = {
        x0,
        y0: source.bbox.y0,
        x1: x0 + width,
        y1: source.bbox.y1,
      };
    };
    copySiblingInkGeometry(actual, charged, headerShift);
    copySiblingInkGeometry(charged, actual, -headerShift);
  }

  // For a proven single-ACTUAL layout, the rightmost decimal immediately to
  // the left of SAID is the old value even if OCR lost the ACTUAL qualifier.
  // This is a placement refinement only; it cannot create a second field.
  if (regions.length === 1 && saidHeaderLeft &&
      !hasChargedHeaderEvidence(words, anchors, analysis.meta)) {
    const region = regions[0];
    const currentRowCenter = (region.bbox.y0 + region.bbox.y1) / 2;
    const visibleValue = words
      .map((word) => {
        const match = String(word.text || '').match(/\d{1,6}(?:[.,]\d{1,3})/);
        return match ? { word, text: match[0].replace(',', '.') } : null;
      })
      .filter(Boolean)
      .filter(({ word }) => {
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        const height = word.bbox.y1 - word.bbox.y0;
        return word.bbox.x0 >= saidHeaderLeft - analysis.meta.width * 0.2 &&
          word.bbox.x1 < saidHeaderLeft - 2 &&
          centerY > analysis.meta.height * 0.28 && centerY < analysis.meta.height * 0.68 &&
          Math.abs(centerY - currentRowCenter) <= analysis.meta.height * 0.085 &&
          height >= 3 && height <= Math.max(32, analysis.meta.height * 0.05);
      })
      .sort((a, b) => {
        const ay = (a.word.bbox.y0 + a.word.bbox.y1) / 2;
        const by = (b.word.bbox.y0 + b.word.bbox.y1) / 2;
        return Math.abs(ay - currentRowCenter) - Math.abs(by - currentRowCenter) ||
          b.word.bbox.x0 - a.word.bbox.x0;
      })[0];
    if (visibleValue) {
      const height = visibleValue.word.bbox.y1 - visibleValue.word.bbox.y0;
      const edgeGuard = Math.max(3, Math.min(7, height * 0.45));
      const existingContainsValue = region.cellBounds &&
        visibleValue.word.bbox.x0 > region.cellBounds.x0 &&
        visibleValue.word.bbox.x1 < region.cellBounds.x1;
      region.bbox = { ...visibleValue.word.bbox };
      region.originalText = visibleValue.text;
      region.cellBounds = {
        x0: existingContainsValue
          ? region.cellBounds.x0
          : Math.max(0, visibleValue.word.bbox.x0 - edgeGuard),
        x1: saidHeaderLeft - Math.max(2, analysis.meta.width * 0.003),
      };
    }
  }

  // OCR and table fallbacks decide which business cells exist, but pixels are
  // the final authority for the old glyph row. Re-scan only those owned cells
  // after schema canonicalization so replacement cannot drift into BOXES or
  // SAID TO CONTAIN even when an OCR bbox is vertically displaced.
  const headerBottomForRegion = (region) => {
    const qualifier = qualifierForKind(region.kind);
    const cellLeft = region.cellBounds?.x0 ?? region.bbox.x0;
    const cellRight = region.cellBounds?.x1 ?? region.bbox.x1;
    const maximumHeaderHeight = Math.max(18, analysis.meta.height * 0.055);
    const weightWords = words
      .filter((word) => /^(?:weight|weigh|weightkg|weighkg|wt|kg)$/i.test(
        String(word.text || '').replace(/[^a-z]/gi, '')
      ))
      .filter((word) => {
        const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
        const height = word.bbox.y1 - word.bbox.y0;
        const nearQualifier = !qualifier || (
          word.bbox.y0 >= qualifier.bbox.y0 - analysis.meta.height * 0.015 &&
          word.bbox.y1 <= qualifier.bbox.y1 + analysis.meta.height * 0.065
        );
        return centerX > cellLeft && centerX < cellRight &&
          height <= maximumHeaderHeight && nearQualifier;
      })
      .sort((a, b) => a.bbox.y1 - b.bbox.y1);
    if (weightWords.length) {
      const word = weightWords[weightWords.length - 1];
      const height = word.bbox.y1 - word.bbox.y0;
      // OCR often lets a rotated header bbox touch the first value pixels.
      // Pull the search boundary slightly upward so the complete old glyph
      // row remains eligible.
      return word.bbox.y1 - Math.max(1, Math.min(5, height * 0.16));
    }
    if (qualifier) {
      const qualifierHeight = qualifier.bbox.y1 - qualifier.bbox.y0;
      return qualifier.bbox.y1 + Math.min(
        qualifierHeight * 0.9,
        analysis.meta.height * 0.022
      );
    }
    // A strict OCR value pair already supplies a trustworthy row. Start just
    // above it rather than rescanning its unreadable header as value ink.
    return Math.max(0, region.bbox.y0 - Math.max(5, analysis.meta.height * 0.008));
  };
  regions = regions.map((region) => {
    if (!region.cellBounds) return region;
    const headerBottom = headerBottomForRegion(region);
    const candidates = words
      .map((word) => {
        const match = String(word.text || '').match(/\d{1,6}(?:[.,]\d{1,3})/);
        return match ? { word, text: match[0].replace(',', '.') } : null;
      })
      .filter(Boolean)
      .filter(({ word }) => {
        const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
        const height = word.bbox.y1 - word.bbox.y0;
        return centerX > region.cellBounds.x0 && centerX < region.cellBounds.x1 &&
          word.bbox.y0 >= headerBottom + 2 &&
          word.bbox.y0 <= headerBottom + analysis.meta.height * 0.1 &&
          height >= 3 && height <= Math.max(38, analysis.meta.height * 0.05);
      })
      .sort((a, b) => a.word.bbox.y0 - b.word.bbox.y0 ||
        a.word.bbox.x0 - b.word.bbox.x0);
    const oldInkWord = candidates[0];
    if (!oldInkWord) return { ...region, headerBottom };
    const oldInkHeight = oldInkWord.word.bbox.y1 - oldInkWord.word.bbox.y0;
    const glyphEdgePad = Math.max(2, Math.min(6, oldInkHeight * 0.2));
    return {
      ...region,
      bbox: { ...oldInkWord.word.bbox },
      cellBounds: {
        ...region.cellBounds,
        x0: Math.max(0, Math.min(
          region.cellBounds.x0,
          oldInkWord.word.bbox.x0 - glyphEdgePad
        )),
        x1: Math.max(region.cellBounds.x1, oldInkWord.word.bbox.x1 + glyphEdgePad),
      },
      originalText: oldInkWord.text,
      ocrConfidence: Number(oldInkWord.word.confidence) || 0,
      ocrInkLocalized: true,
      headerBottom,
    };
  });
  regions = await localizeWeightInkInCells(
    processingInput,
    regions.map((region) => ({
      ...region,
      headerBottom: Number.isFinite(region.headerBottom)
        ? region.headerBottom
        : headerBottomForRegion(region),
    })),
    analysis.meta
  );

  const newWeight = idWeightMap.get(match.id);

  if (!regions.length) {
    return reviewResult({
      status: 'id_matched_no_weight_region',
      shipmentId: match.id,
      newWeight,
      reason: 'Shipment ID matched but no "WEIGHT" column value could be located',
      detectedWeightAnchors: anchors.map((a) => a.words.map((w) => w.text).join(' ')),
      detectedWeightAnchorDetails: anchors.map((anchor) => ({
        text: anchor.words.map((word) => word.text).join(' '),
        bbox: anchor.bbox,
      })),
      detectedStructuralAttempt: singleStructuralAttempt,
      processingMs: elapsedMs(),
    });
  }

  const sharedReplacementText = formatSharedReplacementWeight(newWeight, regions);
  const plainNumericWeightPattern = /^\d{1,6}(?:[.,]\d{1,3})?$/;
  const numericWeightValue = (text) => {
    const normalized = String(text || '').trim().replace(',', '.');
    if (!plainNumericWeightPattern.test(normalized)) return null;
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  };
  const knownWeightValues = [sharedReplacementText, ...regions.map((region) => region.originalText)];
  for (const word of words) {
    const value = numericWeightValue(word.text);
    if (value === null) continue;
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    const belongsToOwnedValueRow = regions.some((region) => {
      const rowCenter = (region.bbox.y0 + region.bbox.y1) / 2;
      const rowHeight = Math.max(8, region.bbox.y1 - region.bbox.y0);
      return region.cellBounds &&
        centerX > region.cellBounds.x0 && centerX < region.cellBounds.x1 &&
        Math.abs(centerY - rowCenter) <= Math.max(7, rowHeight * 0.95);
    });
    if (belongsToOwnedValueRow) knownWeightValues.push(word.text);
  }
  const comparableWeightValues = knownWeightValues
    .map(numericWeightValue)
    .filter((value) => value !== null);
  const matchesKnownWeightValue = (text) => {
    const value = numericWeightValue(text);
    return value !== null && comparableWeightValues.some((known) => Math.abs(known - value) < 0.0001);
  };

  const replacements = regions.map((region) => {
    // OCR frequently splits a printed value into several tokens (for example
    // `49`, `.`, `00`) or returns only one fragment as the chosen region. Join
    // every numeric fragment on the proven value row, but only inside this
    // weight cell. This removes the complete old number without widening the
    // erase operation towards either vertical table rule.
    const initialHeight = region.bbox.y1 - region.bbox.y0;
    const initialWidth = region.bbox.x1 - region.bbox.x0;
    const rowCenter = (region.bbox.y0 + region.bbox.y1) / 2;
    const cellLeft = region.cellBounds?.x0 ?? region.bbox.x0 - initialHeight;
    const cellRight = region.cellBounds?.x1 ?? region.bbox.x1 + initialHeight * 5;
    const localFragmentPad = Math.max(8, initialHeight * 1.35, initialWidth * 0.55);
    const rowFragments = words.filter((word) => {
      const text = String(word.text || '').trim();
      if (!/[0-9]/.test(text) || !/^[\d.,:;|_\-]+$/.test(text)) return false;
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      return centerX > Math.max(cellLeft, region.bbox.x0 - localFragmentPad) &&
        centerX < Math.min(cellRight, region.bbox.x1 + localFragmentPad) &&
        Math.abs(centerY - rowCenter) <= Math.max(5, initialHeight * 0.8);
    });
    const editBbox = rowFragments.length
      ? {
          x0: Math.min(region.bbox.x0, ...rowFragments.map((word) => word.bbox.x0)),
          y0: region.bbox.y0,
          x1: Math.max(region.bbox.x1, ...rowFragments.map((word) => word.bbox.x1)),
          y1: region.bbox.y1,
        }
      : region.bbox;
    const regionWidth = editBbox.x1 - editBbox.x0;
    const regionHeight = editBbox.y1 - editBbox.y0;
    const originalTextIsReliable = /^\d{2,6}(?:\.\d{1,3})?$/.test(region.originalText) &&
      (region.ocrConfidence === undefined || region.ocrConfidence >= config.ocrMinConfidence);
    const hasLocalizedInk = Boolean(region.inkLocalized || region.ocrInkLocalized);
    const useCellStart = Boolean(region.cellBounds) &&
      !originalTextIsReliable && !hasLocalizedInk;
    const usesTinyScanFallback = regionHeight <= 12 && !originalTextIsReliable;
    const clearBbox = buildWeightClearBbox({ ...region, bbox: editBbox }, analysis.meta, anchors);
    const clearEdgeGuard = region.cellBounds
      ? Math.max(4, Math.min(8, regionHeight * 0.3, analysis.meta.width * 0.008))
      : 0;
    const textEdgeGuard = region.cellBounds
      ? Math.max(7, Math.min(12, regionHeight * 0.55, analysis.meta.width * 0.01))
      : 0;
    if (region.cellBounds) {
      // Clear the complete left-aligned numeric zone on the proven value row,
      // not merely Tesseract's often-truncated glyph box. Keep a fixed inset
      // from both ruled edges and stop well before the next/product column.
      clearBbox.x0 = useCellStart
        ? region.cellBounds.x0 + clearEdgeGuard
        : Math.max(
            region.cellBounds.x0 + clearEdgeGuard,
            editBbox.x0 - Math.max(3, Math.min(7, regionHeight * 0.55))
          );
      clearBbox.x1 = Math.min(
        region.cellBounds.x1 - clearEdgeGuard,
        useCellStart
          ? Math.max(
              editBbox.x1 + Math.max(5, Math.min(10, regionHeight * 0.85)),
              region.cellBounds.x0 + Math.max(regionWidth * 1.55, regionHeight * 5)
            )
          : editBbox.x1 + Math.max(5, Math.min(10, regionHeight * 0.85))
      );
      clearBbox.y0 = Math.max(
        0,
        editBbox.y0 - Math.max(1, Math.min(3, regionHeight * 0.18))
      );
      clearBbox.y1 = Math.min(
        analysis.meta.height,
        editBbox.y1 + Math.max(2, Math.min(5, regionHeight * 0.3))
      );
    } else if (originalTextIsReliable) {
      // Clean OCR values should be fully removed, including antialiasing, but
      // without turning a neighbouring dimension number into part of the edit.
      clearBbox.x0 = Math.max(0, editBbox.x0 - Math.max(2, Math.min(5, regionHeight * 0.28)));
      clearBbox.x1 = Math.min(analysis.meta.width, editBbox.x1 + Math.max(3, Math.min(7, regionHeight * 0.42)));
      clearBbox.y0 = Math.max(0, editBbox.y0 - Math.max(1, Math.min(3, regionHeight * 0.16)));
      clearBbox.y1 = Math.min(analysis.meta.height, editBbox.y1 + Math.max(2, Math.min(4, regionHeight * 0.24)));
    }
    if (usesTinyScanFallback && !region.cellBounds) {
      // Never expand left for low-resolution fallback boxes; they often begin
      // one pixel inside the table's vertical border.
      clearBbox.x0 = region.bbox.x0;
      clearBbox.x1 = Math.max(
        clearBbox.x1,
        Math.min(analysis.meta.width, region.bbox.x1 + Math.max(4, regionWidth * 0.4))
      );
    }
    return {
      bbox: editBbox,
      clearBbox,
      textBounds: region.cellBounds ? {
        x0: Math.max(
          region.cellBounds.x0 + textEdgeGuard,
          editBbox.x0
        ),
        x1: region.cellBounds.x1 - textEdgeGuard,
      } : undefined,
      // Pass the physically owned cell boundary through to the renderer. It
      // is used to recover the exact original rule path after all erase/text
      // compositing, not as another OCR-derived clearing estimate.
      leftRuleHint: Number.isFinite(region.cellBounds?.x0)
        ? region.cellBounds.x0
        : undefined,
      replacementText: sharedReplacementText,
      originalText: region.originalText,
      styleReferenceText: usesTinyScanFallback
        ? sharedReplacementText.replace(/\d/g, '0')
        : region.originalText,
      preferPageStyle: useCellStart || !originalTextIsReliable,
      // Never use a flat rectangular erase for inferred/faint values. The
      // selective inpaint path removes only detected glyph ink, preserves
      // straight and perspective-skewed rules, and copies local paper texture.
      solidErase: false,
      forceInteriorErase: Boolean(region.inkLocalized || region.ocrInkLocalized) ||
        useCellStart || !originalTextIsReliable,
      // A clean original weight is the only exact per-image typography
      // specimen. Damaged/partial OCR falls back to the neighbouring printed
      // dimensions, which prevents a rule fragment from producing huge type.
      preferSourceStyle: originalTextIsReliable &&
        regionWidth <= analysis.meta.width * 0.09 &&
        regionHeight <= analysis.meta.height * 0.035,
      // Measured source ink or the local template specimen already supplies
      // the correct size; width/height fitting in the renderer is the only
      // scaling needed.
      fontScale: 1,
      textLeftPaddingRatio: usesTinyScanFallback ? 0.03 : undefined,
      preferTextBoundsStart: useCellStart,
      // Always run the final image-based rule shrink. Even a precisely
      // localized glyph box can inherit a cell-left estimate that crosses a
      // skewed rule by a few pixels.
      skipRuleShrink: false,
    };
  });

  // Clean legacy weight text that an earlier editor run placed in the narrow
  // tail of BOXES & DIMENSION. This is deliberately not a general numeric
  // cleanup: candidates must be plain numbers on the exact weight row, close
  // to (but strictly left of) the proven ACTUAL boundary. Dimension strings
  // containing "x", box counts at the far left, and SAID TO CONTAIN content
  // cannot enter this band.
  const actualRegionForCleanup = regions.find((region) => region.kind === 'actual' && region.cellBounds);
  if (actualRegionForCleanup) {
    const actualLeft = actualRegionForCleanup.cellBounds.x0;
    const actualCellWidth = actualRegionForCleanup.cellBounds.x1 - actualLeft;
    const rowCenter = (actualRegionForCleanup.bbox.y0 + actualRegionForCleanup.bbox.y1) / 2;
    const rowHeight = Math.max(8, actualRegionForCleanup.bbox.y1 - actualRegionForCleanup.bbox.y0);
    const cleanupBandLeft = Math.max(
      analysis.meta.width * 0.14,
      actualLeft - Math.min(analysis.meta.width * 0.11, actualCellWidth * 0.82)
    );
    const cleanupCandidates = words
      .filter((word) => plainNumericWeightPattern.test(String(word.text || '').trim()))
      .filter((word) => matchesKnownWeightValue(word.text))
      .filter((word) => {
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        const height = word.bbox.y1 - word.bbox.y0;
        return word.bbox.x0 >= cleanupBandLeft &&
          word.bbox.x1 < actualLeft - 1 &&
          actualLeft - word.bbox.x1 <= analysis.meta.width * 0.08 &&
          Math.abs(centerY - rowCenter) <= Math.max(7, rowHeight * 0.95) &&
          height > 2 && height <= Math.max(30, analysis.meta.height * 0.05);
      })
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)
      .filter((word, index, all) => !all.slice(0, index).some((previous) => {
        const overlap = Math.max(0, Math.min(word.bbox.x1, previous.bbox.x1) - Math.max(word.bbox.x0, previous.bbox.x0));
        return overlap >= Math.min(word.bbox.x1 - word.bbox.x0, previous.bbox.x1 - previous.bbox.x0) * 0.55;
      }));

    for (const artifact of cleanupCandidates.reverse()) {
      const height = artifact.bbox.y1 - artifact.bbox.y0;
      replacements.unshift({
        bbox: { ...artifact.bbox },
        clearBbox: {
          x0: Math.max(cleanupBandLeft, artifact.bbox.x0 - Math.max(2, height * 0.2)),
          y0: Math.max(0, artifact.bbox.y0 - Math.max(1, height * 0.15)),
          x1: Math.min(actualLeft - 2, artifact.bbox.x1 + Math.max(3, height * 0.3)),
          y1: Math.min(analysis.meta.height, artifact.bbox.y1 + Math.max(2, height * 0.2)),
        },
        replacementText: '',
        originalText: String(artifact.text || '').trim(),
        eraseOnly: true,
        forceInteriorErase: true,
        solidErase: false,
        legacyCleanup: true,
      });
    }
  }

  // Remove only a legacy weight duplicate at the immediate start of SAID TO
  // CONTAIN. Product descriptions remain untouched: a candidate must be a
  // plain number, match an old/new weight, share the localized value row, and
  // fit inside the narrow first band to the right of the SAID heading edge.
  if (saidHeaderLeft !== null && saidHeaderLeft !== undefined && regions.length) {
    const renderedWeightRegions = regions.filter((region) => region.cellBounds);
    const rowCenter = renderedWeightRegions.reduce(
      (sum, region) => sum + (region.bbox.y0 + region.bbox.y1) / 2,
      0
    ) / Math.max(1, renderedWeightRegions.length);
    const rowHeight = Math.max(
      8,
      ...renderedWeightRegions.map((region) => region.bbox.y1 - region.bbox.y0)
    );
    const typicalCellWidth = renderedWeightRegions.length
      ? renderedWeightRegions.reduce(
          (sum, region) => sum + (region.cellBounds.x1 - region.cellBounds.x0),
          0
        ) / renderedWeightRegions.length
      : analysis.meta.width * 0.1;
    const cleanupBandRight = Math.min(
      analysis.meta.width,
      saidHeaderLeft + Math.min(analysis.meta.width * 0.105, typicalCellWidth * 0.9)
    );
    const saidCleanupCandidates = words
      .filter((word) => plainNumericWeightPattern.test(String(word.text || '').trim()))
      .filter((word) => matchesKnownWeightValue(word.text))
      .filter((word) => {
        const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
        const height = word.bbox.y1 - word.bbox.y0;
        return word.bbox.x0 >= saidHeaderLeft - 2 &&
          word.bbox.x1 <= cleanupBandRight &&
          Math.abs(centerY - rowCenter) <= Math.max(7, rowHeight * 0.95) &&
          height > 2 && height <= Math.max(30, analysis.meta.height * 0.05);
      })
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)
      .filter((word, index, all) => !all.slice(0, index).some((previous) => {
        const overlap = Math.max(
          0,
          Math.min(word.bbox.x1, previous.bbox.x1) - Math.max(word.bbox.x0, previous.bbox.x0)
        );
        return overlap >= Math.min(
          word.bbox.x1 - word.bbox.x0,
          previous.bbox.x1 - previous.bbox.x0
        ) * 0.55;
      }));

    for (const artifact of saidCleanupCandidates.reverse()) {
      const height = artifact.bbox.y1 - artifact.bbox.y0;
      replacements.unshift({
        bbox: { ...artifact.bbox },
        clearBbox: {
          x0: Math.max(saidHeaderLeft, artifact.bbox.x0 - Math.max(2, height * 0.2)),
          y0: Math.max(0, artifact.bbox.y0 - Math.max(1, height * 0.15)),
          x1: Math.min(cleanupBandRight, artifact.bbox.x1 + Math.max(3, height * 0.3)),
          y1: Math.min(analysis.meta.height, artifact.bbox.y1 + Math.max(2, height * 0.2)),
        },
        replacementText: '',
        originalText: String(artifact.text || '').trim(),
        eraseOnly: true,
        forceInteriorErase: true,
        solidErase: false,
        legacyCleanup: true,
        cleanupSide: 'said',
      });
    }
  }

  // Use the nearest box/dimension line as the per-image typography specimen.
  // It is generated by the same printer/template as the weight values but is
  // usually much clearer than the faint value OCR boxes themselves.
  const renderedReplacements = replacements.filter((replacement) => !replacement.eraseOnly);
  const replacementCenterY = renderedReplacements.reduce(
    (sum, replacement) => sum + (replacement.bbox.y0 + replacement.bbox.y1) / 2,
    0
  ) / Math.max(1, renderedReplacements.length);
  const firstWeightX = Math.min(...renderedReplacements.map((replacement) => replacement.bbox.x0));
  const maxReferenceYDistance = Math.max(14, analysis.meta.height * 0.04);
  const localReferenceCandidates = words
    .filter((word) => {
      const width = word.bbox.x1 - word.bbox.x0;
      const height = word.bbox.y1 - word.bbox.y0;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      const compact = String(word.text || '').replace(/\s/g, '');
      const isDimensionValue = /\d{1,3}[xX\u00d7]\d{1,3}[xX\u00d7]\d{1,3}/.test(compact);
      const isPlainNumber = /^\d{1,4}(?:[.,]\d{1,3})?$/.test(compact);
      return word.bbox.x1 < firstWeightX - 2 &&
        word.bbox.x0 > analysis.meta.width * 0.02 &&
        Math.abs(centerY - replacementCenterY) <= maxReferenceYDistance &&
        width >= 4 && height >= 4 && height <= Math.max(24, analysis.meta.height * 0.045) &&
        compact.length >= 2 && compact.length <= 18 &&
        (isDimensionValue || isPlainNumber);
    })
    .map((word) => ({
      bbox: word.bbox,
      text: word.text,
      centerY: (word.bbox.y0 + word.bbox.y1) / 2,
      priority: /\d{1,3}[xX\u00d7]\d{1,3}[xX\u00d7]\d{1,3}/.test(
        String(word.text || '').replace(/\s/g, '')
      ) ? 0 : 1,
    }))
    .sort((a, b) =>
      a.priority - b.priority ||
      Math.abs(a.centerY - replacementCenterY) - Math.abs(b.centerY - replacementCenterY) ||
      b.bbox.x1 - a.bbox.x1
    );
  const bestReferenceY = localReferenceCandidates[0]?.centerY;
  const bestReferencePriority = localReferenceCandidates[0]?.priority;
  const preferredStyleReferences = bestReferenceY === undefined
    ? []
    : localReferenceCandidates
      .filter((candidate) =>
        candidate.priority === bestReferencePriority &&
        Math.abs(candidate.centerY - bestReferenceY) <= Math.max(4, analysis.meta.height * 0.008)
      )
      .slice(0, 6)
      .map(({ bbox, text }) => ({ bbox, text }));
  const reliableWeightStyleReferences = regions
    .filter((region) => /^\d{2,6}(?:[.,]\d{1,3})?$/.test(String(region.originalText || '').trim()))
    .filter((region) =>
      region.ocrConfidence === undefined || region.ocrConfidence >= config.ocrMinConfidence
    )
    .map((region) => ({ bbox: region.bbox, text: region.originalText }));
  // A clean original weight is the exact printer/font specimen for this
  // label. Use dimensions only when no reliable old weight remains readable.
  const exactPreferredStyleReferences = reliableWeightStyleReferences.length
    ? reliableWeightStyleReferences
    : preferredStyleReferences;

  // Sibling numeric words on the same page (box dimensions, counts, dates,
  // etc.) act as per-image typography references so the replacement text
  // matches the size and ink color of the surrounding print, even when the
  // weight value's own pixels are too faint/blurry to measure reliably.
  const replacementBoxes = replacements.map((r) => r.bbox);
  const styleReferences = [];
  for (const word of words) {
    const digits = word.text.replace(NON_DIGIT, '');
    if (digits.length < 2 || word.text.length > 12) continue;
    if ((word.text.match(/[a-z]/gi) || []).length > 2) continue;
    const wordHeight = word.bbox.y1 - word.bbox.y0;
    if (wordHeight < 3 || wordHeight > analysis.meta.height * 0.2) continue;
    const overlapsReplacement = replacementBoxes.some(
      (region) =>
        word.bbox.x0 - 2 < region.x1 &&
        word.bbox.x1 + 2 > region.x0 &&
        word.bbox.y0 - 2 < region.y1 &&
        word.bbox.y1 + 2 > region.y0
    );
    if (overlapsReplacement) continue;
    styleReferences.push({ bbox: word.bbox, text: word.text });
    if (styleReferences.length >= 60) break;
  }

  const editedBuffer = await imageEditor.replaceWeightRegions(
    processingInput,
    replacements,
    {
    styleReferences,
    preferredStyleReferences: exactPreferredStyleReferences,
    }
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const outputImageId = detectedImageId?.id || match.id;
  const writtenOutput = await writeOutputNamedByShipmentId(outputPath, outputImageId, editedBuffer);

  return {
    status: 'ok',
    shipmentId: match.id,
    shipmentIdSource: match.source || 'ocr',
    detectedImageId: detectedImageId?.id || null,
    outputImageId,
    appliedRotation: analysis.rotation,
    newWeight,
    processingMs: elapsedMs(),
    replacedRegions: replacements
      .filter((replacement) => !replacement.eraseOnly)
      .map((r) => ({
        originalText: r.originalText,
        newText: r.replacementText,
        bbox: r.bbox,
      })),
    cleanedLegacyArtifacts: replacements
      .filter((replacement) => replacement.legacyCleanup)
      .map((replacement) => ({
        originalText: replacement.originalText,
        bbox: replacement.bbox,
      })),
    outputFilename: writtenOutput.outputFilename,
    downloadable: true,
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
