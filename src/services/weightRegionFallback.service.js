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

function percentileNumber(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function anchorText(anchor) {
  return anchor.words.map((word) => word.text).join(' ');
}

function anchorColumnLeft(anchor) {
  const headerWords = anchor.words.filter((word) => {
    const letters = (String(word.text || '').match(/[a-z]/gi) || []).length;
    return letters >= 3 && /weight|weigh|actual|ctual|charg/i.test(word.text);
  });
  const usable = headerWords.length ? headerWords : anchor.words;
  return Math.min(...usable.map((word) => word.bbox?.x0 ?? anchor.bbox.x0));
}

function findPrimaryWeightHeaderPair(anchors, meta) {
  const candidates = anchors.filter((anchor) => {
    const centerX = (anchor.bbox.x0 + anchor.bbox.x1) / 2;
    const centerY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
    return centerX < meta.width * 0.62 && centerY > meta.height * 0.2 && centerY < meta.height * 0.68;
  });

  const pairs = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i].bbox.x0 <= candidates[j].bbox.x0 ? candidates[i] : candidates[j];
      const right = left === candidates[i] ? candidates[j] : candidates[i];
      const leftHeight = left.bbox.y1 - left.bbox.y0;
      const rightHeight = right.bbox.y1 - right.bbox.y0;
      const centerYLeft = (left.bbox.y0 + left.bbox.y1) / 2;
      const centerYRight = (right.bbox.y0 + right.bbox.y1) / 2;
      const yDrift = Math.abs(centerYLeft - centerYRight);
      const leftColumnX = anchorColumnLeft(left);
      const rightColumnX = anchorColumnLeft(right);
      const separation = rightColumnX - leftColumnX;
      if (yDrift > Math.max(leftHeight, rightHeight) * 0.75) continue;
      if (separation < meta.width * 0.045 || separation > meta.width * 0.22) continue;

      const qualifierScore = [left, right].reduce(
        (score, anchor) => score + (/actual|ctual|charg/i.test(anchorText(anchor)) ? 1 : 0),
        0
      );
      pairs.push({ left, right, leftColumnX, rightColumnX, qualifierScore, y: Math.min(left.bbox.y0, right.bbox.y0) });
    }
  }
  pairs.sort((a, b) => b.qualifierScore - a.qualifierScore || a.y - b.y);
  return pairs[0] || null;
}

function findInkClusters(data, info, cell, headerBottom) {
  const left = Math.max(0, Math.round(cell.left + (cell.right - cell.left) * 0.035));
  // Header left-edge extrapolation can overshoot the true right rule slightly;
  // a generous right inset keeps the product column and its vertical border
  // out while retaining left-aligned weight values.
  const right = Math.min(info.width, Math.round(cell.right - (cell.right - cell.left) * 0.15));
  const top = Math.max(0, Math.round(headerBottom + 1));
  const bottom = Math.min(info.height, Math.round(top + Math.max(26, info.height * 0.09)));
  if (right <= left || bottom <= top) return [];

  const samples = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 2) samples.push(data[y * info.width + x]);
  }
  const paper = percentileNumber(samples, 0.82);
  const darkLimit = Math.min(205, paper - Math.max(10, paper * 0.055));
  const usableWidth = right - left;
  const rows = [];
  for (let y = top; y < bottom; y += 1) {
    let dark = 0;
    for (let x = left; x < right; x += 1) {
      if (data[y * info.width + x] < darkLimit) dark += 1;
    }
    // A table separator spans most of the cell; it is never value ink.
    if (dark >= 2 && dark < usableWidth * 0.34) rows.push({ y, score: dark });
  }

  const grouped = [];
  for (const row of rows) {
    const current = grouped[grouped.length - 1];
    if (current && row.y <= current[current.length - 1].y + 2) current.push(row);
    else grouped.push([row]);
  }

  return grouped
    .map((group) => ({
      top: group[0].y,
      bottom: group[group.length - 1].y + 1,
      score: group.reduce((sum, row) => sum + row.score, 0),
      height: group[group.length - 1].y - group[0].y + 1,
      left,
      right,
      darkLimit,
    }))
    .filter((cluster) =>
      cluster.height >= 3 &&
      cluster.height <= Math.max(16, info.height * 0.03) &&
      cluster.score >= 8
    )
    .sort((a, b) => a.top - b.top);
}

