'use strict';

/**
 * Glyph transplant: compose a replacement value from glyphs actually printed
 * on the same label.
 *
 * No synthetic font can reproduce a thermal/laser print after scanning: the
 * face, hinting, print gain, toner tone, blur and paper tint all differ a
 * little. The label itself, however, already contains those exact glyphs -
 * the BOXES x DIMENSION rows and the old weight value are printed in the
 * same body style. Cutting individual digits out of them and re-assembling
 * the new value gives the same family, size, weight, color and softness by
 * construction.
 *
 * Pipeline
 *   1. Each specimen (dimension row, old value, other body numbers) is
 *      segmented into connected ink components. A specimen is used only when
 *      the component count equals its OCR text length and every component's
 *      geometry is plausible for its character, so each glyph's identity is
 *      known rather than guessed.
 *   2. Specimens are grouped by digit height; only specimens with exactly the
 *      dimension rows' digit height (and, for page numbers, matching glyph
 *      shapes) join the library.
 *   3. The new value is laid out on the dimension rows' measured digit pitch
 *      (body digits are tabular), on one baseline, starting where the old
 *      value's ink started.
 *   4. Glyphs are applied as a multiply blend of (pixel / local paper), so the
 *      scan's own ink tone and edge softness carry over onto the erased cell.
 *
 * Callers must fall back to font rendering when a required character is not
 * in the library; mixing transplanted and synthetic glyphs would look worse
 * than either alone.
 */

const sharp = require('sharp');

const DIGIT = /^[0-9]$/;
const SUPPORTED = /^[0-9.]+$/;

const luma = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

function median(values) {
  return percentile(values, 0.5);
}

async function readCrop(image, meta, box) {
  const left = Math.max(0, Math.floor(box.x0));
  const top = Math.max(0, Math.floor(box.y0));
  const width = Math.min(meta.width - left, Math.ceil(box.x1) - left);
  const height = Math.min(meta.height - top, Math.ceil(box.y1) - top);
  if (width < 4 || height < 4 || width * height > 250000) return null;
  const { data, info } = await image.clone().extract({ left, top, width, height })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels, left, top };
}

/**
 * Splits a crop into ink components, left to right.
 * Returns null when the crop holds no measurable ink.
 */
function segmentCrop(crop, thresholdFactor = 0.35) {
  const { data, width, height, channels } = crop;
  const n = width * height;
  const rs = [], gs = [], bs = [], ls = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const k = i * channels;
    rs.push(data[k]); gs.push(data[k + 1]); bs.push(data[k + 2]);
    ls[i] = luma(data[k], data[k + 1], data[k + 2]);
  }
  const paper = {
    r: Math.max(1, percentile(rs, 0.85)),
    g: Math.max(1, percentile(gs, 0.85)),
    b: Math.max(1, percentile(bs, 0.85)),
  };
  const paperLuma = luma(paper.r, paper.g, paper.b);
  const dark = new Float32Array(n);
  const inked = [];
  for (let i = 0; i < n; i += 1) {
    dark[i] = Math.max(0, paperLuma - ls[i]);
    if (dark[i] > 12) inked.push(dark[i]);
  }
  if (inked.length < 6) return null;
  const solid = percentile(inked, 0.9);
  if (solid < 25) return null;
  const threshold = Math.max(14, solid * thresholdFactor);

  const labels = new Int32Array(n);
  const components = [];
  for (let start = 0; start < n; start += 1) {
    if (labels[start] || dark[start] < threshold) continue;
    const id = components.length + 1;
    const pixels = [start];
    labels[start] = id;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, mass = 0;
    for (let cursor = 0; cursor < pixels.length; cursor += 1) {
      const index = pixels[cursor];
      const x = index % width, y = (index - x) / width;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      mass += dark[index];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (labels[next] || dark[next] < threshold) continue;
          labels[next] = id;
          pixels.push(next);
        }
      }
    }
    components.push({ id, x0, y0, x1, y1, pixels, mass, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return { paper, paperLuma, dark, labels, components, solid, threshold, width, height };
}

/**
 * Splits a component that blur fused from several glyphs, at the column of
 * least ink inside it. Returns the two halves (with fresh label ids written
 * into segmentation.labels) or null when no clear valley exists.
 */
function splitComponent(segmentation, component, nextId) {
  const { dark, labels, width } = segmentation;
  const columns = new Float64Array(component.w);
  for (const index of component.pixels) columns[(index % width) - component.x0] += dark[index];
  const minPart = 2;
  let bestX = -1, bestValue = Infinity;
  for (let x = minPart; x < component.w - minPart; x += 1) {
    if (columns[x] < bestValue) { bestValue = columns[x]; bestX = x; }
  }
  if (bestX < 0) return null;
  const peakLeft = Math.max(...columns.slice(0, bestX));
  const peakRight = Math.max(...columns.slice(bestX + 1));
  // A real gap between glyphs is a clear dip below both neighbouring strokes.
  if (bestValue > Math.min(peakLeft, peakRight) * 0.8) return null;
  const splitAt = component.x0 + bestX;
  const make = (pixels, id) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, mass = 0;
    for (const index of pixels) {
      const x = index % width, y = (index - x) / width;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      mass += dark[index];
      labels[index] = id;
    }
    return { id, x0, y0, x1, y1, pixels, mass, w: x1 - x0 + 1, h: y1 - y0 + 1, parts: null };
  };
  // The valley column itself goes to whichever side holds more of its ink.
  const leftPixels = [], rightPixels = [];
  for (const index of component.pixels) {
    const x = index % width;
    (x < splitAt || (x === splitAt && columns[bestX - 1] >= columns[bestX + 1]) ? leftPixels : rightPixels)
      .push(index);
  }
  if (!leftPixels.length || !rightPixels.length) return null;
  const left = make(leftPixels, nextId);
  const right = make(rightPixels, nextId + 1);
  left.parts = [left];
  right.parts = [right];
  return [left, right];
}

