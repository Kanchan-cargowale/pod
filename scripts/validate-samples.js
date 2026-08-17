'use strict';

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { WorkerPool } = require('../src/services/workerPool.service');
const { inferSingleWeightRegionFromAnchor } = require('../src/services/weightRegionFallback.service');

async function main() {
  const pairs = process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf('=');
    if (separator < 1) throw new Error(`Expected ID=image-path, received: ${argument}`);
    return { id: argument.slice(0, separator), filePath: argument.slice(separator + 1) };
  });
  if (!pairs.length) throw new Error('Pass at least one ID=image-path pair');

  const outputDir = path.resolve('storage', 'qa', 'user-samples');
  await fs.mkdir(outputDir, { recursive: true });
  const mapping = new Map(pairs.map(({ id }) => [id, 777.7]));
  const pool = new WorkerPool(Math.min(3, pairs.length));
  try {
    const results = await Promise.all(pairs.map(({ filePath }, index) =>
      pool.run({
        filePath,
        outputPath: path.join(outputDir, `${index + 1}.png`),
        idWeightMap: mapping,
      }).then(async (result) => {
        let singleFallbackDiagnostic;
        if (result.status === 'id_matched_no_weight_region' && result.detectedWeightAnchorDetails) {
          const meta = await sharp(filePath).metadata();
          const diagnosticAnchors = result.detectedWeightAnchorDetails.map((entry) => ({
            bbox: entry.bbox,
            words: [{ text: entry.text, bbox: entry.bbox }],
          }));
          singleFallbackDiagnostic = await inferSingleWeightRegionFromAnchor(
            filePath,
            diagnosticAnchors,
            [],
            meta
          );
        }
        return { sample: index + 1, ...result, singleFallbackDiagnostic };
      })
    ));
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    await pool.shutdown();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
