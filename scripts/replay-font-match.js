'use strict';

// Replays only the raster appearance match against cached specimen boxes, so
// matcher changes can be evaluated without re-running OCR on every label.
//
//   node scripts/replay-font-match.js <cacheFile> [shipmentId ...]

const fs = require('fs/promises');
const sharp = require('sharp');
const { sampleTextStyle } = require('../src/services/imageEditor.service');
const { matchSourceAppearance } = require('../src/services/textAppearance.service');

async function main() {
  const [cacheFile, ...requested] = process.argv.slice(2);
  if (!cacheFile) throw new Error('Usage: replay-font-match.js <cacheFile> [shipmentId ...]');
  const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));

  for (const [id, entry] of Object.entries(cache)) {
    if (requested.length && !requested.includes(id)) continue;
    const ref = entry.primaryRasterReferences[0];
    if (!ref) {
      console.log(JSON.stringify({ id, note: 'no primary dimension reference' }));
      continue;
    }
    const image = sharp(entry.sourcePath);
    const meta = await image.metadata();
    const compact = String(ref.text).replace(/\s/g, '');
    const style = await sampleTextStyle(image, meta, ref.bbox, compact);
    const collector = [];
    const fit = await matchSourceAppearance(
      image, meta, ref.bbox, compact, style, { dimensionReference: true, collector }
    );
    if (process.env.POD_SHOW_CANDIDATES) {
      const ranked = collector
        .filter((c) => c.referenceText === compact && c.angle === 0 && !c.letterSpacing)
        .sort((a, b) => a.score - b.score)
        .slice(0, Number(process.env.POD_SHOW_CANDIDATES) || 10);
      console.log(`--- ${id} candidate ranking (stage 1, specimen ${compact}) ---`);
      for (const c of ranked) {
        console.log(
          `  ${String(c.score.toFixed(4)).padEnd(8)} ${c.family.padEnd(30)} ` +
          `w=${c.weight} blur=${c.blur} sz=${c.size.toFixed(1)} ` +
          `native=${(c.nativeError ?? NaN).toFixed(4)} mask=${c.maskError.toFixed(4)} ` +
          `stroke=${c.strokeError.toFixed(3)} cov=${c.coverageError.toFixed(3)}`
        );
      }
    }
    console.log(JSON.stringify({
      id,
      change: `${entry.originalText || '(blank)'} -> ${entry.replacementText}`,
      specimen: compact,
      specimenMeasured: {
        inkHeight: style.inkHeight,
        fontWeight: style.fontWeight,
        strokeDensity: Number((style.strokeDensity || 0).toFixed(3)),
        normalizedStrokeThickness: Number((style.normalizedStrokeThickness || 0).toFixed(3)),
        densityThreshold: Number((style.densityThreshold || 0).toFixed(3)),
        edgeSoftness: Number((style.edgeSoftness || 0).toFixed(3)),
      },
      fit: fit ? {
        family: fit.family,
        weight: fit.weight,
        size: Number(fit.size.toFixed(2)),
        blur: fit.blur,
        angle: fit.angle,
        letterSpacing: Number(fit.letterSpacing.toFixed(2)),
        score: Number(fit.score.toFixed(4)),
        visibleHeight: fit.height,
      } : null,
    }));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
