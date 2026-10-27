'use strict';

const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');

/**
 * Records the correction metadata for an edited label without altering a
 * single pixel beyond the weight values the worker already replaced.
 *
 * The edited image is left exactly as the worker produced it: only the
 * weight-value regions differ from the source scan, everything else is
 * byte-identical. We deliberately do NOT extend the canvas or stamp any
 * "CORRECTED COPY" notice onto the output - the deliverable must look like
 * the original label with only the weight changed.
 *
 * We still keep a `.correction.json` audit record (SHA-256 of the source and
 * of the final output, plus the list of replaced regions) and a copy of the
 * original scan for the correction trail, but neither is composited onto the
 * delivered image.
 */
async function recordCorrection({ originalPath, outputPath, originalsDir, result }) {
  const original = await fs.readFile(originalPath);
  const edited = await fs.readFile(outputPath);

  await fs.mkdir(originalsDir, { recursive: true });
  const originalName = `${path.basename(outputPath)}.original.png`;
  const normalizedOriginal = await sharp(original).rotate().png().toBuffer();
  await sharp(normalizedOriginal).rotate(result.appliedRotation || 0).png()
    .toFile(path.join(originalsDir, originalName));

  const record = {
    version: 1,
    correctedAt: new Date().toISOString(),
    shipmentId: result.shipmentId,
    outputFilename: path.basename(outputPath),
    originalSha256: createHash('sha256').update(original).digest('hex'),
    // The output is the worker's edited buffer, unmodified by this step.
    correctedSha256: createHash('sha256').update(edited).digest('hex'),
    changes: result.replacedRegions || [],
    rendering: 'measured source-text fit with nearby printed-text fallback',
  };
  await fs.writeFile(`${outputPath}.correction.json`, JSON.stringify(record, null, 2));

  return { originalPreviewFilename: originalName, correctionRecord: record, correctedCopy: true };
}

module.exports = { recordCorrection };