/**
 * Maps the components of one specimen to the characters of its OCR text.
 * Returns glyph records, or null if identity cannot be established safely.
 */
function identifyGlyphs(segmentation, text, crop, source) {
  const chars = Array.from(String(text).replace(/\s/g, ''));
  if (!chars.length || chars.length > 16) return null;
  const { components, width, height } = segmentation;

  // Drop cell rules, specks and anything clipped by the crop edge (a
  // neighbouring row or word reaching into the padding).
  const digitHeights = components.filter((c) => c.h >= 4).map((c) => c.h);
  const tallest = digitHeights.length ? Math.max(...digitHeights) : 0;
  if (tallest < 5) return null;
  let kept = components.filter((c) => {
    if (c.h >= height * 0.85 && c.w <= Math.max(2, c.h * 0.2)) return false; // vertical rule
    if (c.w >= width * 0.8 && c.h <= 3) return false; // horizontal rule
    // Clipped by the crop: a neighbouring row/word, or a glyph OCR cut off.
    if (c.y0 === 0 || c.y1 === height - 1 || c.x0 === 0 || c.x1 === width - 1) return false;
    return c.pixels.length >= 2;
  });
  // Re-join pieces of one broken glyph (strong horizontal overlap).
  kept.sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const c of kept) {
    const last = merged[merged.length - 1];
    const overlap = last ? Math.min(last.x1, c.x1) - Math.max(last.x0, c.x0) + 1 : 0;
    if (last && overlap >= Math.min(last.w, c.w) * 0.6) {
      last.parts.push(c);
      last.pixels = last.pixels.concat(c.pixels);
      last.x0 = Math.min(last.x0, c.x0); last.x1 = Math.max(last.x1, c.x1);
      last.y0 = Math.min(last.y0, c.y0); last.y1 = Math.max(last.y1, c.y1);
      last.w = last.x1 - last.x0 + 1; last.h = last.y1 - last.y0 + 1;
      last.mass += c.mass;
      continue;
    }
    merged.push({ ...c, parts: [c] });
  }
  // Specks far smaller than a period are noise, unless the text needs a period there.
  const periodCount = chars.filter((ch) => ch === '.').length;
  if (merged.length > chars.length) {
    const specks = merged.filter((c) => c.pixels.length <= 2 && c.h <= 2);
    if (merged.length - specks.length === chars.length && periodCount === 0) {
      kept = merged.filter((c) => !specks.includes(c));
      merged.length = 0; merged.push(...kept);
    }
  }
  // Blur fuses neighbouring glyphs at 8-12px. Split the widest fused blob at
  // its ink valley until the count matches the OCR text; a single glyph is
  // never wider than about 0.9 digit heights in these faces.
  let nextId = segmentation.components.length + 1000;
  while (merged.length < chars.length) {
    let widest = null;
    for (const c of merged) if (!widest || c.w > widest.w) widest = c;
    if (!widest || widest.w < tallest * 0.95) break;
    const halves = splitComponent(segmentation, widest, nextId);
    nextId += 2;
    if (!halves) break;
    merged.splice(merged.indexOf(widest), 1, ...halves);
  }
  if (merged.length !== chars.length) return null;

  const digitComps = merged.filter((_, i) => DIGIT.test(chars[i]));
  if (!digitComps.length) return null;
  const digitHeight = median(digitComps.map((c) => c.h));
  const baseline = median(digitComps.map((c) => c.y1));
  for (let i = 0; i < merged.length; i += 1) {
    const c = merged[i], ch = chars[i];
    if (DIGIT.test(ch)) {
      // Every digit has full digit height and sits on the baseline.
      if (Math.abs(c.h - digitHeight) > Math.max(1, digitHeight * 0.12)) return null;
      if (Math.abs(c.y1 - baseline) > Math.max(1, digitHeight * 0.12)) return null;
      if (c.w > digitHeight * 0.9 || c.w < 1) return null;
    } else if (ch === '.') {
      if (c.h > digitHeight * 0.4 || c.w > digitHeight * 0.45) return null;
      if (Math.abs(c.y1 - baseline) > Math.max(1, digitHeight * 0.15)) return null;
    } else if (/[xX×]/.test(ch)) {
      if (c.h > digitHeight * 0.85 || c.h < digitHeight * 0.35) return null;
    } else {
      return null;
    }
  }

  return merged.map((c, i) => ({
    char: chars[i],
    component: c,
    neighbours: i > 0 && i < merged.length - 1 &&
      DIGIT.test(chars[i - 1]) && DIGIT.test(chars[i + 1])
      ? { prev: merged[i - 1], next: merged[i + 1] }
      : null,
    source,
    crop,
    segmentation,
    digitHeight,
    baseline,
  }));
}

