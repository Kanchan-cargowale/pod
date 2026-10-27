'use strict';

const sharp = require('sharp');
const { ensureBundledFonts } = require('../config/fonts');

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[c]));

// Compare actual rasterized glyphs, including the fonts available on this host.
// A flattened scan identifies apparent ink, not its original paint opacity.
async function profile(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  const inkAlphas = [];
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] < 24) continue;
      inkAlphas.push(data[(y * info.width + x) * 4 + 3]);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (x1 < x0) return null;
  const bounds = { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const mask = await sharp(buffer).extract(bounds).resize(MASK_WIDTH, MASK_HEIGHT, { fit: 'fill' })
    .ensureAlpha().extractChannel(3).raw().toBuffer();
  // Retain the ink alpha at its own resolution. The normalized mask is useful
  // for a cheap, scale-free family shortlist, but only native pixels can judge
  // stroke weight and tracking, which is what the eye compares on the label.
  const alpha = Buffer.alloc(bounds.width * bounds.height);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      alpha[y * bounds.width + x] =
        data[((y + bounds.top) * info.width + (x + bounds.left)) * 4 + 3];
    }
  }
  inkAlphas.sort((a, b) => a - b);
  const coreAlpha = inkAlphas[Math.floor(inkAlphas.length * 0.875)] / 255;
  // Stroke geometry has to be measured on native pixels. Thresholding at half
  // the core coverage makes the measure independent of how dark the ink is, so
  // it reports stroke width and ink mass relative to glyph size - the two
  // things that actually separate a regular face from a bold one.
  //
  // Both measures use ink *mass* rather than thresholded pixel counts. At the
  // 8-12px heights of these labels a regular stroke is ~1px and a soft scan
  // spreads it over 2px; whole-pixel run lengths then read as "twice as
  // thick" and forced a bold face. Blur conserves mass, so mass per stroke
  // crossing measures the printed stroke width at sub-pixel precision and is
  // unaffected by scan softness.
  const strokeThreshold = Math.max(32, coreAlpha * 255 * 0.5);
  // Core-normalized so faint scan noise around the glyphs cannot add mass
  // the way it would to absolute alpha.
  const coreScale = Math.max(1, coreAlpha * 255);
  let crossings = 0;
  let inkMass = 0;
  for (let y = 0; y < bounds.height; y += 1) {
    let inRun = false;
    for (let x = 0; x < bounds.width; x += 1) {
      const value = alpha[y * bounds.width + x];
      inkMass += Math.min(1, value / coreScale);
      const inked = value >= strokeThreshold;
      if (inked && !inRun) crossings += 1;
      inRun = inked;
    }
  }
  // Solid visible rows: the height a reader perceives. `bounds` starts at a
  // ~10% alpha threshold, which on a soft scan adds a faint fringe row above
  // and below the glyphs. Specimen and replacement must both be sized by this
  // same half-core measure, or the replacement comes out ~2px taller.
  const visibleThreshold = Math.max(24, Math.round(coreAlpha * 255 * 0.5));
  let visibleTop = bounds.height;
  let visibleBottom = -1;
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      if (alpha[y * bounds.width + x] < visibleThreshold) continue;
      visibleTop = Math.min(visibleTop, y);
      visibleBottom = Math.max(visibleBottom, y);
      break;
    }
  }
  if (visibleBottom < visibleTop) { visibleTop = 0; visibleBottom = bounds.height - 1; }
  const { strokeMass } = strokeMetrics(alpha, bounds.width, bounds.height);
  return {
    strokeMass,
    bounds,
    mask,
    alpha,
    buffer,
    coreAlpha,
    visibleTop,
    visibleHeight: visibleBottom - visibleTop + 1,
    strokeRatio: crossings ? inkMass / crossings / bounds.height : null,
    inkFraction: inkMass / Math.max(1, bounds.width * bounds.height),
  };
}

/**
 * Scores a candidate face the way it will actually be composited: its ink
 * bounds resized onto the source ink box, then compared per pixel with the
 * scan's own reconstructed ink. Both sides are normalized by their own core
 * coverage, exactly as renderMatchedText normalizes before painting, so the
 * comparison isolates glyph shape, stroke weight and tracking.
 *
 * The 96x32 mask distance cannot do this: stretching an 8-10px specimen to
 * 32px high smooths it, and a bold or blurred candidate then matches the
 * smoothed blob better than the correct regular face.
 */
