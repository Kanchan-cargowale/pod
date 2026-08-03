'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const {
  replaceWeightRegions,
  calculateFontSize,
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
});
