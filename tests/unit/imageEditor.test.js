'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const {
  replaceWeightRegions,
  calculateFontSize,
  sampleTextStyle,
  shrinkClearRectAroundRules,
  computePageStyle,
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

    it('uses the darkest ink cluster so blurred gray prints are not rendered faded', async () => {
      // Simulates camera blur: core glyph pixels around rgb(60) surrounded by
      // a wide anti-aliased halo around rgb(150) on near-white paper.
      const svg = Buffer.from(
        '<svg width="60" height="30" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="60" height="30" fill="rgb(235,235,235)" />' +
          '<rect x="10" y="8" width="16" height="14" fill="rgb(150,150,150)" />' +
          '<rect x="13" y="11" width="10" height="8" fill="rgb(60,60,60)" />' +
          '<rect x="30" y="8" width="16" height="14" fill="rgb(150,150,150)" />' +
          '<rect x="33" y="11" width="10" height="8" fill="rgb(60,60,60)" />' +
          '</svg>'
      );
      const image = sharp(svg);
      const meta = await image.metadata();

      const style = await sampleTextStyle(
        image,
        meta,
        { x0: 5, y0: 4, x1: 55, y1: 26 },
        '80.00'
      );

      const red = Number(style.fill.match(/\d+/)[0]);
      expect(red).toBeLessThan(100); // dark cluster (~60), not the halo (~150)
      expect(style.measured).toBe(true);
    });
  });

  describe('shrinkClearRectAroundRules', () => {
    it('keeps a vertical rule swallowed by the OCR box intact', () => {
      const width = 60;
      const height = 40;
      const gray = new Uint8Array(width * height).fill(255);
      for (let y = 0; y < height; y += 1) {
        gray[y * width + 10] = 0;
        gray[y * width + 11] = 0;
      }
      const rect = shrinkClearRectAroundRules(
        gray,
        { width, height },
        { x: 9, y: 18, right: 50, bottom: 30 },
        { r: 255, g: 255, b: 255 }
      );
      expect(rect.x).toBeGreaterThanOrEqual(12);
      expect(rect.right).toBe(50);
    });

    it('leaves glyph-like strokes alone (short dark runs are not rules)', () => {
      const width = 60;
      const height = 40;
      const gray = new Uint8Array(width * height).fill(255);
      // A 7px tall glyph stroke at the left probe zone - too short to be a rule.
      for (let y = 20; y < 27; y += 1) gray[y * width + 12] = 0;
      const rect = { x: 9, y: 18, right: 50, bottom: 30 };
      const shrunk = shrinkClearRectAroundRules(
        gray,
        { width, height },
        rect,
        { r: 255, g: 255, b: 255 }
      );
      expect(shrunk).toEqual(rect);
    });
  });

  describe('computePageStyle', () => {
    it('derives size and ink color from sibling numeric text on the same page', async () => {
      const svg = Buffer.from(
        '<svg width="200" height="120" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="200" height="120" fill="white" />' +
          '<text x="20" y="102" font-family="Arial" font-size="26" font-weight="700" ' +
          'fill="rgb(10,12,14)">450.00</text></svg>'
      );
      const image = sharp(svg);
      const meta = await image.metadata();

      const pageStyle = await computePageStyle(
        image,
        meta,
        [{ bbox: { x0: 20, y0: 78, x1: 130, y1: 105 }, text: '450.00' }],
        { x0: 15, y0: 20, x1: 70, y1: 42 },
        new Map()
      );

      expect(pageStyle).not.toBeNull();
      expect(pageStyle.fontSize).toBeGreaterThan(14);
      expect(pageStyle.fontSize).toBeLessThan(60);
      expect(pageStyle.fillLuma).toBeLessThan(60);
    });

    it('ignores sibling text with a wildly different glyph height', async () => {
      const svg = Buffer.from(
        '<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="300" height="200" fill="white" />' +
          '<text x="10" y="180" font-family="Arial" font-size="80" fill="black">307775718</text>' +
          '</svg>'
      );
      const image = sharp(svg);
      const meta = await image.metadata();

      const pageStyle = await computePageStyle(
        image,
        meta,
        [{ bbox: { x0: 10, y0: 110, x1: 290, y1: 185 }, text: '307775718' }],
        { x0: 15, y0: 20, x1: 70, y1: 36 },
        new Map()
      );

      expect(pageStyle).toBeNull();
    });
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

  it('keeps the table border when the OCR box itself swallows the line', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'label-editor-'));
    const inputPath = path.join(tempDir, 'border-swallowed.png');

    try {
      await sharp({
        create: { width: 120, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="120" height="80" xmlns="http://www.w3.org/2000/svg">' +
                '<line x1="10" y1="0" x2="10" y2="80" stroke="black" stroke-width="2" />' +
                '<text x="16" y="42" font-family="Arial" font-size="16">268.78</text>' +
                '</svg>'
            ),
          },
        ])
        .png()
        .toFile(inputPath);

      const before = await sharp(inputPath).raw().toBuffer({ resolveWithObject: true });
      // OCR box starts 3px left of the glyphs, merging the border into the box.
      const edited = await replaceWeightRegions(inputPath, [
        {
          bbox: { x0: 8, y0: 28, x1: 70, y1: 44 },
          replacementText: '300.00',
          originalText: '268.78',
        },
      ]);
      const after = await sharp(edited).raw().toBuffer({ resolveWithObject: true });

      const channels = before.info.channels;
      for (let y = 0; y < before.info.height; y += 1) {
        for (const x of [9, 10]) {
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

  it('keeps the original weight ink tone even when sibling numbers are darker', async () => {
    // Faded gray weight value, with a darker box-dimension figure below. The
    // replacement should match the original weight tone, not the darker page
    // number, otherwise the edit is obvious on scanned labels.
    const input = await sharp(
      Buffer.from(
        '<svg width="220" height="140" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="220" height="140" fill="white" />' +
          '<text x="20" y="46" font-family="Arial" font-size="20" ' +
          'fill="rgb(150,150,150)">12.50</text>' +
          '<text x="20" y="116" font-family="Arial" font-size="20" font-weight="700" ' +
          'fill="rgb(15,15,15)">304515</text>' +
          '</svg>'
      )
    )
      .png()
      .toBuffer();

    const valueBbox = { x0: 20, y0: 30, x1: 95, y1: 48 };
    const replacement = {
      bbox: valueBbox,
      replacementText: '88.00',
      originalText: '12.50',
    };
    const darkestPixel = async (buffer) => {
      const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
      let darkest = 255;
      for (let y = 30; y < 48; y += 1) {
        for (let x = 20; x < 95; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          darkest = Math.min(darkest, data[offset], data[offset + 1], data[offset + 2]);
        }
      }
      return darkest;
    };

    const withRefs = await replaceWeightRegions(input, [replacement], {
      styleReferences: [{ bbox: { x0: 20, y0: 98, x1: 95, y1: 118 }, text: '304515' }],
    });

    const originalToneDarkest = await darkestPixel(input);
    const matchedDarkest = await darkestPixel(withRefs);
    expect(Math.abs(matchedDarkest - originalToneDarkest)).toBeLessThanOrEqual(18);
    expect(matchedDarkest).toBeGreaterThan(120);
  });

  it('renders sibling weight replacements with one shared typography style', async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="260" height="80" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="260" height="80" fill="white" />' +
          '<text x="20" y="46" font-family="Arial" font-size="16" fill="black">40.00</text>' +
          '<text x="150" y="50" font-family="Arial" font-size="28" fill="black">40</text>' +
          '</svg>'
      )
    )
      .png()
      .toBuffer();

    const edited = await replaceWeightRegions(input, [
      {
        bbox: { x0: 20, y0: 28, x1: 70, y1: 49 },
        clearBbox: { x0: 18, y0: 25, x1: 78, y1: 54 },
        originalText: '40.00',
        replacementText: '40.00',
      },
      {
        bbox: { x0: 150, y0: 24, x1: 184, y1: 54 },
        clearBbox: { x0: 148, y0: 22, x1: 218, y1: 58 },
        originalText: '40',
        replacementText: '40.00',
      },
    ]);

    const { data, info } = await sharp(edited)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const inkHeight = (x0, x1) => {
      let top = Infinity;
      let bottom = -Infinity;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          if (data[offset] < 120 && data[offset + 1] < 120 && data[offset + 2] < 120) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      return bottom - top + 1;
    };

    expect(Math.abs(inkHeight(18, 95) - inkHeight(148, 235))).toBeLessThanOrEqual(2);
  });
});
