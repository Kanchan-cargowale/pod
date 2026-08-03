'use strict';

const PORTRAIT_ROTATION_RATIO = 1.1;

/**
 * Portrait dimensions alone do not prove that the printed content is
 * sideways. They only tell the processor that quarter-turn OCR fallbacks may
 * be useful if the as-uploaded orientation cannot locate a weight value.
 *
 * @param {{width?: number, height?: number, orientation?: number}} meta
 * @returns {boolean}
 */
function shouldTryQuarterTurns(meta = {}) {
  const width = Number(meta.width);
  const height = Number(meta.height);
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > width * PORTRAIT_ROTATION_RATIO
  );
}

module.exports = { shouldTryQuarterTurns };
