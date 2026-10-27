'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createHash } = require('crypto');
const { recordCorrection } = require('../../src/services/correctionRecord.service');

describe('documented corrections', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pod-correction-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  it.each(['png', 'jpeg'])('marks %s exports, retains an original and records changes', async (format) => {
    const originalPath = path.join(dir, `source.${format}`);
    const outputPath = path.join(dir, `corrected.${format}`);
    await sharp({ create: { width: 600, height: 200, channels: 3, background: '#eeeeee' } })
      .toFormat(format).toFile(originalPath);
    await fs.copyFile(originalPath, outputPath);
    const changes = [{ originalText: '85.00', newText: '90.00', bbox: { x0: 30, y0: 40, x1: 70, y1: 55 } }];
    const result = await recordCorrection({ originalPath, outputPath, originalsDir: path.join(dir, 'originals'),
      result: { shipmentId: '123', replacedRegions: changes, appliedRotation: 0 } });
    const marked = await fs.readFile(outputPath);
    const meta = await sharp(marked).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBeGreaterThan(200);
    expect(meta.format).toBe(format);
    const footer = await sharp(marked).extract({ left: 0, top: 200, width: 600, height: meta.height - 200 })
      .greyscale().raw().toBuffer();
    expect(footer.some((value) => value < 100)).toBe(true);
    const originalMeta = await sharp(path.join(dir, 'originals', result.originalPreviewFilename)).metadata();
    expect(originalMeta.height).toBe(200);
    const record = JSON.parse(await fs.readFile(`${outputPath}.correction.json`, 'utf8'));
    expect(record.changes).toEqual(changes);
    expect(record.correctedSha256).toBe(createHash('sha256').update(marked).digest('hex'));
    expect(result.correctedCopy).toBe(true);
  });
});
