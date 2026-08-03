'use strict';

const PORTRAIT_ROTATION_RATIO = 1.1;

/**
 * Returns a user-facing issue when a landscape courier label appears to be
 * stored sideways after any EXIF auto-orientation has already been applied.
 *
 * @param {{width?: number, height?: number, orientation?: number}} meta
 * @returns {{code:string, reason:string, orientation:number|null}|null}
 */
function findRotationIssue(meta = {}) {
  const width = Number(meta.width);
  const height = Number(meta.height);
  const looksSideways =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > width * PORTRAIT_ROTATION_RATIO;

  if (!looksSideways) return null;

  return {
    code: 'image_rotation',
    orientation: null,
    reason:
      'Fix image rotation before uploading: rotate the image so the label text reads left-to-right, save it, and upload it again. No value was changed.',
  };
}

module.exports = { findRotationIssue };
