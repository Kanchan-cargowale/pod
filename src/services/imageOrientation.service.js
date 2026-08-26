'use strict';

const PORTRAIT_ROTATION_RATIO = 1.1;
const ALTERNATIVE_ROTATIONS = Object.freeze([90, 180, 270]);

function orientationEvidence(analysis = {}) {
  const { meta, anchors = [], regions = [], words = [] } = analysis;
  if (!meta?.width || !meta?.height) return regions.length ? 1 : 0;
  const tableAnchors = anchors.filter(({ bbox }) => bbox.x0 >= meta.width * 0.12 &&
    bbox.x0 < meta.width * 0.6 && bbox.y0 > meta.height * 0.20 && bbox.y0 < meta.height * 0.62);
  const ownedValues = regions.filter(({ bbox }) => tableAnchors.some((anchor) =>
    bbox.x0 >= anchor.bbox.x0 - meta.width * 0.025 &&
    bbox.x0 <= anchor.bbox.x1 + meta.width * 0.025 &&
    bbox.y0 >= anchor.bbox.y1 - 3 && bbox.y0 < anchor.bbox.y1 + meta.height * 0.12));
  const bodyEvidence = words.filter((word) => /^(actual|charged|shipment|recipient|invoice|weight)/i.test(word.text) && word.confidence >= 30).length;
  return tableAnchors.length * 10 + ownedValues.length * 25 + Math.min(9, bodyEvidence);
}

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

/**
 * Rotation is a content decision, not a canvas-shape decision. A sideways
 * label can still be stored in a landscape canvas and an upside-down label
 * keeps exactly the same dimensions. Only invoke the slower orientation
 * cascade when the normal OCR pass cannot locate a usable weight value.
 *
 * @param {{regions?: Array}} analysis
 * @returns {boolean}
 */
function shouldTryContentRotations(analysis = {}) {
  if (!analysis.meta) return !Array.isArray(analysis.regions) || analysis.regions.length === 0;
  return orientationEvidence(analysis) < 35;
}

/**
 * @param {{regions?: Array}} analysis
 * @returns {number[]}
 */
function getAlternativeRotations(analysis = {}) {
  return shouldTryContentRotations(analysis) ? [...ALTERNATIVE_ROTATIONS] : [];
}

module.exports = {
  orientationEvidence,
  shouldTryQuarterTurns,
  shouldTryContentRotations,
  getAlternativeRotations,
};
