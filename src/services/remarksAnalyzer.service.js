'use strict';

const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');

const ocrService = require('./ocr.service');
const { findHeaderShipmentId } = require('./labelMatcher.service');

const MAX_ANALYSIS_WIDTH = 1400;
const MAX_ANALYSIS_PIXELS = 1800000;
const OCR_MAX_DIMENSION = 4800;
const OCR_MAX_PIXELS = 16000000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const center = (box) => ({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 });
const intersects = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const containsPoint = (box, x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
const normalizedText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function median(values) {
  return percentile(values, 0.5);
}

function unionBoxes(boxes) {
  return {
    x0: Math.min(...boxes.map((box) => box.x0)),
    y0: Math.min(...boxes.map((box) => box.y0)),
    x1: Math.max(...boxes.map((box) => box.x1)),
    y1: Math.max(...boxes.map((box) => box.y1)),
  };
}

function scaleBox(box, scale) {
  return {
    x0: Math.floor(box.x0 * scale),
    y0: Math.floor(box.y0 * scale),
    x1: Math.ceil(box.x1 * scale),
    y1: Math.ceil(box.y1 * scale),
  };
}

function boundedOcrScale(width, height, requested) {
  const byDimension = OCR_MAX_DIMENSION / Math.max(1, width, height);
  const byPixels = Math.sqrt(OCR_MAX_PIXELS / Math.max(1, width * height));
  return Math.max(1, Math.min(requested, byDimension, byPixels));
}

function orientationScore(words, meta) {
  const vocabulary = /shipment|delivered|recipient|invoice|actual|weight|boxes|dimension|remarks|damaged|signature|stamp|contain/i;
  const semantic = words.filter((word) => word.confidence >= 20 && vocabulary.test(word.text));
  const headerId = findHeaderShipmentId(words, meta);
  const topWords = semantic.filter((word) => word.bbox.y0 < meta.height * 0.42).length;
  const leftToRight = semantic.filter((word) => word.bbox.x0 < meta.width * 0.75).length;
  return semantic.length * 2 + topWords + Math.min(5, leftToRight) + (headerId ? 12 : 0);
}

async function readOrientation(input, rotation) {
  const pixels = rotation ? await sharp(input).rotate(rotation).toBuffer() : input;
  const meta = await sharp(pixels).metadata();
  const { words } = await ocrService.recognize(pixels);
  return { input: pixels, meta, words, rotation, score: orientationScore(words, meta) };
}

async function chooseOrientation(input) {
  const initial = await readOrientation(input, 0);
  if (initial.score >= 24) return initial;
  let best = initial;
  for (const rotation of [90, 180, 270]) {
    // eslint-disable-next-line no-await-in-loop
    const candidate = await readOrientation(input, rotation);
    if (candidate.score > best.score) best = candidate;
    if (best.score >= 28 && findHeaderShipmentId(best.words, best.meta)) break;
  }
  return best;
}

function digitDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = saved;
    }
  }
  return previous[b.length];
}

function filenameId(filename) {
  const matches = path.basename(filename || '').match(/\d{8,12}/g) || [];
  return matches.sort((a, b) => Math.abs(a.length - 9) - Math.abs(b.length - 9) || b.length - a.length)[0] || null;
}

async function rereadHeaderId(input, meta) {
  const crops = [
    { left: 0.42, top: 0, width: 0.38, height: 0.16 },
    { left: 0.66, top: 0, width: 0.34, height: 0.15 },
  ];
  const candidates = [];
  for (const zone of crops) {
    const crop = {
      left: Math.floor(meta.width * zone.left),
      top: Math.floor(meta.height * zone.top),
      width: Math.max(1, Math.round(meta.width * zone.width)),
      height: Math.max(1, Math.round(meta.height * zone.height)),
    };
    crop.width = Math.min(crop.width, meta.width - crop.left);
    crop.height = Math.min(crop.height, meta.height - crop.top);
    const scale = boundedOcrScale(crop.width, crop.height, 4);
    // eslint-disable-next-line no-await-in-loop
    const prepared = await sharp(input).extract(crop)
      .resize({ width: Math.round(crop.width * scale), height: Math.round(crop.height * scale) })
      .greyscale().normalize().sharpen().png().toBuffer();
    for (const psm of [7, 11]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await ocrService.recognize(prepared, { psm, whitelist: '0123456789' });
      for (const word of result.words) {
        const digits = String(word.text || '').replace(/\D/g, '');
        if (/^\d{8,12}$/.test(digits)) candidates.push({ id: digits, confidence: word.confidence });
      }
      const joined = result.words.map((word) => String(word.text || '').replace(/\D/g, '')).join('');
      if (/^\d{8,12}$/.test(joined)) {
        candidates.push({ id: joined, confidence: Math.min(100, ...result.words.map((word) => word.confidence)) });
      }
    }
  }
  return candidates.sort((a, b) =>
    (b.id.length === 9 ? 1 : 0) - (a.id.length === 9 ? 1 : 0) || b.confidence - a.confidence
  )[0] || null;
}

function findAnchors(words, pattern) {
  return words.filter((word) => pattern.test(normalizedText(word.text)));
}

function detectHorizontalRules(dark, width, height, threshold) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) if (dark[y * width + x] >= threshold) count += 1;
    if (count >= width * 0.32) rows.push(y);
  }
  const groups = [];
  for (const row of rows) {
    const group = groups[groups.length - 1];
    if (group && row <= group[group.length - 1] + 2) group.push(row);
    else groups.push([row]);
  }
  return groups.map((group) => Math.round(median(group)));
}