async function nativeFitError(source, candidate) {
  if (!candidate?.buffer || !source?.alpha) return null;
  const { width, height } = source.bounds;
  if (width < 2 || height < 2 || width * height > 200000) return null;
  let resized;
  try {
    resized = await sharp(candidate.buffer).extract(candidate.bounds)
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha().extractChannel(3).raw().toBuffer();
  } catch {
    return null;
  }
  const sourceCore = Math.max(0.2, source.coreAlpha);
  const candidateCore = Math.max(0.2, candidate.coreAlpha);
  let error = 0;
  for (let i = 0; i < resized.length; i += 1) {
    const a = Math.min(255, source.alpha[i] / sourceCore);
    const b = Math.min(255, resized[i] / candidateCore);
    error += Math.abs(a - b);
  }
  // What the viewer sees: the scan's own ink against the candidate exactly as
  // renderMatchedText will paint it (alpha divided by its 75th-percentile
  // coverage). This penalizes a face that is right in shape but would come
  // out visibly darker or heavier than the printed specimen.
  const inked = [];
  for (let i = 0; i < resized.length; i += 1) if (resized[i] >= 24) inked.push(resized[i]);
  inked.sort((x, y) => x - y);
  const paintCoverage = inked.length
    ? Math.max(0.35, inked[Math.floor(inked.length * 0.75)] / 255)
    : 1;
  // Joint ink-strength fit: the scan is modelled as candidate coverage times
  // one ink gain g (least squares). Weight and ink tone are then judged
  // together, the way pixels actually composite; judging them separately let
  // a grey bold print pass as a dark regular one.
  let dotSC = 0;
  let dotCC = 0;
  for (let i = 0; i < resized.length; i += 1) {
    dotSC += source.alpha[i] * resized[i];
    dotCC += resized[i] * resized[i];
  }
  const inkGain = dotCC > 0 ? dotSC / dotCC : 1;
  let gainError = 0;
  for (let i = 0; i < resized.length; i += 1) {
    gainError += Math.abs(source.alpha[i] - Math.min(255, resized[i] * inkGain));
  }
  let renderError = 0;
  let sourceMass = 0;
  let renderMass = 0;
  let rawMass = 0;
  for (let i = 0; i < resized.length; i += 1) {
    const painted = Math.min(255, resized[i] / paintCoverage);
    renderError += Math.abs(source.alpha[i] - painted);
    sourceMass += source.alpha[i];
    renderMass += painted;
    rawMass += resized[i];
  }
  return {
    error: error / (resized.length * 255),
    renderError: renderError / (resized.length * 255),
    // Total darkness on the same ink box is what reads as "weight" at body
    // sizes; blur moves ink around but barely changes this sum.
    massError: logRatioError(sourceMass, renderMass),
    // Raw coverage (no paint normalization). Optical blur conserves this sum,
    // so it measures printed stroke width independently of scan softness.
    rawMassError: logRatioError(sourceMass, rawMass),
    rawMassRatio: rawMass / Math.max(1, sourceMass),
    gainError: gainError / (resized.length * 255),
    inkGain,
  };
}

/**
 * Perceived boldness of a word, in pixels: total ink coverage (alpha/255,
 * absolute) divided by the number of horizontal stroke crossings.
 *
 * Optical blur and print gain move ink around but conserve it, so this is the
 * printed stroke width of the vertical strokes - what the eye reads as
 * weight - and it is directly comparable between a scanned specimen (alpha
 * relative to its ink color) and a replacement painted in that same color.
 */
function strokeMetrics(alpha, width, height) {
  let peak = 0;
  for (let i = 0; i < alpha.length; i += 1) if (alpha[i] > peak) peak = alpha[i];
  const threshold = Math.max(24, peak * 0.4);
  let crossings = 0;
  let mass = 0;
  for (let y = 0; y < height; y += 1) {
    let inRun = false;
    for (let x = 0; x < width; x += 1) {
      const value = alpha[y * width + x];
      mass += value / 255;
      const inked = value >= threshold;
      if (inked && !inRun) crossings += 1;
      inRun = inked;
    }
  }
  return { strokeMass: crossings ? mass / crossings : null, crossings };
}

/**
 * Horizontally thickens (amount > 0) or thins (amount < 0) a glyph alpha map
 * by a fractional pixel on each side of every vertical stroke. Horizontal-only
 * so the visible glyph height, already locked to the specimen, is unchanged.
 */
function adjustStrokeWidth(alpha, width, height, amount) {
  if (!amount) return alpha;
  const out = new Float32Array(alpha.length);
  const t = Math.min(1, Math.abs(amount));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const left = x > 0 ? alpha[i - 1] : 0;
      const right = x < width - 1 ? alpha[i + 1] : 0;
      out[i] = amount > 0
        ? Math.max(alpha[i], t * Math.max(left, right))
        : alpha[i] - t * (alpha[i] - Math.min(alpha[i], left, right));
    }
  }
  return out;
}

