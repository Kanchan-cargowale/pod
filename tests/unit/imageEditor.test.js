'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const {
  replaceWeightRegions,
  calculateFontSize,
  sampleTextStyle,
} = require('../../src/services/imageEditor.service');

describe('imageEditor.service', () => {
  describe('calculateFontSize', () => {
    it('caps an abnormally tall, narrow OCR box using its text width', () => {
      expect(calculateFontSize(55, 32, '152.00')).toBeCloseTo(18.33, 1);
    });

    it('keeps height-based sizing for a normal proportional OCR box', () => {
      expect(calculateFontSize(144, 34, '900.00')).toBeCloseTo(29.24, 1);
    });
  });

  describe('sampleTextStyle', () => {
    it('preserves different source ink colors and derives usable typography', async () => {
      const regularSvg = Buffer.from(
        '<svg width="180" height="50" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="180" height="50" fill="rgb(205,210,215)" />' +
          '<text x="8" y="35" font-family="Arial" font-size="26" font-weight="400" ' +
          'fill="rgb(82,87,92)">450.32</text></svg>'
      );
      const boldSvg = Buffer.from(
        '<svg width="180" height="50" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="180" height="50" fill="white" />' +
          '<text x="8" y="35" font-family="Arial" font-size="26" font-weight="700" ' +
          'fill="rgb(12,15,18)">268.78</text></svg>'
      );
      const regularImage = sharp(regularSvg);
      const boldImage = sharp(boldSvg);
      const regularMeta = await regularImage.metadata();
      const boldMeta = await boldImage.metadata();

      const regular = await sampleTextStyle(
        regularImage,
        regularMeta,
        { x0: 8, y0: 10, x1: 95, y1: 39 },
        '450.32'
      );
      const bold = await sampleTextStyle(
        boldImage,
        boldMeta,
        { x0: 8, y0: 10, x1: 95, y1: 39 },
        '268.78'
      );

      const regularRed = Number(regular.fill.match(/\d+/)[0]);
      const boldRed = Number(bold.fill.match(/\d+/)[0]);
      expect(regularRed).toBeGreaterThan(boldRed + 40);
      expect(regular.fontWeight).toBeLessThanOrEqual(bold.fontWeight);
      expect(regular.fontSize).toBeGreaterThan(8);
      expect(bold.fontSize).toBeGreaterThan(8);
    });
  });

  it('renders numeric replacement glyphs inside the original weight position', async () => {
    const input = await sharp({
      create: {
        width: 180,
        height: 70,
        channels: 3,
        background: { r: 250, g: 250, b: 250 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="180" height="70" xmlns="http://www.w3.org/2000/svg">' +
              '<text x="52" y="43" font-family="sans-serif" font-size="18" fill="rgb(35,35,35)">42.50</text>' +
              '</svg>'
          ),
        },
      ])
      .png()
      .toBuffer();

    const target = { x0: 52, y0: 26, x1: 102, y1: 46 };
    const edited = await replaceWeightRegions(input, [
      {
        bbox: target,
        replacementText: '80.00',
        originalText: '42.50',
      },
    ]);
    const { data, info } = await sharp(edited)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const darkPixels = [];
    for (let y = target.y0; y <= target.y1; y += 1) {
      for (let x = target.x0; x < target.x1 + 18; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset] < 140 && data[offset + 1] < 140 && data[offset + 2] < 140) {
          darkPixels.push({ x, y });
        }
      }
    }

    expect(darkPixels.length).toBeGreaterThan(20);
    expect(Math.min(...darkPixels.map(({ x }) => x))).toBeGreaterThanOrEqual(target.x0);
    expect(Math.max(...darkPixels.map(({ x }) => x))).toBeLessThan(target.x1 + 18);
    expect(Math.min(...darkPixels.map(({ y }) => y))).toBeGreaterThanOrEqual(target.y0);
    expect(Math.max(...darkPixels.map(({ y }) => y))).toBeLessThanOrEqual(target.y1);
  });

  it('does not erase the table border immediately left of a weight value', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'label-editor-'));
    const inputPath = path.join(tempDir, 'border-test.png');

    try {
      await sharp({
        create: {
          width: 100,
          height: 60,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="100" height="60" xmlns="http://www.w3.org/2000/svg">' +
                '<line x1="14" y1="0" x2="14" y2="60" stroke="black" stroke-width="2" />' +
                '<text x="18" y="35" font-family="Arial" font-size="14">268.78</text>' +
                '</svg>'
            ),
          },
        ])
        .png()
        .toFile(inputPath);

      const before = await sharp(inputPath).raw().toBuffer({ resolveWithObject: true });
      const edited = await replaceWeightRegions(inputPath, [
        {
          bbox: { x0: 18, y0: 22, x1: 58, y1: 37 },
          replacementText: '300.00',
          originalText: '268.78',
        },
      ]);
      const after = await sharp(edited).raw().toBuffer({ resolveWithObject: true });

      const channels = before.info.channels;
      for (let y = 0; y < before.info.height; y += 1) {
        for (const x of [13, 14]) {
          const offset = (y * before.info.width + x) * channels;
          expect(after.data.subarray(offset, offset + channels)).toEqual(
            before.data.subarray(offset, offset + channels)
          );
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('clears old glyph pixels beyond a truncated OCR style box', async () => {
    const input = await sharp({
      create: {
        width: 80,
        height: 45,
        channels: 3,
        background: { r: 245, g: 245, b: 245 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="80" height="45" xmlns="http://www.w3.org/2000/svg">' +
              '<rect x="18" y="20" width="32" height="8" fill="rgb(40,40,40)" />' +
              '</svg>'
          ),
        },
      ])
      .png()
      .toBuffer();

    const edited = await replaceWeightRegions(input, [
      {
        bbox: { x0: 18, y0: 20, x1: 32, y1: 28 },
        clearBbox: { x0: 17, y0: 19, x1: 52, y1: 30 },
        originalText: '57',
        replacementText: '80',
      },
    ]);
    const { data, info } = await sharp(edited).raw().toBuffer({ resolveWithObject: true });
    const offset = (24 * info.width + 48) * info.channels;

    expect(data[offset]).toBeGreaterThan(230);
    expect(data[offset + 1]).toBeGreaterThan(230);
    expect(data[offset + 2]).toBeGreaterThan(230);
  });
});
