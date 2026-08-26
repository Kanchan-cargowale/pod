'use strict';

const {
  shouldTryQuarterTurns,
  shouldTryContentRotations,
  getAlternativeRotations,
  orientationEvidence,
} = require('../../src/services/imageOrientation.service');

describe('imageOrientation.service', () => {
  it('accepts a normal landscape label', () => {
    expect(shouldTryQuarterTurns({ width: 1600, height: 1200, orientation: 1 })).toBe(false);
  });

  it('does not request fallback rotations merely because an EXIF tag is present', () => {
    expect(shouldTryQuarterTurns({ width: 1600, height: 1200, orientation: 6 })).toBe(false);
  });

  it('uses portrait dimensions only to enable OCR rotation fallbacks', () => {
    expect(shouldTryQuarterTurns({ width: 1200, height: 1600 })).toBe(true);
  });

  it('checks every right-angle orientation when normal OCR finds no weight', () => {
    const analysis = { regions: [], anchors: [] };

    expect(shouldTryContentRotations(analysis)).toBe(true);
    expect(getAlternativeRotations(analysis)).toEqual([90, 180, 270]);
  });

  it('does not rotate an image whose normal OCR already found a weight', () => {
    const analysis = { regions: [{ bbox: { x0: 1, y0: 1, x1: 2, y1: 2 } }] };

    expect(shouldTryContentRotations(analysis)).toBe(false);
    expect(getAlternativeRotations(analysis)).toEqual([]);
  });

  it('does not accept a filename match and an unrelated number as proof of orientation', () => {
    const analysis = {
      meta: { width: 718, height: 1600 },
      match: { id: '309952819', distance: 0, source: 'filename' },
      anchors: [{ bbox: { x0: 350, y0: 1100, x1: 400, y1: 1110 } }],
      regions: [{ bbox: { x0: 90, y0: 1200, x1: 120, y1: 1210 } }],
    };
    expect(orientationEvidence(analysis)).toBe(0);
    expect(getAlternativeRotations(analysis)).toEqual([90, 180, 270]);
  });

  it('accepts a value underneath its table header, not a distant footnote', () => {
    const analysis = {
      meta: { width: 1600, height: 718 },
      anchors: [{ bbox: { x0: 570, y0: 300, x1: 640, y1: 330 } }],
      regions: [{ bbox: { x0: 574, y0: 346, x1: 608, y1: 355 } }],
    };
    expect(orientationEvidence(analysis)).toBeGreaterThanOrEqual(35);
    expect(shouldTryContentRotations(analysis)).toBe(false);
    expect(shouldTryContentRotations({
      ...analysis, regions: [{ bbox: { x0: 574, y0: 520, x1: 608, y1: 535 } }],
    })).toBe(true);
  });
});