/**
 * Cuts one glyph out of its crop as a multiply-blend patch: per-channel
 * ratio pixel/paper (<= 1) and a coverage mask that includes the glyph's
 * anti-aliased fringe (up to 2px around the thresholded core) but never a
 * neighbour's pixels.
 */
function extractPatch(glyph) {
  const { component, crop, segmentation } = glyph;
  const { labels, dark, paper } = segmentation;
  const { width, height, data, channels } = crop;
  const ids = new Set(component.parts.map((p) => p.id));
  const pad = 2;
  const px0 = Math.max(0, component.x0 - pad), py0 = Math.max(0, component.y0 - pad);
  const px1 = Math.min(width - 1, component.x1 + pad), py1 = Math.min(height - 1, component.y1 + pad);
  const pw = px1 - px0 + 1, ph = py1 - py0 + 1;
  const ratio = new Float32Array(pw * ph * 3).fill(1);
  const mask = new Uint8Array(pw * ph);
  for (let y = py0; y <= py1; y += 1) {
    for (let x = px0; x <= px1; x += 1) {
      const index = y * width + x;
      let own = ids.has(labels[index]);
      if (!own && labels[index] === 0 && dark[index] > 2) {
        // Fringe pixel: claim it only if the nearest core pixel is ours.
        let best = Infinity, bestOwn = false;
        for (let dy = -pad; dy <= pad; dy += 1) {
          for (let dx = -pad; dx <= pad; dx += 1) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const label = labels[ny * width + nx];
            if (!label) continue;
            const d = dx * dx + dy * dy;
            if (d < best) { best = d; bestOwn = ids.has(label); }
          }
        }
        own = bestOwn;
      }
      if (!own) continue;
      const p = (y - py0) * pw + (x - px0);
      const k = index * channels;
      mask[p] = 1;
      ratio[p * 3] = Math.min(1, data[k] / paper.r);
      ratio[p * 3 + 1] = Math.min(1, data[k + 1] / paper.g);
      ratio[p * 3 + 2] = Math.min(1, data[k + 2] / paper.b);
    }
  }
  return {
    width: pw,
    height: ph,
    ratio,
    mask,
    // Offsets from the patch origin to the glyph's ink box.
    inkLeft: component.x0 - px0,
    inkRight: component.x1 - px0,
    inkBottom: component.y1 - py0,
    inkWidth: component.w,
    inkHeight: component.h,
  };
}

/**
 * Resamples a patch by a small factor (bilinear on darkness and coverage) so
 * a glyph printed 1px taller or shorter than the target joins the library.
 */
