'use strict';

const path = require('path');
const fs = require('fs/promises');
const { parentPort } = require('worker_threads');

const ocrService = require('../services/ocr.service');
const imageEditor = require('../services/imageEditor.service');
const { shouldTryQuarterTurns } = require('../services/imageOrientation.service');
const {
  inferActualSiblingRegion,
  inferWeightRegionsFromAnchors,
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

function buildWeightClearBbox(region, meta) {
  const width = region.bbox.x1 - region.bbox.x0;
  const height = region.bbox.y1 - region.bbox.y0;
  // Inferred regions deliberately have no OCR text. Treating that as a
  // one-character value made width/originalLength equal the entire cell and
  // expanded the erase box far into the next column/header. A typical weight
  // has at least four glyphs; the conservative estimate keeps all clearing in
  // the value's local ink band.
  const originalLength = Math.max(4, String(region.originalText || '').length);
  const horizontalPad = Math.max(5, height * 0.45, width / originalLength);
  const verticalPad = Math.max(2, height * 0.22);

  return {
    // Keep left expansion deliberately tiny. The image editor will still
    // protect table rules, but most Delhivery weight values begin just inside
    // a vertical border, so right/bottom expansion is where old decimal ghosts
    // usually need cleanup.
    x0: Math.max(0, region.bbox.x0 - Math.min(2, horizontalPad * 0.25)),
    y0: Math.max(0, region.bbox.y0 - verticalPad),
    x1: Math.min(meta.width, region.bbox.x1 + Math.min(horizontalPad * 1.65, width * 0.45)),
    y1: Math.min(meta.height, region.bbox.y1 + verticalPad),
  };
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

/**
 * Processes a single label image:
 *   1. OCR the whole page.
 *   2. Identify which shipment ID (from the mapping) is printed on it.
 *   3. Locate the weight value cell(s) belonging to that label.
 *   4. Overwrite just those pixels with the new weight, byte-for-byte
 *      preserving everything else, and write the result to disk.
 */
async function processImage({ filePath, outputPath, idWeightMap }) {
  const startedAtMs = Date.now();
  const elapsedMs = () => Date.now() - startedAtMs;
  const idSet = new Set(idWeightMap.keys());
  const originalMeta = await sharp(filePath).metadata();
  const needsAutoOrientation = Boolean(originalMeta.orientation && originalMeta.orientation !== 1);
  // Sharp's rotate() with no angle applies the EXIF transform and removes the
  // tag. OCR and editing must use these same normalized pixels/coordinates.
  const initialInput = needsAutoOrientation
    ? await sharp(filePath).rotate().toBuffer()
    : filePath;
  const initialMeta = needsAutoOrientation ? await sharp(initialInput).metadata() : originalMeta;

  function buildAnalysis(input, meta, rotation, words) {
    const match = findShipmentId(words, idSet, {
      minConfidence: config.ocrMinConfidence,
      fuzzyMaxDistance: config.matching.idFuzzyMaxDistance,
    });
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

      // eslint-disable-next-line no-await-in-loop
      const zoneInput = await sharp(input)
        .extract(crop)
        .resize({
          width: Math.round(crop.width * zone.scale),
          height: Math.round(crop.height * zone.scale),
        })
        .greyscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
      // eslint-disable-next-line no-await-in-loop
      const zoneOcr = await ocrService.recognize(zoneInput);
      words.push(...mapOcrWords(zoneOcr.words, zone.scale, crop.left, crop.top));
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

  async function inspectOrientation(input, meta, rotation) {
    const { words } = await ocrService.recognize(input);
    let result = buildAnalysis(input, meta, rotation, words);
    let shipmentIdZoneWords = null;

    async function getShipmentIdZoneWords() {
      if (!shipmentIdZoneWords) {
        shipmentIdZoneWords = await readShipmentIdZones(input, meta);
      }
      return shipmentIdZoneWords;
    }

    if (!result.match) {
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
      const enhancedIdWords = result.match ? [] : await getShipmentIdZoneWords();
      const enhancedResult = buildAnalysis(
        input,
        meta,
        rotation,
        // Keep the base OCR headers when enhanced OCR is needed for a faint
        // value. Replacing the word set entirely made one of the two column
        // headers disappear on scans such as 287980980.
        mergeWords(result.words, enhancedWords, enhancedIdWords)
      );
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

  function countWeightColumns(anchors) {
    const weightAnchors = anchors.filter((anchor) =>
      anchor.words.some((word) => /weight|weigh|actual|ctual|charg|chargeable/i.test(word.text))
    );
    return Math.max(1, Math.min(2, weightAnchors.length));
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
    return anchors.some((anchor) => {
      const ax0 = anchor.bbox.x0;
      const ax1 = anchor.bbox.x1;
      const ay0 = anchor.bbox.y0;
      const ay1 = anchor.bbox.y1;
      const overlapX = Math.max(0, Math.min(rx1, ax1) - Math.max(rx0, ax0));
      const overlapY = Math.max(0, Math.min(ry1, ay1) - Math.max(ry0, ay0));
      return overlapX > 0 && overlapY > 0;
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

  const expectedRegionCount = countWeightColumns(anchors);

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

  const maxSafeValueHeight = Math.max(14, analysis.meta.height * 0.025);
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
  if (structuralRegions.length === 2 && (regions.length < 2 || hasUnsafeMergedRegion)) {
    regions = structuralRegions;
  }

  // A normal printed value is a short, single text line. Enlarged OCR can
  // occasionally return a 30-40px box containing the two-line header plus the
  // value (observed as "1160"/"11168"). Such a box is never safe to erase.
  regions = regions.filter((region) => {
    const height = region.bbox.y1 - region.bbox.y0;
    return height <= maxSafeValueHeight;
  });

  if (regions.length < expectedRegionCount) {
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

  if (!match) {
    return {
      status: 'unmatched',
      reason: 'No shipment ID from the mapping sheet was found in the scanned label text',
      detectedNumbers: extractCandidateIds(words, config.ocrMinConfidence),
      processingMs: elapsedMs(),
    };
  }

  if (expectedRegionCount === 2 && regions.length < 2) {
    return {
      status: 'partial_weight_detection',
      shipmentId: match.id,
      newWeight: idWeightMap.get(match.id),
      reason: `Label requires 2 weight fields but only ${regions.length} could be located`,
      detectedWeightAnchors: anchors.map((a) => a.words.map((w) => w.text).join(' ')),
      processingMs: elapsedMs(),
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
      processingMs: elapsedMs(),
    };
  }

  const sharedReplacementText = formatSharedReplacementWeight(newWeight, regions);

  const replacements = regions.map((region) => {
    const regionWidth = region.bbox.x1 - region.bbox.x0;
    const regionHeight = region.bbox.y1 - region.bbox.y0;
    const originalTextIsReliable = /^\d{1,6}(?:\.\d{1,3})?$/.test(region.originalText);
    const usesTinyScanFallback = regionHeight <= 12 && !originalTextIsReliable;
    const clearBbox = buildWeightClearBbox(region, analysis.meta);
    if (usesTinyScanFallback) {
      // Never expand left for low-resolution fallback boxes; they often begin
      // one pixel inside the table's vertical border.
      clearBbox.x0 = region.bbox.x0;
      clearBbox.x1 = Math.max(
        clearBbox.x1,
        Math.min(analysis.meta.width, region.bbox.x1 + Math.max(4, regionWidth * 0.4))
      );
    }
    return {
      bbox: region.bbox,
      clearBbox,
      replacementText: sharedReplacementText,
      originalText: region.originalText,
      styleReferenceText: usesTinyScanFallback
        ? sharedReplacementText.replace(/\d/g, '0')
        : region.originalText,
      fontScale: usesTinyScanFallback ? 0.82 : 1,
      textLeftPaddingRatio: usesTinyScanFallback ? 0.03 : undefined,
    };
  });

  // Use the nearest box/dimension line as the per-image typography specimen.
  // It is generated by the same printer/template as the weight values but is
  // usually much clearer than the faint value OCR boxes themselves.
  const replacementCenterY = replacements.reduce(
    (sum, replacement) => sum + (replacement.bbox.y0 + replacement.bbox.y1) / 2,
    0
  ) / replacements.length;
  const firstWeightX = Math.min(...replacements.map((replacement) => replacement.bbox.x0));
  const maxReferenceYDistance = Math.max(14, analysis.meta.height * 0.04);
  const localReferenceCandidates = words
    .filter((word) => {
      const width = word.bbox.x1 - word.bbox.x0;
      const height = word.bbox.y1 - word.bbox.y0;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      const compact = String(word.text || '').replace(/\s/g, '');
      return word.bbox.x1 < firstWeightX - 2 &&
        word.bbox.x0 > analysis.meta.width * 0.02 &&
        Math.abs(centerY - replacementCenterY) <= maxReferenceYDistance &&
        width >= 4 && height >= 4 && height <= Math.max(24, analysis.meta.height * 0.045) &&
        compact.length >= 2 && compact.length <= 18;
    })
    .map((word) => ({
      bbox: word.bbox,
      text: word.text,
      centerY: (word.bbox.y0 + word.bbox.y1) / 2,
      priority: /box|\d|[x×]/i.test(word.text) ? 0 : 1,
    }))
    .sort((a, b) =>
      a.priority - b.priority ||
      Math.abs(a.centerY - replacementCenterY) - Math.abs(b.centerY - replacementCenterY) ||
      b.bbox.x1 - a.bbox.x1
    );
  const bestReferenceY = localReferenceCandidates[0]?.centerY;
  const preferredStyleReferences = bestReferenceY === undefined
    ? []
    : localReferenceCandidates
      .filter((candidate) => Math.abs(candidate.centerY - bestReferenceY) <= Math.max(4, analysis.meta.height * 0.008))
      .slice(0, 6)
      .map(({ bbox, text }) => ({ bbox, text }));

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

  const editedBuffer = await imageEditor.replaceWeightRegions(processingInput, replacements, {
    styleReferences,
    preferredStyleReferences,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const writtenOutput = await writeOutputNamedByShipmentId(outputPath, match.id, editedBuffer);

  return {
    status: 'ok',
    shipmentId: match.id,
    shipmentIdSource: match.source || 'ocr',
    appliedRotation: analysis.rotation,
    newWeight,
    processingMs: elapsedMs(),
    replacedRegions: replacements.map((r) => ({
      originalText: r.originalText,
      newText: r.replacementText,
      bbox: r.bbox,
    })),
    outputFilename: writtenOutput.outputFilename,
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
