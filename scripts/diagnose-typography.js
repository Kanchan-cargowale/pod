'use strict';

// Re-runs the real worker pipeline on retained originals and reports which
// rendering path produced the replacement plus an objective comparison of the
// rendered glyphs against the neighbouring BOXES x DIMENSION specimen.
//
//   node scripts/diagnose-typography.js <jobId> [shipmentId ...]

process.env.POD_TYPOGRAPHY_DEBUG = '1';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { Worker } = require('worker_threads');
const config = require('../src/config');
const { sampleTextStyle } = require('../src/services/imageEditor.service');

const WORKER_PATH = path.join(__dirname, '..', 'src', 'workers', 'imageProcessor.worker.js');

function runTask(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { env: process.env });
    const finish = (fn, value) => {
      worker.postMessage({ type: 'shutdown' });
      worker.terminate().catch(() => {});
      fn(value);
    };
    worker.on('message', (msg) => {
      if (msg.taskId !== 'diag') return;
      if (msg.ok) finish(resolve, msg.result);
      else finish(reject, new Error(msg.error.message));
    });
    worker.on('error', reject);
    worker.postMessage({ type: 'task', taskId: 'diag', payload });
  });
}

async function measure(imagePath, bbox) {
  const image = sharp(imagePath);
  const meta = await image.metadata();
  const style = await sampleTextStyle(image, meta, bbox, '00000');
  return style.measured ? {
    inkHeight: style.inkHeight,
    inkWidth: style.inkWidth,
    fillLuma: Number(style.fillLuma.toFixed(1)),
    strokeDensity: Number(style.strokeDensity.toFixed(3)),
    normalizedStrokeThickness: Number(style.normalizedStrokeThickness.toFixed(3)),
    paper: Number(style.localBackground.toFixed(1)),
  } : null;
}

// Same yardstick for specimen and replacement: rows/columns whose darkness
// reaches half the region's solid-ink darkness, with cell rules removed.
async function visibleInk(imagePath, bbox, pad = 2) {
  const meta = await sharp(imagePath).metadata();
  const left = Math.max(0, Math.floor(bbox.x0) - pad);
  const top = Math.max(0, Math.floor(bbox.y0) - pad);
  const width = Math.min(meta.width - left, Math.ceil(bbox.x1) - left + pad);
  const height = Math.min(meta.height - top, Math.ceil(bbox.y1) - top + pad);
  const data = await sharp(imagePath).extract({ left, top, width, height })
    .greyscale().raw().toBuffer();
  const sorted = Array.from(data).sort((a, b) => a - b);
  const paper = sorted[Math.floor(sorted.length * 0.85)];
  const dark = Array.from(data, (v) => Math.max(0, paper - v));
  const inked = dark.filter((d) => d > 20).sort((a, b) => a - b);
  if (!inked.length) return null;
  const solid = inked[Math.floor(inked.length * 0.9)];
  const on = (x, y) => dark[y * width + x] >= solid * 0.5;
  const ruleCols = new Set();
  for (let x = 0; x < width; x += 1) {
    let n = 0;
    for (let y = 0; y < height; y += 1) if (on(x, y)) n += 1;
    if (n >= height * 0.75) ruleCols.add(x);
  }
  const rows = [];
  const cols = [];
  for (let y = 0; y < height; y += 1) {
    let n = 0;
    for (let x = 0; x < width; x += 1) if (!ruleCols.has(x) && on(x, y)) { n += 1; cols.push(x); }
    if (n > 0 && n < width * 0.75) rows.push(y);
  }
  if (!rows.length) return null;
  return {
    height: rows[rows.length - 1] - rows[0] + 1,
    width: Math.max(...cols) - Math.min(...cols) + 1,
    darkness: Math.round(solid),
  };
}

