'use strict';

const sharp = require('sharp');

const FONT_SIZE_RATIO = 0.7; // font-size relative to bbox height
const FONT_WIDTH_PER_CHARACTER_RATIO = 0.5; // average Arial numeric glyph advance
const TEXT_LEFT_PADDING_RATIO = 0.08; // inset replacement text inside the cleared value area
const BORDER_GUARD_PX = 12; // how far inside the clear box a table rule may sit
const BORDER_OUTSIDE_PX = 6; // how far outside the clear box we look for rules
const MIN_RULE_RUN_RATIO = 1.8; // rule lines run much longer than glyph strokes
const MAX_PAGE_STYLE_REFERENCES = 40; // sibling numbers sampled per value
const PAGE_STYLE_HEIGHT_RATIO_MIN = 0.45; // ignore much smaller page text
const PAGE_STYLE_HEIGHT_RATIO_MAX = 2.4; // ignore much larger page text (e.g. barcode IDs)
const PAGE_STYLE_SIZE_DEVIATION = 0.45; // trust own ink unless it disagrees wildly
// 306601375 establishes the desired visual scale: roughly 8-12px on a
// 1024px-wide label. Scale with source resolution, never with a tall/skewed
// OCR rectangle alone.
const MAX_WEIGHT_FONT_WIDTH_RATIO = 0.012;
const DEFAULT_TEXT_STYLE = {
  fontFamily: 'Arial, Helvetica, sans-serif',
  fontWeight: 400,
  fill: 'rgb(0,0,0)',
};

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Samples a representative background color for a bounding box by
 * reading a thin strip of pixels directly above it (assumed to still be
 * background, not glyph ink) and taking the median per channel. Falls
 * back to white if the sample region is degenerate (e.g. bbox at the
 * very top of the image).
 */
async function sampleBackgroundColor(image, meta, bbox) {
  const stripHeight = Math.max(2, Math.round((bbox.y1 - bbox.y0) * 0.25));
  const top = Math.max(0, Math.round(bbox.y0 - stripHeight - 2));
  const left = Math.max(0, Math.round(bbox.x0));
  const width = Math.min(meta.width - left, Math.max(1, Math.round(bbox.x1 - bbox.x0)));
  const height = Math.min(meta.height - top, stripHeight);

  if (width <= 0 || height <= 0) return { r: 255, g: 255, b: 255 };

  try {
    const { data, info } = await image
      .clone()
      .extract({ left, top, width, height })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const pixels = [];
    for (let i = 0; i < data.length; i += channels) {
      const pixel = { r: data[i], g: data[i + 1], b: data[i + 2] };
      pixel.luma = luminance(pixel);
      pixels.push(pixel);
    }
    // A horizontal table rule can cross the sample strip above the value.
    // Drop the darkest 40% of pixels before taking the median so line ink
    // cannot tint the background used to repaint the cleared cell.
    const cutoff = percentile(pixels.map((pixel) => pixel.luma), 0.4);
    const lightPixels = pixels.filter((pixel) => pixel.luma >= cutoff);
    return {
      r: medianChannel(lightPixels, 'r'),
      g: medianChannel(lightPixels, 'g'),
      b: medianChannel(lightPixels, 'b'),
    };
  } catch (err) {
    return { r: 255, g: 255, b: 255 };
  }
}

async function sampleLocalPaperColor(image, meta, bbox) {
  const boxWidth = bbox.x1 - bbox.x0;
  const boxHeight = bbox.y1 - bbox.y0;
  const paddingX = Math.max(4, Math.round(boxWidth * 0.35));
  const paddingY = Math.max(3, Math.round(boxHeight));
  const left = Math.max(0, Math.floor(bbox.x0 - paddingX));
  const top = Math.max(0, Math.floor(bbox.y0 - paddingY));
  const right = Math.min(meta.width, Math.ceil(bbox.x1 + paddingX));
  const bottom = Math.min(meta.height, Math.ceil(bbox.y1 + paddingY));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return { r: 255, g: 255, b: 255 };

  try {
    const { data, info } = await image
      .clone()
      .extract({ left, top, width, height })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = [];
    for (let i = 0; i < data.length; i += info.channels) {
      const pixel = { r: data[i], g: data[i + 1], b: data[i + 2] };
      pixel.luma = luminance(pixel);
      pixels.push(pixel);
    }

    // Keep the lighter half of the neighbourhood so glyphs and table rules
    // cannot darken the fill, while preserving the local paper/shadow color.
    const paperCutoff = percentile(pixels.map((pixel) => pixel.luma), 0.5);
    const paperPixels = pixels.filter((pixel) => pixel.luma >= paperCutoff);
    return {
      r: medianChannel(paperPixels, 'r'),
      g: medianChannel(paperPixels, 'g'),
      b: medianChannel(paperPixels, 'b'),
    };
  } catch (err) {
    return sampleBackgroundColor(image, meta, bbox);
  }
}

function rgbToCss({ r, g, b }) {
  return `rgb(${r},${g},${b})`;
}

