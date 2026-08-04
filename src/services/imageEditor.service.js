'use strict';

const fs = require('fs');
const opentype = require('opentype.js');
const sharp = require('sharp');

function loadBundledFont(weight) {
  const fontPath = require.resolve(
    `@fontsource/roboto/files/roboto-latin-${weight}-normal.woff`
  );
  const buffer = fs.readFileSync(fontPath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return opentype.parse(arrayBuffer);
}

// Convert numbers to vector outlines instead of asking librsvg/Pango to find
// a system font. The production sandbox has no installed fonts, which caused
// every character to be emitted as the hollow "missing glyph" square.
const BUNDLED_FONTS = {
  400: loadBundledFont(400),
  700: loadBundledFont(700),
};

const FONT_SIZE_RATIO = 0.86; // font-size relative to bbox height
const FONT_WIDTH_PER_CHARACTER_RATIO = 0.5; // average Arial numeric glyph advance
const TEXT_LEFT_PADDING_RATIO = 0.08; // inset replacement text inside the cleared value area
const DEFAULT_TEXT_STYLE = {
  // Generic SVG families are resolved reliably by libvips/Pango in every
  // environment. Named fallback lists can be treated as one missing family
  // and render numeric text as hollow replacement boxes.
  fontFamily: 'sans-serif',
  fontWeight: 400,
  fill: 'rgb(0,0,0)',
};

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
    const samples = { r: [], g: [], b: [] };
    for (let i = 0; i < data.length; i += channels) {
      samples.r.push(data[i]);
      samples.g.push(data[i + 1]);
      samples.b.push(data[i + 2]);
    }
    const median = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    return { r: median(samples.r), g: median(samples.g), b: median(samples.b) };
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

function estimateFontFamily(inkWidth, inkHeight, originalText) {
  const characterCount = Math.max(1, String(originalText || '').length);
  const characterAspect = inkWidth / Math.max(1, inkHeight * characterCount);

  // Keep the measured width classification, but only emit portable generic
  // families. Stretching sans-serif preserves a narrow source appearance
  // without depending on Arial Narrow being installed in the runtime.
  if (characterAspect < 0.42) return 'sans-serif-condensed';
  if (characterAspect > 0.82) return 'monospace';
  return DEFAULT_TEXT_STYLE.fontFamily;
}

function numericAdvanceUnits(text, fontFamily) {
  const isNarrow = fontFamily === 'sans-serif-condensed';
  const isMonospace = fontFamily === 'monospace';
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

function numericTextPath(text, x, baselineY, fontSize, fontWeight, condensed) {
  const font = BUNDLED_FONTS[fontWeight >= 600 ? 700 : 400];
  const scale = fontSize / font.unitsPerEm;
  const horizontalScale = condensed ? 0.82 : 1;
  let cursorX = x;
  const pathData = [];

  // charToGlyph bypasses OpenType's shaping engine. Numeric weights need no
  // ligatures or script substitutions, and this produces one guaranteed
  // outline for every validated ASCII digit/decimal character.
  for (const character of text) {
    const glyph = font.charToGlyph(character);
    pathData.push(glyph.getPath(cursorX, baselineY, fontSize).toPathData(2));
    cursorX += glyph.advanceWidth * scale;
  }

  return {
    d: pathData.join(''),
    transform: horizontalScale === 1
      ? ''
      : `translate(${x} 0) scale(${horizontalScale} 1) translate(${-x} 0)`,
  };
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
    return { ...DEFAULT_TEXT_STYLE, fontSize: calculateFontSize(width, height, originalText) };
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
        fontSize: calculateFontSize(width, height, originalText),
      };
    }

    const xs = inkPixels.map((pixel) => pixel.x);
    const ys = inkPixels.map((pixel) => pixel.y);
    const inkWidth = Math.max(...xs) - Math.min(...xs) + 1;
    const inkHeight = Math.max(...ys) - Math.min(...ys) + 1;
    const fontFamily = estimateFontFamily(inkWidth, inkHeight, originalText);

    // Use only solid stroke pixels for the fill color. Including anti-aliased
    // edge pixels would make the replacement lighter than the source print.
    const coreThreshold = Math.max(inkThreshold, contrastRange * 0.62);
    const corePixels = inkPixels.filter(
      (pixel) => localBackground - pixel.luma >= coreThreshold
    );
    const colorPixels = corePixels.length >= 3 ? corePixels : inkPixels;
    const fill = rgbToCss({
      r: medianChannel(colorPixels, 'r'),
      g: medianChannel(colorPixels, 'g'),
      b: medianChannel(colorPixels, 'b'),
    });

    const inkArea = Math.max(1, inkWidth * inkHeight);
    const strokeDensity = inkPixels.length / inkArea;
    // Camera blur spreads bold strokes over a larger area but lowers their
    // darkest-pixel density, so scanned bold text needs a lower cutoff than
    // clean screen-rendered text.
    const fontWeight = strokeDensity >= 0.25 ? 700 : 400;
    const widthBasedSize = inkWidth / numericAdvanceUnits(originalText, fontFamily);
    const heightBasedSize = inkHeight / 0.72;
    const fontSize = Math.max(8, Math.min(widthBasedSize, heightBasedSize));

    return { fontFamily, fontWeight, fill, fontSize };
  } catch (err) {
    return {
      ...DEFAULT_TEXT_STYLE,
      fontSize: calculateFontSize(width, height, originalText),
    };
  }
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
 */
