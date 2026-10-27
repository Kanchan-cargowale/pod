'use strict';

const sharp = require('sharp');
const { replaceWeightRegions, calibrateTextRendering, sampleTextStyle } = require('../../src/services/imageEditor.service');

const bbox = { x0: 40, y0: 47, x1: 92, y1: 65 };
async function source(color = 170, weight = 400, sourceSize = 16, referenceSize = 16) {
  return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="140">' +
    '<rect width="1000" height="140" fill="#f5f5f5"/>' +
    `<text x="40" y="62" font-family="Arial" font-weight="${weight}" font-size="${sourceSize}" fill="rgb(${color},${color},${color})">40.00</text>` +
    `<text x="40" y="120" font-family="Arial" font-weight="700" font-size="${referenceSize}" fill="#222">45x32x20</text></svg>`))
    .png().toBuffer();
}
const options = {
  preferredStyleReferences: [{ text: '45x32x20', bbox: { x0: 40, y0: 103, x1: 138, y1: 123 } }],
  validationStyleReferences: [{ text: '45x32x20', bbox: { x0: 40, y0: 103, x1: 138, y1: 123 } }],
  matchValidationInk: true, preferSourceInk: true, separateInkTone: true,
  matchSourceText: false, lockBodyTypography: true,
};
const replacement = { bbox, clearBbox: { x0: 37, y0: 44, x1: 106, y1: 68 },
  originalText: '40.00', replacementText: '58.00', preferSourceStyle: true };
async function darkest(buffer) {
  const pixels = await sharp(buffer).extract({ left: 37, top: 44, width: 70, height: 25 })
    .greyscale().raw().toBuffer();
  return Math.min(...pixels);
}

describe('local ink for corrected copies', () => {
  it.each([400, 700])('matches surrounding body text at weight %s when requested', async (weight) => {
    const input = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="160">' +
      '<rect width="1000" height="160" fill="#f5f5f5"/>' +
      '<text x="40" y="62" font-family="Arial" font-size="12" fill="#aaa">40.00</text>' +
      `<text x="40" y="120" font-family="Arial" font-size="12" font-weight="${weight}" fill="#444">58.00</text></svg>`))
      .png().toBuffer();
    const refs = [{ text: '58.00', bbox: { x0: 39, y0: 101, x1: 90, y1: 123 } }];
    const output = await replaceWeightRegions(input, [replacement], {
      ...options, preferredStyleReferences: refs, validationStyleReferences: refs,
      matchNeighborTypography: true,
    });
    const rendered = sharp(output);
    const meta = await rendered.metadata();
    const actual = await sampleTextStyle(rendered, meta, { x0: 37, y0: 40, x1: 108, y1: 70 }, '58.00');
    const expected = await sampleTextStyle(sharp(input), meta, refs[0].bbox, '58.00');
    expect(Math.abs(actual.inkHeight - expected.inkHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs(actual.fillLuma - expected.fillLuma)).toBeLessThanOrEqual(28);
    expect(Math.abs(actual.strokeDensity - expected.strokeDensity)).toBeLessThanOrEqual(0.15);
  });
  it.each([90, 170, 220])('keeps local tone %s despite a darker dimension reference', async (color) => {
    const input = await source(color);
    const output = await replaceWeightRegions(input, [replacement], options);
    // Rasterized glyph cores vary slightly with digit shape and antialiasing.
    expect(Math.abs(await darkest(output) - await darkest(input))).toBeLessThanOrEqual(28);
  });
  it('selects the same stroke for an identical face in dark and faded ink', async () => {
    const strokes = [];
    for (const color of [30, 180]) {
      const image = sharp(await source(color));
      const style = await sampleTextStyle(image, await image.metadata(), bbox, '40.00');
      strokes.push(await calibrateTextRendering(style, '40.00', { separateInkTone: true }));
    }
    expect(strokes[0].fontWeight).toBe(strokes[1].fontWeight);
    expect(strokes[0].opticalStrokeRatio).toBe(strokes[1].opticalStrokeRatio);
  });
  it('retains visible reference ink when the source field is blank', async () => {
    const input = await source(245);
    const output = await replaceWeightRegions(input, [replacement], options);
    expect(await darkest(output)).toBeLessThan(150);
  });
  it('keeps a clean source value size when a nearby reference is smaller', async () => {
    const input = await source(60, 700, 18, 10);
    const output = await replaceWeightRegions(input, [replacement], options);
    const inkBounds = async (buffer) => {
      const { data, info } = await sharp(buffer).extract({ left: 37, top: 40, width: 75, height: 31 })
        .greyscale().raw().toBuffer({ resolveWithObject: true });
      let top = info.height, bottom = -1, left = info.width, right = -1;
      for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
        if (data[y * info.width + x] < 170) {
          top = Math.min(top, y); bottom = Math.max(bottom, y);
          left = Math.min(left, x); right = Math.max(right, x);
        }
      }
      return { height: bottom - top + 1, width: right - left + 1 };
    };
    const [before, after] = await Promise.all([inkBounds(input), inkBounds(output)]);
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(3);
  });
});