function luminance({ r, g, b }) {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function medianChannel(pixels, channel) {
  return Math.round(percentile(pixels.map((pixel) => pixel[channel]), 0.5));
}

async function samplePaperInsideBbox(image, meta, bbox) {
  const left = Math.max(0, Math.floor(bbox.x0));
  const top = Math.max(0, Math.floor(bbox.y0));
  const width = Math.min(meta.width - left, Math.max(1, Math.ceil(bbox.x1) - left));
  const height = Math.min(meta.height - top, Math.max(1, Math.ceil(bbox.y1) - top));
  if (width <= 0 || height <= 0) return sampleLocalPaperColor(image, meta, bbox);

  try {
    const { data, info } = await image
      .clone()
      .extract({ left, top, width, height })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = [];
    for (let i = 0; i < data.length; i += info.channels) {
      const pixel = { r: data[i], g: data[i + 1], b: data[i + 2] };
      pixel.luma = luminance(pixel);
      pixels.push(pixel);
    }
    // Even a tight numeric word box is mostly paper between/inside glyphs.
    // Its lightest 35% is the best possible match for the exact local scan
    // tint and avoids a rectangular warm/cool patch on blue or gray paper.
    const lumas = pixels.map((pixel) => pixel.luma);
    const lowerPaper = percentile(lumas, 0.35);
    const upperPaper = percentile(lumas, 0.8);
    // Use the middle paper cluster, not the brightest tail. Selecting only
    // bright pixels biased blue/gray photos several levels toward white and
    // made the restored word box visible even when its texture was correct.
    const paperPixels = pixels.filter(
      (pixel) => pixel.luma >= lowerPaper && pixel.luma <= upperPaper
    );
    const insidePaper = {
      r: medianChannel(paperPixels, 'r'),
      g: medianChannel(paperPixels, 'g'),
      b: medianChannel(paperPixels, 'b'),
    };
    const surroundingPaper = await sampleLocalPaperColor(image, meta, bbox);
    // Truncated OCR can occasionally describe only a solid glyph stroke, so
    // there is no paper inside the box. Detect that case instead of sampling
    // the black stroke as the background color.
    return luminance(insidePaper) < luminance(surroundingPaper) - 14
      ? surroundingPaper
      : insidePaper;
  } catch (err) {
    return sampleLocalPaperColor(image, meta, bbox);
  }
}

function medianNumber(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function mostCommon(values, fallback) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function mergeUniformTextStyle(styles) {
  const usable = styles.filter(Boolean);
  if (!usable.length) return null;
  if (usable.length === 1) return { ...usable[0] };

  const fillRgbs = usable.map((style) => style.fillRgb).filter(Boolean);
  const fillRgb = fillRgbs.length
    ? {
        r: medianChannel(fillRgbs, 'r'),
        g: medianChannel(fillRgbs, 'g'),
        b: medianChannel(fillRgbs, 'b'),
      }
    : { r: 0, g: 0, b: 0 };

  return {
    fontFamily: mostCommon(
      usable.map((style) => style.fontFamily),
      DEFAULT_TEXT_STYLE.fontFamily
    ),
    fontWeight: mostCommon(
      usable.map((style) => style.fontWeight || 400),
      400
    ),
    fontSize: Math.max(8, medianNumber(usable.map((style) => style.fontSize).filter(Boolean))),
    fillRgb,
    fillLuma: luminance(fillRgb),
    fill: rgbToCss(fillRgb),
  };
}

async function createSelectiveEraseOverlay(
  image,
  meta,
  gray,
  grayInfo,
  rect,
  bg,
  protectOnlyEdgeRules = false,
  protectRules = true,
  eraseAllInterior = false
) {
  const width = rect.right - rect.x;
  const height = rect.bottom - rect.y;
  if (width <= 0 || height <= 0) return null;

  const bgLuma = luminance(bg);
  // Low-quality blue/gray scans often have only 6-10 luma points between the
  // old printed value and paper. The former 8% threshold left those pixels
  // behind as a visible stale value underneath the replacement.
  const ruleDarkLimit = Math.min(150, Math.max(50, Math.round(bgLuma * 0.58)));

  const scanTop = Math.max(0, rect.y - height);
  const scanBottom = Math.min(grayInfo.height - 1, rect.bottom + height);
  const minVerticalRun = Math.max(8, Math.round(height * MIN_RULE_RUN_RATIO));
  const verticalRuleCols = new Set();
  for (let col = rect.x; col < rect.right; col += 1) {
    let best = 0;
    let run = 0;
    let darkCount = 0;
    for (let row = scanTop; row <= scanBottom; row += 1) {
      if (gray[row * grayInfo.width + col] < ruleDarkLimit) {
        run += 1;
        darkCount += 1;
      }
      else run = 0;
      if (run > best) best = run;
    }
    const scanLength = scanBottom - scanTop + 1;
    if (best >= minVerticalRun || darkCount >= scanLength * 0.45) verticalRuleCols.add(col);
  }

  const scanLeft = Math.max(0, rect.x - width);
  const scanRight = Math.min(grayInfo.width - 1, rect.right + width);
  const minHorizontalRun = Math.max(8, Math.round(width * MIN_RULE_RUN_RATIO));
  const horizontalRuleRows = new Set();
  for (let row = rect.y; row < rect.bottom; row += 1) {
    let best = 0;
    let run = 0;
    let darkCount = 0;
    for (let col = scanLeft; col <= scanRight; col += 1) {
      if (gray[row * grayInfo.width + col] < ruleDarkLimit) {
        run += 1;
        darkCount += 1;
      }
      else run = 0;
      if (run > best) best = run;
    }
    const scanLength = scanRight - scanLeft + 1;
    if (best >= minHorizontalRun || darkCount >= scanLength * 0.65) horizontalRuleRows.add(row);
  }

  // Phone photos turn nominally vertical cell borders into diagonal or bowed
  // strokes. No single x column then contains a long enough run for the check
  // above, even though the stroke is plainly one continuous table rule. Trace
  // connected dark components through the extended value-row window and keep
  // components spanning many rows. Glyph strokes remain too short to qualify.
  const slantedVerticalRulePixels = new Set();
  const componentLeft = Math.max(0, rect.x - BORDER_OUTSIDE_PX);
  const componentRight = Math.min(grayInfo.width - 1, rect.right + BORDER_OUTSIDE_PX);
  const componentWidth = componentRight - componentLeft + 1;
  const componentHeight = scanBottom - scanTop + 1;
  const componentVisited = new Uint8Array(componentWidth * componentHeight);
  const traceDarkLimit = Math.min(210, Math.max(ruleDarkLimit, Math.round(bgLuma * 0.82)));
  const componentIndex = (x, y) => (y - scanTop) * componentWidth + (x - componentLeft);

  for (let startY = scanTop; startY <= scanBottom; startY += 1) {
    for (let startX = componentLeft; startX <= componentRight; startX += 1) {
      const startIndex = componentIndex(startX, startY);
      if (componentVisited[startIndex] || gray[startY * grayInfo.width + startX] >= traceDarkLimit) {
        continue;
      }

      const stack = [{ x: startX, y: startY }];
      const component = [];
      componentVisited[startIndex] = 1;
      let minX = startX;
      let maxX = startX;
      let minY = startY;
      let maxY = startY;
      const occupiedRows = new Set();
      while (stack.length) {
        const pixel = stack.pop();
        component.push(pixel);
        minX = Math.min(minX, pixel.x);
        maxX = Math.max(maxX, pixel.x);
        minY = Math.min(minY, pixel.y);
        maxY = Math.max(maxY, pixel.y);
        occupiedRows.add(pixel.y);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const x = pixel.x + dx;
            const y = pixel.y + dy;
            if (x < componentLeft || x > componentRight || y < scanTop || y > scanBottom) continue;
            const index = componentIndex(x, y);
            if (componentVisited[index] || gray[y * grayInfo.width + x] >= traceDarkLimit) continue;
            componentVisited[index] = 1;
            stack.push({ x, y });
          }
        }
      }

      const verticalSpan = maxY - minY + 1;
      const horizontalSpan = maxX - minX + 1;
      const narrowRuleWidth = Math.max(6, verticalSpan * 0.35);
      if (verticalSpan < minVerticalRun ||
          occupiedRows.size < verticalSpan * 0.72 ||
          horizontalSpan > narrowRuleWidth) continue;
      for (const pixel of component) {
        slantedVerticalRulePixels.add(pixel.y * grayInfo.width + pixel.x);
      }
    }
  }

  const protectedPixelCache = new Map();
  const isProtectedRulePixel = (imageX, imageY) => {
    const key = imageY * grayInfo.width + imageX;
    if (protectedPixelCache.has(key)) return protectedPixelCache.get(key);
    if (slantedVerticalRulePixels.has(key)) {
      protectedPixelCache.set(key, true);
      return true;
    }
    if (gray[key] >= ruleDarkLimit) {
      protectedPixelCache.set(key, false);
      return false;
    }
    let protectedPixel = false;
    if (verticalRuleCols.has(imageX)) {
      let run = 1;
      for (let y = imageY - 1; y >= scanTop && gray[y * grayInfo.width + imageX] < ruleDarkLimit; y -= 1) run += 1;
      for (let y = imageY + 1; y <= scanBottom && gray[y * grayInfo.width + imageX] < ruleDarkLimit; y += 1) run += 1;
      protectedPixel = run >= minVerticalRun;
    }
    if (!protectedPixel && horizontalRuleRows.has(imageY)) {
      let run = 1;
      for (let x = imageX - 1; x >= scanLeft && gray[imageY * grayInfo.width + x] < ruleDarkLimit; x -= 1) run += 1;
      for (let x = imageX + 1; x <= scanRight && gray[imageY * grayInfo.width + x] < ruleDarkLimit; x += 1) run += 1;
      protectedPixel = run >= minHorizontalRun;
    }
    protectedPixelCache.set(key, protectedPixel);
    return protectedPixel;
  };
  const edgeRuleGuard = Math.max(3, Math.min(6, Math.round(width * 0.06)));
  const shouldProtectRulePixel = (imageX, imageY) => {
    if (!protectRules || !isProtectedRulePixel(imageX, imageY)) return false;
    const key = imageY * grayInfo.width + imageX;
    // Narrow connected components spanning the full row window are genuine
    // perspective/slanted rules. For an exact, cell-confined glyph box,
    // however, upright digit strokes (especially "4") can satisfy the same
    // component test. Forced interior cleanup therefore protects these
    // components only at the clear rectangle's geometric edges; the cell
    // boundary remains safe while interior old digits are erased.
    if (slantedVerticalRulePixels.has(key)) {
      if (eraseAllInterior && protectOnlyEdgeRules) {
        return imageX <= rect.x + 1 || imageX >= rect.right - 2;
      }
      return true;
    }
    // Horizontal separators must remain protected across the full clear box.
    // Vertical/slanted components are protected only at geometric edges when
    // requested, so an old digit connected to a stamp or noise stroke cannot
    // masquerade as an interior table rule and survive erasure.
    if (horizontalRuleRows.has(imageY)) return true;
    return !protectOnlyEdgeRules ||
      imageX < rect.x + edgeRuleGuard || imageX >= rect.right - edgeRuleGuard;
  };

  const { data, info } = await image
    .clone()
    .extract({ left: rect.x, top: rect.y, width, height })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Copy real paper texture from the blank part of the same weight cell. A
  // flat RGB fill is visible as a white/gray strip on photographed paper even
  // when its average color is close. The area directly below a weight value is
  // blank on these POD templates and shares the same lighting gradient/noise.
  let textureData = null;
  let textureInfo = null;
  const belowTop = rect.bottom + Math.max(2, Math.round(height * 0.55));
  const aboveTop = rect.y - height - Math.max(2, Math.round(height * 0.35));
  const textureTop = belowTop + height <= meta.height
    ? belowTop
    : Math.max(0, aboveTop);
  if (textureTop + height <= meta.height) {
    try {
      const texture = await image
        .clone()
        .extract({ left: rect.x, top: textureTop, width, height })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
      textureData = texture.data;
      textureInfo = texture.info;
    } catch (err) {
      textureData = null;
    }
  }

  const overlay = Buffer.alloc(width * height * 4, 0);
  const readSourcePixel = (x, y) => {
    const offset = (y * info.width + x) * info.channels;
    return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
  };
  // Estimate paper independently on every row. A photographed blue sheet can
  // change brightness by 10+ levels across one OCR box; comparing the whole
  // box with one global colour mistakes that natural shadow for printed ink.
  const rowPaperLumas = Array.from({ length: height }, (_, y) => {
    const lumas = [];
    for (let x = 0; x < width; x += 1) lumas.push(luminance(readSourcePixel(x, y)));
    return percentile(lumas, 0.72);
  });
  const sameRowPaper = (x, y) => {
    let left = null;
    let right = null;
    const rowPaperLuma = rowPaperLumas[y];
    if (rowPaperLuma < bgLuma - Math.max(8, bgLuma * 0.05)) return null;
    const cleanLimit = rowPaperLuma - Math.max(2, rowPaperLuma * 0.015);
    const maxSearch = Math.max(width, 160);
    for (let distance = 1; distance <= maxSearch; distance += 1) {
      if (!left && x - distance >= 0) {
        const candidate = readSourcePixel(x - distance, y);
        if (luminance(candidate) >= cleanLimit) left = { pixel: candidate, distance };
      }
      if (!right && x + distance < width) {
        const candidate = readSourcePixel(x + distance, y);
        if (luminance(candidate) >= cleanLimit) right = { pixel: candidate, distance };
      }
      if (left && right) break;
    }
    if (left && right) {
      const total = left.distance + right.distance;
      return {
        r: Math.round((left.pixel.r * right.distance + right.pixel.r * left.distance) / total),
        g: Math.round((left.pixel.g * right.distance + right.pixel.g * left.distance) / total),
        b: Math.round((left.pixel.b * right.distance + right.pixel.b * left.distance) / total),
      };
    }
    return left?.pixel || right?.pixel || null;
  };
  let erasedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const imageY = rect.y + y;
    for (let x = 0; x < width; x += 1) {
      const imageX = rect.x + x;
      if (shouldProtectRulePixel(imageX, imageY)) continue;

      const sourceOffset = (y * info.width + x) * info.channels;
      const pixel = {
        r: data[sourceOffset],
        g: data[sourceOffset + 1],
        b: data[sourceOffset + 2],
      };
      const pixelLuma = luminance(pixel);
      // Interpolate paper from this exact image row first. This follows camera
      // shadows and blue/gray lighting without producing a rectangular band.
      // A nearby vertical texture patch remains the fallback for a fully inked
      // row where no clean paper pixel exists on either side of the glyph.
      let replacement = sameRowPaper(x, y) || bg;
      if (replacement === bg && textureData && textureInfo) {
        const textureOffset = (y * textureInfo.width + x) * textureInfo.channels;
        const candidate = {
          r: textureData[textureOffset],
          g: textureData[textureOffset + 1],
          b: textureData[textureOffset + 2],
        };
        // Do not copy an unrelated dust speck or rule into the erased glyph.
        if (luminance(candidate) >= bgLuma - 22) replacement = candidate;
      }
      const localPaperLuma = luminance(replacement);
      const darkness = localPaperLuma - pixelLuma;
      const localInkThreshold = Math.max(2, localPaperLuma * 0.018);
      const isOldInk = eraseAllInterior || darkness >= localInkThreshold;
      if (!isOldInk) continue;

      const overlayOffset = (y * width + x) * 4;
      overlay[overlayOffset] = replacement.r;
      overlay[overlayOffset + 1] = replacement.g;
      overlay[overlayOffset + 2] = replacement.b;
      // Once a pixel is positively classified as old ink, replace it fully.
      // Partial alpha left faint duplicate numerals visible on pale scans.
      overlay[overlayOffset + 3] = 255;
      erasedPixels += 1;
    }
  }

  // Secondary residual sweep: faint fragments of the old weight value can
  // survive the primary pass on degraded scans. After the main erase, scan
  // the clear rectangle once more with a lower luma threshold and remove any
  // remaining dark pixels that are not table rules.
  if (erasedPixels > 0) {
    const residualLimit = Math.max(1, bgLuma * 0.01);
    for (let y = 0; y < height; y += 1) {
      const imageY = rect.y + y;
      for (let x = 0; x < width; x += 1) {
        const imageX = rect.x + x;
        if (shouldProtectRulePixel(imageX, imageY)) continue;

        const sourceOffset = (y * info.width + x) * info.channels;
        const pixelLuma = luminance({
          r: data[sourceOffset],
          g: data[sourceOffset + 1],
          b: data[sourceOffset + 2],
        });
        if (bgLuma - pixelLuma < residualLimit) continue;

        const overlayOffset = (y * width + x) * 4;
        if (overlay[overlayOffset + 3] === 0) {
          let replacement = sameRowPaper(x, y) || bg;
          if (replacement === bg && textureData && textureInfo) {
            const textureOffset = (y * textureInfo.width + x) * textureInfo.channels;
            const candidate = {
              r: textureData[textureOffset],
              g: textureData[textureOffset + 1],
              b: textureData[textureOffset + 2],
            };
            if (luminance(candidate) >= bgLuma - 22) replacement = candidate;
          }
          overlay[overlayOffset] = replacement.r;
          overlay[overlayOffset + 1] = replacement.g;
          overlay[overlayOffset + 2] = replacement.b;
          overlay[overlayOffset + 3] = 255;
        }
      }
    }
  }

  // Tertiary global sweep: catch any remaining dark fragments that were
  // missed by both the primary and residual passes. This uses a very low
  // threshold and only operates on pixels that are still un-erased.
  if (erasedPixels > 0) {
    const globalLimit = Math.max(1, bgLuma * 0.008);
    for (let y = 0; y < height; y += 1) {
      const imageY = rect.y + y;
      for (let x = 0; x < width; x += 1) {
        const imageX = rect.x + x;
        if (shouldProtectRulePixel(imageX, imageY)) continue;

        const sourceOffset = (y * info.width + x) * info.channels;
        const pixelLuma = luminance({
          r: data[sourceOffset],
          g: data[sourceOffset + 1],
          b: data[sourceOffset + 2],
        });
        if (bgLuma - pixelLuma < globalLimit) continue;

        const overlayOffset = (y * width + x) * 4;
        if (overlay[overlayOffset + 3] === 0) {
          overlay[overlayOffset] = bg.r;
          overlay[overlayOffset + 1] = bg.g;
          overlay[overlayOffset + 2] = bg.b;
          overlay[overlayOffset + 3] = 255;
        }
      }
    }
  }

  // Anti-aliased and motion-blurred glyph edges can be nearly the same luma
  // as photographed paper, so threshold passes alone may leave a one-pixel
  // ghost of the old number. Expand the proven ink mask by one pixel and
  // inpaint that halo with the same row-adaptive paper estimate. The tight
  // value-row rectangle and explicit rule masks keep this away from borders.
  if (erasedPixels > 0) {
    const seeds = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (overlay[(y * width + x) * 4 + 3] > 0) seeds.push({ x, y });
      }
    }
    for (const seed of seeds) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = seed.x + dx;
          const y = seed.y + dy;
          if (x < 0 || x >= width || y < 0 || y >= height) continue;
          const imageX = rect.x + x;
          const imageY = rect.y + y;
          if (shouldProtectRulePixel(imageX, imageY)) continue;
          const overlayOffset = (y * width + x) * 4;
          if (overlay[overlayOffset + 3] > 0) continue;
          const replacement = sameRowPaper(x, y) || bg;
          overlay[overlayOffset] = replacement.r;
          overlay[overlayOffset + 1] = replacement.g;
          overlay[overlayOffset + 2] = replacement.b;
          overlay[overlayOffset + 3] = 235;
        }
      }
    }
  }

  if (!erasedPixels) return null;

  return {
    input: await sharp(overlay, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    left: rect.x,
    top: rect.y,
  };
}