function rescalePatch(patch, scale) {
  const width = Math.max(1, Math.round(patch.width * scale));
  const height = Math.max(1, Math.round(patch.height * scale));
  const ratio = new Float32Array(width * height * 3).fill(1);
  const mask = new Uint8Array(width * height);
  const sample = (x, y, read) => {
    const fx = Math.min(patch.width - 1, Math.max(0, x)), fy = Math.min(patch.height - 1, Math.max(0, y));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(patch.width - 1, x0 + 1), y1 = Math.min(patch.height - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const v = (xx, yy) => read(yy * patch.width + xx);
    return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = (x + 0.5) / scale - 0.5, sy = (y + 0.5) / scale - 0.5;
      const q = y * width + x;
      const coverage = sample(sx, sy, (i) => patch.mask[i]);
      if (coverage < 0.3) continue;
      mask[q] = 1;
      for (let c = 0; c < 3; c += 1) {
        // Darkness of covered pixels only, so paper outside the mask cannot dilute it.
        const dark = sample(sx, sy, (i) => (patch.mask[i] ? 1 - patch.ratio[i * 3 + c] : 0));
        ratio[q * 3 + c] = Math.max(0, Math.min(1, 1 - dark / coverage));
      }
    }
  }
  return {
    width,
    height,
    ratio,
    mask,
    inkLeft: Math.round(patch.inkLeft * scale),
    inkRight: Math.round(patch.inkRight * scale),
    inkBottom: Math.round((patch.inkBottom + 0.5) * scale - 0.5),
    inkWidth: Math.max(1, Math.round(patch.inkWidth * scale)),
    inkHeight: Math.max(1, Math.round(patch.inkHeight * scale)),
  };
}

/** Normalized correlation of two glyph darkness maps, best of +-1px shifts. */
function glyphSimilarity(a, b) {
  const pa = a.patch, pb = b.patch;
  let best = -1;
  for (let sx = -1; sx <= 1; sx += 1) {
    for (let sy = -1; sy <= 1; sy += 1) {
      let sab = 0, saa = 0, sbb = 0, sa = 0, sb = 0, count = 0;
      for (let y = 0; y < pa.height; y += 1) {
        for (let x = 0; x < pa.width; x += 1) {
          // Align ink boxes at left/bottom.
          const bx = x - pa.inkLeft + pb.inkLeft + sx;
          const by = y - pa.inkBottom + pb.inkBottom + sy;
          const va = 1 - pa.ratio[(y * pa.width + x) * 3 + 1];
          const vb = bx >= 0 && by >= 0 && bx < pb.width && by < pb.height
            ? 1 - pb.ratio[(by * pb.width + bx) * 3 + 1]
            : 0;
          sab += va * vb; saa += va * va; sbb += vb * vb; sa += va; sb += vb; count += 1;
        }
      }
      const cov = sab - (sa * sb) / count;
      const den = Math.sqrt((saa - (sa * sa) / count) * (sbb - (sb * sb) / count));
      if (den > 0) best = Math.max(best, cov / den);
    }
  }
  return best;
}

// Reference digit shapes for identity checks, per digit height.
const templateCache = new Map();
const TEMPLATE_FACES = [
  ['DejaVu Sans', 400], ['DejaVu Sans', 700],
  ['Arial, Helvetica, sans-serif', 400], ['Arial, Helvetica, sans-serif', 700],
];

async function digitTemplates(digitHeight) {
  const key = Math.round(digitHeight);
  if (templateCache.has(key)) return templateCache.get(key);
  const promise = (async () => {
    const templates = new Map();
    for (const [family, weight] of TEMPLATE_FACES) {
      for (const ch of '0123456789') {
        const size = key / 0.73;
        const w = Math.ceil(size * 2), h = Math.ceil(size * 2);
        // eslint-disable-next-line no-await-in-loop
        const { data, info } = await sharp(Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
          `<rect width="100%" height="100%" fill="white"/>` +
          `<text x="${size * 0.4}" y="${size * 1.3}" font-family="${family}" font-weight="${weight}" ` +
          `font-size="${size}" fill="black">${ch}</text></svg>`
        )).greyscale().raw().toBuffer({ resolveWithObject: true });
        let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
        for (let y = 0; y < info.height; y += 1) {
          for (let x = 0; x < info.width; x += 1) {
            if (data[y * info.width + x] > 128) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        if (x1 < 0) continue;
        const pw = x1 - x0 + 3, ph = y1 - y0 + 3;
        const ratio = new Float32Array(pw * ph * 3).fill(1);
        const mask = new Uint8Array(pw * ph);
        for (let y = 0; y < ph; y += 1) {
          for (let x = 0; x < pw; x += 1) {
            const sx = x0 - 1 + x, sy = y0 - 1 + y;
            if (sx < 0 || sy < 0 || sx >= info.width || sy >= info.height) continue;
            const v = data[sy * info.width + sx] / 255;
            if (v > 0.97) continue;
            const i = y * pw + x;
            mask[i] = 1;
            ratio[i * 3] = ratio[i * 3 + 1] = ratio[i * 3 + 2] = v;
          }
        }
        if (!templates.has(ch)) templates.set(ch, []);
        templates.get(ch).push({
          patch: { width: pw, height: ph, ratio, mask, inkLeft: 1, inkRight: x1 - x0 + 1, inkBottom: y1 - y0 + 1 },
        });
      }
    }
    return templates;
  })();
  templateCache.set(key, promise);
  return promise;
}

/**
 * True when every digit of a segmented specimen looks most like the digit
 * OCR says it is. Guards against OCR strings that dropped or swapped a digit
 * (e.g. "0x38x26" for "70x38x26"), whose glyphs would otherwise be filed
 * under the wrong character.
 */
async function digitsConsistent(glyphs) {
  const digits = glyphs.filter((g) => DIGIT.test(g.char));
  if (!digits.length) return false;
  const templates = await digitTemplates(digits[0].digitHeight);
  for (const g of digits) {
    g.patch = g.patch || extractPatch(g);
    let own = -1, other = -1;
    for (const [ch, list] of templates) {
      for (const t of list) {
        const s = glyphSimilarity(g, t);
        if (ch === g.char) own = Math.max(own, s); else other = Math.max(other, s);
      }
    }
    g.identity = { own, other };
    if (process.env.POD_GLYPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`  identity ${g.source} '${g.char}' own=${own.toFixed(3)} other=${other.toFixed(3)}`);
    }
    // At 7-10px 6/8/9/0 are close even for correct glyphs, so only reject on
    // clear evidence that the glyph is a different digit.
    if (own < 0.45 || own < other - 0.08) return false;
  }
  return true;
}

