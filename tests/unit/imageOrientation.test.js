'use strict';

const { findRotationIssue } = require('../../src/services/imageOrientation.service');

describe('imageOrientation.service', () => {
  it('accepts a normal landscape label', () => {
    expect(findRotationIssue({ width: 1600, height: 1200, orientation: 1 })).toBeNull();
  });

  it('does not reject a landscape image merely because an EXIF tag is present', () => {
    expect(findRotationIssue({ width: 1600, height: 1200, orientation: 6 })).toBeNull();
  });

  it('rejects a sideways portrait label even when EXIF orientation is missing', () => {
    expect(findRotationIssue({ width: 1200, height: 1600 })).toMatchObject({
      code: 'image_rotation',
      orientation: null,
    });
  });
});