/**
 * Tracks the original left table rule near a worker-provided cell boundary and
 * returns a narrow source-pixel overlay. The overlay is composited last, so a
 * faint, slanted, or partly missed rule cannot be damaged by erase halos or
 * replacement text. Dynamic programming follows the darkest continuous path;
 * short digit strokes cannot satisfy the required row support.
 */
async function createVerticalRuleRestoreOverlay(image, meta, gray, grayInfo, request) {
  const hintX = Number(request?.x);
  const valueTop = Number(request?.y0);
  const valueBottom = Number(request?.y1);
  if (![hintX, valueTop, valueBottom].every(Number.isFinite) || valueBottom <= valueTop) {
    return null;
  }

  const valueHeight = Math.max(4, valueBottom - valueTop);
  const verticalMargin = Math.max(12, Math.min(48, Math.round(valueHeight * 2)));
  const scanTop = Math.max(0, Math.floor(valueTop - verticalMargin));
  const scanBottom = Math.min(grayInfo.height, Math.ceil(valueBottom + verticalMargin));
  const searchRadius = Math.max(10, Math.min(28, Math.round(meta.width * 0.018)));
  const scanLeft = Math.max(0, Math.floor(hintX - searchRadius));
  const scanRight = Math.min(grayInfo.width - 1, Math.ceil(hintX + searchRadius));
  const candidateWidth = scanRight - scanLeft + 1;
  const rowCount = scanBottom - scanTop;
  if (candidateWidth < 3 || rowCount < 8) return null;

  const rowPapers = new Float64Array(rowCount);
  const predecessors = Array.from({ length: rowCount }, () => {
    const row = new Int16Array(candidateWidth);
    row.fill(-1);
    return row;
  });
  let previous = new Float64Array(candidateWidth);
  let current = new Float64Array(candidateWidth);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const imageY = scanTop + rowIndex;
    const rowLumas = [];
    for (let x = scanLeft; x <= scanRight; x += 1) {
      rowLumas.push(gray[imageY * grayInfo.width + x]);
    }
    rowPapers[rowIndex] = percentile(rowLumas, 0.75);

    for (let xIndex = 0; xIndex < candidateWidth; xIndex += 1) {
      const imageX = scanLeft + xIndex;
      const emission = gray[imageY * grayInfo.width + imageX] +
        Math.abs(imageX - hintX) * 0.12;
      if (rowIndex === 0) {
        current[xIndex] = emission;
        continue;
      }

      let bestCost = Infinity;
      let bestPrevious = -1;
      const previousStart = Math.max(0, xIndex - 2);
      const previousEnd = Math.min(candidateWidth - 1, xIndex + 2);
      for (let previousIndex = previousStart; previousIndex <= previousEnd; previousIndex += 1) {
        const transition = Math.abs(previousIndex - xIndex) * 8;
        const cost = previous[previousIndex] + transition;
        if (cost < bestCost) {
          bestCost = cost;
          bestPrevious = previousIndex;
        }
      }
      current[xIndex] = bestCost + emission;
      predecessors[rowIndex][xIndex] = bestPrevious;
    }

    const swap = previous;
    previous = current;
    current = swap;
  }

  let finalIndex = 0;
  for (let xIndex = 1; xIndex < candidateWidth; xIndex += 1) {
    if (previous[xIndex] < previous[finalIndex]) finalIndex = xIndex;
  }
  const path = new Int32Array(rowCount);
  let pathIndex = finalIndex;
  for (let rowIndex = rowCount - 1; rowIndex >= 0; rowIndex -= 1) {
    path[rowIndex] = scanLeft + pathIndex;
    if (rowIndex > 0) {
      const prior = predecessors[rowIndex][pathIndex];
      pathIndex = prior >= 0 ? prior : pathIndex;
    }
  }

  let supportedRows = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const imageY = scanTop + rowIndex;
    const pathLuma = gray[imageY * grayInfo.width + path[rowIndex]];
    const minimumContrast = Math.max(8, rowPapers[rowIndex] * 0.045);
    if (rowPapers[rowIndex] - pathLuma >= minimumContrast) supportedRows += 1;
  }
  if (supportedRows < Math.max(10, rowCount * 0.35)) return null;

  const bandRadius = Math.max(1, Math.min(2, Math.round(valueHeight * 0.08)));
  const cropLeft = Math.max(0, Math.min(...path) - bandRadius);
  const cropRight = Math.min(grayInfo.width - 1, Math.max(...path) + bandRadius);
  const cropWidth = cropRight - cropLeft + 1;
  const { data: source, info: sourceInfo } = await image
    .clone()
    .extract({ left: cropLeft, top: scanTop, width: cropWidth, height: rowCount })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const overlay = Buffer.alloc(cropWidth * rowCount * 4, 0);
  let ruleXAtValue = hintX;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const imageY = scanTop + rowIndex;
    const centerX = path[rowIndex];
    if (imageY >= valueTop && imageY <= valueBottom) {
      ruleXAtValue = Math.max(ruleXAtValue, centerX + bandRadius);
    }
    for (let imageX = centerX - bandRadius; imageX <= centerX + bandRadius; imageX += 1) {
      if (imageX < cropLeft || imageX > cropRight) continue;
      const localX = imageX - cropLeft;
      const sourceOffset = (rowIndex * sourceInfo.width + localX) * sourceInfo.channels;
      const overlayOffset = (rowIndex * cropWidth + localX) * 4;
      overlay[overlayOffset] = source[sourceOffset];
      overlay[overlayOffset + 1] = source[sourceOffset + 1];
      overlay[overlayOffset + 2] = source[sourceOffset + 2];
      overlay[overlayOffset + 3] = 255;
    }
  }

  return {
    overlay: {
      input: await sharp(overlay, { raw: { width: cropWidth, height: rowCount, channels: 4 } })
        .png()
        .toBuffer(),
      left: cropLeft,
      top: scanTop,
    },
    ruleXAtValue,
  };
}

