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
  const globalPaper = percentileNumber(samples, 0.82);
  const globalDarkLimit = Math.min(205, globalPaper - Math.max(8, globalPaper * 0.045));
  const usableWidth = right - left;
  const rows = [];
  for (let y = top; y < bottom; y += 1) {
    const rowPixels = [];
    for (let x = left; x < right; x += 1) rowPixels.push(data[y * info.width + x]);
    // A broad phone shadow changes the absolute luma of the complete row but
    // leaves printed glyphs darker than that row's paper. Use row-local paper
    // instead of one threshold for the whole search band.
    const rowPaper = percentileNumber(rowPixels, 0.8) || globalPaper;
    const rowDark = percentileNumber(rowPixels, 0.1);
    const rowContrast = rowPaper - rowDark;
    const rowDarkLimit = Math.min(
      215,
      rowPaper - Math.max(5, rowPaper * 0.032)
    );
    let dark = 0;
    for (const pixel of rowPixels) {
      if (pixel < Math.min(globalDarkLimit + 28, rowDarkLimit)) dark += 1;
    }
    // Broad shadows/noise can contain many slightly darker pixels but have a
    // very small within-row contrast range. Printed value strokes retain a
    // clear dark tail even inside that shadow.
    const hasGlyphContrast = rowContrast >= Math.max(14, rowPaper * 0.11);
    // A table separator spans most of the cell; it is never value ink.
    if (hasGlyphContrast && dark >= 2 && dark < usableWidth * 0.72) {
      rows.push({
        y,
        score: dark + rowContrast,
        darkLimit: Math.min(globalDarkLimit + 28, rowDarkLimit),
      });
    }
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
      darkLimit: percentileNumber(group.map((row) => row.darkLimit), 0.5),
      darkLimits: new Map(group.map((row) => [row.y, row.darkLimit])),
    }))
    .filter((cluster) =>
      cluster.height >= 3 &&
      cluster.height <= Math.max(18, info.height * 0.045) &&
      cluster.score >= 8
    )
    .sort((a, b) => a.top - b.top);
}

function bboxForInkCluster(data, info, cluster) {
  const inkByX = new Map();
  const rowHeight = Math.max(1, cluster.bottom - cluster.top);
  const contextRadius = Math.max(5, Math.round(rowHeight * 0.8));
  const localPaperByX = new Map();
  for (let x = cluster.left; x < cluster.right; x += 1) {
    const columnSamples = [];
    const sampleTop = Math.max(0, cluster.top - contextRadius);
    const sampleBottom = Math.min(info.height, cluster.bottom + contextRadius);
    for (let y = sampleTop; y < sampleBottom; y += 1) {
      columnSamples.push(data[y * info.width + x]);
    }
    localPaperByX.set(x, percentileNumber(columnSamples, 0.75));
  }
  for (let y = cluster.top; y < cluster.bottom; y += 1) {
    const rowDarkLimit = cluster.darkLimits?.get(y) ?? cluster.darkLimit;
    for (let x = cluster.left; x < cluster.right; x += 1) {
      const localPaper = localPaperByX.get(x) || 255;
      const localDarkLimit = localPaper - Math.max(5, localPaper * 0.04);
      if (data[y * info.width + x] < Math.min(rowDarkLimit, localDarkLimit)) {
        inkByX.set(x, (inkByX.get(x) || 0) + 1);
      }
    }
  }
  const occupied = [...inkByX.entries()]
    // A table rule is dark through nearly the complete row; glyph columns
    // occupy only part of it. Never include such a rule in the value bbox.
    .filter(([, count]) => count < rowHeight * 0.82)
    .map(([x]) => x)
    .sort((a, b) => a - b);
  if (!occupied.length) return null;

  const groups = [];
  for (const x of occupied) {
    const current = groups[groups.length - 1];
    if (current && x <= current[current.length - 1] + 4) current.push(x);
    else groups.push([x]);
  }
  const componentGroups = groups
    .map((group) => ({
      left: group[0],
      right: group[group.length - 1],
      ink: group.reduce((sum, x) => sum + (inkByX.get(x) || 0), 0),
    }))
    .filter((group) => group.ink >= Math.max(3, rowHeight * 0.12));
  const candidates = componentGroups
    .filter((group) => group.right - group.left >= 3 && group.ink >= 6)
    .sort((a, b) => b.ink - a.ink || a.left - b.left);
  const valueGroup = candidates[0];
  if (!valueGroup) return null;
  // Shadowed/blurred numbers can split into several x-components. Starting
  // from the strongest component, absorb nearby groups on the same proven
  // row so the bbox covers every old digit rather than only the final glyph.
  // Keep narrow components for this expansion: faint single strokes often
  // fail the primary width threshold even though they are part of the value.
  const maxGap = Math.max(8, rowHeight * 0.85);
  const selectedGroups = [valueGroup];
  let unionLeft = valueGroup.left;
  let unionRight = valueGroup.right;
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const candidate of componentGroups) {
      if (selectedGroups.includes(candidate)) continue;
      const gap = candidate.right < unionLeft
        ? unionLeft - candidate.right
        : candidate.left > unionRight
          ? candidate.left - unionRight
          : 0;
      const nextLeft = Math.min(unionLeft, candidate.left);
      const nextRight = Math.max(unionRight, candidate.right);
      if (gap <= maxGap && nextRight - nextLeft <= (cluster.right - cluster.left) * 0.78) {
        selectedGroups.push(candidate);
        unionLeft = nextLeft;
        unionRight = nextRight;
        expanded = true;
      }
    }
  }
  return {
    x0: Math.max(cluster.left, unionLeft - 2),
    y0: Math.max(0, cluster.top - 1),
    x1: Math.min(cluster.right, unionRight + 3),
    y1: Math.min(info.height, cluster.bottom + 1),
  };
}

