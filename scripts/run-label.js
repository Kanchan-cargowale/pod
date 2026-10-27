'use strict';

// Runs one label through the real worker against a real mapping sheet and
// prints the outcome. Useful for ID-reading and typography checks.
//
//   node scripts/run-label.js <image> <mapping.xlsx> [outputDir]

process.env.POD_TYPOGRAPHY_DEBUG = process.env.POD_TYPOGRAPHY_DEBUG || '1';

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { Worker } = require('worker_threads');
const { parseWeightMapping } = require('../src/services/excelParser.service');

const WORKER_PATH = path.join(__dirname, '..', 'src', 'workers', 'imageProcessor.worker.js');

async function main() {
  const [image, mappingFile, outDir] = process.argv.slice(2);
  if (!image || !mappingFile) throw new Error('Usage: run-label.js <image> <mapping.xlsx> [outputDir]');
  const { map } = await parseWeightMapping(mappingFile);
  const dir = outDir || await fs.mkdtemp(path.join(os.tmpdir(), 'pod-label-'));
  await fs.mkdir(dir, { recursive: true });
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { env: process.env });
    worker.on('message', (msg) => {
      if (msg.taskId !== 'run') return;
      worker.terminate().catch(() => {});
      if (msg.ok) resolve(msg.result); else reject(new Error(msg.error.message));
    });
    worker.on('error', reject);
    worker.postMessage({
      type: 'task',
      taskId: 'run',
      payload: {
        filePath: image,
        outputPath: path.join(dir, path.basename(image)),
        idWeightMap: map,
        filenameHint: path.basename(image),
      },
    });
  });
  const render = (result.typographyDiagnostics?.events || []).filter((e) => e.stage === 'render');
  console.log(JSON.stringify({
    status: result.status,
    shipmentId: result.shipmentId,
    source: result.shipmentIdSource,
    reason: result.reason || null,
    replaced: (result.replacedRegions || []).map((r) => `${r.originalText} -> ${r.newText}`),
    render: render.map((e) => `${e.path} ${e.family}/${e.weight} vis=${e.visibleHeight}`),
    output: path.join(dir, result.outputFilename || ''),
    ms: Date.now() - started,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