function estimateFontFamily(inkWidth, inkHeight, strokeThickness, originalText) {
  const characterCount = Math.max(1, String(originalText || '').length);
  const characterAspect = inkWidth / Math.max(1, inkHeight * characterCount);
  const strokeRatio = strokeThickness / Math.max(1, inkHeight);

  if (strokeRatio > 0.16 && characterAspect > 0.5) return 'Arial Black, Arial, sans-serif';
  if (characterAspect < 0.42) return 'Arial Narrow, Arial, sans-serif';
  if (characterAspect > 0.82) return 'Courier New, monospace';
  return DEFAULT_TEXT_STYLE.fontFamily;
}

function estimateStrokeThickness(inkPixels, pixelWidth, pixelHeight) {
  if (inkPixels.length < 4) return 1;

  const inkSet = new Set(inkPixels.map((p) => `${p.x},${p.y}`));
  const runs = [];

  for (const pixel of inkPixels) {
    let hRun = 1;
    for (let dx = 1; pixel.x + dx < pixelWidth; dx += 1) {
      if (inkSet.has(`${pixel.x + dx},${pixel.y}`)) hRun += 1;
      else break;
    }
    let vRun = 1;
    for (let dy = 1; pixel.y + dy < pixelHeight; dy += 1) {
      if (inkSet.has(`${pixel.x},${pixel.y + dy}`)) vRun += 1;
      else break;
    }
    if (hRun >= 2 || vRun >= 2) runs.push(Math.min(hRun, vRun));
  }

  if (!runs.length) return 1;
  const sorted = runs.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.35)] || 1;
}