/**
 * Re-locate old value ink after the worker has made its final business-schema
 * decision. The caller supplies only ACTUAL/CHARGED regions with physically
 * proven cell bounds; this function may refine their pixel boxes but can
 * never create a field or move one into BOXES/SAID TO CONTAIN.
 */
async function localizeWeightInkInCells(imageInput, regions, meta = {}) {
  if (!Array.isArray(regions) || !regions.length) return regions || [];

  const { data, info } = await sharp(imageInput)
    .greyscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Perspective-skewed text can span 3-4% of page height even when each
  // glyph is normally sized. The cell boundary and rule-row rejection remain
  // the hard safety constraints; do not discard that complete slanted row.
  const maxSafeHeight = Math.max(18, (meta.height || info.height) * 0.045);
  const minimumHeaderGap = Math.max(5, info.height * 0.007);
  const rowTolerance = Math.max(8, info.height * 0.018);

  const searches = regions.map((region) => {
    if (!region.cellBounds) return { region, candidates: [] };
    const cell = {
      left: Math.max(0, region.cellBounds.x0),
      right: Math.min(info.width, region.cellBounds.x1),
    };
    const fallbackHeaderBottom = Math.max(
      0,
      region.bbox.y0 - Math.max(8, info.height * 0.035)
    );
    const headerBottom = Math.max(
      0,
      Math.min(
        info.height - 1,
        Number.isFinite(region.headerBottom) ? region.headerBottom : fallbackHeaderBottom
      )
    );
    const candidates = findInkClusters(data, info, cell, headerBottom)
      .filter((cluster) => cluster.top - headerBottom >= minimumHeaderGap)
      .map((cluster) => ({ cluster, bbox: bboxForInkCluster(data, info, cluster) }))
      .filter(({ bbox }) => {
        if (!bbox) return false;
        const height = bbox.y1 - bbox.y0;
        const centerX = (bbox.x0 + bbox.x1) / 2;
        return height >= 3 && height <= maxSafeHeight &&
          centerX > cell.left && centerX < cell.right &&
          bbox.x0 >= cell.left && bbox.x1 <= cell.right;
      })
      // The printed value is the first non-rule ink row beneath its own
      // heading. Score is a tie-breaker only; it must not pull selection down
      // into footer text when a faint old value exists above it.
      .sort((a, b) => a.cluster.top - b.cluster.top || b.cluster.score - a.cluster.score)
      .slice(0, 6);
    return { region, cell, headerBottom, candidates };
  });

  const selected = new Array(regions.length).fill(null);
  if (regions.length === 2 && searches.every((search) => search.candidates.length)) {
    let bestPair = null;
    for (const leftCandidate of searches[0].candidates) {
      for (const rightCandidate of searches[1].candidates) {
        const leftCenterY = (leftCandidate.bbox.y0 + leftCandidate.bbox.y1) / 2;
        const rightCenterY = (rightCandidate.bbox.y0 + rightCandidate.bbox.y1) / 2;
        const drift = Math.abs(leftCenterY - rightCenterY);
        if (drift > rowTolerance) continue;
        const firstBandDistance =
          leftCandidate.cluster.top - searches[0].headerBottom +
          rightCandidate.cluster.top - searches[1].headerBottom;
        const score = firstBandDistance + drift * 4;
        if (!bestPair || score < bestPair.score) {
          bestPair = { leftCandidate, rightCandidate, score };
        }
      }
    }
    if (bestPair) {
      selected[0] = bestPair.leftCandidate;
      selected[1] = bestPair.rightCandidate;
    }
  }

  // A single-field label needs only its first owned ink band. For a proven
  // two-field schema, one visible sibling can establish the row of a faint or
  // blank cell, but x remains independently clipped to that target cell.
  if (regions.length === 1) {
    selected[0] = searches[0].candidates[0] || null;
  } else if (regions.length === 2 && !selected[0] && !selected[1]) {
    const sourceIndex = searches[0].candidates.length ? 0 :
      searches[1].candidates.length ? 1 : -1;
    if (sourceIndex >= 0) {
      selected[sourceIndex] = searches[sourceIndex].candidates[0];
      const targetIndex = sourceIndex === 0 ? 1 : 0;
      const sourceBbox = selected[sourceIndex].bbox;
      const sourceCell = searches[sourceIndex].cell;
      const targetCell = searches[targetIndex].cell;
      if (sourceCell && targetCell) {
        const width = Math.min(
          sourceBbox.x1 - sourceBbox.x0,
          Math.max(6, targetCell.right - targetCell.left - 4)
        );
        const relativeLeft = Math.max(2, sourceBbox.x0 - sourceCell.left);
        const x0 = Math.min(
          targetCell.right - width - 2,
          targetCell.left + relativeLeft
        );
        selected[targetIndex] = {
          bbox: {
            x0: Math.max(targetCell.left + 2, x0),
            y0: sourceBbox.y0,
            x1: Math.min(targetCell.right - 2, Math.max(targetCell.left + 2, x0) + width),
            y1: sourceBbox.y1,
          },
          inheritedRow: true,
        };
      }
    }
  }

  return regions.map((region, index) => {
    const localized = selected[index];
    if (!localized?.bbox) return region;
    if (region.ocrInkLocalized) {
      const existingHeight = region.bbox.y1 - region.bbox.y0;
      const localizedHeight = localized.bbox.y1 - localized.bbox.y0;
      const coversOcrRow = localized.bbox.y0 <= region.bbox.y0 + 2 &&
        localized.bbox.y1 >= region.bbox.y1 - 2;
      // On a perspective-skewed word, horizontal row scanning can isolate
      // only the lower strokes. Never replace a complete exact OCR glyph box
      // with that smaller fragment.
      if (!coversOcrRow && localizedHeight < existingHeight * 0.85) return region;
    }
    return {
      ...region,
      bbox: { ...localized.bbox },
      inkLocalized: !localized.inheritedRow,
      rowLocalizedFromSibling: Boolean(localized.inheritedRow),
    };
  });
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
  // The value baseline can begin only 6-10px below the header separator on
  // downscaled phone images. A 2% page-height minimum skipped that real row
  // and selected the footer hundreds of pixels below it.
  const minimumValueGap = Math.max(5, info.height * 0.007);
  const clusterSets = cells.map((cell) =>
    findInkClusters(data, info, cell, headerBottom).filter((cluster) =>
      cluster.top - headerBottom >= minimumValueGap
    )
  );

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
      // Header glyphs are inset from their physical cells. Include the normal
      // left padding so stale leading digits from an earlier bad edit are
      // also inside the cleanup mask; rule detection still protects borders.
      cellBounds: {
        // Physical ruled-cell interiors are the hard edit boundary. Extending
        // ACTUAL left into BOXES & DIMENSION allowed a same-row dimension or
        // stale failed edit to be erased and replaced as weight text.
        x0: Math.max(0, cells[index].left),
        x1: cells[index].right,
      },
      originalText: matchingWord ? matchingWord.text.trim().replace(',', '.') : '',
      anchorText: index === 0 ? 'structural ACTUAL WEIGHT' : 'structural CHARGED WEIGHT',
      kind,
    };
  });
}