async function replaceWeightRegions(filePath, replacements) {
  const image = sharp(filePath);
  const meta = await image.metadata();

  const rects = [];
  const texts = [];

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
    const numericReplacement = String(replacementText).trim();
    if (
      width <= 0 ||
      height <= 0 ||
      !/^\d+(?:\.\d+)?$/.test(numericReplacement) ||
      !Number.isFinite(Number(numericReplacement))
    ) {
      continue;
    }

    // Clear only the OCR word box. Expanding this rectangle can erase nearby
    // table borders, especially the vertical line immediately left of a
    // weight value. Integer edges plus crispEdges prevent SVG antialiasing
    // from leaking the background fill into neighbouring pixels.
    const rectX = Math.max(0, Math.floor(clearBbox.x0));
    const rectY = Math.max(0, Math.floor(clearBbox.y0));
    const rectRight = Math.min(meta.width, Math.ceil(clearBbox.x1));
    const rectBottom = Math.min(meta.height, Math.ceil(clearBbox.y1));
    const rectW = rectRight - rectX;
    const rectH = rectBottom - rectY;

    // eslint-disable-next-line no-await-in-loop
    const usesExpandedClearing = clearBbox !== bbox;
    const bg = usesExpandedClearing
      ? await sampleLocalPaperColor(image, meta, clearBbox)
      : await sampleBackgroundColor(image, meta, bbox);
    const fill = rgbToCss(bg);

    rects.push(
      `<rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" ` +
        `fill="${fill}" shape-rendering="crispEdges" />`
    );

    // Sample before adding the clearing rectangle so the original glyphs are
    // still available for per-image style matching.
    // eslint-disable-next-line no-await-in-loop
    const textStyle = await sampleTextStyle(image, meta, bbox, styleReferenceText);
    const baselineY = bbox.y1 - height * 0.16;
    const textX = bbox.x0 + width * textLeftPaddingRatio;
    const renderedFontSize = textStyle.fontSize * fontScale;
    const outlinedText = numericTextPath(
      numericReplacement,
      textX,
      baselineY,
      renderedFontSize,
      textStyle.fontWeight,
      textStyle.fontFamily === 'sans-serif-condensed'
    );
    const transform = outlinedText.transform
      ? ` transform="${outlinedText.transform}"`
      : '';

    texts.push(
      `<path d="${outlinedText.d}" fill="${textStyle.fill}"${transform} />`
    );
  }

  if (!rects.length) {
    // Nothing matched on this label - return the original bytes untouched.
    return image.toBuffer();
  }

  const overlaySvg = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">` +
      rects.join('') +
      texts.join('') +
      `</svg>`
  );

  return image
    .composite([{ input: overlaySvg, top: 0, left: 0 }])
    .toBuffer();
}

module.exports = {
  replaceWeightRegions,
  sampleBackgroundColor,
  sampleLocalPaperColor,
  sampleTextStyle,
  calculateFontSize,
  numericTextPath,
};