function specimenBox(bbox, extraRight = true) {
  const h = Math.max(4, bbox.y1 - bbox.y0);
  return {
    x0: bbox.x0 - 2,
    y0: bbox.y0 - Math.max(2, h * 0.35),
    x1: bbox.x1 + (extraRight ? Math.max(2, h * 0.45) : 2),
    y1: bbox.y1 + Math.max(2, h * 0.35),
  };
}

async function segmentSpecimen(image, meta, ref, source) {
  const text = String(ref.text || '').replace(/\s/g, '');
  if (!text || !/^[0-9.xX×]+$/.test(text)) return null;
  const crop = await readCrop(image, meta, specimenBox(ref.bbox));
  if (!crop) return null;
  // Lower thresholds keep thin strokes connected; higher ones separate
  // glyphs that blur fused. Use the first that identifies every character.
  let fallback = null;
  for (const factor of [0.35, 0.5, 0.62]) {
    const segmentation = segmentCrop(crop, factor);
    if (!segmentation) continue;
    if (!fallback) fallback = segmentation;
    const glyphs = identifyGlyphs(segmentation, text, crop, source);
    // eslint-disable-next-line no-await-in-loop
    if (glyphs && await digitsConsistent(glyphs)) return { ref, text, crop, segmentation, glyphs };
  }
  return fallback ? { ref, text, crop, segmentation: fallback, glyphs: null } : null;
}

/**
 * Ink geometry of an old value in its cell (works even when its glyphs can
 * not be identified): left edge and baseline in image coordinates.
 */
function inkGeometry(specimen) {
  if (!specimen?.segmentation) return null;
  const { components, height, width } = specimen.segmentation;
  const usable = components.filter((c) =>
    !(c.h >= height * 0.85 && c.w <= Math.max(2, c.h * 0.2)) &&
    !(c.w >= width * 0.8 && c.h <= 3) && c.y0 > 0 && c.y1 < height - 1 && c.pixels.length >= 3);
  if (!usable.length) return null;
  const tall = Math.max(...usable.map((c) => c.h));
  const digits = usable.filter((c) => c.h >= tall * 0.7);
  return {
    left: specimen.crop.left + Math.min(...usable.map((c) => c.x0)),
    baseline: specimen.crop.top + median(digits.map((c) => c.y1)),
    digitHeight: median(digits.map((c) => c.h)),
  };
}

/**
 * Builds the glyph library for one label.
 *
 * @param {sharp.Sharp} image original (unedited) label pixels
 * @param {{width:number,height:number}} meta
 * @param {{dimension: Array, oldValues: Array, page?: Array}} specimens
 */