async function raster(text, family, weight, size, blur = 0, angle = 0, fill = 'black', letterSpacing = 0) {
  const width = Math.ceil(size * (Array.from(text).length + 4));
  const height = Math.ceil(size * 4);
  let pipeline = sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<text x="${size}" y="${size * 2}" font-family="${escapeXml(family)}" font-size="${size}" ` +
    `font-weight="${weight}" letter-spacing="${letterSpacing}" fill="${fill}">${escapeXml(text)}</text></svg>`));
  if (blur >= 0.3) pipeline = pipeline.blur(blur);
  const buffer = await pipeline.png().toBuffer();
  return angle ? sharp(buffer).rotate(angle, { background: '#00000000' }).png().toBuffer() : buffer;
}

const MASK_WIDTH = 96;
const MASK_HEIGHT = 32;

function distance(a, b) {
  let error = 0;
  for (let i = 0; i < a.length; i += 1) error += Math.abs(a[i] - b[i]);
  return error / (a.length * 255);
}

/** A doubling or halving of a relative measure scores a full unit of error. */
function logRatioError(sourceValue, candidateValue) {
  if (!sourceValue || !candidateValue) return 0;
  return Math.min(1, Math.abs(Math.log(candidateValue / sourceValue)) / Math.LN2);
}

function smoothedMaskDistance(a, b) {
  const width = 96, height = 32;
  let error = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sumA = 0, sumB = 0, count = 0;
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dx = -3; dx <= 3; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const index = ny * width + nx;
          sumA += a[index]; sumB += b[index]; count += 1;
        }
      }
      error += Math.abs(sumA / count - sumB / count);
    }
  }
  return error / (a.length * 255);
}

// Candidate faces, most template-accurate name first.
//
// These POD templates print every body value in an Arial/Helvetica-metric
// sans face, so serif and monospace families were removed: at the 8-17px
// specimen heights available here they are not reliably distinguishable from
// a sans face, and when one won the match the replacement was rendered in a
// visibly alien typeface. Condensed sans is excluded for a related reason -
// renderMatchedText rescales the glyph run onto the specimen's ink box, so a
// condensed face's natural width is normalized away and it becomes
// indistinguishable from a correct normal-width face at a heavier weight.
//
// Liberation Sans is metrically compatible with Arial and is what the
// container image provides; DejaVu Sans is the universally present fallback.
// Order matters: de-duplication keeps the first name that claims a given
// rasterized signature, so the most template-accurate name is listed first and
// the universal fallback last. That way the winning family name stays honest on
// a host with real Arial as well as inside the container.
//
// DejaVu Sans is bundled in /fonts and registered at runtime (see
// config/fonts.js): the Cargowale/Delhivery POD template prints its body
// values in DejaVu Sans, whose wide, round digits no Arial weight can mimic.
const CANDIDATE_FAMILIES = [
  { family: 'Arial, Helvetica, sans-serif', weights: [400, 500, 600, 700] },
  { family: 'DejaVu Sans', weights: [400, 700] },
  { family: 'Liberation Sans', weights: [400, 500, 600, 700] },
  { family: 'Nimbus Sans', weights: [400, 700] },
];
const FACE_PROBE_TEXT = '80x43x19';
// Optical softness offered alongside every face in the first search stage.
const FACE_SEARCH_BLURS = [0, 0.35, 0.7];
let candidateFacesPromise = null;

/**
 * Keeps only families that genuinely rasterize differently on this host.
 *
 * fontconfig silently substitutes a missing family, so several names in the
 * pool can resolve to one face - on a bare container every name collapses to
 * DejaVu Sans. Scoring those duplicates wasted most of the search budget and,
 * worse, made the reported winning family arbitrary: whichever duplicate name
 * happened to be evaluated first won the tie. De-duplicating by rasterized
 * signature makes the match deterministic and the chosen family meaningful,
 * whatever fonts the host actually has installed.
 */
async function resolveCandidateFaces() {
  if (!candidateFacesPromise) {
    candidateFacesPromise = (async () => {
      await ensureBundledFonts();
      const signatureOf = async (family, weight) => {
        const measured = await profile(await raster(FACE_PROBE_TEXT, family, weight, 28));
        return measured
          ? `${measured.bounds.width}x${measured.bounds.height}:` +
            `${Buffer.from(measured.mask).toString('base64')}`
          : `empty:${weight}`;
      };
      // A family that is not installed renders exactly like a name that cannot
      // exist. On Windows that substitute differs per weight (a CJK mono face
      // at 400, Times New Roman Bold at 700), so "Liberation Sans 700" was in
      // fact a serif face and won fits on bold specimens. Drop such names.
      //
      // The fallback is only trusted on a bare host where *no* candidate
      // resolves to a real face (a container with just DejaVu Sans: there
      // the fallback is DejaVu, a legitimate sans). As soon as any candidate
      // is genuinely installed, every name that renders like the fallback is
      // a substitution and is dropped.
      const missingSignatures = new Map();
      for (const weight of [400, 500, 600, 700]) {
        // eslint-disable-next-line no-await-in-loop
        missingSignatures.set(weight, await signatureOf('PodNoSuchFontFamily', weight));
      }
      const signatures = new Map();
      let anyRealFace = false;
      for (const { family, weights } of CANDIDATE_FAMILIES) {
        for (const weight of weights) {
          // eslint-disable-next-line no-await-in-loop
          const signature = await signatureOf(family, weight);
          signatures.set(`${family}@${weight}`, signature);
          if (signature !== missingSignatures.get(weight)) anyRealFace = true;
        }
      }
      const bySignature = new Map();
      const resolved = [];
      for (const { family, weights } of CANDIDATE_FAMILIES) {
        const distinctWeights = [];
        for (const weight of weights) {
          const signature = signatures.get(`${family}@${weight}`);
          if (anyRealFace && signature === missingSignatures.get(weight)) continue;
          if (bySignature.has(signature)) continue;
          bySignature.set(signature, `${family}@${weight}`);
          distinctWeights.push(weight);
        }
        if (distinctWeights.length) resolved.push({ family, weights: distinctWeights });
      }
      // A bare container substitutes DejaVu Sans for everything, so it is
      // filtered above as "missing"; it is still a real sans face to use.
      return resolved.length ? resolved : [{ family: 'DejaVu Sans', weights: [400, 700] }];
    })();
  }
  return candidateFacesPromise;
}

const DIMENSION_PATTERN = /^\d{1,4}(?:[.,]\d+)?[xX×]\d{1,4}(?:[.,]\d+)?[xX×]\d{1,4}(?:[.,]\d+)?$/;
const NUMERIC_COMPONENT_PATTERN = /^\d{1,4}(?:[.,]\d+)?$/;
const DIMENSION_CONFIDENCE_LIMIT = 0.24;

function dimensionRepairCandidates(text, limit = 96) {
  const components = String(text).split(/[xX×]/);
  const separators = String(text).match(/[xX×]/g) || [];
  if (components.length !== 3 || separators.length !== 2) return [text];
  const candidates = [];
  const seen = new Set();
  const add = (parts) => {
    const candidate = `${parts[0]}${separators[0]}${parts[1]}${separators[1]}${parts[2]}`;
    if (candidates.length >= limit || candidate.length > 24 || !DIMENSION_PATTERN.test(candidate) || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };
  add(components);
  for (let componentIndex = 0; componentIndex < components.length && candidates.length < limit; componentIndex += 1) {
    const component = components[componentIndex];
    for (let digit = 0; digit <= 9 && candidates.length < limit; digit += 1) {
      for (const repaired of [`${digit}${component}`, `${component}${digit}`]) {
        if (!NUMERIC_COMPONENT_PATTERN.test(repaired)) continue;
        const parts = [...components];
        parts[componentIndex] = repaired;
        add(parts);
      }
    }
    for (let index = 0; index < component.length && candidates.length < limit; index += 1) {
      if (!/\d/.test(component[index])) continue;
      const repaired = component.slice(0, index) + component.slice(index + 1);
      if (!NUMERIC_COMPONENT_PATTERN.test(repaired)) continue;
      const parts = [...components];
      parts[componentIndex] = repaired;
      add(parts);
    }
  }
  return candidates;
}

function isLikelyCollapsedDigitRepair(originalText, repairedText) {
  const original = String(originalText).split(/[xX×]/);
  const repaired = String(repairedText).split(/[xX×]/);
  if (original.length !== 3 || repaired.length !== 3) return false;
  const changed = original.map((component, index) => component === repaired[index] ? -1 : index)
    .filter((index) => index >= 0);
  if (changed.length !== 1) return false;
  const index = changed[0];
  const component = original[index], candidate = repaired[index];
  const digitLengths = original.map((part) => (part.match(/\d/g) || []).length);
  if (digitLengths[index] !== Math.min(...digitLengths)) return false;
  return (candidate === `${component}${component[component.length - 1]}`) ||
    (candidate === `${component[0]}${component}`);
}

/** Confidence-gated matching for a single, reliable numeric OCR word. */
async function matchSourceAppearance(image, meta, bbox, text, style,
  { dimensionReference = false, collector = null, faces = null, stage1Only = false } = {}) {
  const validText = dimensionReference
    ? DIMENSION_PATTERN.test(text)
    : /^\d+(?:[.,]\d+)?$/.test(text);
  if (!style.measured || !validText || text.length > 24) return null;
  const left = Math.max(0, Math.floor(bbox.x0));
  const top = Math.max(0, Math.floor(bbox.y0));
  const ocrWidth = Math.min(meta.width - left, Math.ceil(bbox.x1) - left);
  // Tesseract boxes on these labels routinely end inside the last glyph of a
  // dimension value. A clipped specimen is narrower than the printed text, so
  // the matched face was rendered horizontally squashed. Give dimension
  // specimens a little room on the right (they end their cell) and let the
  // ink itself, not the OCR box, define the measured width.
  const rightPad = dimensionReference
    ? Math.ceil(Math.max(2, (bbox.y1 - bbox.y0) * 0.45))
    : 0;
  const width = Math.min(meta.width - left, ocrWidth + rightPad);
  const height = Math.min(meta.height - top, Math.ceil(bbox.y1) - top);
  if (width < 3 || height < 5 || width * height > 100000) return null;
  const { data, info } = await image.clone().extract({ left, top, width, height })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const contrast = style.localBackground - style.fillLuma;
  if (contrast < 18) return null;
  const measuredInk = style.inkBounds;
  const hasMeasuredInkBounds = measuredInk &&
    ['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(measuredInk[key])) &&
    measuredInk.right > measuredInk.left && measuredInk.bottom > measuredInk.top;
  const inkClip = dimensionReference && hasMeasuredInkBounds ? {
    left: Math.max(0, Math.floor(measuredInk.left) - 1),
    top: Math.max(0, Math.floor(measuredInk.top) - 1),
    // Ink measured against a clipped OCR box touches its right edge; keep the
    // padded area in that case so the rest of the final glyph is retained.
    right: Math.ceil(measuredInk.right) >= ocrWidth - 1
      ? width
      : Math.min(width, Math.ceil(measuredInk.right) + 1),
    bottom: Math.min(height, Math.ceil(measuredInk.bottom) + 1),
  } : null;
  const rowBackgrounds = [];
  if (dimensionReference) {
    for (let y = 0; y < height; y += 1) {
      const lumas = [];
      for (let x = 0; x < width; x += 1) {
        const k = (y * width + x) * info.channels;
        lumas.push(data[k] * 0.2126 + data[k + 1] * 0.7152 + data[k + 2] * 0.0722);
      }
      lumas.sort((a, b) => a - b);
      rowBackgrounds.push(lumas[Math.floor((lumas.length - 1) * 0.82)]);
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const x = i % width, y = Math.floor(i / width);
    if (inkClip && (x < inkClip.left || x >= inkClip.right || y < inkClip.top || y >= inkClip.bottom)) continue;
    const k = i * info.channels;
    const luma = data[k] * 0.2126 + data[k + 1] * 0.7152 + data[k + 2] * 0.0722;
    const sourceBackground = dimensionReference
      ? Math.max(style.fillLuma + 18, rowBackgrounds[y])
      : style.localBackground;
    const sourceContrast = dimensionReference
      ? sourceBackground - style.fillLuma
      : contrast;
    const alpha = (sourceBackground - luma) / sourceContrast;
    rgba[i * 4 + 3] = alpha < 0.1 ? 0 : Math.min(255, Math.max(0, Math.round(alpha * 255)));
  }
  // OCR can include the cell divider. Remove long, thin connected strokes
  // before measuring glyph height, otherwise a border becomes a tall digit.
  const visited = new Uint8Array(width * height);
  for (let start = 0; start < visited.length; start += 1) {
    if (visited[start] || rgba[start * 4 + 3] < 24) continue;
    const component = [start];
    visited[start] = 1;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      const index = component[cursor], x = index % width, y = Math.floor(index / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || visited[next] || rgba[next * 4 + 3] < 24) continue;
        visited[next] = 1;
        component.push(next);
      }
    }
    if (((maxY - minY + 1) >= height * 0.8 && (maxX - minX + 1) <= height * 0.25) ||
      ((maxX - minX + 1) >= width * 0.9 && (maxY - minY + 1) <= 3)) {
      for (const index of component) rgba[index * 4 + 3] = 0;
    }
  }
  const source = await profile(await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer());
  if (!source || source.bounds.height < 5 ||
    source.bounds.height > style.fontSize * 1.35) return null;
  const size = Math.max(8, Math.min(80, source.bounds.height / 0.75));
  let best = null;
  // Refinement stages revisit their own starting point (spacing 0, angle 0,
  // scale 1). Each evaluation costs an SVG raster plus two sharp passes, so
  // identical candidates are scored once per specimen.
  const evaluated = new Map();
  const evaluate = (referenceText, family, weight, blur, angle,
    candidateSize = size, letterSpacing = 0, smoothMask = false) => {
    const key = [referenceText, family, weight, blur, angle,
      candidateSize.toFixed(3), letterSpacing.toFixed(3), smoothMask].join('|');
    if (!evaluated.has(key)) {
      evaluated.set(key, scoreCandidate(referenceText, family, weight, blur, angle,
        candidateSize, letterSpacing, smoothMask));
    }
    return evaluated.get(key);
  };
  const scoreCandidate = async (referenceText, family, weight, blur, angle,
    candidateSize, letterSpacing, smoothMask) => {
    const buffer = await raster(referenceText, family, weight, candidateSize, blur, angle, 'black', letterSpacing);
    const candidate = await profile(buffer);
    if (!candidate) return null;
    // Normalized glyph shape is primary, while native aspect, height, stroke
    // weight and coverage keep similarly shaped host fallbacks from winning by
    // accident.
    const maskError = smoothMask
      ? smoothedMaskDistance(source.mask, candidate.mask)
      : distance(source.mask, candidate.mask);
    const sourceAspect = source.bounds.width / Math.max(1, source.bounds.height);
    const candidateAspect = candidate.bounds.width / Math.max(1, candidate.bounds.height);
    const aspectError = Math.min(1, Math.abs(Math.log(candidateAspect / sourceAspect)));
    const heightError = Math.min(1,
      Math.abs(candidate.bounds.height - source.bounds.height) / source.bounds.height);
    const coverageError = Math.min(1, Math.abs(candidate.coreAlpha - source.coreAlpha));
    const strokeError = logRatioError(source.strokeRatio, candidate.strokeRatio);
    const inkError = logRatioError(source.inkFraction, candidate.inkFraction);
    const native = await nativeFitError(source, candidate);
    const nativeError = native ? native.error : null;
    const renderError = native ? native.renderError : null;
    const massError = native ? native.massError : null;
    const rawMassError = native ? native.rawMassError : null;
    const rawMassRatio = native ? native.rawMassRatio : null;
    const gainError = native ? native.gainError : null;
    const inkGain = native ? native.inkGain : null;
    // Final-render fidelity leads; the normalized mask remains a shape guard
    // so a native misalignment of a pixel cannot by itself pick an alien face.
    // Stroke width and ink mass are what the eye reads as "weight", so they
    // carry real influence rather than the token share they had before.
    // Weight is judged by rendered ink mass (darkness on the specimen's own
    // ink box, painted exactly as renderMatchedText paints). Whole-pixel
    // stroke runs could not separate regular from bold at 8-12px: a soft
    // regular stroke spans 2px and read as bold on half the labels checked.
    const score = Number.isFinite(nativeError)
      ? nativeError * 0.3 + maskError * 0.2 + massError * 0.3 +
        aspectError * 0.1 + heightError * 0.05 + coverageError * 0.05
      : maskError * 0.42 + strokeError * 0.24 + inkError * 0.18 +
        aspectError * 0.09 + heightError * 0.05 + coverageError * 0.02;
    const fit = {
      family, weight, blur, angle, score, candidate, size: candidateSize,
      letterSpacing, referenceText, aspectError,
    };
    if (collector) {
      collector.push({
        family, weight, blur, angle, size: candidateSize, letterSpacing, referenceText,
        score, nativeError, renderError, massError, rawMassError, rawMassRatio, gainError, inkGain, maskError, aspectError, heightError, coverageError,
        strokeError, inkError,
      });
    }
    if (!best || score < best.score) best = fit;
    return fit;
  };

  // `faces` restricts the search to a face already chosen from the whole
  // label's evidence (see rankFacesAcrossSpecimens).
  const families = faces || await resolveCandidateFaces();
  // Search optical blur jointly with family and weight, never after them.
  //
  // Print gain and camera softness thicken a scanned stroke, so a regular
  // printed digit measures about as wide as a clean bold glyph. Choosing the
  // face at blur 0 therefore made a bold candidate the only way to match that
  // ink, and the later blur refinement could not undo an already locked
  // weight - every slightly soft label came out visibly bolder than its
  // neighbours. Offering "regular face plus blur" as a first-class candidate
  // lets the scan's softness be modelled as softness instead of as weight.
  const originalFaces = [];
  for (const { family, weights } of families) {
    for (const weight of weights) {
      for (const blur of FACE_SEARCH_BLURS) {
        originalFaces.push(await evaluate(text, family, weight, blur, 0));
      }
    }
  }

  // First use the OCR value to identify only a few plausible host faces. If
  // that value is already credible, avoid speculative repair entirely. When
  // it is not, compare one-edit dimension variants only against those faces;
  // this keeps both the accepted language and the search cost tightly bound.
  let selectedReferenceText = text;
  const originalBest = best;
  if (!originalBest) return null;
  if (stage1Only) {
    // Per-face best score (over blur) for cross-specimen face voting.
    const perFace = new Map();
    for (const fit of originalFaces) {
      if (!fit) continue;
      const key = `${fit.family}@${fit.weight}`;
      if (!perFace.has(key) || fit.score < perFace.get(key).score) perFace.set(key, fit);
    }
    return { perFace, best: originalBest };
  }
  // A dropped or doubled OCR digit changes the string length, which shows up
  // as an ink-box aspect mismatch of roughly one glyph (>= ~9% on these
  // 7-10 character values). When the OCR string already spans the ink, a
  // weak score comes from print softness, not a wrong string: "repairing" it
  // then fitted 9 glyphs into 8 glyphs of ink and rendered a squashed face.
  const lengthMismatch = originalBest.aspectError > 0.075;
  if (dimensionReference && lengthMismatch && originalBest.score > DIMENSION_CONFIDENCE_LIMIT) {
    const plausibleFaces = originalFaces
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, 4);
    let repairedBest = null;
    let collapsedDigitBest = null;
    for (const repairedText of dimensionRepairCandidates(text).slice(1)) {
      for (const face of plausibleFaces) {
        const fit = await evaluate(repairedText, face.family, face.weight, face.blur, 0);
        if (!repairedBest || fit.score < repairedBest.score) repairedBest = fit;
        if (isLikelyCollapsedDigitRepair(text, repairedText) &&
          (!collapsedDigitBest || fit.score < collapsedDigitBest.score)) {
          collapsedDigitBest = fit;
        }
      }
    }
    // OCR commonly collapses a repeated digit in the shortest component
    // (for example 11 -> 1). Prefer that repair when its coarse fit remains
    // close to the unrestricted one-edit winner; the strict final score still
    // decides whether the specimen is safe to use.
    if (collapsedDigitBest && repairedBest &&
      collapsedDigitBest.score <= repairedBest.score + 0.04) {
      repairedBest = collapsedDigitBest;
    }
    // The repair must fix the length mismatch it was invoked for and clearly
    // beat the OCR reading; otherwise keep the text OCR actually reported.
    if (repairedBest && repairedBest.score < originalBest.score - 0.02 &&
      repairedBest.aspectError < originalBest.aspectError) {
      best = repairedBest;
      selectedReferenceText = repairedBest.referenceText;
    } else {
      best = originalBest;
    }
  }

  // Each refinement stage carries the winning blur and angle forward. Resetting
  // them to zero here discarded the optical softness selected above and let the
  // later stages re-converge on an over-weighted face.
  const repairedReference = selectedReferenceText !== text;
  const face = { ...best };
  // Grids are deliberately coarse: renderMatchedText re-normalizes height and
  // width onto the specimen, so sub-3% scale steps changed nothing visible
  // while costing about half of every fit.
  for (const spacingRatio of [-0.06, -0.03, 0, 0.03, 0.06]) {
    await evaluate(selectedReferenceText, face.family, face.weight, face.blur, face.angle, size,
      size * spacingRatio, repairedReference);
  }
  const spaced = { ...best };
  for (const angle of [-3, -1.5, 0, 1.5, 3]) {
    await evaluate(selectedReferenceText, spaced.family, spaced.weight, spaced.blur, angle, size,
      spaced.letterSpacing, repairedReference);
  }
  const oriented = { ...best };
  const nearbyBlurs = [0, 0.2, 0.35, 0.5, 0.7, 0.9]
    .filter((blur) => Math.abs(blur - oriented.blur) <= 0.2);
  for (const scale of [0.94, 1, 1.06]) {
    for (const blur of nearbyBlurs) {
      await evaluate(selectedReferenceText, oriented.family, oriented.weight, blur, oriented.angle, size * scale,
        oriented.letterSpacing * scale, repairedReference);
    }
  }
  // Reject clipped words, rules, handwriting, and OCR strings unlike the ink.
  // Repaired references use a stricter final gate than exact OCR text.
  const confidenceLimit = dimensionReference
    ? (repairedReference ? 0.22 : DIMENSION_CONFIDENCE_LIMIT)
    : 0.19;
  if (!best || best.score > confidenceLimit) return null;
  return { ...best, x: left + source.bounds.left, y: top + source.bounds.top,
    width: source.bounds.width, height: source.bounds.height,
    visibleHeight: source.visibleHeight,
    strokeMass: source.strokeMass,
    fill: style.fill, fillRgb: style.fillRgb };
}

async function renderMatchedText(match, text, limits) {
  if (!text || text.length > 128 || /[\r\n]/.test(text)) return null;
  const buffer = await raster(text, match.family, match.weight, match.size, match.blur, match.angle,
    match.fill, match.letterSpacing);
  const measured = await profile(buffer);
  if (!measured) return null;
  const hasTargetVisibleHeight = Number.isFinite(match.targetVisibleHeight);
  const targetVisibleHeight = Math.max(1, hasTargetVisibleHeight
    ? Math.round(match.targetVisibleHeight)
    : Math.round(measured.bounds.height * match.height / match.candidate.bounds.height));

  // `measured.bounds` includes very faint anti-aliased fringe rows. Treating
  // that complete bitmap as the requested visible height can make a nominal
  // 14px replacement look only 12px tall beside the printed dimension text.
  // Measure the replacement's solid visible rows at the same relative-contrast
  // threshold used by sampleTextStyle, then retain its fringe outside the
  // requested visible height. This changes geometry only; family, weight,
  // blur, spacing and ink are untouched.
  let visibleTop = 0;
  let nativeVisibleHeight = measured.bounds.height;
  if (hasTargetVisibleHeight && match.normalizeToVisibleInk && measured.alpha) {
    // Half-core coverage tracks the solid rows perceived as glyph height; the
    // lower 24% threshold still counted faint fringe as type and left some
    // replacements one visible pixel shorter than the printed specimen.
    const visibleThreshold = Math.max(24, Math.round(measured.coreAlpha * 255 * 0.5));
    let firstVisibleRow = measured.bounds.height;
    let lastVisibleRow = -1;
    for (let row = 0; row < measured.bounds.height; row += 1) {
      for (let column = 0; column < measured.bounds.width; column += 1) {
        if (measured.alpha[row * measured.bounds.width + column] < visibleThreshold) continue;
        firstVisibleRow = Math.min(firstVisibleRow, row);
        lastVisibleRow = Math.max(lastVisibleRow, row);
        break;
      }
    }
    if (lastVisibleRow >= firstVisibleRow) {
      visibleTop = firstVisibleRow;
      nativeVisibleHeight = lastVisibleRow - firstVisibleRow + 1;
    }
  }

  // Type-size scale taken from the fit itself: the specimen string was
  // rendered at this exact family/weight/size/angle and its solid visible
  // height compared with the scan's. Applying that ratio to the replacement
  // reproduces the printed font size whatever the row's tilt. Sizing to the
  // specimen's *box* height instead was wrong on tilted rows: a 50px-wide
  // value tilted 3 degrees has a box ~3px taller than its digits, and a short
  // replacement given that box height came out visibly larger.
  const fitScale = match.useFitScale && match.visibleHeight > 0 &&
    match.candidate?.visibleHeight > 0
    ? match.visibleHeight / match.candidate.visibleHeight
    : null;
  const fringeScale = fitScale || (hasTargetVisibleHeight && match.normalizeToVisibleInk
    ? targetVisibleHeight / Math.max(1, nativeVisibleHeight)
    : targetVisibleHeight / Math.max(1, measured.bounds.height));
  const targetHeight = Math.max(1, Math.round(measured.bounds.height * fringeScale));
  const visibleTopOffset = (fitScale ? measured.visibleTop : visibleTop) * fringeScale;
  const renderedVisibleHeight = (fitScale ? measured.visibleHeight : nativeVisibleHeight) * fringeScale;
  const x = Math.max(Math.ceil(limits.x0), Math.round(match.x));
  // A row centre, when given, places the replacement's visible ink centred on
  // the value row, independent of how tall that ink turns out to be.
  const anchorY = Number.isFinite(match.centerY)
    ? match.centerY - renderedVisibleHeight / 2
    : match.y;
  const y = Math.max(Math.ceil(limits.y0), Math.round(anchorY - visibleTopOffset));
  const availableWidth = Math.floor(limits.x1 - x);
  const availableHeight = Math.floor(limits.y1 - y);
  if (availableWidth < 1 || availableHeight < 1) return null;

  // A visible-height override changes the optical font size. Apply that same
  // ratio horizontally so the replacement is enlarged/shrunk like real type,
  // rather than stretching only its y-axis while retaining the old width.
  // Height is set by the target; width follows the specimen's measured set
  // width relative to the host face (thermal print drivers commonly print
  // 10-20% narrower than Liberation/Arial). The ratio is bounded so a stray
  // rule pixel or a residual OCR clip cannot distort the face beyond that.
  const specimenAnisotropy = (match.width / Math.max(1, match.candidate.bounds.width)) /
    (match.height / Math.max(1, match.candidate.bounds.height));
  const xPerY = Number.isFinite(specimenAnisotropy)
    ? Math.max(0.78, Math.min(1.15, specimenAnisotropy))
    : 1;
  const targetWidth = Math.max(1, Math.round(
    measured.bounds.width * (targetHeight / Math.max(1, measured.bounds.height)) * xPerY
  ));
  if (limits.requireExactFit &&
    (targetWidth > availableWidth || targetHeight > availableHeight)) return null;
  const width = Math.max(1, Math.min(availableWidth, targetWidth));
  const height = Math.max(1, Math.min(availableHeight, targetHeight));
  const { data, info } = await sharp(buffer).extract(measured.bounds)
    .resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // The sampled color already contains the scan's apparent transparency.
  // Avoid fading it a second time. Dimension-driven replacements normalize
  // after resizing because punctuation and digit shapes can have less core
  // alpha than the longer reference string.
  let coverage = Math.max(0.35, match.candidate.coreAlpha);
  if (match.normalizeToVisibleInk) {
    const resizedInkAlphas = [];
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] >= 24) resizedInkAlphas.push(data[i]);
    }
    resizedInkAlphas.sort((a, b) => a - b);
    if (resizedInkAlphas.length) {
      coverage = Math.max(0.35,
        resizedInkAlphas[Math.floor(resizedInkAlphas.length * 0.75)] / 255);
    }
  }
  let painted = new Float32Array(info.width * info.height);
  for (let i = 0; i < painted.length; i += 1) {
    painted[i] = Math.min(255, data[i * 4 + 3] / coverage);
  }

  // Stroke-weight calibration. The face search only offers whole weights
  // (DejaVu has Book and Bold, nothing between), and at 8-12px a printer's
  // gain sits between them, so the chosen weight alone left replacements
  // visibly lighter or heavier than the dimension digits beside them. Measure
  // the painted replacement's stroke width exactly as the specimen's was
  // measured and correct the difference with sub-pixel horizontal
  // thickening/thinning. Height and glyph shape are unchanged.
  let strokeAdjustment = 0;
  let renderedStrokeMass = null;
  if (match.matchStrokeWeight && Number.isFinite(match.strokeMass) && match.strokeMass > 0) {
    let adjusted = painted;
    for (let pass = 0; pass < 4; pass += 1) {
      const current = strokeMetrics(adjusted, info.width, info.height).strokeMass;
      renderedStrokeMass = current;
      if (!Number.isFinite(current)) break;
      const delta = match.strokeMass - current;
      if (Math.abs(delta) < 0.05) break;
      // Dilating by t on both edges of a stroke adds about 2t pixels.
      const step = Math.max(-0.75, Math.min(0.75, delta / 2));
      strokeAdjustment += step;
      adjusted = adjustStrokeWidth(adjusted, info.width, info.height, step);
    }
    // Bounded: a correction beyond ~1px means the measurement is unreliable
    // (merged glyphs, stray rule); keep the unadjusted face then.
    if (Math.abs(strokeAdjustment) <= 1.2) painted = adjusted;
    else strokeAdjustment = 0;
  }

  for (let i = 0; i < painted.length; i += 1) {
    data[i * 4] = match.fillRgb.r;
    data[i * 4 + 1] = match.fillRgb.g;
    data[i * 4 + 2] = match.fillRgb.b;
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(painted[i])));
  }
  const input = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return {
    input, left: x, top: y, width: info.width, height: info.height,
    strokeAdjustment: Number(strokeAdjustment.toFixed(3)),
    renderedStrokeMass: Number.isFinite(renderedStrokeMass) ? Number(renderedStrokeMass.toFixed(3)) : null,
    targetStrokeMass: Number.isFinite(match.strokeMass) ? Number(match.strokeMass.toFixed(3)) : null,
  };
}

async function measureTextWidth(text, family, weight, size) {
  // Numeric replacements are short. Bound allocation for unexpected callers.
  if (!text || String(text).length > 128 || !Number.isFinite(size) || size <= 0) return null;
  const measured = await profile(await raster(String(text), family, weight, size));
  return measured ? Math.max(1, measured.bounds.left + measured.bounds.width - size) : null;
}

module.exports = { matchSourceAppearance, renderMatchedText, measureTextWidth };