function locateLabel(words, width, height, rules, medianWordHeight) {
  const confident = words.filter((word) => word.confidence >= 35 && word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0);
  const wordBounds = confident.length ? unionBoxes(confident.map((word) => word.bbox)) : {
    x0: width * 0.03, y0: height * 0.02, x1: width * 0.97, y1: height * 0.78,
  };
  const footerWords = confident.filter((word) =>
    /printed|document|terms|limited|registered|transporter/i.test(word.text) && word.bbox.y0 > height * 0.48
  );
  const footerBottom = footerWords.length
    ? Math.max(...footerWords.map((word) => word.bbox.y1)) + medianWordHeight * 1.5
    : 0;
  const lastRule = rules.filter((row) => row > height * 0.45 && row < height * 0.96).at(-1) || 0;
  // A long bottom rule is stronger evidence than OCR bounds: stamps and
  // handwritten notes below the label are often OCR'd and would otherwise be
  // mistaken for part of the printed form.
  const bottom = clamp(lastRule || footerBottom || wordBounds.y1, height * 0.52, height * 0.96);
  return {
    x0: clamp(wordBounds.x0 - medianWordHeight * 2, 0, width * 0.12),
    y0: clamp(wordBounds.y0 - medianWordHeight, 0, height * 0.08),
    x1: clamp(wordBounds.x1 + medianWordHeight * 2, width * 0.88, width),
    y1: bottom,
  };
}

function markBox(mask, width, height, box, pad = 0) {
  const x0 = clamp(Math.floor(box.x0 - pad), 0, width);
  const y0 = clamp(Math.floor(box.y0 - pad), 0, height);
  const x1 = clamp(Math.ceil(box.x1 + pad), 0, width);
  const y1 = clamp(Math.ceil(box.y1 + pad), 0, height);
  for (let y = y0; y < y1; y += 1) mask.fill(1, y * width + x0, y * width + x1);
}

function componentize(binary, strength, width, height) {
  const seen = new Uint8Array(binary.length);
  const components = [];
  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || seen[start]) continue;
    seen[start] = 1;
    const pixels = [start];
    let x0 = width, y0 = height, x1 = -1, y1 = -1, mass = 0;
    for (let cursor = 0; cursor < pixels.length; cursor += 1) {
      const index = pixels[cursor];
      const x = index % width;
      const y = (index - x) / width;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      mass += strength[index];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (binary[next] && !seen[next]) {
            seen[next] = 1;
            pixels.push(next);
          }
        }
      }
    }
    components.push({ pixels, area: pixels.length, mass, x0, y0, x1: x1 + 1, y1: y1 + 1, width: x1 - x0 + 1, height: y1 - y0 + 1 });
  }
  return components;
}

function groupComponents(components, medianHeight) {
  const parent = components.map((_, index) => index);
  const root = (index) => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) parent[b] = a; };
  for (let i = 0; i < components.length; i += 1) {
    const a = components[i];
    for (let j = i + 1; j < components.length; j += 1) {
      const b = components[j];
      const gapX = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
      const gapY = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
      const centerY = Math.abs((a.y0 + a.y1 - b.y0 - b.y1) / 2);
      const sameLine = centerY <= Math.max(medianHeight * 0.72, Math.min(a.height, b.height) * 0.8) &&
        gapY <= medianHeight * 0.55 && gapX <= medianHeight * 2.4;
      if (sameLine) join(i, j);
    }
  }
  const groups = new Map();
  components.forEach((component, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(component);
  });
  return [...groups.values()].map((members) => ({ members, ...unionBoxes(members) }));
}

function groupStampComponents(components, medianHeight) {
  const parent = components.map((_, index) => index);
  const root = (index) => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  for (let i = 0; i < components.length; i += 1) {
    for (let j = i + 1; j < components.length; j += 1) {
      const a = components[i], b = components[j];
      const gapX = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
      const gapY = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
      if (gapX <= medianHeight * 1.25 && gapY <= medianHeight * 1.25) {
        const ra = root(i), rb = root(j);
        if (ra !== rb) parent[rb] = ra;
      }
    }
  }
  const groups = new Map();
  components.forEach((component, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(component);
  });
  return [...groups.values()].map((members) => ({ members, ...unionBoxes(members) }));
}

function stampLike(group, binary, width, height, medianHeight, stampAnchors) {
  const boxWidth = group.x1 - group.x0;
  const boxHeight = group.y1 - group.y0;
  if (boxWidth < medianHeight * 4 || boxHeight < medianHeight * 3.5 ||
      boxWidth > width * 0.22 || boxHeight > height * 0.24) return false;
  const ratio = boxWidth / Math.max(1, boxHeight);
  const nearStampAnchor = stampAnchors.some((anchor) => {
    const c = center(anchor.bbox);
    return c.x >= group.x0 - boxWidth && c.x <= group.x1 + boxWidth && c.y <= group.y1 && c.y >= group.y0 - boxHeight * 1.5;
  });
  if (ratio < 0.55 || ratio > 1.8) return false;
  if (!nearStampAnchor && group.members.length < 3) return false;
  const bandX = Math.max(1, Math.round(boxWidth * 0.18));
  const bandY = Math.max(1, Math.round(boxHeight * 0.18));
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let y = group.y0; y < group.y1; y += 1) {
    for (let x = group.x0; x < group.x1; x += 1) {
      if (!binary[y * width + x]) continue;
      if (y < group.y0 + bandY) top += 1;
      if (y >= group.y1 - bandY) bottom += 1;
      if (x < group.x0 + bandX) left += 1;
      if (x >= group.x1 - bandX) right += 1;
    }
  }
  const sideMinimum = Math.max(2, Math.min(boxWidth, boxHeight) * 0.08);
  return top >= sideMinimum && bottom >= sideMinimum && left >= sideMinimum && right >= sideMinimum;
}

