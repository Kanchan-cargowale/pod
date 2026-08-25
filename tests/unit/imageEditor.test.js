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
  samplePaperInsideBbox,
  estimateStrokeThickness,
  calculateLockedStrokeWidth,
  calculateBodyFontLimits,
  resolveBodyOpticalStrokeRatio,
  hasNumericFontWeightOverride,
  calibrateTextRendering,
  buildCalibratedConsensus,
} = require('../../src/services/imageEditor.service');

describe('imageEditor.service', () => {
  describe('samplePaperInsideBbox', () => {
    it('matches blue-gray paper instead of selecting bright scan outliers', async () => {
      const width = 80;
      const height = 40;
      const channels = 3;
      const pixels = Buffer.alloc(width * height * channels);

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * channels;
          const isBrightOutlier = x >= 62;
          const isInk = x >= 12 && x <= 20 && y >= 12 && y <= 27;
          const color = isInk
            ? [55, 65, 78]
            : isBrightOutlier
              ? [245, 248, 252]
              : [170 + (x % 4), 198 + (y % 3), 226 + (x % 3)];
          pixels[offset] = color[0];
          pixels[offset + 1] = color[1];
          pixels[offset + 2] = color[2];
        }
      }

      const image = sharp(pixels, { raw: { width, height, channels } });
      const meta = await image.metadata();
      const paper = await samplePaperInsideBbox(image, meta, {
        x0: 0,
        y0: 0,
        x1: width,
        y1: height,
      });

      expect(paper.r).toBeGreaterThanOrEqual(165);
      expect(paper.r).toBeLessThan(190);
      expect(paper.b).toBeGreaterThan(215);
      expect(paper.b).toBeLessThan(240);
    });
  });

  it('does not repaint naturally shadowed blue paper around the old glyphs', async () => {
    const width = 180;
    const height = 80;
    const baseSvg = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
        '<defs><linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="rgb(92,163,194)" />' +
        '<stop offset="1" stop-color="rgb(65,133,168)" />' +
        '</linearGradient></defs>' +
        '<rect width="180" height="80" fill="url(#paper)" />' +
        '<text x="45" y="48" font-family="Arial" font-size="22" fill="rgb(28,69,88)">49.9</text>' +
        '</svg>'
    );
    const original = await sharp(baseSvg).png().toBuffer();
    const edited = await replaceWeightRegions(original, [{
      bbox: { x0: 43, y0: 28, x1: 92, y1: 53 },
      clearBbox: { x0: 40, y0: 25, x1: 98, y1: 56 },
      originalText: '49.9',
      replacementText: '56.0',
    }], { uniformTextStyle: false });

    const originalRaw = await sharp(original).removeAlpha().raw().toBuffer();
    const editedRaw = await sharp(edited).removeAlpha().raw().toBuffer();
    // This point lies inside the clear rectangle but outside both old and new
    // glyphs. It must remain untouched instead of becoming part of a strip.
    const sampleOffset = (30 * width + 95) * 3;
    expect(editedRaw[sampleOffset]).toBe(originalRaw[sampleOffset]);
    expect(editedRaw[sampleOffset + 1]).toBe(originalRaw[sampleOffset + 1]);
    expect(editedRaw[sampleOffset + 2]).toBe(originalRaw[sampleOffset + 2]);
  });

  describe('calculateFontSize', () => {
    it('caps an abnormally tall, narrow OCR box using its text width', () => {
      expect(calculateFontSize(55, 32, '152.00')).toBeCloseTo(18.33, 1);
    });

    it('keeps height-based sizing for a normal proportional OCR box', () => {
      expect(calculateFontSize(144, 34, '900.00')).toBeCloseTo(23.8, 1);
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
      expect(regular.fontWeight).toBe(400);
      expect(bold.fontWeight).toBe(700);
      expect(regular.fontFamily).not.toContain('Arial Black');
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

    it('does not mistake a wide dimension token for monospace text', async () => {
      const image = sharp(Buffer.from(
        '<svg width="190" height="55" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="190" height="55" fill="white"/>' +
          '<text x="8" y="39" font-family="Arial" font-size="24" font-weight="700">' +
          '55x52x34</text></svg>'
      ));
      const meta = await image.metadata();
      const style = await sampleTextStyle(
        image,
        meta,
        { x0: 6, y0: 12, x1: 125, y1: 44 },
        '55x52x34'
      );

      expect(style.fontFamily).toContain('Arial');
      expect(style.fontFamily).not.toContain('Courier');
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

  it('inpaints erased ink with local paper texture instead of a flat light strip', async () => {
    const width = 100;
    const height = 70;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        const tone = 205 + Math.round(x * 0.18) + ((x + y) % 3);
        pixels[offset] = tone - 8;
        pixels[offset + 1] = tone;
        pixels[offset + 2] = Math.min(255, tone + 12);
      }
    }
    const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .composite([{ input: Buffer.from(
        '<svg width="100" height="70" xmlns="http://www.w3.org/2000/svg">' +
          '<rect x="20" y="20" width="34" height="9" fill="rgb(35,35,35)" />' +
          '</svg>'
      ) }])
      .png()
      .toBuffer();

    const edited = await replaceWeightRegions(input, [{
      bbox: { x0: 20, y0: 20, x1: 40, y1: 29 },
      clearBbox: { x0: 18, y0: 18, x1: 56, y1: 31 },
      originalText: '80',
      replacementText: '',
    }]);
    const { data, info } = await sharp(edited).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const colorAt = (x, y) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const filledA = colorAt(25, 24);
    const filledB = colorAt(48, 24);
    const nearbyA = colorAt(25, 45);
    const nearbyB = colorAt(48, 45);

    expect(Math.abs(filledA[0] - nearbyA[0])).toBeLessThan(10);
    expect(Math.abs(filledB[0] - nearbyB[0])).toBeLessThan(10);
    expect(filledB[0] - filledA[0]).toBeGreaterThan(2);
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

  it('keeps a perspective-slanted table border through the erased value row', async () => {
    const width = 130;
    const height = 90;
    const linePath = Array.from({ length: height }, (_, y) => {
      const x = 9 + Math.floor(y / 9);
      return `<rect x="${x}" y="${y}" width="2" height="1" fill="rgb(35,35,35)" />`;
    }).join('');
    const input = await sharp(
      Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
          '<rect width="130" height="90" fill="white" />' +
          linePath +
          '<text x="18" y="49" font-family="Arial" font-size="17">268.78</text>' +
          '</svg>'
      )
    ).png().toBuffer();

    const before = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const edited = await replaceWeightRegions(input, [{
      // Deliberately swallow the slanted border. Its x coordinate changes by
      // several pixels over the scan window, so fixed-column detection fails.
      bbox: { x0: 10, y0: 33, x1: 76, y1: 52 },
      clearBbox: { x0: 10, y0: 31, x1: 80, y1: 54 },
      replacementText: '300.00',
      originalText: '268.78',
    }]);
    const after = await sharp(edited).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let y = 31; y < 54; y += 1) {
      const lineX = 9 + Math.floor(y / 9);
      for (const x of [lineX, lineX + 1]) {
        const offset = (y * width + x) * before.info.channels;
        expect(after.data.subarray(offset, offset + 3)).toEqual(
          before.data.subarray(offset, offset + 3)
        );
      }
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
      forceInteriorErase: true,
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

  it('never erases a heading separator crossed by an expanded value box', async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="140" height="70" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="140" height="70" fill="white" />' +
          '<line x1="0" y1="25" x2="140" y2="25" stroke="black" stroke-width="2" />' +
          '<text x="20" y="45" font-family="Arial" font-size="16">80.00</text>' +
          '</svg>'
      )
    ).png().toBuffer();

    const before = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const edited = await replaceWeightRegions(input, [{
      bbox: { x0: 20, y0: 31, x1: 65, y1: 48 },
      clearBbox: { x0: 17, y0: 23, x1: 78, y1: 51 },
      originalText: '80.00',
      replacementText: '95.00',
    }]);
    const after = await sharp(edited).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let x = 0; x < 140; x += 1) {
      for (const y of [24, 25]) {
        const offset = (y * before.info.width + x) * before.info.channels;
        expect(after.data.subarray(offset, offset + 3)).toEqual(
          before.data.subarray(offset, offset + 3)
        );
      }
    }
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

  describe('calculateLockedStrokeWidth', () => {
    it('uses the calibrated ratio and keeps it bounded across scan resolutions', () => {
      expect(calculateLockedStrokeWidth(12, 700, true, 0.065)).toBeCloseTo(0.78, 2);
      expect(calculateLockedStrokeWidth(30, 700, true, 0.065)).toBe(1.35);
      expect(calculateLockedStrokeWidth(12, 400, true, 0)).toBe(0);
      expect(calculateLockedStrokeWidth(12, 700, false, 0.065)).toBe(0);
    });

  });

  describe('calculateBodyFontLimits', () => {
    it('uses the measured body specimen instead of enlarging text from canvas margins', () => {
      expect(calculateBodyFontLimits(1000, 8)).toEqual({ floor: 7.2, cap: 8.24 });
      expect(calculateBodyFontLimits(2000, 10)).toEqual({ floor: 9, cap: 10.3 });
      expect(calculateBodyFontLimits(1000)).toEqual({ floor: 10.5, cap: 11 });
    });
  });

  describe('resolveBodyOpticalStrokeRatio', () => {
    it('prevents both regular and bold dynamic body text from rendering with zero print gain', () => {
      expect(resolveBodyOpticalStrokeRatio(400, 0)).toBe(0.065);
      expect(resolveBodyOpticalStrokeRatio(700, 0)).toBe(0.025);
      expect(resolveBodyOpticalStrokeRatio(700, 0.065)).toBe(0.065);
      expect(resolveBodyOpticalStrokeRatio(400, 0.2)).toBe(0.085);
    });
  });

  describe('hasNumericFontWeightOverride', () => {
    it('does not coerce a missing override into font weight zero', () => {
      expect(hasNumericFontWeightOverride(null)).toBe(false);
      expect(hasNumericFontWeightOverride(undefined)).toBe(false);
      expect(hasNumericFontWeightOverride('')).toBe(false);
      expect(hasNumericFontWeightOverride(400)).toBe(true);
      expect(hasNumericFontWeightOverride(700)).toBe(true);
    });
  });

  describe('calibrateTextRendering', () => {
    it('does not force the same optical stroke onto regular and heavy specimens', async () => {
      const specimen = async (weight, strokeWidth) => {
        const stroke = strokeWidth > 0
          ? ` stroke="black" stroke-width="${strokeWidth}" paint-order="stroke fill"`
          : '';
        const image = sharp(Buffer.from(
          '<svg width="180" height="55" xmlns="http://www.w3.org/2000/svg">' +
            '<rect width="180" height="55" fill="white"/>' +
            `<text x="8" y="38" font-family="Arial" font-size="24" font-weight="${weight}" ` +
            `fill="black"${stroke}>45x32x20</text></svg>`
        ));
        const meta = await image.metadata();
        return sampleTextStyle(image, meta, { x0: 5, y0: 8, x1: 150, y1: 44 }, '45x32x20');
      };
      const regular = await calibrateTextRendering(await specimen(400, 0), '45x32x20');
      const heavy = await calibrateTextRendering(await specimen(700, 1.1), '45x32x20');
      const regularStrength = regular.fontWeight + regular.opticalStrokeRatio * 1000;
      const heavyStrength = heavy.fontWeight + heavy.opticalStrokeRatio * 1000;

      expect(heavyStrength).toBeGreaterThan(regularStrength);
      expect(regular.opticalStrokeRatio).toBeLessThanOrEqual(0.025);
    });
  });

  describe('buildCalibratedConsensus', () => {
    it('rejects one oversized OCR specimen when the dimension rows agree', async () => {
      const style = (fontSize, gray) => ({
        measured: true,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontWeight: 400,
        fontSize,
        fill: `rgb(${gray},${gray},${gray})`,
        fillRgb: { r: gray, g: gray, b: gray },
        fillLuma: gray,
        localBackground: 245,
        inkCoverage: 0.68,
        strokeDensity: 0.53,
        strokeThickness: 2,
        normalizedStrokeThickness: 0.2,
        characterAspect: 0.72,
      });
      const consensus = await buildCalibratedConsensus([
        { style: style(11.5, 70), ref: { text: '64x42x27' } },
        { style: style(12, 80), ref: { text: '55x52x34' } },
        { style: style(27, 180), ref: { text: '84x44x31' } },
      ]);

      expect(consensus.fontSize).toBeCloseTo(11.75, 2);
      expect(consensus.fillRgb.r).toBe(80);
      expect(consensus.fontWeight + consensus.opticalStrokeRatio * 1000)
        .toBeGreaterThanOrEqual(445);
    });

    it('never emits plain regular text for printed body values', async () => {
      const regular = {
        measured: true,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontWeight: 400,
        fontSize: 12,
        fill: 'rgb(80,80,80)',
        fillRgb: { r: 80, g: 80, b: 80 },
        fillLuma: 80,
        localBackground: 245,
        inkCoverage: 0.6,
        strokeDensity: 0.42,
        strokeThickness: 1,
        normalizedStrokeThickness: 0.1,
        characterAspect: 0.7,
      };
      const consensus = await buildCalibratedConsensus([
        { style: regular, ref: { text: '63x41x27' } },
      ]);

      expect(consensus.fontWeight).toBeGreaterThanOrEqual(400);
      expect(consensus.opticalStrokeRatio).toBeGreaterThanOrEqual(0.065);
    });
  });

  it('shares typography but preserves each weight cell local ink color', async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="1000" height="140" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="1000" height="140" fill="rgb(245,245,245)" />' +
          '<text x="40" y="75" font-family="Arial" font-size="20" fill="rgb(65,65,65)">40.00</text>' +
          '<text x="520" y="75" font-family="Arial" font-size="20" fill="rgb(155,155,155)">40.00</text>' +
          '</svg>'
      )
    ).png().toBuffer();

    const edited = await replaceWeightRegions(input, [
      {
        bbox: { x0: 40, y0: 57, x1: 105, y1: 79 },
        clearBbox: { x0: 36, y0: 53, x1: 120, y1: 83 },
        originalText: '40.00',
        replacementText: '55.00',
        forceInteriorErase: true,
      },
      {
        bbox: { x0: 520, y0: 57, x1: 585, y1: 79 },
        clearBbox: { x0: 516, y0: 53, x1: 600, y1: 83 },
        originalText: '40.00',
        replacementText: '55.00',
        forceInteriorErase: true,
      },
    ]);
    const { data, info } = await sharp(edited).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const darkest = (x0, x1) => {
      let result = 255;
      for (let y = 55; y < 82; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          result = Math.min(result, data[(y * info.width + x) * info.channels]);
        }
      }
      return result;
    };

    expect(darkest(36, 130)).toBeLessThan(darkest(516, 620) - 50);
  });

  it('keeps the approved weight typography fixed across different source styles', async () => {
    const makeInput = (referenceSize, referenceWeight) => sharp(Buffer.from(
      '<svg width="1000" height="170" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="1000" height="170" fill="white" />' +
        '<text x="50" y="65" font-family="Arial" font-size="13" fill="rgb(80,80,80)">40.00</text>' +
        `<text x="50" y="135" font-family="Arial" font-size="${referenceSize}" ` +
        `font-weight="${referenceWeight}" fill="rgb(80,80,80)">55x52x34</text>` +
        '</svg>'
    )).png().toBuffer();
    const replacement = {
      bbox: { x0: 50, y0: 53, x1: 88, y1: 67 },
      clearBbox: { x0: 47, y0: 49, x1: 105, y1: 70 },
      originalText: '40.00',
      replacementText: '77.70',
      forceInteriorErase: true,
    };
    const render = async (referenceSize, referenceWeight) => replaceWeightRegions(
      await makeInput(referenceSize, referenceWeight),
      [replacement],
      {
        validationStyleReferences: [
          { bbox: { x0: 48, y0: 105, x1: 180, y1: 140 }, text: '55x52x34' },
        ],
        matchValidationInk: true,
        lockBodyTypography: true,
        fontFamilyOverride: 'Arial, Helvetica, sans-serif',
        fontWeightOverride: 700,
        fixedFontSizeRatio: 0.0115,
      }
    );
    const [smallRegular, largeBold] = await Promise.all([
      render(12, 400),
      render(24, 700),
    ]);
    const glyphBounds = async (buffer) => {
      const { data, info } = await sharp(buffer)
      .extract({ left: 45, top: 45, width: 90, height: 35 })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          if (data[y * info.width + x] >= 210) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      return { left, top, right, bottom };
    };
    const [firstBounds, secondBounds] = await Promise.all([
      glyphBounds(smallRegular),
      glyphBounds(largeBold),
    ]);

    expect(firstBounds).toEqual(secondBounds);
  });

  it('uses a nearby dimension value to reject an oversized weight OCR box', async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="3000" height="260" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="3000" height="260" fill="white" />' +
          '<text x="100" y="105" font-family="Arial" font-size="40">90.00</text>' +
          '<text x="100" y="210" font-family="Arial" font-size="18">55x52x34</text>' +
          '</svg>'
      )
    ).png().toBuffer();

    const edited = await replaceWeightRegions(input, [{
      bbox: { x0: 100, y0: 67, x1: 230, y1: 112 },
      clearBbox: { x0: 94, y0: 62, x1: 250, y1: 116 },
      originalText: '90.00',
      replacementText: '95.00',
      forceInteriorErase: true,
    }], {
      validationStyleReferences: [
        { bbox: { x0: 100, y0: 192, x1: 180, y1: 214 }, text: '55x52x34' },
      ],
    });
    const { data, info } = await sharp(edited).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let top = Infinity;
    let bottom = -Infinity;
    for (let y = 60; y < 120; y += 1) {
      for (let x = 90; x < 260; x += 1) {
        if (data[(y * info.width + x) * info.channels] < 100) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }

    expect(bottom - top + 1).toBeGreaterThanOrEqual(10);
    expect(bottom - top + 1).toBeLessThanOrEqual(20);
  });

  it('matches bold box-value ink without enlarging the weight text', async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="1000" height="150" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="1000" height="150" fill="white" />' +
          '<text x="40" y="65" font-family="Arial" font-size="20" fill="rgb(150,150,150)">40.00</text>' +
          '<text x="40" y="125" font-family="Arial" font-size="20" font-weight="700" fill="rgb(65,65,65)">64x42x27</text>' +
          '</svg>'
      )
    ).png().toBuffer();
    const replacement = {
      bbox: { x0: 40, y0: 47, x1: 105, y1: 69 },
      clearBbox: { x0: 36, y0: 43, x1: 120, y1: 73 },
      originalText: '40.00',
      replacementText: '55.00',
      forceInteriorErase: true,
    };
    const options = {
      validationStyleReferences: [
        { bbox: { x0: 40, y0: 107, x1: 145, y1: 129 }, text: '64x42x27' },
      ],
      matchValidationInk: true,
    };
    const [regular, bold] = await Promise.all([
      replaceWeightRegions(input, [replacement], { ...options, fontWeightOverride: 400 }),
      replaceWeightRegions(input, [replacement], { ...options, fontWeightOverride: 700 }),
    ]);
    const darkPixelCount = async (buffer) => {
      const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let count = 0;
      let darkest = 255;
      for (let y = 43; y < 74; y += 1) {
        for (let x = 36; x < 125; x += 1) {
          const red = data[(y * info.width + x) * info.channels];
          if (red < 170) count += 1;
          darkest = Math.min(darkest, red);
        }
      }
      return { count, darkest };
    };
    const regularInk = await darkPixelCount(regular);
    const boldInk = await darkPixelCount(bold);

    // Bold must remain visibly heavier, but should not require the excessive
    // fixed ink expansion that made medium-weight scans look over-bold.
    expect(boldInk.count).toBeGreaterThan(regularInk.count * 1.12);
    expect(boldInk.darkest).toBeLessThan(100);
  });

  it('applies final print gain and specimen sizing after dynamic calibration', async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="2000" height="170" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="2000" height="170" fill="white" />' +
          '<text x="50" y="65" font-family="Arial" font-size="20" fill="rgb(90,90,90)">40.00</text>' +
          '<text x="50" y="135" font-family="Arial" font-size="9" font-weight="700" ' +
          'fill="rgb(70,70,70)">45x32x20</text>' +
          '</svg>'
      )
    ).png().toBuffer();
    const replacement = {
      bbox: { x0: 50, y0: 47, x1: 105, y1: 69 },
      clearBbox: { x0: 46, y0: 43, x1: 120, y1: 73 },
      originalText: '40.00',
      replacementText: '77.70',
      forceInteriorErase: true,
    };
    const options = {
      validationStyleReferences: [
        { bbox: { x0: 48, y0: 123, x1: 105, y1: 138 }, text: '45x32x20' },
      ],
      matchValidationInk: true,
      lockBodyTypography: true,
    };
    const [dynamic, noDynamicStroke] = await Promise.all([
      replaceWeightRegions(input, [replacement], options),
      replaceWeightRegions(input, [replacement], { ...options, fontWeightOverride: 700 }),
    ]);
    const inkMetrics = async (buffer, x0, x1, y0, y1) => {
      const { data, info } = await sharp(buffer).greyscale().raw()
        .toBuffer({ resolveWithObject: true });
      let count = 0;
      let top = Infinity;
      let bottom = -Infinity;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (data[y * info.width + x] >= 180) continue;
          count += 1;
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      return { count, height: bottom - top + 1 };
    };
    const [dynamicInk, plainInk, referenceInk] = await Promise.all([
      inkMetrics(dynamic, 46, 125, 43, 75),
      inkMetrics(noDynamicStroke, 46, 125, 43, 75),
      inkMetrics(input, 48, 115, 120, 142),
    ]);

    expect(dynamicInk.count).toBeGreaterThan(plainInk.count);
    expect(dynamicInk.height).toBeLessThanOrEqual(referenceInk.height + 2);
  });

  it('does not collapse locked bold text to a tiny OCR value box', async () => {
    const input = await sharp(
      Buffer.from(
        '<svg width="1000" height="130" xmlns="http://www.w3.org/2000/svg">' +
          '<rect width="1000" height="130" fill="white" />' +
          '<text x="50" y="58" font-family="Arial" font-size="7" fill="rgb(150,150,150)">20.00</text>' +
          '<text x="50" y="108" font-family="Arial" font-size="18" font-weight="700">45x32x20</text>' +
          '</svg>'
      )
    ).png().toBuffer();
    const edited = await replaceWeightRegions(input, [{
      bbox: { x0: 50, y0: 52, x1: 70, y1: 59 },
      clearBbox: { x0: 47, y0: 49, x1: 90, y1: 62 },
      originalText: '20.00',
      replacementText: '55.00',
      forceInteriorErase: true,
      fontScale: 1,
    }], {
      validationStyleReferences: [
        { bbox: { x0: 50, y0: 91, x1: 150, y1: 112 }, text: '45x32x20' },
      ],
      matchValidationInk: true,
      fontWeightOverride: 700,
    });
    const { data, info } = await sharp(edited).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let top = Infinity;
    let bottom = -Infinity;
    for (let y = 42; y < 62; y += 1) {
      for (let x = 45; x < 105; x += 1) {
        if (data[(y * info.width + x) * info.channels] < 150) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }

    expect(bottom - top + 1).toBeGreaterThanOrEqual(7);
  });

  it('removes faint residual ink fragments after the primary erase pass', async () => {
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
              '<rect x="18" y="18" width="34" height="9" fill="rgb(200,200,200)" />' +
              '<rect x="48" y="20" width="3" height="5" fill="rgb(200,200,200)" />' +
              '</svg>'
          ),
        },
      ])
      .png()
      .toBuffer();

    const edited = await replaceWeightRegions(input, [
      {
        bbox: { x0: 18, y0: 18, x1: 52, y1: 27 },
        clearBbox: { x0: 17, y0: 17, x1: 54, y1: 28 },
        originalText: '80.0',
        replacementText: '90.0',
      },
    ]);
    const { data, info } = await sharp(edited).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let y = 18; y <= 27; y += 1) {
      for (let x = 48; x <= 51; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        expect(data[offset]).toBeGreaterThan(230);
        expect(data[offset + 1]).toBeGreaterThan(230);
        expect(data[offset + 2]).toBeGreaterThan(230);
      }
    }
  });

  it('samples stroke thickness and classifies bold vs regular text', async () => {
    const svg = Buffer.from(
      '<svg width="60" height="30" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="60" height="30" fill="white" />' +
        '<text x="5" y="22" font-family="Arial" font-size="20" font-weight="700" fill="black">900</text>' +
        '</svg>'
    );
    const image = sharp(svg);
    const meta = await image.metadata();

    const style = await sampleTextStyle(
      image,
      meta,
      { x0: 5, y0: 5, x1: 50, y1: 25 },
      '900'
    );

    expect(style.fontWeight).toBe(700);
    expect(style.fontSize).toBeGreaterThan(10);
    expect(style.measured).toBe(true);
  });
});
