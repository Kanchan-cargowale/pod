'use strict';

// Self-contained typography-match check. Renders a synthetic label with a
// printed weight value and a sibling dimension value in a deliberately
// different size/family/ink tone, replaces the weight via the real editor
// pipeline, then verifies:
//   1. The replacement glyph height tracks the dimension specimen.
//   2. The replacement ink tracks the dimension specimen rather than the old
//      weight value.
//   3. Pixels outside the weight cell are untouched (true pixel preservation).
// No OCR, no external fixtures.

const sharp = require('sharp');
const { replaceWeightRegions, sampleTextStyle } = require('../src/services/imageEditor.service');

const WIDTH = 1024;
const HEIGHT = 300;
const CELL_LEFT = 302;
const CELL_RIGHT = 470;
const BASELINE_Y = 185;

function labelSvg({ weightText, weightSize, weightFill, dimText, dimSize, dimFamily, dimWeight, dimFill }) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
      `<rect width="100%" height="100%" fill="white"/>` +
      `<rect x="${CELL_LEFT}" y="120" width="2" height="90" fill="black"/>` +
      `<rect x="${CELL_RIGHT}" y="120" width="2" height="90" fill="black"/>` +
      `<text x="312" y="140" font-family="Arial" font-size="12" fill="black">ACTUAL WEIGHT(kg)</text>` +
      `<text x="312" y="${BASELINE_Y}" font-family="Arial" font-size="${weightSize}" ` +
        `font-weight="400" fill="${weightFill}">${weightText}</text>` +
      `<text x="120" y="${BASELINE_Y}" font-family="${dimFamily}" font-size="${dimSize}" ` +
        `font-weight="${dimWeight}" fill="${dimFill}">${dimText}</text>` +
      `</svg>`
  );
}

// Measure glyph height plus darkest and representative visible ink inside a box.
async function measureInk(buffer, box) {
  const left = Math.max(0, Math.floor(box.x0));
  const top = Math.max(0, Math.floor(box.y0));
  const width = Math.ceil(box.x1) - left;
  const height = Math.ceil(box.y1) - top;
  const { data, info } = await sharp(buffer)
    .extract({ left, top, width, height })
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  let minY = info.height;
  let maxY = -1;
  let darkest = 255;
  let inkCount = 0;
  const visibleInkLumas = [];
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const luma = data[y * info.width + x];
      if (luma < 200) visibleInkLumas.push(luma);
      if (luma < 160) {
        inkCount += 1;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (luma < darkest) darkest = luma;
      }
    }
  }
  visibleInkLumas.sort((a, b) => a - b);
  return {
    inkHeight: maxY >= minY ? maxY - minY + 1 : 0,
    darkestLuma: inkCount ? darkest : 255,
    representativeLuma: visibleInkLumas.length
      ? visibleInkLumas[Math.floor(visibleInkLumas.length * 0.25)]
      : 255,
    inkCount,
  };
}

// Count how many pixels differ outside the weight cell (should be ~0).
async function countOutsideCellDiff(a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { data: da, info } = ra;
  const { data: db } = rb;
  let diff = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      // skip the editable cell band
      if (x >= CELL_LEFT - 2 && x <= CELL_RIGHT + 2 && y >= 118 && y <= 212) continue;
      if (Math.abs(da[y * info.width + x] - db[y * info.width + x]) > 12) diff += 1;
    }
  }
  return diff;
}

