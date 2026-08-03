'use strict';

const sharp = require('sharp');

const FONT_SIZE_RATIO = 0.86; // font-size relative to bbox height
const FONT_WIDTH_PER_CHARACTER_RATIO = 0.5; // average Arial numeric glyph advance
const TEXT_LEFT_PADDING_RATIO = 0.08; // inset replacement text inside the cleared value area

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

function rgbToCss({ r, g, b }) {
  return `rgb(${r},${g},${b})`;
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
 * @param {Array<{bbox:{x0:number,y0:number,x1:number,y1:number}, replacementText:string}>} replacements
 */
async function replaceWeightRegions(filePath, replacements) {
  const image = sharp(filePath);
  const meta = await image.metadata();

  const rects = [];
  const texts = [];

  for (const { bbox, replacementText } of replacements) {
    const width = bbox.x1 - bbox.x0;
    const height = bbox.y1 - bbox.y0;
    if (width <= 0 || height <= 0) continue;

    // Clear only the OCR word box. Expanding this rectangle can erase nearby
    // table borders, especially the vertical line immediately left of a
    // weight value. Integer edges plus crispEdges prevent SVG antialiasing
    // from leaking the background fill into neighbouring pixels.
    const rectX = Math.max(0, Math.floor(bbox.x0));
    const rectY = Math.max(0, Math.floor(bbox.y0));
    const rectRight = Math.min(meta.width, Math.ceil(bbox.x1));
    const rectBottom = Math.min(meta.height, Math.ceil(bbox.y1));
    const rectW = rectRight - rectX;
    const rectH = rectBottom - rectY;

    // eslint-disable-next-line no-await-in-loop
    const bg = await sampleBackgroundColor(image, meta, bbox);
    const fill = rgbToCss(bg);

    rects.push(
      `<rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" ` +
        `fill="${fill}" shape-rendering="crispEdges" />`
    );

    const fontSize = calculateFontSize(width, height, replacementText);
    const baselineY = bbox.y1 - height * 0.16;
    const textX = bbox.x0 + width * TEXT_LEFT_PADDING_RATIO;

    texts.push(
      `<text x="${textX}" y="${baselineY}" font-family="Arial, Helvetica, sans-serif" ` +
        `font-size="${fontSize.toFixed(1)}" font-weight="600" fill="#000000">` +
        `${escapeXml(replacementText)}</text>`
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

module.exports = { replaceWeightRegions, sampleBackgroundColor, calculateFontSize };