async function main() {
  const [jobId, ...requested] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/.test(jobId || '')) throw new Error('Pass a job UUID');
  const job = JSON.parse(await fs.readFile(path.join(config.jobsDir, `${jobId}.json`), 'utf8'));
  const idWeightMap = new Map(
    job.results.filter((r) => r.shipmentId && Number.isFinite(Number(r.newWeight)))
      .map((r) => [r.shipmentId, Number(r.newWeight)])
  );
  const targets = job.results.filter((r) =>
    r.originalPreviewFilename && r.status === 'ok' &&
    (!requested.length || requested.includes(r.shipmentId))
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pod-diag-'));

  for (const target of targets) {
    const sourcePath = path.join(config.uploadsDir, jobId, target.originalPreviewFilename);
    const outputPath = path.join(tmp, `${target.shipmentId}.jpg`);
    let result;
    const startedAt = Date.now();
    try {
      result = await runTask({
        filePath: sourcePath,
        outputPath,
        idWeightMap: new Map([[target.shipmentId, idWeightMap.get(target.shipmentId)]]),
        filenameHint: target.originalFilename,
      });
    } catch (error) {
      console.log(JSON.stringify({ id: target.shipmentId, error: error.message }));
      continue;
    }
    const elapsedMs = Date.now() - startedAt;
    const diag = result.typographyDiagnostics || {};
    if (process.env.POD_DIAG_CACHE) {
      const cacheFile = process.env.POD_DIAG_CACHE;
      let cache = {};
      try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { cache = {}; }
      cache[target.shipmentId] = {
        sourcePath,
        replacementText: result.replacedRegions?.[0]?.newText || null,
        originalText: result.replacedRegions?.[0]?.originalText || null,
        originalBbox: result.replacedRegions?.[0]?.bbox || null,
        primaryRasterReferences: diag.primaryRasterReferences || [],
        preferredStyleReferences: diag.preferredStyleReferences || [],
        styleReferences: diag.styleReferences || [],
      };
      await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    }
    const rendered = (diag.events || []).filter((e) => e.stage === 'render');
    const specimen = (diag.primaryRasterReferences || [])[0] ||
      (diag.preferredStyleReferences || [])[0] || null;
    const written = path.join(path.dirname(outputPath), result.outputFilename || path.basename(outputPath));
    const region = result.replacedRegions?.[0];
    const report = {
      id: target.shipmentId,
      newWeight: result.newWeight,
      replacedText: region ? `${region.originalText || '(blank)'} -> ${region.newText}` : null,
      renderPaths: rendered.map((e) => e.path),
      renderDetail: rendered,
      referenceEvents: (diag.events || []).filter((e) => e.stage !== 'render'),
      specimenText: specimen?.text || null,
    };
    if (region && specimen) {
      report.specimenVisible = await visibleInk(written, specimen.bbox, 1);
      report.renderedVisible = await visibleInk(written, region.bbox, 3);
      report.specimenInk = await measure(written, specimen.bbox);
      report.renderedInk = await measure(written, {
        x0: region.bbox.x0 - 2, y0: region.bbox.y0 - 3,
        x1: region.bbox.x1 + 3, y1: region.bbox.y1 + 3,
      });
      if (report.specimenInk && report.renderedInk) {
        report.heightDeltaPct = Number((
          (report.renderedInk.inkHeight - report.specimenInk.inkHeight) /
          report.specimenInk.inkHeight * 100
        ).toFixed(1));
        report.inkLumaDelta = Number((
          report.renderedInk.fillLuma - report.specimenInk.fillLuma
        ).toFixed(1));
        report.strokeDensityDelta = Number((
          report.renderedInk.strokeDensity - report.specimenInk.strokeDensity
        ).toFixed(3));
      }
    }
    if (region && process.env.POD_DIAG_CROPS) {
      const boxes = result.replacedRegions.map((entry) => entry.bbox);
      const meta = await sharp(sourcePath).metadata();
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
      const sources = [
        sourcePath,
        path.join(config.outputsDir, jobId, target.outputFilename),
        written,
      ];
      const panels = [];
      for (const source of sources) {
        panels.push(await sharp(source).extract(crop)
          .resize(panelWidth, panelHeight, { kernel: 'nearest' }).png().toBuffer());
      }
      await fs.mkdir(process.env.POD_DIAG_CROPS, { recursive: true });
      report.crop = path.join(process.env.POD_DIAG_CROPS, `${target.shipmentId}.png`);
      await sharp({
        create: {
          width: panelWidth, height: panelHeight * 3 + 12,
          channels: 3, background: '#ff0000',
        },
      }).composite(panels.map((input, index) => ({
        input, top: index * (panelHeight + 6), left: 0,
      }))).png().toFile(report.crop);
    }
    if (process.env.POD_DIAG_BRIEF) {
      const r = rendered[0] || {};
      console.log([
        report.id, `${elapsedMs}ms`, `edit=${diag.editMs ?? '-'}ms`, r.path || 'none', r.family || '-', r.weight || '-',
        `vis=${r.visibleHeight ?? '-'}`, `spec=${report.specimenInk?.inkHeight ?? '-'}`,
        `specH=${report.specimenVisible?.height ?? '-'}`,
        `outH=${report.renderedVisible?.height ?? '-'}`,
        `specDark=${report.specimenVisible?.darkness ?? '-'}`,
        `outDark=${report.renderedVisible?.darkness ?? '-'}`,
        `spec=${specimen?.text || '-'}`,
        `stroke=${r.renderedStrokeMass ?? '-'}/${r.targetStrokeMass ?? '-'}(adj ${r.strokeAdjustment ?? '-'})`,
      ].join(' '));
    } else {
      report.elapsedMs = elapsedMs;
      console.log(JSON.stringify(report));
    }
  }
  console.log(JSON.stringify({ tmp }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
