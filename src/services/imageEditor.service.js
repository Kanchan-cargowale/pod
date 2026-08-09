'use strict';

const sharp = require('sharp');

const FONT_SIZE_RATIO = 0.86; // font-size relative to bbox height
const FONT_WIDTH_PER_CHARACTER_RATIO = 0.5; // average Arial numeric glyph advance
const TEXT_LEFT_PADDING_RATIO = 0.08; // inset replacement text inside the cleared value area
const BORDER_GUARD_PX = 8; // how far inside the clear box a table rule may sit
const BORDER_OUTSIDE_PX = 4; // how far outside the clear box we look for rules
const MIN_RULE_RUN_RATIO = 1.2; // rule lines run much longer than glyph strokes
const MAX_PAGE_STYLE_REFERENCES = 40; // sibling numbers sampled per value
const PAGE_STYLE_HEIGHT_RATIO_MIN = 0.45; // ignore much smaller page text
const PAGE_STYLE_HEIGHT_RATIO_MAX = 2.4; // ignore much larger page text (e.g. barcode IDs)
const PAGE_STYLE_SIZE_DEVIATION = 0.45; // trust own ink unless it disagrees wildly
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
  if (usable.length <= 1) return null;

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

async function createSelectiveEraseOverlay(image, meta, gray, grayInfo, rect, bg) {
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
    // A solid/merged OCR glyph can occupy almost the entire row. In that case
    // the row percentile is ink, not paper; let the vertical texture fallback
    // handle it instead of treating black pixels as a valid replacement.
    if (rowPaperLuma < bgLuma - Math.max(12, bgLuma * 0.08)) return null;
    const cleanLimit = rowPaperLuma - Math.max(3, rowPaperLuma * 0.022);
    for (let distance = 1; distance < width; distance += 1) {
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
      if (verticalRuleCols.has(imageX) || horizontalRuleRows.has(imageY)) continue;

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
      const localInkThreshold = Math.max(5, localPaperLuma * 0.035);
      const isOldInk = darkness >= localInkThreshold;
      if (!isOldInk) continue;

      const overlayOffset = (y * width + x) * 4;
      overlay[overlayOffset] = replacement.r;
      overlay[overlayOffset + 1] = replacement.g;
      overlay[overlayOffset + 2] = replacement.b;
      overlay[overlayOffset + 3] = darkness > 25 ? 255 : 205;
      erasedPixels += 1;
    }
  }

  if (!erasedPixels) return null;

  return {
    input: await sharp(overlay, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    left: rect.x,
    top: rect.y,
  };
}

function estimateFontFamily(inkWidth, inkHeight, originalText) {
  const characterCount = Math.max(1, String(originalText || '').length);
  const characterAspect = inkWidth / Math.max(1, inkHeight * characterCount);

  if (characterAspect < 0.42) return 'Arial Narrow, Arial, sans-serif';
  if (characterAspect > 0.82) return 'Courier New, monospace';
  return DEFAULT_TEXT_STYLE.fontFamily;
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
    const fontFamily = estimateFontFamily(inkWidth, inkHeight, originalText);

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
    // Camera blur spreads bold strokes over a larger area but lowers their
    // darkest-pixel density, so scanned bold text needs a lower cutoff than
    // clean screen-rendered text.
    const fontWeight = strokeDensity >= 0.25 ? 700 : 400;
    const widthBasedSize = inkWidth / numericAdvanceUnits(originalText, fontFamily);
    const heightBasedSize = inkHeight / 0.72;
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
    if (preferredTextStyle) {
      // Delhivery's dimension/value figures are proportional sans-serif.
      // OCR word boxes often include large side gaps and falsely classify
      // them as monospace; that was the clearest remaining visual mismatch.
      preferredTextStyle.fontFamily = DEFAULT_TEXT_STYLE.fontFamily;
    }
  }

  for (const {
    bbox,
    clearBbox = bbox,
    replacementText,
    originalText = replacementText,
    styleReferenceText = originalText,
    fontScale = 1,
    textLeftPaddingRatio = TEXT_LEFT_PADDING_RATIO,
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
    const shrunk = shrinkClearRectAroundRules(
      gray,
      grayInfo,
      { x: rectX, y: rectY, right: rectRight, bottom: rectBottom },
      bg
    );
    rectX = shrunk.x;
    rectY = shrunk.y;
    rectRight = shrunk.right;
    rectBottom = shrunk.bottom;
    const rectW = rectRight - rectX;
    const rectH = rectBottom - rectY;

    if (rectW > 0 && rectH > 0) {
      // eslint-disable-next-line no-await-in-loop
      const eraseOverlay = await createSelectiveEraseOverlay(
        image,
        meta,
        gray,
        grayInfo,
        { x: rectX, y: rectY, right: rectRight, bottom: rectBottom },
        bg
      );
      if (eraseOverlay) eraseOverlays.push(eraseOverlay);
    }

    // Sample before adding the clearing rectangle so the original glyphs are
    // still available for per-image style matching.
    // eslint-disable-next-line no-await-in-loop
    let textStyle = await sampleTextStyle(image, meta, bbox, styleReferenceText);

    // The box-dimension figures are printed by the same label template and
    // are a much cleaner type specimen than a faint/damaged weight value.
    // Apply that local specimen to both weight columns as one exact style.
    if (preferredTextStyle) {
      textStyle = {
        ...textStyle,
        fontFamily: preferredTextStyle.fontFamily,
        fontWeight: preferredTextStyle.fontWeight,
        fontSize: preferredTextStyle.fontSize,
        fill: preferredTextStyle.fill,
        fillRgb: preferredTextStyle.fillRgb,
        fillLuma: preferredTextStyle.fillLuma,
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

    textOps.push({
      bbox,
      width,
      height,
      rectX,
      rectW,
      replacementText,
      textStyle,
      fontScale,
      textLeftPaddingRatio,
    });
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
      const guardedTextX = op.rectX + Math.max(1, op.rectW * op.textLeftPaddingRatio);
      const textX = Math.max(naturalTextX, guardedTextX);
      const heightLimit = Math.max(6, op.height / 0.82);
      const widthLimit = Math.max(4, op.rectX + op.rectW - textX - 1) /
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
    const guardedTextX = op.rectX + Math.max(1, op.rectW * op.textLeftPaddingRatio);
    const textX = Math.max(naturalTextX, guardedTextX);
    const maxFontSizeForHeight = Math.max(6, op.height / 0.82);
    const maxTextWidth = Math.max(4, op.rectX + op.rectW - textX - 1);
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
    .composite([...eraseOverlays, { input: renderedTextOverlay, top: 0, left: 0 }])
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