function signatureExclusions(words, label, medianHeight, width, height) {
  const exclusions = [];
  const anchors = findAnchors(words, /receiver|signature|shipperssign|requiredsignature|deliveryemp/);
  for (const anchor of anchors) {
    const text = normalizedText(anchor.text);
    if (text.includes('receiver')) {
      exclusions.push({
        type: 'receiver_signature',
        bbox: {
          x0: clamp(anchor.bbox.x0 - medianHeight * 2, 0, width),
          y0: clamp(anchor.bbox.y0 - medianHeight, 0, height),
          x1: label.x1,
          y1: clamp(anchor.bbox.y1 + medianHeight * 7, 0, label.y1),
        },
      });
    } else {
      exclusions.push({
        type: 'signature_field',
        bbox: {
          x0: clamp(anchor.bbox.x0 - medianHeight, 0, width),
          y0: clamp(anchor.bbox.y0 - medianHeight, 0, height),
          x1: clamp(anchor.bbox.x1 + medianHeight * 12, 0, width),
          y1: clamp(anchor.bbox.y1 + medianHeight * 4, 0, label.y1),
        },
      });
    }
  }
  return exclusions;
}

function zoneFor(box, label, words, medianHeight) {
  const c = center(box);
  if (c.y > label.y1 + medianHeight * 0.5) return 'below_label';
  const named = [
    ['damaged_content', /damaged|damage/],
    ['items_missing', /items|missing|receivedboxes/],
    ['pod_remarks', /podremarks|remarks/],
    ['date_time', /dateofreceipt|timeofreceipt/],
    ['stamp_area', /stamp|seal/],
  ];
  for (const [name, pattern] of named) {
    const anchors = findAnchors(words, pattern);
    if (anchors.some((anchor) => {
      const a = center(anchor.bbox);
      return c.x >= anchor.bbox.x0 - medianHeight * 2 &&
        c.x <= anchor.bbox.x1 + medianHeight * 18 &&
        c.y >= a.y - medianHeight && c.y <= a.y + medianHeight * 14;
    })) return name;
  }
  return c.x >= label.x0 && c.x <= label.x1 && c.y >= label.y0 && c.y <= label.y1
    ? 'label_body'
    : 'outside_label';
}

function reasonsForGroup(group, zone, medianHeight, overlappingWords, coloredRatio) {
  const count = group.members.length;
  const width = group.x1 - group.x0;
  const height = group.y1 - group.y0;
  const reasons = [];
  let score = zone === 'damaged_content' || zone === 'items_missing' || zone === 'pod_remarks'
    ? 34
    : zone === 'below_label' ? 28 : zone === 'date_time' || zone === 'stamp_area' ? 22 : 8;
  if (count >= 3) { score += 14; reasons.push('MULTIPLE_INK_COMPONENTS'); }
  if (count >= 7) { score += 8; reasons.push('HANDWRITING_CLUSTER'); }
  if (width >= medianHeight * 3) { score += 10; reasons.push('WORD_LENGTH_INK'); }
  if (height >= medianHeight * 1.25) { score += 8; reasons.push('IRREGULAR_TEXT_HEIGHT'); }
  if (coloredRatio >= 0.12) { score += 8; reasons.push('COLORED_PEN_INK'); }
  const text = overlappingWords
    .filter((word) => word.confidence < 55)
    .map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
  if (text.replace(/[^a-z0-9]/gi, '').length >= 3) {
    score += 14;
    reasons.push('OCR_TEXT_SUPPORT');
  }
  if (zone !== 'label_body') reasons.unshift(`ZONE_${zone.toUpperCase()}`);
  return { score: clamp(score, 0, 100), reasons, text };
}

function expectedBoxCount(words, medianHeight) {
  const totalAnchors = words.filter((word) => /total/i.test(word.text));
  for (const anchor of totalAnchors) {
    const nearby = words.filter((word) => {
      const c = center(word.bbox);
      const a = center(anchor.bbox);
      return Math.abs(c.y - a.y) <= medianHeight * 1.4 &&
        word.bbox.x0 >= anchor.bbox.x0 && word.bbox.x0 <= anchor.bbox.x0 + medianHeight * 30;
    }).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const rowText = nearby.map((word) => word.text).join(' ');
    if (!/box/i.test(rowText)) continue;
    const explicit = rowText.match(/boxes?\D{0,4}(\d{1,4})(?:\D|$)/i);
    if (explicit) return Number(explicit[1]);
    const numbers = nearby
      .filter((word) => word.bbox.x0 > anchor.bbox.x1)
      .flatMap((word) => String(word.text).match(/\b\d{1,4}\b/g) || [])
      .map(Number).filter((value) => value > 0 && value <= 5000);
    if (numbers.length) return numbers.at(-1);
  }
  return null;
}

