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

function groupAdjacentRows(rows) {
  const groups = [];
  for (const entry of rows) {
    const current = groups[groups.length - 1];
    if (current && entry.y <= current[current.length - 1].y + 2) current.push(entry);
    else groups.push([entry]);
  }
  return groups.map((group) =>
    group.reduce((best, entry) => (entry.score > best.score ? entry : best))
  );
}

function findVerticalLineTop(data, info, x, yMin, yMax) {
  const rows = [];
  for (let y = yMin; y < yMax; y += 1) {
    let dark = false;
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = x + dx;
      if (px < 0 || px >= info.width) continue;
      if (data[y * info.width + px] < 185) {
        dark = true;
        break;
      }
    }
    if (dark) rows.push({ y, score: 1 });
  }

  const groups = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    if (current && row.y <= current[current.length - 1].y + 3) current.push(row);
    else groups.push([row]);
  }

  const best = groups
    .map((group) => ({ top: group[0].y, bottom: group[group.length - 1].y, length: group.length }))
    .filter((group) => group.length >= Math.max(15, info.height * 0.025))
    .sort((a, b) => b.length - a.length)[0];

  return best?.top ?? null;
}

function findValueTextBand(data, info, columns) {
  const candidates = [];
  const minGap = Math.max(14, info.height * 0.025);
  const yMin = Math.round(info.height * 0.34);
  const yMax = Math.round(info.height * 0.65);

  for (const column of columns) {
    const width = column.right - column.left;
    const x0 = Math.max(0, Math.round(column.left + width * 0.08));
    const x1 = Math.min(info.width, Math.round(column.right - width * 0.08));
    if (x1 <= x0) continue;

    const rows = [];
    for (let y = yMin; y < yMax; y += 1) {
      let count = 0;
      for (let x = x0; x < x1; x += 1) {
        if (data[y * info.width + x] < 175) count += 1;
      }
      if (count >= 2) rows.push({ y, score: count });
    }

    const groups = [];
    for (const row of rows) {
      const current = groups[groups.length - 1];
      if (current && row.y <= current[current.length - 1].y + 2) current.push(row);
      else groups.push([row]);
    }

    const clusters = groups
      .map((group) => ({
        top: group[0].y,
        bottom: group[group.length - 1].y,
        sum: group.reduce((total, row) => total + row.score, 0),
      }))
      .filter((cluster) => cluster.sum >= 6);

    for (let i = 1; i < clusters.length; i += 1) {
      const previous = clusters[i - 1];
      const cluster = clusters[i];
      if (cluster.top - previous.bottom >= minGap) {
        candidates.push(cluster);
        break;
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.top - b.top);
  const selected = candidates[Math.floor(candidates.length / 2)];
  return {
    y0: Math.max(0, selected.top - 2),
    y1: Math.min(info.height, selected.bottom + Math.max(3, Math.round(info.height * 0.01))),
  };
}

function pickWeightColumnBorders(borders) {
  const sortedBorders = [...borders].sort((a, b) => a.x - b.x);
  const xs = sortedBorders.map((border) => border.x);
  if (xs.length < 4) return [];

  const gaps = [];
  for (let i = 0; i < xs.length - 1; i += 1) {
    gaps.push({ index: i, width: xs[i + 1] - xs[i] });
  }

  // Two-column labels have ACTUAL and CHARGED as adjacent, nearly equal-width
  // cells, followed by a narrower SAID TO CONTAIN/product column.
  const twoColumn = gaps.find((gap, index) => {
    const next = gaps[index + 1];
    const after = gaps[index + 2];
    if (!next || !after) return false;
    if (gap.width < 70 || gap.width > 180 || next.width < 70 || next.width > 180) {
      return false;
    }
    const ratio = next.width / gap.width;
    return ratio >= 0.65 && ratio <= 1.35 && after.width <= Math.max(gap.width, next.width) * 0.85;
  });
  if (twoColumn) {
    const i = twoColumn.index;
    return [
      { left: xs[i], right: xs[i + 1] },
      { left: xs[i + 1], right: xs[i + 2] },
    ];
  }

  // For single ACTUAL WEIGHT templates, suppress weaker internal text strokes
  // and use the first strong 80-180px cell before the SAID TO CONTAIN column.
  const strongXs = sortedBorders
    .filter((border) => border.score >= 125)
    .map((border) => border.x);
  if (strongXs.length >= 3) {
    for (let i = 0; i < strongXs.length - 1; i += 1) {
      const width = strongXs[i + 1] - strongXs[i];
      if (width >= 80 && width <= 180) {
        return [{ left: strongXs[i], right: strongXs[i + 1] }];
      }
    }
  }

  // The box-dimension column is normally the widest column immediately before
  // ACTUAL/CHARGED weight. Use that as the left edge of the weight columns.
  const plausible = gaps
    .filter((gap) => gap.width >= 70 && gap.width <= 260 && gap.index + 2 < xs.length)
    .sort((a, b) => b.width - a.width);
  const boxGap = plausible[0];
  if (!boxGap) return [];

  const firstWeightLeftIndex = boxGap.index + 1;
  const afterFirstWidth = xs[firstWeightLeftIndex + 1] - xs[firstWeightLeftIndex];
  const afterSecondWidth =
    firstWeightLeftIndex + 2 < xs.length
      ? xs[firstWeightLeftIndex + 2] - xs[firstWeightLeftIndex + 1]
      : 0;

  if (afterFirstWidth < 45 || afterFirstWidth > 180) return [];

  const columns = [
    { left: xs[firstWeightLeftIndex], right: xs[firstWeightLeftIndex + 1] },
  ];

  // Two weight columns are adjacent and similar width; a single-weight
  // template is followed by the product/SAID TO CONTAIN column instead.
  const widthRatio = afterSecondWidth / afterFirstWidth;
  if (afterSecondWidth >= 45 && afterSecondWidth <= 180 && widthRatio >= 0.65 && widthRatio <= 1.35) {
    columns.push({ left: xs[firstWeightLeftIndex + 1], right: xs[firstWeightLeftIndex + 2] });
  }

  return columns;
}

/**
 * Last-resort Delhivery table fallback for faint scans where OCR matches the
 * shipment ID but misses the ACTUAL/CHARGED WEIGHT headers and values. It
 * recovers the value cells from the printed table's vertical rules.
 */
async function inferWeightRegionsFromTable(imageInput, meta) {
  const { data, info } = await sharp(imageInput)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const yMin = Math.round(info.height * 0.25);
  const yMax = Math.round(info.height * 0.75);
  const bandHeight = Math.max(1, yMax - yMin);
  const xMin = Math.round(info.width * 0.02);
  const xMax = Math.round(info.width * 0.6);

  const scoredXs = [];
  for (let x = xMin; x < xMax; x += 1) {
    let count = 0;
    let bestRun = 0;
    let run = 0;
    for (let y = yMin; y < yMax; y += 1) {
      if (data[y * info.width + x] < 185) {
        count += 1;
        run += 1;
      } else {
        if (run > bestRun) bestRun = run;
        run = 0;
      }
    }
    if (run > bestRun) bestRun = run;
    const score = Math.max(count, bestRun * 3);
    if (count >= bandHeight * 0.08 || bestRun >= bandHeight * 0.08) {
      scoredXs.push({ x, score, count, bestRun });
    }
  }

  const borders = groupAdjacentXs(scoredXs)
    .filter((border) => border.score >= Math.max(55, bandHeight * 0.18))
    .sort((a, b) => a.x - b.x);
  const columns = pickWeightColumnBorders(borders);
  if (!columns.length) return [];

  const valueTextBand = findValueTextBand(data, info, columns);
  const lineTops = columns
    .flatMap((column) => [column.left, column.right])
    .map((x) => findVerticalLineTop(data, info, x, yMin, yMax))
    .filter((top) => top !== null);
  let y0;
  let y1;
  if (valueTextBand) {
    y0 = valueTextBand.y0;
    y1 = valueTextBand.y1;
  } else {
    if (!lineTops.length) return [];
    const headerTop = Math.round(lineTops.sort((a, b) => a - b)[Math.floor(lineTops.length / 2)]);
    y0 = Math.max(0, Math.round(headerTop + Math.max(18, info.height * 0.035)));
    y1 = Math.min(info.height, Math.round(y0 + Math.max(10, info.height * 0.022)));
  }

  return columns.map((column, index) => {
    const width = column.right - column.left;
    const x0 = Math.max(0, Math.round(column.left + width * 0.06));
    const x1 = Math.min(info.width, Math.round(column.right - Math.max(2, width * 0.08)));
    return {
      bbox: { x0, y0, x1, y1 },
      originalText: '',
      anchorText: index === 0 ? 'inferred ACTUAL WEIGHT table cell' : 'inferred CHARGED WEIGHT table cell',
    };
  });
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

module.exports = { inferActualSiblingRegion, inferWeightRegionsFromTable };