function numericAdvanceUnits(text, fontFamily) {
  const isNarrow = fontFamily.startsWith('Arial Narrow');
  const isMonospace = fontFamily.startsWith('Courier New');
  if (isMonospace) return Math.max(1, String(text).length * 0.6);

  const digitWidth = isNarrow ? 0.445 : 0.556;
  const punctuationWidth = isNarrow ? 0.225 : 0.278;
  return Math.max(
    digitWidth,
    [...String(text)].reduce(
      (total, character) => total + (/\d/.test(character) ? digitWidth : punctuationWidth),
      0
    )
  );
}

/**
 * Recovers the appearance of the original numeric word from its pixels.
 * OCR boxes are often much taller than the glyphs, so the ink itself is a
 * more reliable source for font size, darkness, width and stroke weight.
 */
async function sampleTextStyle(image, meta, bbox, originalText) {
  const left = Math.max(0, Math.floor(bbox.x0));
  const top = Math.max(0, Math.floor(bbox.y0));
  const width = Math.min(meta.width - left, Math.max(1, Math.ceil(bbox.x1) - left));
  const height = Math.min(meta.height - top, Math.max(1, Math.ceil(bbox.y1) - top));

  if (width <= 0 || height <= 0) {
    return {
      ...DEFAULT_TEXT_STYLE,
      fillRgb: { r: 0, g: 0, b: 0 },
      fillLuma: 0,
      measured: false,
      fontSize: calculateFontSize(width, height, originalText),
    };
  }

  try {
    const { data, info } = await image
      .clone()
      .extract({ left, top, width, height })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = [];
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        const pixel = { x, y, r: data[offset], g: data[offset + 1], b: data[offset + 2] };
        pixel.luma = luminance(pixel);
        pixels.push(pixel);
      }
    }

    // The lightest part of the word box represents local paper even when a
    // photograph has a shadow or the paper itself is gray.
    const localBackground = percentile(pixels.map((pixel) => pixel.luma), 0.82);
    const darkestInk = percentile(pixels.map((pixel) => pixel.luma), 0.05);
    const contrastRange = Math.max(0, localBackground - darkestInk);
    const inkThreshold = Math.max(10, contrastRange * 0.24);
    const inkPixels = pixels.filter(
      (pixel) => localBackground - pixel.luma >= inkThreshold
    );

    if (inkPixels.length < 3 || contrastRange < 10) {
      return {
        ...DEFAULT_TEXT_STYLE,
        fillRgb: { r: 0, g: 0, b: 0 },
        fillLuma: 0,
        measured: false,
        fontSize: calculateFontSize(width, height, originalText),
      };
    }

    const xs = inkPixels.map((pixel) => pixel.x);
    const ys = inkPixels.map((pixel) => pixel.y);
    const inkWidth = Math.max(...xs) - Math.min(...xs) + 1;
    const inkHeight = Math.max(...ys) - Math.min(...ys) + 1;

    // Use the darkest quarter of the ink for the fill color. A plain median
    // of the "core" pixels lands on gray anti-aliased edge pixels for blurred
    // camera photos, which made replacement text look washed out next to the
    // original print. The eye matches the darkest stroke pixels, so sample
    // those and take the median per channel inside that dark cluster.
    const inkLumas = inkPixels.map((pixel) => pixel.luma);
    const coreCutoff = percentile(inkLumas, 0.25);
    const corePixels = inkPixels.filter((pixel) => pixel.luma <= coreCutoff);
    const colorPixels = corePixels.length >= 3 ? corePixels : inkPixels;
    const fillRgb = {
      r: medianChannel(colorPixels, 'r'),
      g: medianChannel(colorPixels, 'g'),
      b: medianChannel(colorPixels, 'b'),
    };
    const fill = rgbToCss(fillRgb);

    const inkArea = Math.max(1, inkWidth * inkHeight);
    const strokeDensity = inkPixels.length / inkArea;
    const strokeThickness = estimateStrokeThickness(inkPixels, info.width, info.height);
    const fontWeight = strokeDensity >= 0.22 || strokeThickness >= 2.2 ? 700 : 400;
    const fontFamily = estimateFontFamily(inkWidth, inkHeight, strokeThickness, originalText);
    const widthBasedSize = inkWidth / numericAdvanceUnits(originalText, fontFamily);
    const heightBasedSize = inkHeight / 0.85;
    const fontSize = Math.max(8, Math.min(widthBasedSize, heightBasedSize));

    return { fontFamily, fontWeight, fill, fillRgb, fillLuma: luminance(fillRgb), measured: true, fontSize };
  } catch (err) {
    return {
      ...DEFAULT_TEXT_STYLE,
      fillRgb: { r: 0, g: 0, b: 0 },
      fillLuma: 0,
      measured: false,
      fontSize: calculateFontSize(width, height, originalText),
    };
  }
}

/**
 * Shrinks a clearing rectangle so it never paints over the table's printed
 * rule lines. OCR word boxes frequently touch or swallow the vertical border
 * immediately left of a weight value (or the one right of it); repainting
 * that rectangle with background color erased the line. A rule line is
 * detected by a continuous dark run much longer than any glyph stroke in the
 * box (>1.2x the box's own size, checked over an extended scan window).
 * Only rules sitting within a small guard zone of the box edge are treated
 * as borders - anything deeper inside the box is a glyph and stays cleared.
 *
 * @param {Uint8Array} gray single-channel pixel data of the whole image
 * @param {{width:number,height:number}} grayInfo dimensions of `gray`
 * @param {{x:number,y:number,right:number,bottom:number}} rect integer clear rect
 * @param {{r:number,g:number,b:number}} bg sampled local paper color
 */