function bboxForInkCluster(data, info, cluster) {
  const xs = [];
  for (let y = cluster.top; y < cluster.bottom; y += 1) {
    for (let x = cluster.left; x < cluster.right; x += 1) {
      if (data[y * info.width + x] < cluster.darkLimit) xs.push(x);
    }
  }
  if (!xs.length) return null;
  return {
    x0: Math.max(cluster.left, percentileNumber(xs, 0.03) - 1),
    y0: Math.max(0, cluster.top - 1),
    x1: Math.min(cluster.right, percentileNumber(xs, 0.97) + 2),
    y1: Math.min(info.height, cluster.bottom + 1),
  };
}

/**
 * Detect the physical value row independently of OCR word boxes. Enhanced OCR
 * sometimes merges a two-line header and the value into one tall token; using
 * that token for erasing destroys ACTUAL/CHARGED and their separator. Here the
 * two header left edges define the cells and the first non-rule ink band below
 * the header defines the only pixels that may be edited.
 */
async function inferWeightRegionsFromAnchors(imageInput, anchors, words, meta) {
  const pair = findPrimaryWeightHeaderPair(anchors, meta);
  if (!pair) return [];

  const separation = pair.rightColumnX - pair.leftColumnX;
  const cells = [
    { left: pair.leftColumnX, right: pair.rightColumnX },
    { left: pair.rightColumnX, right: pair.rightColumnX + separation },
  ];
  // If one OCR header swallows the value row its bottom becomes much lower
  // than its sibling. The aligned sibling provides the safe separator.
  const headerBottom = Math.min(pair.left.bbox.y1, pair.right.bbox.y1);
  const { data, info } = await sharp(imageInput).greyscale().raw().toBuffer({ resolveWithObject: true });
  const clusterSets = cells.map((cell) => findInkClusters(data, info, cell, headerBottom));

  let selected = [clusterSets[0][0] || null, clusterSets[1][0] || null];
  if (selected[0] && selected[1]) {
    let best = null;
    for (const leftCluster of clusterSets[0].slice(0, 4)) {
      for (const rightCluster of clusterSets[1].slice(0, 4)) {
        const drift = Math.abs(leftCluster.top - rightCluster.top);
        if (!best || drift < best.drift) best = { leftCluster, rightCluster, drift };
      }
    }
    if (best) selected = [best.leftCluster, best.rightCluster];
  } else if (selected[0] || selected[1]) {
    const source = selected[0] || selected[1];
    const missingIndex = selected[0] ? 1 : 0;
    // A very faint sibling may have no independently detectable row. Reuse
    // the proven row only after both header columns established its cell.
    selected[missingIndex] = { ...source, left: Math.round(cells[missingIndex].left + separation * 0.035), right: Math.round(cells[missingIndex].right - separation * 0.15) };
  }
  if (!selected[0] || !selected[1]) return [];
  if (Math.abs(selected[0].top - selected[1].top) > Math.max(8, info.height * 0.018)) return [];

  return selected.map((cluster, index) => {
    const bbox = bboxForInkCluster(data, info, cluster) || {
      x0: Math.round(cells[index].left + separation * 0.06),
      y0: cluster.top,
      x1: Math.round(cells[index].left + separation * 0.7),
      y1: cluster.bottom,
    };
    const yTolerance = Math.max(5, info.height * 0.012);
    const maxWordHeight = Math.max(16, info.height * 0.03);
    const matchingWord = words.find((word) => {
      const cx = (word.bbox.x0 + word.bbox.x1) / 2;
      const cy = (word.bbox.y0 + word.bbox.y1) / 2;
      const wordHeight = word.bbox.y1 - word.bbox.y0;
      return cx >= cells[index].left && cx <= cells[index].right &&
        cy >= bbox.y0 - yTolerance && cy <= bbox.y1 + yTolerance &&
        wordHeight <= maxWordHeight &&
        /^\d{1,6}(?:[.,]\d{1,3})?$/.test(word.text.trim());
    });
    const kind = index === 0 ? 'actual' : 'charged';
    return {
      bbox,
      originalText: matchingWord ? matchingWord.text.trim().replace(',', '.') : '',
      anchorText: index === 0 ? 'structural ACTUAL WEIGHT' : 'structural CHARGED WEIGHT',
      kind,
    };
  });
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

function findValueTextBand(data, info, columns, searchBand = {}) {
  const candidates = [];
  const minGap = Math.max(14, info.height * 0.025);
  const yMin = Math.max(0, Math.round(searchBand.yMin ?? info.height * 0.34));
  const yMax = Math.min(info.height, Math.round(searchBand.yMax ?? info.height * 0.65));

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

function pickWeightColumnBorders(borders, imageWidth) {
  const sortedBorders = [...borders].sort((a, b) => a.x - b.x);
  const xs = sortedBorders.map((border) => border.x);
  if (xs.length < 4) return [];

  // Cell widths scale with the photographed page. Fixed pixel limits worked
  // on ~1100px scans but rejected the same table in 3K/4K phone photos.
  const minCellWidth = Math.max(24, imageWidth * 0.032);
  const maxCellWidth = Math.max(180, imageWidth * 0.19);

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
    if (
      gap.width < minCellWidth || gap.width > maxCellWidth ||
      next.width < minCellWidth || next.width > maxCellWidth
    ) {
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
  const strongestScore = Math.max(...sortedBorders.map((border) => border.score));
  const strongXs = sortedBorders
    .filter((border) => border.score >= strongestScore * 0.45)
    .map((border) => border.x);
  if (strongXs.length >= 3) {
    for (let i = 0; i < strongXs.length - 1; i += 1) {
      const width = strongXs[i + 1] - strongXs[i];
      if (width >= minCellWidth && width <= maxCellWidth) {
        return [{ left: strongXs[i], right: strongXs[i + 1] }];
      }
    }
  }

  // The box-dimension column is normally the widest column immediately before
  // ACTUAL/CHARGED weight. Use that as the left edge of the weight columns.
  const plausible = gaps
    .filter((gap) => gap.width >= minCellWidth && gap.width <= maxCellWidth * 1.45 && gap.index + 2 < xs.length)
    .sort((a, b) => b.width - a.width);
  const boxGap = plausible[0];
  if (!boxGap) return [];

  const firstWeightLeftIndex = boxGap.index + 1;
  const afterFirstWidth = xs[firstWeightLeftIndex + 1] - xs[firstWeightLeftIndex];
  const afterSecondWidth =
    firstWeightLeftIndex + 2 < xs.length
      ? xs[firstWeightLeftIndex + 2] - xs[firstWeightLeftIndex + 1]
      : 0;

  if (afterFirstWidth < minCellWidth * 0.65 || afterFirstWidth > maxCellWidth) return [];

  const columns = [
    { left: xs[firstWeightLeftIndex], right: xs[firstWeightLeftIndex + 1] },
  ];

  // Two weight columns are adjacent and similar width; a single-weight
  // template is followed by the product/SAID TO CONTAIN column instead.
  const widthRatio = afterSecondWidth / afterFirstWidth;
  if (
    afterSecondWidth >= minCellWidth * 0.65 && afterSecondWidth <= maxCellWidth &&
    widthRatio >= 0.65 && widthRatio <= 1.35
  ) {
    columns.push({ left: xs[firstWeightLeftIndex + 1], right: xs[firstWeightLeftIndex + 2] });
  }

  return columns;
}

/**
 * Last-resort Delhivery table fallback for faint scans where OCR matches the
 * shipment ID but misses the ACTUAL/CHARGED WEIGHT headers and values. It
 * recovers the value cells from the printed table's vertical rules.
 */
async function inferWeightRegionsFromTable(imageInput, meta, anchors = []) {
  const { data, info } = await sharp(imageInput)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const weightAnchors = anchors.filter((anchor) =>
    anchor.words.some((word) => /weight|actual|ctual|charg/i.test(word.text))
  );
  const anchorTop = weightAnchors.length
    ? Math.min(...weightAnchors.map((anchor) => anchor.bbox.y0))
    : null;
  const anchorBottom = weightAnchors.length
    ? Math.max(...weightAnchors.map((anchor) => anchor.bbox.y1))
    : null;
  const yMin = Math.max(0, Math.round(anchorTop === null ? info.height * 0.25 : anchorTop - info.height * 0.06));
  const yMax = Math.min(
    info.height,
    Math.round(anchorBottom === null ? info.height * 0.75 : anchorBottom + info.height * 0.28)
  );
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
  const columns = pickWeightColumnBorders(borders, info.width);
  if (!columns.length) return [];

  const valueTextBand = findValueTextBand(data, info, columns, { yMin, yMax });
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
    const kind = index === 0 ? 'actual' : 'charged';
    return {
      bbox: { x0, y0, x1, y1 },
      originalText: '',
      anchorText: index === 0 ? 'inferred ACTUAL WEIGHT table cell' : 'inferred CHARGED WEIGHT table cell',
      kind,
    };
  });
}

/**
 * When a tiny scan exposes only the CHARGED value to OCR, recover the ACTUAL
 * value box from the adjacent table column. This uses strong vertical borders
 * and only activates when the two neighbouring columns have matching widths.
 */
function weightColumnKind(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^a-z]/g, '');
  if (/actual|ctual/.test(normalized)) return 'actual';
  if (/charged|chargeable|chargd/.test(normalized)) return 'charged';
  return null;
}