async function readColorLineText(input, meta, box, analysisScale, medianHeight) {
  const source = {
    x0: clamp(Math.floor((box.x0 - medianHeight * 4) / analysisScale), 0, meta.width - 1),
    y0: clamp(Math.floor((box.y0 - medianHeight * 1.5) / analysisScale), 0, meta.height - 1),
    x1: clamp(Math.ceil((box.x1 + medianHeight * 14) / analysisScale), 1, meta.width),
    y1: clamp(Math.ceil((box.y1 + medianHeight * 1.5) / analysisScale), 1, meta.height),
  };
  if (source.x1 <= source.x0 || source.y1 <= source.y0) return { text: '', confidence: 0 };
  const width = source.x1 - source.x0, height = source.y1 - source.y0;
  const { data, info } = await sharp(input).extract({ left: source.x0, top: source.y0, width, height })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const isolated = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const k = (y * width + x) * info.channels;
      const r = data[k], g = data[k + 1], b = data[k + 2];
      const coolBlue = b - Math.min(r, g) >= 10 && b >= g - 3;
      const purple = r - g >= 8 && b - g >= 8;
      if (!coolBlue && !purple) continue;
      const darkness = Math.max(0, 255 - Math.min(r, g, b));
      if (darkness < 32) continue;
      isolated[y * width + x] = Math.max(0, 255 - darkness);
    }
  }
  const scale = boundedOcrScale(width, height, clamp(44 / Math.max(4, medianHeight / analysisScale), 2, 6));
  const prepared = await sharp(isolated, { raw: { width, height, channels: 1 } })
    .resize({ width: Math.round(width * scale), height: Math.round(height * scale), kernel: 'lanczos3' })
    .normalize().sharpen().png().toBuffer();
  const reads = [];
  for (const psm of [7, 6, 11]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await ocrService.recognize(prepared, { psm });
    const text = result.words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text) reads.push({ text, confidence: median(result.words.map((word) => word.confidence)) || 0 });
  }
  return reads.sort((a, b) => b.confidence - a.confidence || b.text.length - a.text.length)[0] || {
    text: '', confidence: 0,
  };
}

async function readOriginalLineText(input, meta, box, analysisScale, medianHeight) {
  const source = {
    x0: clamp(Math.floor((box.x0 - medianHeight * 10) / analysisScale), 0, meta.width - 1),
    y0: clamp(Math.floor((box.y0 - medianHeight * 1.8) / analysisScale), 0, meta.height - 1),
    x1: clamp(Math.ceil((box.x1 + medianHeight * 12) / analysisScale), 1, meta.width),
    y1: clamp(Math.ceil((box.y1 + medianHeight * 1.8) / analysisScale), 1, meta.height),
  };
  if (source.x1 <= source.x0 || source.y1 <= source.y0) return { text: '', confidence: 0 };
  const width = source.x1 - source.x0, height = source.y1 - source.y0;
  const scale = boundedOcrScale(width, height, clamp(44 / Math.max(4, medianHeight / analysisScale), 2, 6));
  const prepared = await sharp(input).extract({ left: source.x0, top: source.y0, width, height })
    .resize({ width: Math.round(width * scale), height: Math.round(height * scale), kernel: 'lanczos3' })
    .greyscale().normalize().sharpen().png().toBuffer();
  const reads = [];
  for (const psm of [7, 6]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await ocrService.recognize(prepared, { psm });
    const text = result.words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text) reads.push({ text, confidence: median(result.words.map((word) => word.confidence)) || 0 });
  }
  return reads.sort((a, b) => b.confidence - a.confidence || b.text.length - a.text.length)[0] || {
    text: '', confidence: 0,
  };
}

async function readResidualText(binary, width, height, box, medianHeight) {
  const pad = Math.max(2, Math.round(medianHeight * 0.7));
  const x0 = clamp(Math.floor(box.x0 - pad), 0, width - 1);
  const y0 = clamp(Math.floor(box.y0 - pad), 0, height - 1);
  const x1 = clamp(Math.ceil(box.x1 + pad), x0 + 1, width);
  const y1 = clamp(Math.ceil(box.y1 + pad), y0 + 1, height);
  const cropWidth = x1 - x0, cropHeight = y1 - y0;
  const pixels = Buffer.alloc(cropWidth * cropHeight, 255);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!binary[y * width + x]) continue;
      const tx = x - x0, ty = y - y0;
      // One-pixel dilation reconnects pen strokes split by JPEG artifacts.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = tx + dx, ny = ty + dy;
          if (nx >= 0 && ny >= 0 && nx < cropWidth && ny < cropHeight) pixels[ny * cropWidth + nx] = 0;
        }
      }
    }
  }
  const scale = boundedOcrScale(cropWidth, cropHeight, clamp(36 / medianHeight, 2, 6));
  const prepared = await sharp(pixels, { raw: { width: cropWidth, height: cropHeight, channels: 1 } })
    .resize({ width: Math.round(cropWidth * scale), height: Math.round(cropHeight * scale), kernel: 'lanczos3' })
    .png().toBuffer();
  const reads = [];
  for (const psm of [6, 11]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await ocrService.recognize(prepared, { psm });
    const text = result.words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text) reads.push({ text, confidence: median(result.words.map((word) => word.confidence)) || 0 });
    if (text.replace(/[^a-z0-9]/gi, '').length >= 4) break;
  }
  return reads.sort((a, b) => b.confidence - a.confidence || b.text.length - a.text.length)[0] || {
    text: '', confidence: 0,
  };
}

const ADVERSE_REMARK = /damag|dowag|dawag|demag|domag|samag|5amag|dmg|broken|break|shortage|boxshort|shortreceived|shortsupply|missing|notreceived|notrecived|notreceive|notrecive|notrecd|only|open|leak|wet|dent|torn|crush|defect|mismatch|excess|less|reject|refus|subjecttoverif|verification|tamper|pilfer|loose/;
const ROUTINE_RECEIPT = /receiv|reciev|reciv|recd|boxreceived|boxesreceived|materialreceived|goodsreceived|allreceived/;

