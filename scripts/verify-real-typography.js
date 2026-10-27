'use strict';

// QA with retained originals. Pass source job UUID, then optionally the new
// job UUID to create crops ordered original / previous output / new output.
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const ExcelJS = require('exceljs');
const config = require('../src/config');
const ids = ['298274933', '319592767', '319592769', '314262917', '308134090'];

async function main() {
  const [sourceJobId, newJobId] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/.test(sourceJobId || '') ||
    (newJobId && !/^[a-f0-9-]{36}$/.test(newJobId))) throw new Error('Pass valid source/new job UUIDs');
  const source = JSON.parse(await fs.readFile(path.join(config.jobsDir, `${sourceJobId}.json`), 'utf8'));
  const outputDir = path.join(config.storageDir, 'qa', 'typography-real');
  await fs.mkdir(outputDir, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Weights');
  sheet.addRow(['ID', 'Weight']);
  const files = [];
  for (const id of ids) {
    const result = source.results.find((entry) => entry.shipmentId === id && entry.originalPreviewFilename);
    if (!result) throw new Error(`No retained original for ${id}`);
    sheet.addRow([id, result.newWeight]);
    const originalPath = path.join(config.uploadsDir, sourceJobId, result.originalPreviewFilename);
    const fixture = path.join(outputDir, `${id}.png`);
    await fs.copyFile(originalPath, fixture);
    files.push(fixture);
  }
  const mapping = path.join(outputDir, 'weights.xlsx');
  await workbook.xlsx.writeFile(mapping);
  console.log(JSON.stringify({ files, mapping }));
  if (!newJobId) return;
  const updated = JSON.parse(await fs.readFile(path.join(config.jobsDir, `${newJobId}.json`), 'utf8'));
  for (const id of ids) {
    const result = updated.results.find((entry) => entry.shipmentId === id);
    if (!result || result.status !== 'ok') continue;
    const original = path.join(outputDir, `${id}.png`);
    const metadata = await sharp(original).metadata();
    const regions = result.replacedRegions.map((entry) => entry.bbox);
    const top = Math.max(0, Math.floor(Math.min(...regions.map((box) => box.y0)) - 30));
    const bottom = Math.min(metadata.height, Math.ceil(Math.max(...regions.map((box) => box.y1)) + 55));
    const crop = { left: 0, top, width: Math.ceil(metadata.width * 0.65), height: bottom - top };
    const cropWidth = 1500;
    const cropHeight = Math.round(crop.height * cropWidth / crop.width);
    const inputs = [original,
      path.join(config.outputsDir, sourceJobId, source.results.find((entry) => entry.shipmentId === id).outputFilename),
      path.join(config.outputsDir, newJobId, result.outputFilename)];
    const overlays = [];
    for (let index = 0; index < inputs.length; index += 1) {
      overlays.push({ input: await sharp(inputs[index]).extract(crop).resize(cropWidth, cropHeight).png().toBuffer(),
        top: index * cropHeight, left: 0 });
    }
    const target = path.join(outputDir, `${id}-comparison.png`);
    await sharp({ create: { width: cropWidth, height: cropHeight * 3, channels: 3, background: 'white' } })
      .composite(overlays).png().toFile(target);
    console.log(JSON.stringify({ id, comparison: target, order: ['original', 'previous renderer', 'updated renderer'] }));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