function hasTargetWeightHeaderEvidence(anchors, words, sourceRegion, candidateRegion, meta) {
  // Unit callers created before OCR evidence was added retain their focused
  // geometry behaviour. Production always supplies the full OCR word list.
  if (!Array.isArray(words) || !words.length) return true;

  const sourceCenter = (sourceRegion.bbox.x0 + sourceRegion.bbox.x1) / 2;
  const targetCenter = (candidateRegion.bbox.x0 + candidateRegion.bbox.x1) / 2;
  const separation = Math.abs(targetCenter - sourceCenter);
  if (separation < meta.width * 0.035) return false;

  const sourceAnchor = [...anchors].sort((a, b) => {
    const ax = (a.bbox.x0 + a.bbox.x1) / 2;
    const bx = (b.bbox.x0 + b.bbox.x1) / 2;
    return Math.abs(ax - sourceCenter) - Math.abs(bx - sourceCenter);
  })[0];
  const headerTop = Math.max(
    0,
    Math.floor((sourceAnchor?.bbox.y0 ?? sourceRegion.bbox.y0 - meta.height * 0.08) - meta.height * 0.025)
  );
  const headerBottom = Math.ceil(sourceRegion.bbox.y0 + Math.max(3, meta.height * 0.008));
  const targetLeft = targetCenter - separation * 0.48;
  const targetRight = targetCenter + separation * 0.48;

  const targetHeaderWords = words.filter((word) => {
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    return centerX >= targetLeft && centerX <= targetRight &&
      centerY >= headerTop && centerY <= headerBottom;
  });
  const targetText = targetHeaderWords
    .map((word) => String(word.text || '').toLowerCase().replace(/[^a-z]/g, ''))
    .join(' ');

  // Product cells are common immediately beside a single ACTUAL WEIGHT cell.
  // Their similar width is not evidence of a missing CHARGED column.
  if (/said|contain|product|description|item/.test(targetText)) return false;

  const targetAnchor = anchors.some((anchor) => {
    const centerX = (anchor.bbox.x0 + anchor.bbox.x1) / 2;
    const centerY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
    const text = anchor.words.map((word) => word.text).join(' ');
    return centerX >= targetLeft && centerX <= targetRight &&
      centerY >= headerTop && centerY <= headerBottom &&
      /weight|weigh|charg|actual|ctual/i.test(text);
  });
  if (targetAnchor) return true;

  return /weight|weigh|charg|actual|ctual/.test(targetText);
}

