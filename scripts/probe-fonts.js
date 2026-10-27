'use strict';

// Reports which candidate font families actually resolve to distinct faces on
// this host. Identical width/ink signatures mean fontconfig silently
// substituted the same face, so the matcher's family choice is meaningless.

const sharp = require('sharp');

const FAMILIES = [
  'DejaVu Sans',
  'Liberation Sans',
  'Arial, Helvetica, sans-serif',
  'Nimbus Sans',
  'Noto Sans',
  'Arial Narrow, Liberation Sans Narrow, sans-serif',
  'DejaVu Serif, Liberation Serif, Times New Roman, serif',
  'DejaVu Sans Mono, Liberation Mono, Courier New, monospace',
  'sans-serif',
];

async function signature(family, weight) {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="70">' +
    `<text x="10" y="45" font-family="${family}" font-size="28" ` +
    `font-weight="${weight}" fill="black">43x30x19</text></svg>`
  );
  const { data, info } = await sharp(svg).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let x0 = Infinity;
  let x1 = -1;
  let ink = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] <= 24) continue;
      ink += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
  }
  return { width: x1 - x0 + 1, ink };
}

async function main() {
  const seen = new Map();
  for (const family of FAMILIES) {
    const parts = [];
    for (const weight of [400, 700]) {
      // eslint-disable-next-line no-await-in-loop
      const sig = await signature(family, weight);
      parts.push(`${weight}:w=${sig.width},ink=${sig.ink}`);
    }
    const key = parts.join('|');
    const duplicateOf = seen.get(key);
    if (!duplicateOf) seen.set(key, family);
    console.log(
      `${family.padEnd(58)} ${parts.join('  ')}` +
      (duplicateOf ? `   == SAME FACE AS "${duplicateOf}"` : '   [distinct]')
    );
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
