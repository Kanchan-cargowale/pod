'use strict';

// Registers the project's bundled fonts with fontconfig (the font engine
// sharp/librsvg use to rasterize replacement text).
//
// The POD labels are printed in DejaVu Sans. A Windows host does not have it,
// and fontconfig then silently substitutes a CJK monospace face, so the
// replacement could never match the printed typography. Rendering one tiny
// sharp text image with `fontfile` adds that file to fontconfig's
// application font set for the whole process, after which SVG text can use
// "DejaVu Sans" exactly as on a Linux host. Idempotent and cheap.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const FONT_DIR = path.join(__dirname, '..', '..', 'fonts');
const BUNDLED_FONTS = [
  { file: 'DejaVuSans.ttf', family: 'DejaVu Sans' },
  { file: 'DejaVuSans-Bold.ttf', family: 'DejaVu Sans Bold' },
];

let registration = null;

function ensureBundledFonts() {
  if (!registration) {
    registration = (async () => {
      const registered = [];
      for (const { file, family } of BUNDLED_FONTS) {
        const fontfile = path.join(FONT_DIR, file);
        if (!fs.existsSync(fontfile)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await sharp({ text: { text: '0', font: family, fontfile } }).png().toBuffer();
          registered.push(file);
        } catch {
          // A host without text support simply keeps its own fonts.
        }
      }
      return registered;
    })();
  }
  return registration;
}

module.exports = { ensureBundledFonts, FONT_DIR };
