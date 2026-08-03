'use strict';

const {
  findShipmentId,
  findShipmentIdInFilename,
  findWeightAnchors,
  findWeightValueRegions,
  formatReplacementWeight,
} = require('../../src/services/labelMatcher.service');

// This word list is a trimmed, real subset of what Tesseract.js actually
// returned for tests/fixtures/sample_label.jpeg (see README "How matching
// was validated"), so the unit tests exercise the exact geometry found on
// a genuine Delhivery LM POD document rather than a synthetic mock.
const SAMPLE_WORDS = [
  { text: '307775718', confidence: 95.0, bbox: { x0: 2108, y0: 193, x1: 2486, y1: 245 } },
  { text: '307775718', confidence: 91.0, bbox: { x0: 3498, y0: 297, x1: 3615, y1: 317 } },
  { text: 'ACTUAL', confidence: 96, bbox: { x0: 939, y0: 1160, x1: 1119, y1: 1191 } },
  { text: 'CHARGED', confidence: 95, bbox: { x0: 1408, y0: 1163, x1: 1624, y1: 1195 } },
  { text: 'WEIGHT', confidence: 94, bbox: { x0: 1406, y0: 1186, x1: 1565, y1: 1261 } },
  { text: '802.91', confidence: 94.0, bbox: { x0: 937, y0: 1324, x1: 1081, y1: 1358 } },
  { text: '802.91', confidence: 96.0, bbox: { x0: 1407, y0: 1325, x1: 1547, y1: 1358 } },
  { text: '417248.0', confidence: 92, bbox: { x0: 573, y0: 1068, x1: 756, y1: 1100 } },
];

const IMAGE_HEIGHT = 3024;

describe('labelMatcher.service', () => {
  describe('findShipmentId', () => {
    it('finds an exact match against the mapping key set', () => {
      const idSet = new Set(['307775718', '307479457']);
      const match = findShipmentId(SAMPLE_WORDS, idSet, { minConfidence: 40, fuzzyMaxDistance: 1 });

      expect(match).not.toBeNull();
      expect(match.id).toBe('307775718');
      expect(match.distance).toBe(0);
    });

    it('returns null when no ID on the page is in the mapping', () => {
      const idSet = new Set(['999999999']);
      const match = findShipmentId(SAMPLE_WORDS, idSet, { minConfidence: 40, fuzzyMaxDistance: 1 });
      expect(match).toBeNull();
    });

    it('falls back to a fuzzy match for a single OCR misread digit', () => {
      const wordsWithTypo = [
        { text: '307775719', confidence: 90, bbox: { x0: 0, y0: 0, x1: 100, y1: 30 } },
      ];
      const idSet = new Set(['307775718']);
      const match = findShipmentId(wordsWithTypo, idSet, { minConfidence: 40, fuzzyMaxDistance: 1 });

      expect(match).not.toBeNull();
      expect(match.id).toBe('307775718');
      expect(match.distance).toBe(1);
    });

    it('ignores low-confidence tokens', () => {
      const idSet = new Set(['307775718']);
      const lowConfWords = [
        { text: '307775718', confidence: 10, bbox: { x0: 0, y0: 0, x1: 100, y1: 30 } },
      ];
      const match = findShipmentId(lowConfWords, idSet, { minConfidence: 40, fuzzyMaxDistance: 0 });
      expect(match).toBeNull();
    });
  });

  describe('findShipmentIdInFilename', () => {
    it('matches an exact spreadsheet LR embedded in a courier filename', () => {
      const match = findShipmentIdInFilename(
        'lm-pod-307869128-1785403938665.jpg',
        new Set(['287969023', '307869128'])
      );

      expect(match).toMatchObject({
        id: '307869128',
        distance: 0,
        confidence: 100,
        source: 'filename',
      });
    });

    it('does not match an ID that is only part of a longer filename number', () => {
      expect(
        findShipmentIdInFilename('lm-pod-13078691289.jpg', new Set(['307869128']))
      ).toBeNull();
    });
  });

  describe('findWeightAnchors', () => {
    it('groups the two "WEIGHT" column headers into separate anchors', () => {
      const anchors = findWeightAnchors(SAMPLE_WORDS);
      const headerAnchors = anchors.filter((anchor) => anchor.bbox.y0 < 1500);

      expect(headerAnchors).toHaveLength(2);
      expect(headerAnchors[0].words.map((word) => word.text)).toEqual(['ACTUAL']);
      expect(headerAnchors[1].words.map((word) => word.text)).toEqual(['CHARGED', 'WEIGHT']);
    });
  });

  describe('findWeightValueRegions', () => {
    it('locates the printed weight value below each WEIGHT anchor', () => {
      const anchors = findWeightAnchors(SAMPLE_WORDS);
      const regions = findWeightValueRegions(SAMPLE_WORDS, anchors, {
        imageHeight: IMAGE_HEIGHT,
        verticalWindowRatio: 0.18,
        horizontalTolerancePx: 120,
      });

      expect(regions).toHaveLength(2);
      for (const region of regions) {
        expect(region.originalText).toBe('802.91');
      }
      expect(regions.map((region) => region.bbox.x0)).toEqual([937, 1407]);
    });

    it('does not match a numeric value far outside the vertical window', () => {
      const anchors = [
        { bbox: { x0: 500, y0: 200, x1: 700, y1: 240, height: 40 }, words: [] },
      ];
      const farWords = [
        { text: '999.99', confidence: 90, bbox: { x0: 500, y0: 5000, x1: 700, y1: 5040 } },
      ];
      const regions = findWeightValueRegions(farWords, anchors, {
        imageHeight: IMAGE_HEIGHT,
        verticalWindowRatio: 0.1,
        horizontalTolerancePx: 100,
      });
      expect(regions).toHaveLength(0);
    });
  });

  describe('formatReplacementWeight', () => {
    it('matches the decimal precision of the original value', () => {
      expect(formatReplacementWeight(900, '802.91')).toBe('900.00');
      expect(formatReplacementWeight(500.5, '802.91')).toBe('500.50');
    });

    it('keeps whole numbers whole when the original had no decimals', () => {
      expect(formatReplacementWeight(900, '803')).toBe('900');
    });
  });
});
