'use strict';

const sharp = require('sharp');

function groupAdjacentXs(xs) {
  const groups = [];
  for (const entry of xs) {
    const current = groups[groups.length - 1];
    if (current && entry.x <= current[current.length - 1].x + 1) current.push(entry);
    else groups.push([entry]);
  }
  return groups.map((group) =>
    group.reduce((best, entry) => (entry.score > best.score ? entry : best))
  );
}

/**
 * When a tiny scan exposes only the CHARGED value to OCR, recover the ACTUAL
 * value box from the adjacent table column. This uses strong vertical borders
 * and only activates when the two neighbouring columns have matching widths.
 */
async function inferActualSiblingRegion(imageInput, anchors, regions, meta) {
  if (regions.length !== 1) return [];
  const [chargedRegion] = regions;
  if (!/charg/i.test(chargedRegion.anchorText || '')) return [];
  if (anchors.some((anchor) => anchor.words.some((word) => /actual/i.test(word.text)))) {
    return [];
  }

  const chargedAnchor = anchors.find((anchor) =>
    anchor.words.some((word) => /charg/i.test(word.text))
  );
  if (!chargedAnchor) return [];

  const { data, info } = await sharp(imageInput)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const anchorHeight = chargedAnchor.bbox.y1 - chargedAnchor.bbox.y0;
  const top = Math.max(0, Math.floor(chargedAnchor.bbox.y0 - Math.max(10, anchorHeight * 2)));
  const bottom = Math.min(
    info.height,
    Math.ceil(chargedRegion.bbox.y1 + Math.max(25, anchorHeight * 5))
  );
  const searchRadius = Math.min(250, Math.round(info.width * 0.25));
  const searchLeft = Math.max(0, Math.floor(chargedRegion.bbox.x0 - searchRadius));
  const searchRight = Math.min(info.width - 1, Math.ceil(chargedRegion.bbox.x1 + searchRadius));
  const bandHeight = Math.max(1, bottom - top);

  const scoredXs = [];
  for (let x = searchLeft; x <= searchRight; x += 1) {
    let score = 0;
    for (let y = top; y < bottom; y += 1) {
      if (data[y * info.width + x] < 165) score += 1;
    }
    if (score >= bandHeight * 0.3) scoredXs.push({ x, score });
  }

  const borders = groupAdjacentXs(scoredXs).sort((a, b) => a.x - b.x);
  const centerX = (chargedRegion.bbox.x0 + chargedRegion.bbox.x1) / 2;
  const leftBorders = borders.filter((border) => border.x < centerX);
  const rightBorders = borders.filter((border) => border.x > centerX);
  if (leftBorders.length < 2 || !rightBorders.length) return [];

  const currentLeft = leftBorders[leftBorders.length - 1].x;
  const previousLeft = leftBorders[leftBorders.length - 2].x;
  const currentRight = rightBorders[0].x;
  const currentWidth = currentRight - currentLeft;
  const previousWidth = currentLeft - previousLeft;
  if (currentWidth <= 0 || previousWidth <= 0) return [];
  const widthRatio = previousWidth / currentWidth;
  if (widthRatio < 0.7 || widthRatio > 1.3) return [];

  const shift = currentLeft - previousLeft;
  const inferredBbox = {
    x0: chargedRegion.bbox.x0 - shift,
    y0: chargedRegion.bbox.y0,
    x1: chargedRegion.bbox.x1 - shift,
    y1: chargedRegion.bbox.y1,
  };
  if (inferredBbox.x0 <= previousLeft || inferredBbox.x1 >= currentLeft) return [];

  return [
    {
      bbox: inferredBbox,
      originalText: '',
      anchorText: 'inferred ACTUAL WEIGHT',
    },
  ];
}

module.exports = { inferActualSiblingRegion };
