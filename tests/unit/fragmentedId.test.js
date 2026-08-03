'use strict';

const { findShipmentId } = require('../../src/services/labelMatcher.service');

// This is the real, verbatim OCR output for the barcode ID "309030935" on
// tests/fixtures/real_world_2.jpg - a phone photo of an actual Delhivery
// LM POD, where Tesseract fragmented the large bold ID into four separate
// word tokens instead of reading it as one string. Regression test for
// the fix that reconstructs IDs split across nearby OCR fragments.
const FRAGMENTED_ID_WORDS = [
  { text: '30', confidence: 95.0, bbox: { x0: 563, y0: 78, x1: 588, y1: 98 } },
  { text: '903', confidence: 91.0, bbox: { x0: 591, y0: 64, x1: 629, y1: 90 } },
  { text: '0', confidence: 50.0, bbox: { x0: 632, y0: 60, x1: 644, y1: 76 } },
  { text: '935', confidence: 86.0, bbox: { x0: 647, y0: 45, x1: 688, y1: 72 } },
  // Unrelated nearby numeric noise that should NOT get pulled into the chain.
  { text: '208021', confidence: 63.0, bbox: { x0: 930, y0: 181, x1: 1024, y1: 196 } },
];

describe('labelMatcher.service - fragmented shipment ID reconstruction', () => {
  it('reconstructs an ID that OCR split across several word fragments', () => {
    const idSet = new Set(['309030935']);
    const match = findShipmentId(FRAGMENTED_ID_WORDS, idSet, {
      minConfidence: 40,
      fuzzyMaxDistance: 1,
    });

    expect(match).not.toBeNull();
    expect(match.id).toBe('309030935');
    expect(match.distance).toBe(0);
    expect(match.words.length).toBe(4);
  });

  it('still prefers a clean single-word exact match when one is present', () => {
    const words = [
      { text: '307775718', confidence: 95, bbox: { x0: 0, y0: 0, x1: 100, y1: 30 } },
      ...FRAGMENTED_ID_WORDS,
    ];
    const idSet = new Set(['307775718', '309030935']);
    const match = findShipmentId(words, idSet, { minConfidence: 40, fuzzyMaxDistance: 1 });

    expect(match.id).toBe('307775718');
    expect(match.words.length).toBe(1);
  });

  it('does not fabricate a match when the fragments do not add up to any known ID', () => {
    const idSet = new Set(['999999999']);
    const match = findShipmentId(FRAGMENTED_ID_WORDS, idSet, { minConfidence: 40, fuzzyMaxDistance: 1 });
    expect(match).toBeNull();
  });
});