async function run(testCase) {
  const source = await sharp(labelSvg(testCase)).png().toBuffer();
  const measureBox = { x0: CELL_LEFT + 4, y0: 150, x1: CELL_RIGHT - 2, y1: 205 };
  const oldWeight = await measureInk(source, measureBox);
  const dimensionBox = {
    x0: 118,
    y0: BASELINE_Y - testCase.dimSize * 0.9,
    x1: 120 + testCase.dimText.length * testCase.dimSize * 0.62,
    y1: BASELINE_Y + 3,
  };
  const dimension = await measureInk(source, dimensionBox);
  const sourceImage = sharp(source);
  const sourceMeta = await sourceImage.metadata();
  const dimensionStyle = await sampleTextStyle(
    sourceImage, sourceMeta, dimensionBox, testCase.dimText
  );

  const bbox = {
    x0: 311,
    y0: BASELINE_Y - testCase.weightSize * 0.78,
    x1: 311 + testCase.weightText.length * testCase.weightSize * 0.56,
    y1: BASELINE_Y + 2,
  };
  const replacements = [{
    bbox,
    clearBbox: { x0: CELL_LEFT + 3, y0: 162, x1: CELL_RIGHT - 3, y1: 200 },
    textBounds: { x0: 311, x1: CELL_RIGHT - 4 },
    leftRuleHint: CELL_LEFT,
    originalText: testCase.weightText,
    replacementText: testCase.replacementText,
    preferSourceStyle: true,
    forceInteriorErase: true,
    solidErase: false,
  }];

  const dimensionReferences = [{ bbox: dimensionBox, text: testCase.dimText }];
  const diagnostics = process.env.POD_VERIFY_TRACE ? { events: [] } : null;
  const output = await replaceWeightRegions(source, replacements, {
    diagnostics,
    styleReferences: dimensionReferences,
    preferredStyleReferences: dimensionReferences,
    primaryRasterReferences: dimensionReferences,
    validationStyleReferences: dimensionReferences,
    matchValidationInk: true,
    preferSourceInk: true,
    separateInkTone: true,
    matchNeighborTypography: true,
    lockBodyTypography: true,
    matchSourceText: true,
  });

  const after = await measureInk(output, measureBox);
  const outsideDiff = await countOutsideCellDiff(source, output);
  const rowCenterY = (bbox.y0 + bbox.y1) / 2;
  const outputStyleBox = {
    x0: 309,
    y0: rowCenterY - testCase.dimSize,
    x1: Math.min(CELL_RIGHT - 2,
      311 + testCase.replacementText.length * testCase.dimSize * 0.75),
    y1: rowCenterY + testCase.dimSize,
  };
  const outputImage = sharp(output);
  const outputStyle = await sampleTextStyle(
    outputImage, await outputImage.metadata(), outputStyleBox, testCase.replacementText
  );

  const dimensionHeightPct = dimension.inkHeight
    ? Math.abs(after.inkHeight - dimension.inkHeight) / dimension.inkHeight * 100
    : 999;
  const dimensionInkDelta = dimensionStyle.measured && outputStyle.measured
    ? Math.abs(outputStyle.fillLuma - dimensionStyle.fillLuma)
    : 999;

  return {
    name: testCase.name,
    ...(diagnostics ? { trace: diagnostics.events } : {}),
    oldWeightHeight: oldWeight.inkHeight,
    dimensionHeight: dimension.inkHeight,
    outHeight: after.inkHeight,
    dimensionHeightPct: Number(dimensionHeightPct.toFixed(1)),
    oldWeightDarkest: oldWeight.darkestLuma,
    dimensionDarkest: dimension.darkestLuma,
    outDarkest: after.darkestLuma,
    dimensionRepresentativeInk: dimension.representativeLuma,
    outRepresentativeInk: after.representativeLuma,
    dimensionSampledInk: dimensionStyle.fillLuma,
    outSampledInk: outputStyle.fillLuma,
    dimensionInkDelta: Number(dimensionInkDelta.toFixed(1)),
    outsideCellChangedPx: outsideDiff,
    pass:
      dimensionHeightPct <= 25 &&
      dimensionInkDelta <= 25 &&
      after.inkCount > 0 &&
      outsideDiff <= 40,
  };
}

async function main() {
  const cases = [
    { name: 'old weight 18px / primary dimension 12px', weightText: '36.00', weightSize: 18,
      weightFill: 'rgb(15,15,15)', dimText: '40x35x20', dimSize: 12,
      dimFamily: 'DejaVu Sans', dimWeight: 400, dimFill: 'rgb(85,85,85)', replacementText: '900.00' },
    { name: 'old weight 14px / primary dimension 20px', weightText: '102.34', weightSize: 14,
      weightFill: 'rgb(20,20,20)', dimText: '62x40x25', dimSize: 20,
      dimFamily: 'DejaVu Sans', dimWeight: 600, dimFill: 'rgb(95,95,95)', replacementText: '500.00' },
    { name: 'old weight 19px / primary dimension 15px', weightText: '720.00', weightSize: 19,
      weightFill: 'rgb(110,110,110)', dimText: '70x40x29', dimSize: 15,
      dimFamily: 'DejaVu Sans', dimWeight: 500, dimFill: 'rgb(35,35,35)', replacementText: '650.00' },
  ];

  const results = [];
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await run(testCase));
  }
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} case(s) outside tolerance`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${results.length} cases within tolerance`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
