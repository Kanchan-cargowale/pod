'use strict';

const sharp = require('sharp');
const path = require('path');
const { replaceWeightRegions, sampleTextStyle } = require('../src/services/imageEditor.service');

async function main() {
  const id = process.argv[2] || '298274933';
  const input = path.join(__dirname, '..', 'storage', 'qa', 'typography-real', `${id}.png`);
  const reference = id === '319592767'
    ? { text: '83x44x31', bbox: { x0: 110, y0: 309, x1: 180, y1: 324 } }
    : { text: '43x30x20', bbox: { x0: 70, y0: 345, x1: 142, y1: 360 } };
  const regions = id === '319592767'
    ? [{ x0: 306, y0: 314, x1: 360, y1: 335 }]
    : [
    { x0: 203, y0: 347, x1: 239, y1: 356 },
    { x0: 314, y0: 347, x1: 350, y1: 356 },
  ];
  const replacements = regions.map((bbox) => ({
    bbox, clearBbox: { x0: bbox.x0 - 3, y0: bbox.y0 - 3, x1: bbox.x1 + 8, y1: bbox.y1 + 4 },
    textBounds: { x0: bbox.x0, x1: bbox.x0 + 82 },
    originalText: id === '319592767' ? '84.74' : '225.0',
    replacementText: id === '319592767' ? '210.00' : '257.0', preferSourceStyle: true,
  }));
  const output = await replaceWeightRegions(input, replacements, {
    preferredStyleReferences: [reference], validationStyleReferences: [reference],
    matchValidationInk: true, separateInkTone: true, matchNeighborTypography: true,
    lockBodyTypography: true, matchSourceText: true,
  });
  const outputPath = path.join(__dirname, '..', 'storage', 'qa', 'typography-real', `${id}-direct.png`);
  await sharp(output).png().toFile(outputPath);
  const area = id === '319592767'
    ? { left: 40, top: 280, width: 500, height: 110 }
    : { left: 42, top: 328, width: 500, height: 85 };
  const originalCrop = await sharp(input).extract(area).resize(1500, 255).png().toBuffer();
  const updatedCrop = await sharp(output).extract(area).resize(1500, 255).png().toBuffer();
  const comparison = path.join(__dirname, '..', 'storage', 'qa', 'typography-real', `${id}-direct-comparison.png`);
  await sharp({ create: { width: 1500, height: 510, channels: 3, background: 'white' } })
    .composite([{ input: originalCrop, left: 0, top: 0 }, { input: updatedCrop, left: 0, top: 255 }])
    .png().toFile(comparison);
  const source = sharp(input), rendered = sharp(output), meta = await source.metadata();
  const styles = await Promise.all([
    sampleTextStyle(source, meta, reference.bbox, reference.text),
    sampleTextStyle(source, meta, regions[0], replacements[0].originalText),
    sampleTextStyle(rendered, meta, regions[0], replacements[0].replacementText),
  ]);
  console.log(JSON.stringify({ comparison, styles: styles.map(({ inkHeight, fillLuma, strokeDensity, inkWidth }) =>
    ({ inkHeight, fillLuma, strokeDensity, inkWidth })) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