function semanticDecision(candidate, focused, expectedBoxes) {
  // Only the focused OCR of residual ink is trusted for meaning. Page OCR
  // text overlapping the box is usually the underlying printed form prompt
  // (for example SHORT BOX?) and would create false adverse keywords.
  const raw = String(focused.text || '').trim();
  if (raw.length > 120) {
    return { isRemark: false, reason: 'OCR_CROP_CONTAMINATED', text: null };
  }
  const text = normalizedText(raw);
  // Remove standard printed form sentences before looking for adverse words.
  // Imperfect OCR of SHORT BOX?, ITEMS MISSING and DAMAGED CONTENT was the
  // main source of clean POD false positives.
  const semanticText = text
    .replace(/ifyesnumberofshortboxes/g, '')
    .replace(/numberofshortboxes/g, '')
    .replace(/itemsmissinginreceivedboxes/g, '')
    .replace(/boxeshavingpilferage/g, '')
    .replace(/boxeshavingdamagedcontent/g, '')
    .replace(/damagedcontent/g, '')
    .replace(/shortbox/g, '');
  const reasons = [];
  const quantities = [...raw.matchAll(/(\d{1,4})\s*(?:boxes?|box|nos?)/gi)].map((match) => Number(match[1]));
  const adverse = ADVERSE_REMARK.test(semanticText);
  const routineReceipt = ROUTINE_RECEIPT.test(semanticText) && !adverse;

  if (candidate.zone === 'date_time') {
    return { isRemark: false, reason: 'DATE_OR_TIME_ENTRY', text: focused.text || null };
  }
  if (adverse) {
    reasons.push('ADVERSE_REMARK_LANGUAGE');
    return { isRemark: true, reasons, text: focused.text || raw || null };
  }
  if (routineReceipt) {
    if (Number.isFinite(expectedBoxes) && quantities.length && quantities.some((value) => value !== expectedBoxes)) {
      return {
        isRemark: true,
        reasons: ['RECEIVED_QUANTITY_MISMATCH'],
        text: focused.text || raw || null,
      };
    }
    return { isRemark: false, reason: 'ROUTINE_RECEIPT_CONFIRMATION', text: focused.text || raw || null };
  }
  // Phone/date/reference-number writing is operational metadata, not a remark.
  if (text && !/[a-z]{3}/.test(text) && /^[0-9]+$/.test(text)) {
    return { isRemark: false, reason: 'NUMERIC_METADATA', text: focused.text || raw || null };
  }
  if (candidate.zone === 'stamp_area') {
    return { isRemark: false, reason: 'STAMP_AREA_WITHOUT_ADVERSE_TEXT', text: focused.text || raw || null };
  }

  // Unreadable handwriting is not enough to declare a remark. It may be a
  // name, signature, stamp note, phone number or routine acknowledgement.
  // Only adverse language or a verified box-count mismatch above is positive.
  return { isRemark: false, reason: 'NO_REMARK_MEANING', text: focused.text || raw || null };
}