async function inferSiblingFromTableRules(imageInput, anchors, regions, meta) {
  if (regions.length !== 1) return [];
  const source = regions[0];
  const sourceKind = weightColumnKind(source.anchorText);
  const { data, info } = await sharp(imageInput).greyscale().raw().toBuffer({ resolveWithObject: true });
  const anchorTop = anchors.length ? Math.min(...anchors.map((anchor) => anchor.bbox.y0)) : source.bbox.y0;
  const top = Math.max(0, Math.floor(anchorTop - Math.max(8, info.height * 0.015)));
  const bottom = Math.min(info.height, Math.ceil(source.bbox.y1 + Math.max(28, info.height * 0.055)));
  const centerX = (source.bbox.x0 + source.bbox.x1) / 2;
  const searchLeft = Math.max(0, Math.floor(centerX - info.width * 0.32));
  const searchRight = Math.min(info.width - 1, Math.ceil(centerX + info.width * 0.32));
  const bandHeight = Math.max(1, bottom - top);
  const xs = [];
  for (let x = searchLeft; x <= searchRight; x += 1) {
    let dark = 0;
    let longestRun = 0;
    let run = 0;
    for (let y = top; y < bottom; y += 1) {
      if (data[y * info.width + x] < 175) {
        dark += 1;
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else {
        run = 0;
      }
    }
    const score = Math.max(dark, longestRun * 2);
    if (dark >= bandHeight * 0.28 || longestRun >= bandHeight * 0.24) xs.push({ x, score });
  }
  const borders = groupAdjacentXs(xs).sort((a, b) => a.x - b.x);
  const leftBorders = borders.filter((border) => border.x < centerX);
  const rightBorders = borders.filter((border) => border.x > centerX);
  if (!leftBorders.length || !rightBorders.length) return [];

  const currentLeftIndex = leftBorders.length - 1;
  const currentLeft = leftBorders[currentLeftIndex].x;
  const currentRight = rightBorders[0].x;
  const currentWidth = currentRight - currentLeft;
  if (currentWidth < info.width * 0.035 || currentWidth > info.width * 0.2) return [];

  const previousLeft = currentLeftIndex > 0 ? leftBorders[currentLeftIndex - 1].x : null;
  const nextRight = rightBorders.length > 1 ? rightBorders[1].x : null;
  const leftWidth = previousLeft === null ? null : currentLeft - previousLeft;
  const rightWidth = nextRight === null ? null : nextRight - currentRight;
  const isMatchingWidth = (width) => width !== null && width / currentWidth >= 0.68 && width / currentWidth <= 1.32;
  const canInferLeft = isMatchingWidth(leftWidth);
  const canInferRight = isMatchingWidth(rightWidth);

  let direction = 0;
  if (sourceKind === 'actual' && canInferRight) direction = 1;
  else if (sourceKind === 'charged' && canInferLeft) direction = -1;
  else if (canInferRight && !canInferLeft) direction = 1;
  else if (canInferLeft && !canInferRight) direction = -1;
  else if (canInferLeft && canInferRight) {
    // The box-dimension column to the left is normally substantially wider;
    // when both sides look plausible, the closer width match is the sibling.
    direction = Math.abs(rightWidth - currentWidth) <= Math.abs(leftWidth - currentWidth) ? 1 : -1;
  }
  if (!direction) return [];

  const shift = direction > 0 ? currentWidth : -leftWidth;
  const bbox = {
    x0: source.bbox.x0 + shift,
    y0: source.bbox.y0,
    x1: source.bbox.x1 + shift,
    y1: source.bbox.y1,
  };
  if (bbox.x0 < 0 || bbox.x1 > meta.width) return [];
  const targetKind = direction > 0 ? 'charged' : 'actual';
  return [{ bbox, originalText: '', anchorText: `inferred ${targetKind.toUpperCase()} WEIGHT from table rules`, kind: targetKind }];
}

/**
 * Recover a missing ACTUAL or CHARGED value from the other column.  Header
 * coordinates are considerably more stable than OCR value coordinates on
 * faint PODs, so prefer their measured centre-to-centre offset.  This also
 * handles the formerly unsupported case where ACTUAL was read but CHARGED
 * was not, or where both headers were read but only one value survived OCR.
 */
function inferSiblingFromAnchors(anchors, regions, meta) {
  if (regions.length !== 1) return [];

  const sourceRegion = regions[0];
  let sourceKind = weightColumnKind(sourceRegion.anchorText);
  const anchorEntries = anchors
    .map((anchor) => ({
      anchor,
      kind: weightColumnKind(anchor.words.map((word) => word.text).join(' ')),
    }));
  const regionCenterX = (sourceRegion.bbox.x0 + sourceRegion.bbox.x1) / 2;
  // Geometry wins over the OCR qualifier. A duplicated value can be assigned
  // to the wrong header (e.g. ACTUAL value tagged as CHARGED); choosing by the
  // qualifier would then infer a sibling in the wrong direction.
  const sourceEntry = [...anchorEntries]
    .filter((entry) => entry.anchor.bbox.y0 < sourceRegion.bbox.y1)
    .sort((a, b) => {
      const ax = (a.anchor.bbox.x0 + a.anchor.bbox.x1) / 2;
      const bx = (b.anchor.bbox.x0 + b.anchor.bbox.x1) / 2;
      return Math.abs(ax - regionCenterX) - Math.abs(bx - regionCenterX);
    })[0];
  if (!sourceEntry) return [];
  if (sourceEntry.kind) sourceKind = sourceEntry.kind;

  const sourceAnchor = sourceEntry.anchor;
  const sourceCenterY = (sourceAnchor.bbox.y0 + sourceAnchor.bbox.y1) / 2;
  const sourceHeight = sourceAnchor.bbox.y1 - sourceAnchor.bbox.y0;
  const targetEntry = anchorEntries
    .filter((entry) => entry !== sourceEntry)
    .filter((entry) => {
      const centerY = (entry.anchor.bbox.y0 + entry.anchor.bbox.y1) / 2;
      const height = entry.anchor.bbox.y1 - entry.anchor.bbox.y0;
      const centerX = (entry.anchor.bbox.x0 + entry.anchor.bbox.x1) / 2;
      const sourceX = (sourceAnchor.bbox.x0 + sourceAnchor.bbox.x1) / 2;
      return Math.abs(centerY - sourceCenterY) <= Math.max(sourceHeight, height) * 0.9 &&
        Math.abs(centerX - sourceX) >= meta.width * 0.075;
    })
    .sort((a, b) => {
      const aKindPenalty = sourceKind && a.kind && a.kind === sourceKind ? 1 : 0;
      const bKindPenalty = sourceKind && b.kind && b.kind === sourceKind ? 1 : 0;
      if (aKindPenalty !== bKindPenalty) return aKindPenalty - bKindPenalty;
      const ax = (a.anchor.bbox.x0 + a.anchor.bbox.x1) / 2;
      const bx = (b.anchor.bbox.x0 + b.anchor.bbox.x1) / 2;
      const sourceX = (sourceAnchor.bbox.x0 + sourceAnchor.bbox.x1) / 2;
      return Math.abs(ax - sourceX) - Math.abs(bx - sourceX);
    })[0];
  if (!targetEntry) return [];

  const sourceCenter = (sourceAnchor.bbox.x0 + sourceAnchor.bbox.x1) / 2;
  const targetCenter = (targetEntry.anchor.bbox.x0 + targetEntry.anchor.bbox.x1) / 2;
  const shift = targetCenter - sourceCenter;
  if (!sourceKind) sourceKind = shift > 0 ? 'actual' : 'charged';
  const targetKind = targetEntry.kind || (sourceKind === 'actual' ? 'charged' : 'actual');
  const width = sourceRegion.bbox.x1 - sourceRegion.bbox.x0;
  const minShift = Math.max(width * 1.05, meta.width * 0.025);
  if (Math.abs(shift) < minShift || Math.abs(shift) > meta.width * 0.3) return [];

  const inferredBbox = {
    x0: sourceRegion.bbox.x0 + shift,
    y0: sourceRegion.bbox.y0,
    x1: sourceRegion.bbox.x1 + shift,
    y1: sourceRegion.bbox.y1,
  };
  if (inferredBbox.x0 < 0 || inferredBbox.x1 > meta.width) return [];

  return [{
    bbox: inferredBbox,
    originalText: '',
    anchorText: `inferred ${targetKind.toUpperCase()} WEIGHT`,
    kind: targetKind,
  }];
}

async function inferActualSiblingRegion(imageInput, anchors, regions, meta, words = []) {
  if (regions.length !== 1) return [];
  // Printed table rules are the authoritative column geometry. OCR frequently
  // returns only the word WEIGHT (or a clipped heading), whose centre is well
  // inside the cell and can place the inferred value back in the source cell.
  const ruleInferred = await inferSiblingFromTableRules(imageInput, anchors, regions, meta);
  if (
    ruleInferred.length &&
    hasTargetWeightHeaderEvidence(anchors, words, regions[0], ruleInferred[0], meta)
  ) return ruleInferred;
  const anchorInferred = inferSiblingFromAnchors(anchors, regions, meta);
  if (
    anchorInferred.length &&
    hasTargetWeightHeaderEvidence(anchors, words, regions[0], anchorInferred[0], meta)
  ) return anchorInferred;

  const [chargedRegion] = regions;
  if (!/charg/i.test(chargedRegion.anchorText || '')) return [];

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
      kind: 'actual',
    },
  ];
}

module.exports = {
  inferActualSiblingRegion,
  inferSiblingFromAnchors,
  inferSiblingFromTableRules,
  inferWeightRegionsFromAnchors,
  inferWeightRegionsFromTable,
};