async function buildGlyphLibrary(image, meta, { dimension = [], oldValues = [], page = [] }) {
  const seen = new Set();
  const unique = (refs) => refs.filter((ref) => {
    if (!ref?.bbox) return false;
    const key = [ref.bbox.x0, ref.bbox.y0, ref.bbox.x1, ref.bbox.y1].map(Math.round).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dimensionSpecimens = [];
  for (const ref of unique(dimension).slice(0, 8)) {
    // eslint-disable-next-line no-await-in-loop
    const s = await segmentSpecimen(image, meta, ref, 'dimension');
    if (s?.glyphs) dimensionSpecimens.push(s);
  }
  if (!dimensionSpecimens.length) return null;

  // The dimension rows define the target digit height and pitch.
  const digitHeight = median(dimensionSpecimens.map((s) => s.glyphs[0].digitHeight));
  const sameHeight = (s) => Math.abs(s.glyphs[0].digitHeight - digitHeight) <= 0.5;
  const base = dimensionSpecimens.filter(sameHeight);
  if (!base.length) return null;

  const pitches = [];
  for (const s of base) {
    for (let i = 1; i < s.glyphs.length; i += 1) {
      const a = s.glyphs[i - 1], b = s.glyphs[i];
      if (!DIGIT.test(a.char) || !DIGIT.test(b.char)) continue;
      pitches.push(((b.component.x0 + b.component.x1) - (a.component.x0 + a.component.x1)) / 2);
    }
  }
  const pitch = median(pitches);
  if (!Number.isFinite(pitch) || pitch < digitHeight * 0.35 || pitch > digitHeight * 1.1) return null;

  const library = new Map();
  const add = (glyph, priority) => {
    if (!SUPPORTED.test(glyph.char)) return;
    glyph.patch = glyph.patch || extractPatch(glyph);
    glyph.priority = priority;
    if (!library.has(glyph.char)) library.set(glyph.char, []);
    library.get(glyph.char).push(glyph);
  };
  // Same face printed one pixel taller/shorter (a different row of the same
  // label): usable after a small resample, ranked after exact-height glyphs.
  const nearHeight = (s) => {
    const h = s.glyphs[0].digitHeight;
    return !sameHeight(s) && Math.abs(h - digitHeight) <= Math.max(1.5, digitHeight * 0.12);
  };
  const addRescaled = (s, priority) => {
    const scale = digitHeight / s.glyphs[0].digitHeight;
    for (const g of s.glyphs) {
      if (!SUPPORTED.test(g.char)) continue;
      const patch = rescalePatch(extractPatch(g), scale);
      add({
        ...g,
        patch,
        component: { ...g.component, h: Math.round(g.component.h * scale), w: patch.inkWidth },
        rescaled: scale,
      }, priority);
    }
  };

  const oldValueGeometry = new Map();
  const oldSpecimens = [];
  for (const ref of oldValues.slice(0, 6)) {
    // eslint-disable-next-line no-await-in-loop
    const s = await segmentSpecimen(image, meta, ref, 'oldValue');
    if (!s) continue;
    const geometry = inkGeometry(s);
    if (geometry) oldValueGeometry.set(ref.key ?? ref.bbox, geometry);
    if (s.glyphs) oldSpecimens.push(s);
  }
  // Same cell, same print pass: the old value's own glyphs come first.
  for (const s of oldSpecimens) if (sameHeight(s)) for (const g of s.glyphs) add(g, 0);
  for (const s of base) for (const g of s.glyphs) add(g, 1);
  for (const s of oldSpecimens) if (nearHeight(s)) addRescaled(s, 3);
  for (const s of dimensionSpecimens) if (nearHeight(s)) addRescaled(s, 3);

  // Other body numbers on the page widen coverage, but only when they share
  // the digit height *and* their shared glyphs look like the dimension ones.
  for (const ref of unique(page).slice(0, 40)) {
    if (!/^[0-9.]+$/.test(String(ref.text || '').replace(/\s/g, ''))) continue;
    // eslint-disable-next-line no-await-in-loop
    const s = await segmentSpecimen(image, meta, ref, 'page');
    if (!s?.glyphs || !(sameHeight(s) || nearHeight(s))) continue;
    if (nearHeight(s)) {
      // Rescaled page glyphs are the last resort, and still must look like
      // the label's body digits wherever a shared character allows a check.
      const scale = digitHeight / s.glyphs[0].digitHeight;
      let compared = 0, agreeing = 0;
      for (const g of s.glyphs) {
        const reference = (library.get(g.char) || []).find((r) => r.source !== 'page');
        if (!reference) continue;
        compared += 1;
        if (glyphSimilarity({ patch: rescalePatch(extractPatch(g), scale) }, reference) >= 0.8) agreeing += 1;
      }
      if (compared >= 2 && agreeing === compared) addRescaled(s, 4);
      continue;
    }
    let compared = 0, agreeing = 0;
    for (const g of s.glyphs) {
      const reference = (library.get(g.char) || []).find((r) => r.source !== 'page');
      if (!reference) continue;
      g.patch = extractPatch(g);
      compared += 1;
      if (glyphSimilarity(g, reference) >= 0.82) agreeing += 1;
    }
    if (compared >= 2 && agreeing === compared) for (const g of s.glyphs) add(g, 2);
  }

  // Advance of '.', measured where a printed value has digit '.' digit:
  // centre-to-centre distance across the period minus one digit pitch.
  // A period is a square dot one stroke wide. When the label prints none at
  // this size, build it from the label's own digits: side = their measured
  // vertical-stroke width, core tone = their core ink, edges = their fringe.
  if (!library.has('.')) {
    const digits = [...library.entries()].filter(([ch]) => DIGIT.test(ch)).flatMap(([, gs]) => gs);
    const widths = [], cores = [[], [], []], fringes = [[], [], []];
    for (const g of digits) {
      const p = g.patch;
      for (let y = 0; y < p.height; y += 1) {
        let run = 0;
        for (let x = 0; x < p.width; x += 1) {
          const i = y * p.width + x;
          const darkness = p.mask[i] ? 1 - p.ratio[i * 3 + 1] : 0;
          if (darkness > 0.5) run += 1;
          else { if (run) widths.push(run); run = 0; }
          if (!p.mask[i]) continue;
          for (let c = 0; c < 3; c += 1) {
            const v = p.ratio[i * 3 + c];
            if (darkness > 0.6) cores[c].push(v); else if (darkness > 0.15) fringes[c].push(v);
          }
        }
        if (run) widths.push(run);
      }
    }
    const side = Math.max(1, Math.round(median(widths) || 1));
    if (cores[1].length) {
      const pad = 1, w = side + pad * 2;
      const ratio = new Float32Array(w * w * 3).fill(1);
      const mask = new Uint8Array(w * w);
      for (let y = 0; y < w; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const core = x >= pad && x < pad + side && y >= pad && y < pad + side;
          const corner = (x === 0 || x === w - 1) && (y === 0 || y === w - 1);
          if (corner) continue;
          const i = y * w + x;
          mask[i] = 1;
          for (let c = 0; c < 3; c += 1) {
            ratio[i * 3 + c] = core ? median(cores[c]) : (median(fringes[c]) ?? 1);
          }
        }
      }
      const patch = {
        width: w, height: w, ratio, mask,
        inkLeft: pad, inkRight: pad + side - 1, inkBottom: pad + side - 1, inkWidth: side, inkHeight: side,
      };
      add({ char: '.', patch, component: { h: side, w: side, mass: 0, pixels: [] }, source: 'synth-period' }, 5);
    }
  }

  // A period is not centred in its advance (it sits close to the preceding
  // digit), so measure its two offsets separately where the label prints
  // digit '.' digit: previous digit centre -> period ink centre, and period
  // ink centre -> next digit centre.
  const beforePeriod = [], afterPeriod = [];
  for (const glyphs of library.values()) {
    for (const g of glyphs) {
      if (g.char !== '.' || !g.neighbours) continue;
      const { prev, next } = g.neighbours;
      const centre = (g.component.x0 + g.component.x1) / 2;
      beforePeriod.push(centre - (prev.x0 + prev.x1) / 2);
      afterPeriod.push((next.x0 + next.x1) / 2 - centre);
    }
  }
  const before = median(beforePeriod), after = median(afterPeriod);
  const periodOffsets = Number.isFinite(before) && Number.isFinite(after) &&
    before > pitch * 0.25 && after > pitch * 0.25 && before + after < pitch * 2.2
    ? { before, after }
    : { before: pitch * 0.75, after: pitch * 0.75 };

  return { library, pitch, periodOffsets, digitHeight, oldValueGeometry, specimenCount: base.length };
}

/**
 * Candidates for one character, best first: same print pass first (old
 * value, then dimension rows, then page numbers), then the glyph whose shape
 * most clearly reads as that digit, then the one closest to the target
 * height. `variant` walks down the list so a caller can retry when OCR
 * verification of a composite fails.
 */
function rankGlyphs(candidates, digitHeight) {
  const margin = (g) => (g.identity ? g.identity.own - g.identity.other : 0);
  return [...candidates].sort((a, b) =>
    a.priority - b.priority ||
    margin(b) - margin(a) ||
    Math.abs(a.component.h - digitHeight) - Math.abs(b.component.h - digitHeight));
}

function chooseGlyph(candidates, digitHeight, variant = 0) {
  const ranked = rankGlyphs(candidates, digitHeight);
  return ranked[variant % ranked.length];
}

/** Number of distinct glyph choices available for `text` (for retries). */
function variantCount(glyphLibrary, text) {
  if (!glyphLibrary) return 0;
  return Math.max(1, ...Array.from(String(text)).map((ch) => glyphLibrary.library.get(ch)?.length || 1));
}

/** Characters of `text` the library cannot supply. */
function missingCharacters(glyphLibrary, text) {
  if (!glyphLibrary) return Array.from(String(text));
  return Array.from(new Set(Array.from(String(text)).filter((ch) => !glyphLibrary.library.has(ch))));
}

/**
 * Lays out `text` and returns a multiply-blend overlay, or null.
 *
 * @param {object} glyphLibrary from buildGlyphLibrary
 * @param {string} text digits and '.'
 * @param {{inkLeft:number, baseline:number, maxRight:number, minTop?:number, maxBottom?:number}} placement
 *        image coordinates: first glyph's ink left edge, baseline row, limits
 */
async function renderGlyphTransplant(glyphLibrary, text, placement, { variant = 0 } = {}) {
  const value = String(text);
  if (!glyphLibrary || !SUPPORTED.test(value) || value.length > 16) return null;
  if (missingCharacters(glyphLibrary, value).length) return null;
  const { pitch, digitHeight, periodOffsets } = glyphLibrary;
  const chars = Array.from(value);
  const glyphs = chars.map((ch) => chooseGlyph(glyphLibrary.library.get(ch), digitHeight, variant));
  // Glyph centres: tabular digits one pitch apart; a period uses the offsets
  // measured on this label from the previous digit and to the next one.
  const centres = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (i === 0) { centres.push(0); continue; }
    const step = chars[i] === '.'
      ? periodOffsets.before
      : chars[i - 1] === '.' ? periodOffsets.after : pitch;
    centres.push(centres[i - 1] + step);
  }
  // Shift so the first glyph's ink starts at placement.inkLeft.
  const shift = placement.inkLeft + glyphs[0].patch.inkWidth / 2;

  const placed = [];
  for (let i = 0; i < glyphs.length; i += 1) {
    const patch = glyphs[i].patch;
    const inkLeft = Math.round(shift + centres[i] - patch.inkWidth / 2);
    placed.push({
      patch,
      left: inkLeft - patch.inkLeft,
      top: Math.round(placement.baseline) - patch.inkBottom,
    });
  }
  const x0 = Math.min(...placed.map((p) => p.left));
  const y0 = Math.min(...placed.map((p) => p.top));
  const x1 = Math.max(...placed.map((p) => p.left + p.patch.width));
  const y1 = Math.max(...placed.map((p) => p.top + p.patch.height));
  const inkRight = Math.max(...placed.map((p) => p.left + p.patch.inkRight));
  if (Number.isFinite(placement.maxRight) && inkRight > placement.maxRight) return null;
  if (Number.isFinite(placement.minTop) && y0 + 2 < placement.minTop) return null;
  if (Number.isFinite(placement.maxBottom) && y1 - 2 > placement.maxBottom) return null;

  const width = x1 - x0, height = y1 - y0;
  const ratio = new Float32Array(width * height * 3).fill(1);
  const mask = new Uint8Array(width * height);
  for (const { patch, left, top } of placed) {
    for (let y = 0; y < patch.height; y += 1) {
      for (let x = 0; x < patch.width; x += 1) {
        const p = y * patch.width + x;
        if (!patch.mask[p]) continue;
        const q = (top - y0 + y) * width + (left - x0 + x);
        mask[q] = 1;
        for (let c = 0; c < 3; c += 1) ratio[q * 3 + c] *= patch.ratio[p * 3 + c];
      }
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = Math.round(ratio[i * 3] * 255);
    rgba[i * 4 + 1] = Math.round(ratio[i * 3 + 1] * 255);
    rgba[i * 4 + 2] = Math.round(ratio[i * 3 + 2] * 255);
    rgba[i * 4 + 3] = mask[i] ? 255 : 0;
  }
  const input = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return {
    input,
    left: x0,
    top: y0,
    width,
    height,
    blend: 'multiply',
    sources: glyphs.map((g) => g.source),
    // For verification: the same composite on clean paper.
    preview: { rgba, width, height },
  };
}

/** Renders an overlay's preview on white for OCR verification. */
async function previewForOcr(overlay, scale = 4) {
  const { rgba, width, height } = overlay.preview;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = Math.round(255 * (1 - a) + rgba[i * 4 + c] * a);
  }
  const pad = Math.max(4, Math.round(height * 0.6));
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
    .resize({ width: (width + pad * 2) * scale, kernel: 'lanczos3' })
    .greyscale().normalize().png().toBuffer();
}

module.exports = {
  buildGlyphLibrary,
  renderGlyphTransplant,
  missingCharacters,
  previewForOcr,
  variantCount,
  // exported for tests
  segmentCrop,
  identifyGlyphs,
};
