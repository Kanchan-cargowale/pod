'use strict';

// Stacks the weight row from the retained original and the edited output so the
// replacement's typography can be compared against the printed neighbours.
//
//   node scripts/crop-compare.js <jobId> <outDir> [shipmentId ...]

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const config = require('../src/config');

async function main() {
  const [jobId, outDir, ...requested] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/.test(jobId || '') || !outDir) {
    throw new Error('Usage: crop-compare.js <jobId> <outDir> [shipmentId ...]');
  }
  const job = JSON.parse(await fs.readFile(path.join(config.jobsDir, `${jobId}.json`), 'utf8'));
  await fs.mkdir(outDir, { recursive: true });

  for (const result of job.results) {
    if (!result.originalPreviewFilename || result.status !== 'ok') continue;
    if (requested.length && !requested.includes(result.shipmentId)) continue;
    const boxes = (result.replacedRegions || []).map((entry) => entry.bbox);
    if (!boxes.length) continue;

    const originalPath = path.join(config.uploadsDir, jobId, result.originalPreviewFilename);
    const editedPath = path.join(config.outputsDir, jobId, result.outputFilename);
    const meta = await sharp(originalPath).metadata();
    const rowTop = Math.min(...boxes.map((b) => b.y0));
    const rowBottom = Math.max(...boxes.map((b) => b.y1));
    const pad = Math.max(10, Math.round((rowBottom - rowTop) * 1.2));
    const crop = {
      left: Math.max(0, Math.round(meta.width * 0.02)),
      top: Math.max(0, Math.round(rowTop - pad)),
      width: Math.min(meta.width - 1, Math.round(meta.width * 0.6)),
      height: Math.min(meta.height - rowTop + pad, Math.round(rowBottom - rowTop + pad * 2)),
    };
    const zoom = 3;
    const panelWidth = crop.width * zoom;
    const panelHeight = crop.height * zoom;
    const panels = [];
    for (const source of [originalPath, editedPath]) {
      panels.push(await sharp(source).extract(crop)
        .resize(panelWidth, panelHeight, { kernel: 'nearest' }).png().toBuffer());
    }
    const target = path.join(outDir, `${result.shipmentId}.png`);
    await sharp({
      create: {
        width: panelWidth, height: panelHeight * 2 + 6,
        channels: 3, background: '#ff0000',
      },
    }).composite([
      { input: panels[0], top: 0, left: 0 },
      { input: panels[1], top: panelHeight + 6, left: 0 },
    ]).png().toFile(target);
    console.log(JSON.stringify({
      id: result.shipmentId,
      change: (result.replacedRegions || [])
        .map((e) => `${e.originalText || '(blank)'} -> ${e.newText}`).join(', '),
      file: target,
    }));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
