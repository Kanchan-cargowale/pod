'use strict';

const { shouldTryQuarterTurns } = require('../../src/services/imageOrientation.service');

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
});
