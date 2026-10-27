'use strict';

const sharp = require('sharp');
const path = require('path');
const { sampleTextStyle, replaceWeightRegions } = require('../../src/services/imageEditor.service');
const { matchSourceAppearance, renderMatchedText } = require('../../src/services/textAppearance.service');

async function specimen({ family = 'Arial', weight = 400, blur = 0, color = '#536579', angle = 0, spacing = 0 } = {}) {
  let image = sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">' +
    '<rect width="300" height="100" fill="#f5f5f5"/>' +
    `<text transform="rotate(${angle} 30 55)" x="30" y="55" font-family="${family}" font-size="24" ` +
    `letter-spacing="${spacing}" font-weight="${weight}" fill="${color}">58.00</text></svg>`));
  if (blur) image = image.blur(blur);
  const input = await image.png().toBuffer();
  image = sharp(input);
  const meta = await image.metadata();
  const bbox = { x0: 28, y0: 26, x1: 115, y1: 64 };
  const style = await sampleTextStyle(image, meta, bbox, '58.00');
  const match = await matchSourceAppearance(image, meta, bbox, '58.00', style);
  return { input, image, meta, bbox, style, match };
}

describe('source appearance matching', () => {
  it.each([
    ['Arial', 400, 0], ['Arial', 700, 0.85], ['Times New Roman', 400, 0],
    ['Courier New', 700, 0],
  ])('matches %s weight %s blur %s', async (family, weight, blur) => {
    const { match } = await specimen({ family, weight, blur });
    expect(match).not.toBeNull();
    expect(match.family.startsWith(family)).toBe(true);
    expect(match.weight).toBe(weight);
    expect(Math.abs(match.angle)).toBeLessThanOrEqual(1);
    if (blur) expect(match.blur).toBeGreaterThanOrEqual(0.3);
  });

  it('keeps the same source origin and height for short, long and decimal values', async () => {
    const { match } = await specimen();
    const outputs = [];
    for (const value of ['1', '77.70', '999999999999.99']) {
      const overlay = await renderMatchedText(match, value, { x0: 28, y0: 29, x1: 110, y1: 65 });
      const meta = await sharp(overlay.input).metadata();
      expect(overlay.left).toBe(Math.round(match.x));
      expect(overlay.top).toBe(Math.round(match.y));
      expect(overlay.left + meta.width).toBeLessThanOrEqual(110);
      outputs.push(meta.height);
    }
    expect(Math.max(...outputs) - Math.min(...outputs)).toBeLessThanOrEqual(2);
  });

  it.each([-4, 4])('recovers a small scan rotation of %s degrees', async (angle) => {
    const { match } = await specimen({ angle });
    expect(match).not.toBeNull();
    expect(Math.abs(match.angle - angle)).toBeLessThanOrEqual(2);
  });

  it('detects increased tracking between digits', async () => {
    const { match } = await specimen({ spacing: 2 });
    expect(match).not.toBeNull();
    expect(match.letterSpacing).toBeGreaterThan(0);
  });

  it('preserves the apparent color of faint scanned ink', async () => {
    const { match, input, bbox } = await specimen({ color: '#b8bec8' });
    expect(match).not.toBeNull();
    const output = await replaceWeightRegions(input, [{ bbox,
      originalText: '58.00', replacementText: '88.88', preferSourceStyle: true,
    }]);
    const darkest = async (buffer) => {
      const { data, info } = await sharp(buffer).extract({ left: 30, top: 30, width: 80, height: 30 })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return [0, 1, 2].map((channel) => {
        let minimum = 255;
        for (let i = channel; i < data.length; i += info.channels) minimum = Math.min(minimum, data[i]);
        return minimum;
      });
    };
    const before = await darkest(input), after = await darkest(output);
    before.forEach((channel, i) => expect(Math.abs(channel - after[i])).toBeLessThanOrEqual(12));
  });

  it('preserves pixels outside the edited region and keeps the measured position', async () => {
    const { input, bbox, match } = await specimen();
    const output = await replaceWeightRegions(input, [{ bbox,
      clearBbox: { x0: 26, y0: 28, x1: 115, y1: 64 },
      originalText: '58.00', replacementText: '77.70', preferSourceStyle: true,
    }]);
    const before = await sharp(input).removeAlpha().raw().toBuffer();
    const after = await sharp(output).removeAlpha().raw().toBuffer();
    let left = 300, top = 100;
    for (let y = 0; y < 100; y += 1) {
      for (let x = 0; x < 300; x += 1) {
        const i = (y * 300 + x) * 3;
        if (x < 26 || x >= 115 || y < 28 || y >= 64) {
          expect(after.subarray(i, i + 3).equals(before.subarray(i, i + 3))).toBe(true);
        }
        if (after[i] < 180) { left = Math.min(left, x); top = Math.min(top, y); }
      }
    }
    expect(Math.abs(left - match.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(top - match.y)).toBeLessThanOrEqual(1);
  });

  it('rejects unmeasurable, multiline and unreliable specimens', async () => {
    const { image, meta, bbox, style } = await specimen();
    expect(await matchSourceAppearance(image, meta, bbox, '58\n00', style)).toBeNull();
    expect(await matchSourceAppearance(image, meta, bbox, '58.00', { ...style, measured: false })).toBeNull();
    expect(await matchSourceAppearance(image, meta, bbox, '58.00', { ...style, localBackground: style.fillLuma + 5 })).toBeNull();
  });

  it('rounds fractional OCR cell edges inward for valid, contained composites', async () => {
    const { match, input } = await specimen();
    const overlay = await renderMatchedText(match, '77.70', {
      x0: match.x + 0.6, y0: match.y + 0.2, x1: 110.4, y1: 65.8,
    });
    expect(Number.isInteger(overlay.left)).toBe(true);
    expect(Number.isInteger(overlay.top)).toBe(true);
    await expect(sharp(input).composite([overlay]).png().toBuffer()).resolves.toBeInstanceOf(Buffer);
  });

  it('rejects a textured photograph whose OCR box includes a connected divider', async () => {
    const input = await sharp(path.join(__dirname, '../fixtures/real_world_1.jpeg')).rotate().png().toBuffer();
    const image = sharp(input), meta = await image.metadata();
    const bbox = { x0: 471, y0: 462, x1: 526, y1: 494 };
    const style = await sampleTextStyle(image, meta, bbox, '450.32');
    const match = await matchSourceAppearance(image, meta, bbox, '450.32', style);
    expect(match).toBeNull();
  });

  it('does not move values on distinct rows onto a common baseline', async () => {
    const input = await sharp({ create: { width: 300, height: 140, channels: 3, background: 'white' } }).png().toBuffer();
    const output = await replaceWeightRegions(input, [30, 95].map((y) => ({
      bbox: { x0: 30, y0: y, x1: 90, y1: y + 18 }, replacementText: '75.00',
    })));
    const { data, info } = await sharp(output).greyscale().raw().toBuffer({ resolveWithObject: true });
    const count = (y0, y1) => {
      let total = 0;
      for (let y = y0; y < y1; y += 1) for (let x = 25; x < 100; x += 1) {
        if (data[y * info.width + x] < 200) total += 1;
      }
      return total;
    };
    expect(count(30, 49)).toBeGreaterThan(5);
    expect(count(95, 114)).toBeGreaterThan(5);
    expect(count(50, 94)).toBe(0);
  });

  it('contains long values even when the fallback renderer reaches its minimum font size', async () => {
    const input = await sharp({ create: { width: 150, height: 70, channels: 3, background: 'white' } }).png().toBuffer();
    const output = await replaceWeightRegions(input, [{
      bbox: { x0: 30, y0: 25, x1: 65, y1: 45 }, replacementText: '999999999999.99',
    }]);
    const { data, info } = await sharp(output).greyscale().raw().toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] >= 220) continue;
      count += 1;
      expect(x).toBeGreaterThanOrEqual(30);
      expect(x).toBeLessThan(65);
    }
    expect(count).toBeGreaterThan(10);
  });
});