async function detectRemarks(input, meta, words) {
  const maxScale = Math.min(1, MAX_ANALYSIS_WIDTH / meta.width, Math.sqrt(MAX_ANALYSIS_PIXELS / (meta.width * meta.height)));
  const scale = Math.min(1, maxScale);
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));
  const preparedWords = words.map((word) => ({ ...word, bbox: scaleBox(word.bbox, scale) }));
  const wordHeights = preparedWords
    .filter((word) => word.confidence >= 45)
    .map((word) => word.bbox.y1 - word.bbox.y0)
    .filter((value) => value >= 3 && value < height * 0.08);
  const medianWordHeight = Math.max(5, median(wordHeights) || height * 0.014);

  const { data, info } = await sharp(input)
    .resize({ width, height, fit: 'fill' })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const sampleR = [], sampleG = [], sampleB = [];
  for (let i = 0; i < width * height; i += 4) {
    const k = i * info.channels;
    sampleR.push(data[k]); sampleG.push(data[k + 1]); sampleB.push(data[k + 2]);
  }
  const paper = { r: percentile(sampleR, 0.88), g: percentile(sampleG, 0.88), b: percentile(sampleB, 0.88) };
  const paperLuma = paper.r * 0.2126 + paper.g * 0.7152 + paper.b * 0.0722;
  const strength = new Float32Array(width * height);
  const colorInk = new Uint8Array(width * height);
  const dark = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const k = i * info.channels;
    const r = data[k], g = data[k + 1], b = data[k + 2];
    const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const darkness = Math.max(0, paperLuma - value);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const colorDistance = Math.sqrt((r - paper.r) ** 2 + (g - paper.g) ** 2 + (b - paper.b) ** 2);
    dark[i] = darkness;
    const coolBlue = b - Math.min(r, g) >= 14 && b >= g - 2;
    const purple = r - g >= 10 && b - g >= 10;
    if (chroma >= 18 && colorDistance >= 28 && (coolBlue || purple)) colorInk[i] = 1;
    strength[i] = Math.max(darkness, colorInk[i] ? colorDistance * 0.7 : 0);
  }
  const solid = percentile([...strength].filter((value) => value > 10), 0.82);
  const threshold = Math.max(20, Math.min(55, solid * 0.32));
  const rules = detectHorizontalRules(dark, width, height, Math.max(34, threshold));
  const label = locateLabel(preparedWords, width, height, rules, medianWordHeight);
  const mask = new Uint8Array(width * height);
  const remarksAnchors = findAnchors(preparedWords, /podremarks|remarks|allokay|shortbox|damaged|items|stamp|dateofreceipt/);
  const remarksTop = remarksAnchors.length
    ? Math.min(...remarksAnchors.map((word) => word.bbox.y0))
    : label.y0 + (label.y1 - label.y0) * 0.28;
  const remarksLeft = label.x0 + (label.x1 - label.x0) * 0.48;
  const handwritingWords = [];

  // OCR boxes are primarily a printed-ink mask. Preserve colored or unusually
  // tall words in the remarks area so focused OCR can classify their meaning.
  for (const word of preparedWords) {
    const h = word.bbox.y1 - word.bbox.y0;
    // Page OCR is used here as a printed-ink mask, not as a handwriting
    // detector. Even low-confidence printed words on faint scans leave enough
    // residual edges to look handwritten, so mask every plausible text token.
    // Handwritten notes are still found from their unrecognized connected
    // strokes and from colored ink outside these compact boxes.
    if (word.confidence >= 8 && h >= 2) {
      const c = center(word.bbox);
      let ink = 0, colored = 0;
      for (let y = clamp(word.bbox.y0, 0, height); y < clamp(word.bbox.y1, 0, height); y += 1) {
        for (let x = clamp(word.bbox.x0, 0, width); x < clamp(word.bbox.x1, 0, width); x += 1) {
          const index = y * width + x;
          if (strength[index] < threshold) continue;
          ink += 1;
          if (colorInk[index]) colored += 1;
        }
      }
      const inRemarksArea = c.y >= remarksTop && (c.x >= remarksLeft || c.y > label.y1);
      const colorRatio = colored / Math.max(1, ink);
      const likelyHandwriting = inRemarksArea && (
        (colorRatio >= 0.25 && (h >= medianWordHeight * 1.25 || word.confidence < 65)) ||
        (h >= medianWordHeight * 1.4 && word.confidence < 88)
      );
      if (likelyHandwriting) {
        handwritingWords.push({
          ...word,
          handwritingColorRatio: colored / Math.max(1, ink),
        });
      } else if (h <= medianWordHeight * 3.2) {
        markBox(mask, width, height, word.bbox, Math.max(3, medianWordHeight * 0.62));
      }
    }
  }
  // Logo/barcode/header decorations are never remarks.
  markBox(mask, width, height, { x0: label.x0, y0: label.y0, x1: label.x1, y1: Math.min(label.y1, label.y0 + medianWordHeight * 4) });
  const signatureZones = signatureExclusions(preparedWords, label, medianWordHeight, width, height);
  signatureZones.forEach((entry) => markBox(mask, width, height, entry.bbox));

  // Remarks are expected in the right-side POD remarks form and anywhere
  // below the printed label. Colored pen is also inspected across the label,
  // allowing an out-of-box note without opening the whole form to black print
  // residuals.
  const binary = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const insideRemarksForm = x >= remarksLeft && x <= label.x1 && y >= remarksTop && y <= label.y1;
      const belowLabel = y > label.y1 + medianWordHeight * 0.4 &&
        y <= Math.min(height - 1, label.y1 + height * 0.28) &&
        x >= Math.max(0, label.x0 - medianWordHeight * 4) && x <= Math.min(width - 1, label.x1 + medianWordHeight * 4);
      const coloredElsewhere = Boolean(colorInk[i]) && x >= label.x0 && x <= label.x1 && y >= remarksTop && y <= label.y1;
      if ((insideRemarksForm || belowLabel || coloredElsewhere) && !mask[i] && strength[i] >= threshold) binary[i] = 1;
    }
  }

  const rawComponents = componentize(binary, strength, width, height);
  const components = rawComponents.filter((component) => {
    if (component.area < Math.max(4, medianWordHeight * 0.25)) return false;
    if (component.width >= width * 0.055 && component.height <= Math.max(4, medianWordHeight * 0.52)) return false;
    if (component.height >= height * 0.08 && component.width <= Math.max(4, medianWordHeight * 0.52)) return false;
    if (component.width > width * 0.5 || component.height > height * 0.3) return false;
    return true;
  });
  let groups = groupComponents(components, medianWordHeight);
  const stampAnchors = findAnchors(preparedWords, /stamp|seal/);
  const colorComponents = componentize(colorInk, strength, width, height)
    .filter((component) => component.area >= Math.max(3, medianWordHeight * 0.18) &&
      component.width < width * 0.32 && component.height < height * 0.28);
  const colorStampGroups = groupStampComponents(colorComponents, medianWordHeight * 1.35)
    .filter((group) => stampLike(group, colorInk, width, height, medianWordHeight, stampAnchors));
  const stampGroups = [
    ...groupStampComponents(components, medianWordHeight)
      .filter((group) => stampLike(group, binary, width, height, medianWordHeight, stampAnchors)),
    ...colorStampGroups,
  ];
  const stampExclusions = stampGroups.map((group) => ({
    type: 'stamp',
    bbox: {
      x0: group.x0 - medianWordHeight * 1.8, y0: group.y0 - medianWordHeight * 3,
      x1: group.x1 + medianWordHeight * 1.8, y1: group.y1 + medianWordHeight * 1.8,
    },
  }));
  groups = groups.filter((group) => !stampExclusions.some((entry) =>
    containsPoint(entry.bbox, (group.x0 + group.x1) / 2, (group.y0 + group.y1) / 2)
  ));

  const candidates = [];
  for (const group of groups) {
    const box = { x0: group.x0, y0: group.y0, x1: group.x1, y1: group.y1 };
    const boxWidth = box.x1 - box.x0;
    const boxHeight = box.y1 - box.y0;
    // A single candidate can never cover a major fraction of the form; those
    // are missed print, a shadow, or a page edge rather than one written note.
    if (boxWidth > width * 0.48 || boxHeight > height * 0.16) continue;
    // Do not reject a wide cursive line by shape alone: a valid one-line
    // remark and a signature have the same geometry. Signature fields are
    // masked earlier; anything elsewhere must pass the semantic gate below.
    if (boxWidth < medianWordHeight * 1.15 && boxHeight < medianWordHeight * 1.15 && group.members.length < 3) continue;
    const zone = zoneFor(box, label, preparedWords, medianWordHeight);
    // Broken table/page borders and scan edges are not handwriting.
    if ((boxWidth > width * 0.58 && boxHeight < medianWordHeight * 3) ||
        box.x0 <= 1 || box.x1 >= width - 1 || box.y1 >= height - 1) continue;
    // The final printed/footer band is never a remark regardless of which
    // broad semantic cell anchor happens to be nearest.
    if (box.y0 > label.y1 - medianWordHeight * 4.5 && box.y1 <= label.y1 + medianWordHeight * 0.5) continue;
    const coloredPixels = group.members.reduce((sum, component) =>
      sum + component.pixels.filter((index) => colorInk[index]).length, 0);
    const totalPixels = group.members.reduce((sum, component) => sum + component.area, 0);
    const overlappingWords = preparedWords.filter((word) => intersects(word.bbox, box));
    const regularPrintedWords = overlappingWords.filter((word) =>
      word.confidence >= 22 && word.bbox.y1 - word.bbox.y0 <= medianWordHeight * 2.4);
    // Residual anti-aliased edges around a confidently OCR'd printed word are
    // still print. Colored pen may cross that text, so it is retained.
    if (regularPrintedWords.length >= 1 &&
        coloredPixels / Math.max(1, totalPixels) < 0.1 &&
        boxHeight <= medianWordHeight * 2.5) continue;
    const colorRatio = coloredPixels / Math.max(1, totalPixels);
    const templateText = overlappingWords.map((word) => normalizedText(word.text)).join('');
    const isPrintedFormPrompt = /damag|content|item|missing|stamp|seal|shortbox|numberof|num|mum|boxes|carton|package|having|pilferage|describe|printed|document|type|receiver|signature|actual|weight|contain|remarks|receipt/.test(templateText);
    if (isPrintedFormPrompt && colorRatio < 0.16) continue;
    // Black residual ink needs substantial irregular geometry; a few glyph
    // edges left by OCR masking are not enough. Colored pen gets the looser
    // path because black printed form text has negligible chroma.
    if (colorRatio < 0.08 && boxHeight <= medianWordHeight * 1.45 && group.members.length < 8) continue;
    const scored = reasonsForGroup(group, zone, medianWordHeight, overlappingWords, colorRatio);
    if (scored.score < 42) continue;
    candidates.push({
      bbox: box,
      zone,
      score: scored.score,
      reasons: scored.reasons,
      ocrText: scored.text || null,
      componentCount: group.members.length,
      inkArea: totalPixels,
    });
  }

  // Nearby lines form one written note. Joining them prevents two-line remarks
  // from being diluted into several weak candidates.
  const merged = [];
  for (const candidate of candidates.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)) {
    const existing = merged.find((item) => {
      const gapY = Math.max(0, Math.max(item.bbox.y0, candidate.bbox.y0) - Math.min(item.bbox.y1, candidate.bbox.y1));
      const overlapX = Math.min(item.bbox.x1, candidate.bbox.x1) - Math.max(item.bbox.x0, candidate.bbox.x0);
      return item.zone === candidate.zone && gapY <= medianWordHeight * 2.2 &&
        overlapX >= -medianWordHeight * 4;
    });
    if (!existing) { merged.push({ ...candidate, lineCount: 1 }); continue; }
    existing.bbox = unionBoxes([existing.bbox, candidate.bbox]);
    existing.lineCount += 1;
    existing.score = clamp(Math.max(existing.score, candidate.score) + 12, 0, 100);
    existing.componentCount += candidate.componentCount;
    existing.inkArea += candidate.inkArea;
    existing.reasons = [...new Set([...existing.reasons, ...candidate.reasons, 'MULTIPLE_WRITTEN_LINES'])];
    existing.ocrText = [existing.ocrText, candidate.ocrText].filter(Boolean).join(' ') || null;
  }

  const expectedBoxes = expectedBoxCount(preparedWords, medianWordHeight);
  const semanticCandidates = [];
  const ignoredNotes = [];
  for (const candidate of [...merged].sort((a, b) => b.score - a.score).slice(0, 10)) {
    // eslint-disable-next-line no-await-in-loop
    const focused = await readResidualText(binary, width, height, candidate.bbox, medianWordHeight);
    const decision = semanticDecision(candidate, focused, expectedBoxes);
    const enriched = {
      ...candidate,
      semanticText: decision.text,
      semanticReasons: decision.reasons || (decision.reason ? [decision.reason] : []),
    };
    if (decision.isRemark) semanticCandidates.push(enriched);
    else ignoredNotes.push({ type: decision.reason || 'non_remark_handwriting', bbox: candidate.bbox, text: decision.text });
  }
  // One recognized handwritten word is enough to seed a reread of its full
  // line from the original pixels. This catches cursive phrases whose letters
  // do not remain one stable residual component after print masking.
  const semanticSeedWords = [...handwritingWords]
    .sort((a, b) => b.handwritingColorRatio - a.handwritingColorRatio ||
      (b.bbox.y1 - b.bbox.y0) - (a.bbox.y1 - a.bbox.y0));
  const probedSeedBoxes = [];
  for (const word of semanticSeedWords) {
    if (probedSeedBoxes.length >= 12) break;
    if (probedSeedBoxes.some((box) => intersects(box, word.bbox))) continue;
    const probeBox = {
      x0: clamp(word.bbox.x0 - medianWordHeight * 4, 0, width),
      y0: clamp(word.bbox.y0 - medianWordHeight * 1.4, 0, height),
      x1: clamp(word.bbox.x1 + medianWordHeight * 14, 0, width),
      y1: clamp(word.bbox.y1 + medianWordHeight * 1.4, 0, height),
    };
    if ([...signatureZones, ...stampExclusions].some((entry) => intersects(entry.bbox, probeBox))) continue;
    probedSeedBoxes.push(probeBox);
    // eslint-disable-next-line no-await-in-loop
    const focused = word.handwritingColorRatio >= 0.08
      ? await readColorLineText(input, meta, word.bbox, scale, medianWordHeight)
      : await readOriginalLineText(input, meta, word.bbox, scale, medianWordHeight);
    const seeded = {
      bbox: probeBox,
      zone: zoneFor(word.bbox, label, preparedWords, medianWordHeight),
      score: 92,
      componentCount: 0,
      inkArea: 0,
      lineCount: 1,
      ocrText: null,
    };
    const decision = semanticDecision(seeded, focused, expectedBoxes);
    if (!decision.isRemark || semanticCandidates.some((candidate) => intersects(candidate.bbox, word.bbox))) continue;
    semanticCandidates.push({
      ...seeded,
      reasons: ['SEMANTIC_LINE_REREAD'],
      semanticReasons: decision.reasons,
      semanticText: decision.text,
    });
  }

  const withRemarks = semanticCandidates.length > 0;
  const toSource = (box) => ({
    x0: clamp(Math.round(box.x0 / scale), 0, meta.width),
    y0: clamp(Math.round(box.y0 / scale), 0, meta.height),
    x1: clamp(Math.round(box.x1 / scale), 0, meta.width),
    y1: clamp(Math.round(box.y1 / scale), 0, meta.height),
  });
  return {
    hasRemarks: withRemarks,
    confidence: withRemarks
      ? Math.max(...semanticCandidates.map((candidate) =>
        candidate.semanticReasons.includes('ADVERSE_REMARK_LANGUAGE') ? Math.max(90, candidate.score) : candidate.score))
      : ignoredNotes.length ? 88 : 94,
    reasons: withRemarks
      ? [...new Set(semanticCandidates.flatMap((candidate) => candidate.semanticReasons))]
      : ignoredNotes.some((entry) => entry.type === 'ROUTINE_RECEIPT_CONFIRMATION')
        ? ['ROUTINE_RECEIPT_CONFIRMATION_NOT_A_REMARK']
        : ['NO_REMARK_MEANING_DETECTED'],
    regions: semanticCandidates.map((candidate) => ({ ...candidate, bbox: toSource(candidate.bbox) })),
    exclusions: [
      ...signatureZones,
      ...stampExclusions,
      ...ignoredNotes.filter((entry) => ['ROUTINE_RECEIPT_CONFIRMATION', 'DATE_OR_TIME_ENTRY', 'NUMERIC_METADATA'].includes(entry.type)),
    ].map((entry) => ({ ...entry, bbox: toSource(entry.bbox) })),
    analysis: {
      imageWidth: meta.width,
      imageHeight: meta.height,
      scale: Number(scale.toFixed(4)),
      medianPrintedHeight: Number((medianWordHeight / scale).toFixed(2)),
      labelBounds: toSource(label),
      residualComponents: components.length,
      candidateGroups: merged.length,
      semanticCandidates: semanticCandidates.length,
      expectedBoxCount: expectedBoxes,
      ignoredHandwriting: ignoredNotes.map((entry) => ({
        type: entry.type,
        text: entry.text || null,
        bbox: toSource(entry.bbox),
      })),
    },
  };
}