function shrinkClearRectAroundRules(gray, grayInfo, rect, bg) {
  const imgWidth = grayInfo.width;
  const imgHeight = grayInfo.height;
  const width = rect.right - rect.x;
  const height = rect.bottom - rect.y;
  if (width <= 2 || height <= 2) return rect;

  const darkLimit = Math.min(150, Math.max(50, Math.round(luminance(bg) * 0.58)));

  // Vertical rules: columns scan over an extended vertical window.
  const scanTop = Math.max(0, rect.y - height);
  const scanBottom = Math.min(imgHeight - 1, rect.bottom + height);
  const minVerticalRun = Math.max(8, Math.round(height * MIN_RULE_RUN_RATIO));
  const columnMaxRun = (col) => {
    let best = 0;
    let run = 0;
    for (let row = scanTop; row <= scanBottom; row += 1) {
      if (gray[row * imgWidth + col] < darkLimit) run += 1;
      else run = 0;
      if (run > best) best = run;
    }
    return best;
  };

  let x0 = rect.x;
  let x1 = rect.right;
  const leftProbeEnd = Math.min(rect.right - 1, rect.x + BORDER_GUARD_PX);
  for (let col = Math.max(0, rect.x - BORDER_OUTSIDE_PX); col <= leftProbeEnd; col += 1) {
    if (columnMaxRun(col) >= minVerticalRun) x0 = Math.max(x0, col + 1);
  }
  const rightProbeStart = Math.max(x0, rect.right - BORDER_GUARD_PX);
  for (let col = rightProbeStart; col <= Math.min(imgWidth - 1, rect.right + BORDER_OUTSIDE_PX); col += 1) {
    if (columnMaxRun(col) >= minVerticalRun) x1 = Math.min(x1, col);
  }

  // Horizontal rules: rows scan over an extended horizontal window.
  const currentWidth = x1 - x0;
  if (currentWidth <= 2) return { x: x0, y: rect.y, right: x1, bottom: rect.bottom };
  const scanLeft = Math.max(0, x0 - currentWidth);
  const scanRight = Math.min(imgWidth - 1, x1 + currentWidth);
  const minHorizontalRun = Math.max(8, Math.round(currentWidth * MIN_RULE_RUN_RATIO));
  const rowMaxRun = (row) => {
    let best = 0;
    let run = 0;
    for (let col = scanLeft; col <= scanRight; col += 1) {
      if (gray[row * imgWidth + col] < darkLimit) run += 1;
      else run = 0;
      if (run > best) best = run;
    }
    return best;
  };

  let y0 = rect.y;
  let y1 = rect.bottom;
  const topProbeEnd = Math.min(rect.bottom - 1, rect.y + BORDER_GUARD_PX);
  for (let row = Math.max(0, rect.y - BORDER_OUTSIDE_PX); row <= topProbeEnd; row += 1) {
    if (rowMaxRun(row) >= minHorizontalRun) y0 = Math.max(y0, row + 1);
  }
  const bottomProbeStart = Math.max(y0, rect.bottom - BORDER_GUARD_PX);
  for (let row = bottomProbeStart; row <= Math.min(imgHeight - 1, rect.bottom + BORDER_OUTSIDE_PX); row += 1) {
    if (rowMaxRun(row) >= minHorizontalRun) y1 = Math.min(y1, row);
  }

  return { x: x0, y: y0, right: x1, bottom: y1 };
}

/**
 * Derives a per-image reference style from other numeric words printed on
 * the same page (e.g. box dimension values, counts, dates). Only words with
 * a similar glyph height to the value being replaced are considered, so a
 * giant barcode ID or a tiny footnote cannot skew the reference. The result
 * is used when a value's own ink measurement failed or disagrees wildly,
 * and to keep the replacement color as dark as the page's other numbers.
 */