function findVerticalLineTop(data, info, x, yMin, yMax, darkLimit = 185) {
  const rows = [];
  for (let y = yMin; y < yMax; y += 1) {
    let dark = false;
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = x + dx;
      if (px < 0 || px >= info.width) continue;
      if (data[y * info.width + px] < darkLimit) {
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
  const darkLimit = searchBand.darkLimit ?? 175;

  for (const column of columns) {
    const width = column.right - column.left;
    const x0 = Math.max(0, Math.round(column.left + width * 0.08));
    const x1 = Math.min(info.width, Math.round(column.right - width * 0.08));
    if (x1 <= x0) continue;

    const rows = [];
    for (let y = yMin; y < yMax; y += 1) {
      let count = 0;
      for (let x = x0; x < x1; x += 1) {
        if (data[y * info.width + x] < darkLimit) count += 1;
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
  if (xs.length < 3) return [];

  // Extremely faint single-ACTUAL scans may expose only the three long rules
  // around ACTUAL and SAID TO CONTAIN; the outer BOXES boundary is at/cropped
  // by the page edge. In that specific Delhivery geometry, the first interior
  // cell is ACTUAL and the second is the product cell. Return only ACTUAL.
  if (xs.length === 3) {
    const firstWidth = xs[1] - xs[0];
    const secondWidth = xs[2] - xs[1];
    const firstXRatio = xs[0] / imageWidth;
    const plausibleWidth = firstWidth >= imageWidth * 0.055 && firstWidth <= imageWidth * 0.19;
    const neighbourRatio = secondWidth / Math.max(1, firstWidth);
    if (firstXRatio >= 0.16 && firstXRatio <= 0.32 && plausibleWidth &&
        neighbourRatio >= 0.55 && neighbourRatio <= 1.25) {
      return [{ left: xs[0], right: xs[1] }];
    }
    return [];
  }

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

  const strongestScore = Math.max(...sortedBorders.map((border) => border.score));
  const strongXs = sortedBorders
    .filter((border) => border.score >= strongestScore * 0.45)
    .map((border) => border.x);

  for (let i = 0; i < strongXs.length - 2; i += 1) {
    const width = strongXs[i + 1] - strongXs[i];
    const nextWidth = strongXs[i + 2] - strongXs[i + 1];
    const beforeWidth = i > 0 ? strongXs[i] - strongXs[i - 1] : 0;
    const afterWidth = i + 3 < strongXs.length ? strongXs[i + 3] - strongXs[i + 2] : 0;
    if (
      width >= minCellWidth && width <= maxCellWidth &&
      nextWidth >= minCellWidth && nextWidth <= maxCellWidth &&
      nextWidth / width >= 0.65 && nextWidth / width <= 1.35 &&
      (beforeWidth >= Math.max(width, nextWidth) * 1.35 ||
        (afterWidth > 0 && afterWidth <= Math.max(width, nextWidth) * 0.9))
    ) {
      return [
        { left: strongXs[i], right: strongXs[i + 1] },
        { left: strongXs[i + 1], right: strongXs[i + 2] },
      ];
    }
  }

  // For single ACTUAL WEIGHT templates, suppress weaker internal text strokes
  // and use the first strong 80-180px cell before the SAID TO CONTAIN column.
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
  const bandSamples = [];
  for (let y = yMin; y < yMax; y += 3) {
    for (let x = xMin; x < xMax; x += 3) bandSamples.push(data[y * info.width + x]);
  }
  const localPaper = percentileNumber(bandSamples, 0.75) || 255;
  // Fixed 175/185 thresholds classify blue/gray paper itself as a rule. Use
  // contrast relative to this label's local paper, capped at the old value
  // for normal white scans.
  const tableDarkLimit = Math.min(185, localPaper - Math.max(8, localPaper * 0.05));

  const scoredXs = [];
  for (let x = xMin; x < xMax; x += 1) {
    let count = 0;
    let bestRun = 0;
    let run = 0;
    for (let y = yMin; y < yMax; y += 1) {
      if (data[y * info.width + x] < tableDarkLimit) {
        count += 1;
        run += 1;
      } else {
        if (run > bestRun) bestRun = run;
        run = 0;
      }
    }
    if (run > bestRun) bestRun = run;
    const score = Math.max(count, bestRun * 3);
    if (count >= bandHeight * 0.035 || bestRun >= bandHeight * 0.035) {
      scoredXs.push({ x, score, count, bestRun });
    }
  }

  const borders = groupAdjacentXs(scoredXs)
    .filter((border) => border.score >= Math.max(24, bandHeight * 0.08))
    .sort((a, b) => a.x - b.x);
  let columns = pickWeightColumnBorders(borders, info.width);
  if (!columns.length && !weightAnchors.length) {
    // On very low-contrast phone photos, text strokes can bridge the grouped
    // x-candidates and hide otherwise strong vertical rules. Recover only the
    // known single-ACTUAL geometry: one strong interior rule in the 16-32%
    // band and one similarly strong rule 5.5-19% of page width to its right.
    // The bounded right search excludes the farther SAID TO CONTAIN edge.
    const minimumRuleScore = Math.max(30, bandHeight * 0.4);
    const leftRule = scoredXs
      .filter((entry) => entry.x >= info.width * 0.16 && entry.x <= info.width * 0.32)
      .filter((entry) => entry.score >= minimumRuleScore)
      .sort((a, b) => b.score - a.score)[0];
    const rightRule = leftRule ? scoredXs
      .filter((entry) => entry.x >= leftRule.x + info.width * 0.055)
      .filter((entry) => entry.x <= leftRule.x + info.width * 0.19)
      .filter((entry) => entry.score >= minimumRuleScore)
      .sort((a, b) => b.score - a.score)[0] : null;
    if (leftRule && rightRule && rightRule.x - leftRule.x >= info.width * 0.055) {
      columns = [{ left: leftRule.x, right: rightRule.x }];
    }
  }
  if (!columns.length) return [];

  const valueTextBand = findValueTextBand(data, info, columns, {
    yMin,
    yMax,
    darkLimit: tableDarkLimit,
  });
  const lineTops = columns
    .flatMap((column) => [column.left, column.right])
    .map((x) => findVerticalLineTop(data, info, x, yMin, yMax, tableDarkLimit))
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
    const cellLeft = Math.max(0, Math.round(column.left));
    return {
      bbox: { x0, y0, x1, y1 },
      cellBounds: { x0: cellLeft, x1: column.right },
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

  if (/weight|weigh|charg|actual|ctual/.test(targetText)) return true;

  // Equal-width adjacent table rules are already required by the caller.
  // A damaged but clearly printed alphabetic header (for example CHARGED
  // recognized as "Tar") is enough additional evidence, provided it was not
  // identified above as SAID TO CONTAIN/product text.
  return targetHeaderWords.some((word) =>
    String(word.text || '').replace(/[^a-z]/gi, '').length >= 3
  );
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
  const targetLeft = direction > 0 ? currentRight : previousLeft;
  const targetRight = direction > 0 ? nextRight : currentLeft;
  return [{
    bbox,
    cellBounds: { x0: targetLeft, x1: targetRight },
    originalText: '',
    anchorText: `inferred ${targetKind.toUpperCase()} WEIGHT from table rules`,
    kind: targetKind,
  }];
}

async function inferSingleWeightRegionFromAnchor(imageInput, anchors, words, meta) {
  const candidates = anchors
    .filter((anchor) => {
      const centerX = (anchor.bbox.x0 + anchor.bbox.x1) / 2;
      const centerY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
      return centerX < meta.width * 0.62 &&
        centerY > meta.height * 0.2 && centerY < meta.height * 0.68;
    })
    .sort((a, b) => a.bbox.y0 - b.bbox.y0);
  if (!candidates.length) return [];
  const anchor = candidates[0];
  const { data, info } = await sharp(imageInput).greyscale().raw().toBuffer({ resolveWithObject: true });
  const centerX = (anchor.bbox.x0 + anchor.bbox.x1) / 2;
  const top = Math.max(0, Math.floor(anchor.bbox.y0 - info.height * 0.025));
  const bottom = Math.min(info.height, Math.ceil(anchor.bbox.y1 + info.height * 0.22));
  const searchLeft = Math.max(0, Math.floor(anchor.bbox.x0 - info.width * 0.16));
  const searchRight = Math.min(info.width - 1, Math.ceil(anchor.bbox.x1 + info.width * 0.16));
  const bandHeight = Math.max(1, bottom - top);
  const xs = [];
  for (let x = searchLeft; x <= searchRight; x += 1) {
    let longestRun = 0;
    let run = 0;
    for (let y = top; y < bottom; y += 1) {
      if (data[y * info.width + x] < 180) {
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else {
        run = 0;
      }
    }
    if (longestRun >= bandHeight * 0.42) xs.push({ x, score: longestRun });
  }
  const borders = groupAdjacentXs(xs).sort((a, b) => a.x - b.x);
  let leftBorder = borders.filter((border) => border.x < centerX).at(-1);
  let rightBorder = borders.find((border) => border.x > centerX);
  const anchorWidth = anchor.bbox.x1 - anchor.bbox.x0;
  const boundariesLookInset = leftBorder &&
    anchor.bbox.x0 - leftBorder.x < anchorWidth * 0.2;
  if (!leftBorder || !rightBorder || boundariesLookInset) {
    // Perspective-skewed photos turn vertical rules into diagonals, so no
    // single x coordinate has a long run. The header text is still inset by a
    // stable amount; use it as a conservative cell estimate and keep the
    // existing right inset in findInkClusters away from the product column.
    leftBorder = { x: Math.max(0, anchor.bbox.x0 - anchorWidth * 0.45) };
    rightBorder = { x: Math.min(info.width, anchor.bbox.x1) };
  }
  let cellWidth = rightBorder.x - leftBorder.x;
  if (cellWidth < info.width * 0.045 || cellWidth > info.width * 0.24) {
    leftBorder = { x: Math.max(0, anchor.bbox.x0 - anchorWidth * 0.45) };
    rightBorder = { x: Math.min(info.width, anchor.bbox.x1) };
    cellWidth = rightBorder.x - leftBorder.x;
  }
  if (cellWidth < info.width * 0.045 || cellWidth > info.width * 0.24) return [];

  const clusters = findInkClusters(
    data,
    info,
    { left: leftBorder.x, right: rightBorder.x },
    anchor.bbox.y1
  );
  const minimumValueGap = Math.max(12, info.height * 0.02);
  const cluster = clusters.find((candidate) =>
    candidate.top - anchor.bbox.y1 >= minimumValueGap
  ) || null;
  const fallbackBbox = {
    x0: Math.round(leftBorder.x + cellWidth * 0.045),
    y0: Math.round(anchor.bbox.y1 + Math.max(8, info.height * 0.014)),
    x1: Math.round(leftBorder.x + cellWidth * 0.58),
    y1: Math.round(anchor.bbox.y1 + Math.max(20, info.height * 0.04)),
  };
  const bbox = cluster
    ? (bboxForInkCluster(data, info, cluster) || fallbackBbox)
    : {
        // Last-resort row for an extremely faint value beneath a positively
        // identified single ACTUAL WEIGHT header. These Delhivery templates
        // use a stable one-line header-to-value gap; the cell bounds prevent
        // this from drifting into invoice or product fields.
        ...fallbackBbox,
      };
  if (!bbox || bbox.y1 <= bbox.y0) return [];
  const matchingWord = words.find((word) => {
    const cx = (word.bbox.x0 + word.bbox.x1) / 2;
    const cy = (word.bbox.y0 + word.bbox.y1) / 2;
    return cx > leftBorder.x && cx < rightBorder.x &&
      cy >= bbox.y0 - 5 && cy <= bbox.y1 + 5 &&
      /^\d{1,6}(?:[.,]\d{1,3})?$/.test(String(word.text || '').trim());
  });
  return [{
    bbox,
    cellBounds: { x0: leftBorder.x, x1: rightBorder.x },
    originalText: matchingWord ? matchingWord.text.trim().replace(',', '.') : '',
    anchorText: 'structural ACTUAL WEIGHT',
    kind: 'actual',
  }];
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
  inferSingleWeightRegionFromAnchor,
  inferWeightRegionsFromTable,
  localizeWeightInkInCells,
};