async function processRemarksImage({ filePath, outputPath, filenameHint = null }) {
  const startedAt = Date.now();
  const metadata = await sharp(filePath).metadata();
  const initial = metadata.orientation && metadata.orientation !== 1
    ? await sharp(filePath).rotate().toBuffer()
    : filePath;
  const oriented = await chooseOrientation(initial);
  let detected = findHeaderShipmentId(oriented.words, oriented.meta);
  // Always perform the focused header read. Page OCR can return a plausible
  // nine-digit ID with one wrong digit, which length checks cannot catch.
  const focused = await rereadHeaderId(oriented.input, oriented.meta);
  if (focused && (!detected || focused.id.length === 9 &&
      (detected.id.length !== 9 || focused.confidence >= detected.confidence - 8))) {
    detected = { ...focused, source: 'focused_header_ocr' };
  }
  const fromFilename = filenameId(filenameHint || filePath);
  if (fromFilename && (!detected || digitDistance(fromFilename, detected.id) === 1)) {
    // One damaged OCR digit plus a nine-digit LR in the uploaded filename is
    // enough to repair the read; unrelated filename numbers are never used.
    detected = {
      id: fromFilename,
      confidence: detected?.confidence ?? null,
      source: detected ? 'header_filename_repair' : 'filename',
    };
  }

  const detection = await detectRemarks(oriented.input, oriented.meta, oriented.words);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(oriented.input).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(outputPath);
  return {
    status: detection.hasRemarks ? 'with_remarks' : 'without_remarks',
    hasRemarks: detection.hasRemarks,
    shipmentId: detected?.id || null,
    detectedImageId: detected?.id || null,
    shipmentIdSource: detected?.source || 'unavailable',
    idConfidence: Number.isFinite(detected?.confidence) ? Number(detected.confidence.toFixed(1)) : null,
    remarkConfidence: detection.confidence,
    remarkReasons: detection.reasons,
    remarkRegions: detection.regions,
    excludedRegions: detection.exclusions,
    remarkAnalysis: detection.analysis,
    appliedRotation: oriented.rotation,
    processingMs: Date.now() - startedAt,
    outputFilename: path.basename(outputPath),
    downloadable: true,
  };
}

module.exports = { processRemarksImage, detectRemarks, chooseOrientation, rereadHeaderId };