async function computePageStyle(image, meta, styleReferences, regionBbox, cache) {
  const regionHeight = Math.max(1, regionBbox.y1 - regionBbox.y0);
  const regionWidth = Math.max(1, regionBbox.x1 - regionBbox.x0);

  const ranked = [];
  for (const ref of styleReferences) {
    const refWidth = ref.bbox.x1 - ref.bbox.x0;
    const refHeight = ref.bbox.y1 - ref.bbox.y0;
    if (refWidth < 3 || refHeight < 3) continue;
    if (refWidth > regionWidth * 8) continue;
    const ratio = refHeight / regionHeight;
    if (ratio < PAGE_STYLE_HEIGHT_RATIO_MIN || ratio > PAGE_STYLE_HEIGHT_RATIO_MAX) continue;
    ranked.push({ ref, rank: Math.abs(ratio - 1) });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const selected = ranked.slice(0, MAX_PAGE_STYLE_REFERENCES);

  const sizes = [];
  const fillRgbs = [];
  for (const { ref } of selected) {
    let style = cache.get(ref);
    if (style === undefined) {
      // eslint-disable-next-line no-await-in-loop
      style = await sampleTextStyle(image, meta, ref.bbox, ref.text);
      cache.set(ref, style);
    }
    if (!style.measured) continue;
    sizes.push(style.fontSize);
    fillRgbs.push(style.fillRgb);
  }
  if (!sizes.length) return null;

  const fillRgb = {
    r: medianChannel(fillRgbs, 'r'),
    g: medianChannel(fillRgbs, 'g'),
    b: medianChannel(fillRgbs, 'b'),
  };
  return {
    fontSize: percentile(sizes, 0.5),
    fillRgb,
    fillLuma: luminance(fillRgb),
  };
}

/**
 * OCR occasionally returns a word box with the correct x-range but a much
 * taller y-range (for example 55x32 around text that is actually ~18px tall).
 * Use height normally, but cap it by the size that can fit the detected word
 * width so one malformed OCR box cannot create oversized replacement text.
 */
function calculateFontSize(width, height, replacementText) {
  const heightBasedSize = height * FONT_SIZE_RATIO;
  const characterCount = Math.max(1, String(replacementText).length);
  const widthBasedSize = width / (characterCount * FONT_WIDTH_PER_CHARACTER_RATIO);
  return Math.max(8, Math.min(heightBasedSize, widthBasedSize));
}

/**
 * Replaces the printed weight value(s) in an image with new value(s),
 * preserving every other pixel. Returns the edited image as a Buffer.
 *
 * @param {string|Buffer} filePath source image path or normalized image buffer
 * @param {Array<{bbox:{x0:number,y0:number,x1:number,y1:number}, clearBbox?:{x0:number,y0:number,x1:number,y1:number}, replacementText:string}>} replacements
 * @param {{styleReferences?: Array<{bbox:{x0:number,y0:number,x1:number,y1:number}, text:string}>}} [options]
 *        styleReferences are other numeric words on the same page used for
 *        per-image typography (size + ink color), e.g. box dimension values.
 */
async function replaceWeightRegions(filePath, replacements, options = {}) {
  const {
    styleReferences = [],
    preferredStyleReferences = [],
    uniformTextStyle = true,
  } = options;
  const image = sharp(filePath);
  const meta = await image.metadata();

  const eraseOverlays = [];
  const ruleRestoreOverlays = [];
  const textOps = [];

  // Single-channel copy for table-rule detection; decoded at most once and
  // only when there is actually something to clear.
  let grayCache = null;
  const grayPixels = async () => {
    if (!grayCache) {
      const { data, info } = await image
        .clone()
        .removeAlpha()
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      grayCache = { data, info };
    }
    return grayCache;
  };
  const pageStyleCache = new Map();
  let preferredTextStyle = null;
  if (preferredStyleReferences.length) {
    const preferredStyles = [];
    for (const ref of preferredStyleReferences.slice(0, 6)) {
      // eslint-disable-next-line no-await-in-loop
      const style = await sampleTextStyle(image, meta, ref.bbox, ref.text);
      if (style.measured) preferredStyles.push(style);
    }
    preferredTextStyle = mergeUniformTextStyle(preferredStyles);
  }

  for (const {
    bbox,
    clearBbox = bbox,
    textBounds = null,
    leftRuleHint = null,
    eraseOnly = false,
    replacementText,
    originalText = replacementText,
    styleReferenceText = originalText,
    preferSourceStyle = false,
    preferPageStyle = false,
    solidErase = false,
    forceInteriorErase = false,
    fontScale = 1,
    textLeftPaddingRatio = TEXT_LEFT_PADDING_RATIO,
    preferTextBoundsStart = false,
    skipRuleShrink = false,
  } of replacements) {
    const width = bbox.x1 - bbox.x0;
    const height = bbox.y1 - bbox.y0;
    if (width <= 0 || height <= 0) continue;

    // Clear only the OCR word box. Expanding this rectangle can erase nearby
    // table borders, especially the vertical line immediately left of a
    // weight value. Integer edges plus crispEdges prevent SVG antialiasing
    // from leaking the background fill into neighbouring pixels.
    let rectX = Math.max(0, Math.floor(clearBbox.x0));
    let rectY = Math.max(0, Math.floor(clearBbox.y0));
    let rectRight = Math.min(meta.width, Math.ceil(clearBbox.x1));
    let rectBottom = Math.min(meta.height, Math.ceil(clearBbox.y1));

    // eslint-disable-next-line no-await-in-loop
    const bg = await samplePaperInsideBbox(image, meta, bbox);

    // Shrink the clear rect around any printed table rule it touches, so the
    // vertical line left of the value (and any other border) survives intact.
    // eslint-disable-next-line no-await-in-loop
    const { data: gray, info: grayInfo } = await grayPixels();
    if (!skipRuleShrink) {
      const shrunk = shrinkClearRectAroundRules(
        gray,
        grayInfo,
        { x: rectX, y: rectY, right: rectRight, bottom: rectBottom },
        bg,
        false
      );
      rectX = shrunk.x;
      rectY = shrunk.y;
      rectRight = shrunk.right;
      rectBottom = shrunk.bottom;
    }
    const rectW = rectRight - rectX;
    const rectH = rectBottom - rectY;

    if (rectW > 0 && rectH > 0 && solidErase) {
      const solidOverlay = Buffer.from(
        `<svg width="${rectW}" height="${rectH}" xmlns="http://www.w3.org/2000/svg">` +
          `<rect x="0" y="0" width="${rectW}" height="${rectH}" fill="${rgbToCss(bg)}" ` +
          `shape-rendering="crispEdges"/></svg>`
      );
      eraseOverlays.push({ input: solidOverlay, left: rectX, top: rectY });
    } else if (rectW > 0 && rectH > 0) {
      // eslint-disable-next-line no-await-in-loop
      const eraseOverlay = await createSelectiveEraseOverlay(
        image,
        meta,
        gray,
        grayInfo,
        { x: rectX, y: rectY, right: rectRight, bottom: rectBottom },
        bg,
        true,
        true,
        forceInteriorErase
      );
      if (eraseOverlay) eraseOverlays.push(eraseOverlay);
    }

    if (eraseOnly) continue;

    // Sample before adding the clearing rectangle so the original glyphs are
    // still available for per-image style matching.
    // eslint-disable-next-line no-await-in-loop
    let textStyle = await sampleTextStyle(image, meta, bbox, styleReferenceText);

    // Prefer the original weight pixels whenever they are measurable. Nearby
    // dimensions are only a fallback specimen; overriding a faint but valid
    // source made replacements too dark/bold on photographed labels.
    if (preferredTextStyle && (!textStyle.measured || preferPageStyle)) {
      const sourceWasMeasured = textStyle.measured;
      const boundedSourceFontSize = sourceWasMeasured && !preferPageStyle
        ? Math.max(
            preferredTextStyle.fontSize * 0.9,
            Math.min(textStyle.fontSize, preferredTextStyle.fontSize * 1.1)
          )
        : preferredTextStyle.fontSize;
      textStyle = {
        ...textStyle,
        fontFamily: preferredTextStyle.fontFamily,
        // A clean value's own glyph box is the closest possible size/weight
        // reference. The dimensions specimen is only the fallback for a
        // missing or damaged value; taking the larger of both made small
        // labels visibly oversized.
        // Preserve the measured template specimen's stroke weight. Artificially
        // forcing inferred values to 600 made faint scans look bolder than the
        // original and amplified size differences between label variants.
        fontWeight: preferredTextStyle.fontWeight || 400,
        fontSize: Math.min(boundedSourceFontSize, Math.max(8, height * 0.92)),
        fill: sourceWasMeasured && !preferPageStyle ? textStyle.fill : preferredTextStyle.fill,
        fillRgb: sourceWasMeasured && !preferPageStyle ? textStyle.fillRgb : preferredTextStyle.fillRgb,
        fillLuma: sourceWasMeasured && !preferPageStyle ? textStyle.fillLuma : preferredTextStyle.fillLuma,
        measured: true,
      };
    }

    // Align the replacement with the page's other numbers (size + ink color)
    // when the value's own ink measurement is missing, wildly off, or lighter.
    if (styleReferences.length) {
      // eslint-disable-next-line no-await-in-loop
      const pageStyle = await computePageStyle(image, meta, styleReferences, bbox, pageStyleCache);
      if (pageStyle) {
        if (!textStyle.measured) {
          textStyle = {
            ...textStyle,
            fill: rgbToCss(pageStyle.fillRgb),
            fillRgb: pageStyle.fillRgb,
            fillLuma: pageStyle.fillLuma,
          };
        }
        const sizeDeviation = Math.abs(textStyle.fontSize - pageStyle.fontSize) / pageStyle.fontSize;
        if (!textStyle.measured && sizeDeviation > PAGE_STYLE_SIZE_DEVIATION) {
          textStyle = {
            ...textStyle,
            fontSize: Math.max(8, Math.min(pageStyle.fontSize, height / 0.6)),
          };
        }
      }
    }

    // A sampled style must still be visibly darker than the paper under this
    // exact value. This prevents a blank/shadowed fallback box from producing
    // pale or white replacement text.
    const paperLuma = luminance(bg);
    const maximumInkLuma = Math.max(0, paperLuma - Math.max(24, paperLuma * 0.18));
    const sampledFill = textStyle.fillRgb || { r: 0, g: 0, b: 0 };
    const sampledFillLuma = luminance(sampledFill);
    let visibleFill = sampledFill;
    if (!Number.isFinite(sampledFillLuma) || sampledFillLuma > maximumInkLuma) {
      const scale = sampledFillLuma > 0 ? maximumInkLuma / sampledFillLuma : 0;
      visibleFill = {
        r: Math.max(0, Math.round(sampledFill.r * scale)),
        g: Math.max(0, Math.round(sampledFill.g * scale)),
        b: Math.max(0, Math.round(sampledFill.b * scale)),
      };
    }
    const templateFontCap = Math.max(7, meta.width * MAX_WEIGHT_FONT_WIDTH_RATIO);
    textStyle = {
      ...textStyle,
      fillRgb: visibleFill,
      fillLuma: luminance(visibleFill),
      fill: rgbToCss(visibleFill),
      fontSize: Math.min(textStyle.fontSize || templateFontCap, templateFontCap),
    };

    textOps.push({
      bbox,
      width,
      height,
      rectX,
      rectW,
      rectH,
      textBounds,
      leftRuleHint,
      replacementText,
      textStyle,
      fontScale,
      textLeftPaddingRatio,
      preferTextBoundsStart,
    });
  }

  // Reconstruct every proven left rule from the untouched source after the
  // erase/text layers are prepared. This is an authoritative repair pass,
  // independent of whether the earlier heuristic mask recognized the rule.
  if (textOps.some((op) => Number.isFinite(Number(op.leftRuleHint)))) {
    const { data: gray, info: grayInfo } = await grayPixels();
    for (const op of textOps) {
      if (!Number.isFinite(Number(op.leftRuleHint))) continue;
      // eslint-disable-next-line no-await-in-loop
      const restoredRule = await createVerticalRuleRestoreOverlay(
        image,
        meta,
        gray,
        grayInfo,
        { x: op.leftRuleHint, y0: op.bbox.y0, y1: op.bbox.y1 }
      );
      if (!restoredRule) continue;
      ruleRestoreOverlays.push(restoredRule.overlay);
      op.detectedLeftRuleX = restoredRule.ruleXAtValue;
    }
  }

  if (!textOps.length) {
    // Nothing matched on this label - return the original bytes untouched.
    return image.toBuffer();
  }

  const sharedTextStyle = uniformTextStyle
    ? mergeUniformTextStyle(textOps.map((op) => op.textStyle))
    : null;
  // ACTUAL and CHARGED are one visual row. Calculate their final type size
  // once, against every cell's available width/height, instead of allowing a
  // slightly different OCR box to produce visibly different typography.
  let sharedRenderedFontSize = null;
  let sharedBaselineY = null;
  if (sharedTextStyle && textOps.length > 1) {
    const limits = textOps.map((op) => {
      const naturalTextX = op.bbox.x0 + op.width * op.textLeftPaddingRatio;
      const detectedRuleX = Number.isFinite(op.detectedLeftRuleX)
        ? op.detectedLeftRuleX
        : op.rectX;
      const ruleSafeTextX = Math.max(op.rectX, detectedRuleX) +
        Math.max(3, Math.min(8, meta.width * 0.004));
      const guardedTextX = op.textBounds
        ? Math.max(op.textBounds.x0, ruleSafeTextX)
        : Math.max(
            ruleSafeTextX,
            op.rectX + Math.max(1, op.rectW * op.textLeftPaddingRatio)
          );
      const textX = op.preferTextBoundsStart ? guardedTextX : Math.max(naturalTextX, guardedTextX);
      const heightLimit = preferredTextStyle
        ? Math.max(6, op.height * 0.98)
        : Math.max(6, op.height / 0.9);
      const textRight = op.textBounds?.x1 ?? (op.rectX + op.rectW);
      const widthLimit = Math.max(4, textRight - textX - 1) /
        numericAdvanceUnits(op.replacementText, sharedTextStyle.fontFamily);
      return Math.min(heightLimit, widthLimit);
    });
    sharedRenderedFontSize = Math.max(
      6,
      Math.min(
        sharedTextStyle.fontSize * Math.min(...textOps.map((op) => op.fontScale)),
        ...limits
      )
    );

    const candidateBaselines = textOps.map((op) =>
      Math.min(
        op.bbox.y1 - 1,
        Math.max(
          op.bbox.y0 + sharedRenderedFontSize * 0.72,
          op.bbox.y0 + op.height / 2 + sharedRenderedFontSize * 0.28
        )
      )
    );
    const commonMin = Math.max(
      ...textOps.map((op) => op.bbox.y0 + sharedRenderedFontSize * 0.72)
    );
    const commonMax = Math.min(...textOps.map((op) => op.bbox.y1 - 1));
    const medianBaseline = medianNumber(candidateBaselines);
    sharedBaselineY = commonMin <= commonMax
      ? Math.max(commonMin, Math.min(commonMax, medianBaseline))
      : medianBaseline;
  }

  const texts = textOps.map((op) => {
    const textStyle = sharedTextStyle || op.textStyle;
    const naturalTextX = op.bbox.x0 + op.width * op.textLeftPaddingRatio;
    const detectedRuleX = Number.isFinite(op.detectedLeftRuleX)
      ? op.detectedLeftRuleX
      : op.rectX;
    const ruleSafeTextX = Math.max(op.rectX, detectedRuleX) +
      Math.max(3, Math.min(8, meta.width * 0.004));
    const guardedTextX = op.textBounds
      ? Math.max(op.textBounds.x0, ruleSafeTextX)
      : Math.max(
          ruleSafeTextX,
          op.rectX + Math.max(1, op.rectW * op.textLeftPaddingRatio)
        );
    const textX = op.preferTextBoundsStart ? guardedTextX : Math.max(naturalTextX, guardedTextX);
    const maxFontSizeForHeight = preferredTextStyle
      ? Math.max(6, op.height * 0.98)
      : Math.max(6, op.height / 0.9);
    const textRight = op.textBounds?.x1 ?? (op.rectX + op.rectW);
    const maxTextWidth = Math.max(4, textRight - textX - 1);
    const maxFontSizeForWidth =
      maxTextWidth / numericAdvanceUnits(op.replacementText, textStyle.fontFamily);
    const renderedFontSize = sharedRenderedFontSize ?? Math.max(
      6,
      Math.min(textStyle.fontSize * op.fontScale, maxFontSizeForHeight, maxFontSizeForWidth)
    );
    const baselineY = sharedBaselineY ?? Math.min(
      op.bbox.y1 - 1,
      Math.max(op.bbox.y0 + renderedFontSize * 0.72, op.bbox.y0 + op.height / 2 + renderedFontSize * 0.28)
    );

    return (
      `<text x="${textX}" y="${baselineY}" font-family="${textStyle.fontFamily}" ` +
      `font-size="${renderedFontSize.toFixed(1)}" font-weight="${textStyle.fontWeight}" ` +
      `fill="${textStyle.fill}">` +
      `${escapeXml(op.replacementText)}</text>`
    );
  });

  const overlaySvg = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">` +
      texts.join('') +
      `</svg>`
  );

  let renderedTextOverlay = overlaySvg;
  if (preferredTextStyle && Math.max(meta.width, meta.height) <= 2400) {
    // Native label text in low-resolution scans has a small optical/scan blur;
    // raw SVG edges look conspicuously digital beside it. Apply only a subtle
    // resolution-aware blur and keep high-resolution source text untouched.
    const sigma = Math.min(0.55, Math.max(0.3, 700 / Math.max(meta.width, meta.height)));
    renderedTextOverlay = await sharp(overlaySvg).png().blur(sigma).toBuffer();
  }

  return image
    .composite([
      ...eraseOverlays,
      { input: renderedTextOverlay, top: 0, left: 0 },
      // Source rule pixels are authoritative and are restored last so neither
      // inpainting nor text antialiasing can break or cover the cell border.
      ...ruleRestoreOverlays,
    ])
    .toBuffer();
}

module.exports = {
  replaceWeightRegions,
  sampleBackgroundColor,
  sampleLocalPaperColor,
  samplePaperInsideBbox,
  sampleTextStyle,
  calculateFontSize,
  shrinkClearRectAroundRules,
  computePageStyle,
};
