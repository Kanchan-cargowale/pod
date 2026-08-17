'use strict';

const {
  findShipmentId,
  findWeightAnchors,
  findWeightValueRegions,
  formatReplacementWeight,
  formatSharedReplacementWeight,
  isWeightAnchorText,
  isWeightQualifierText,
  weightColumnKind,
  classifyWeightRegion,
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

    it('repairs common barcode-header OCR glyph confusions', () => {
      const words = [
        { text: '3O99526I4', confidence: 82, bbox: { x0: 620, y0: 35, x1: 770, y1: 70 } },
      ];
      const match = findShipmentId(words, new Set(['309952614']), {
        minConfidence: 40,
        fuzzyMaxDistance: 0,
        imageWidth: 1000,
        imageHeight: 700,
      });

      expect(match.id).toBe('309952614');
      expect(match.source).toBe('ocr_confusion_repair');
    });

    it('prefers the large upper header ID when multiple mapped IDs appear', () => {
      const words = [
        { text: '287798368', confidence: 78, bbox: { x0: 530, y0: 35, x1: 690, y1: 72 } },
        { text: '309952614', confidence: 95, bbox: { x0: 120, y0: 430, x1: 220, y1: 446 } },
      ];
      const match = findShipmentId(words, new Set(['287798368', '309952614']), {
        minConfidence: 40,
        fuzzyMaxDistance: 0,
        imageWidth: 1000,
        imageHeight: 700,
      });

      expect(match.id).toBe('287798368');
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

    it('accepts common damaged and split OCR readings of WEIGHT', () => {
      expect(isWeightAnchorText('WE1GHT(kg)')).toBe(true);
      expect(isWeightAnchorText('WElGHT')).toBe(true);
      expect(isWeightAnchorText('WEGHT')).toBe(true);

      const splitWords = [
        { text: 'WEI', confidence: 71, bbox: { x0: 400, y0: 200, x1: 450, y1: 225 } },
        { text: 'GHT', confidence: 68, bbox: { x0: 455, y0: 201, x1: 510, y1: 225 } },
      ];
      const anchors = findWeightAnchors(splitWords);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].words.map((word) => word.text)).toEqual(['WEI', 'GHT']);
    });

    it('does not mistake FREIGHT PAYMENT for a weight column', () => {
      expect(isWeightAnchorText('Freight')).toBe(false);
      expect(isWeightAnchorText('Frelght')).toBe(false);
    });

    it('accepts damaged ACTUAL text but rejects product Charger text', () => {
      expect(isWeightQualifierText('CTUAL')).toBe(true);
      expect(isWeightQualifierText('Charger')).toBe(false);

      const anchors = findWeightAnchors([
        { text: 'CTUAL', confidence: 38, bbox: { x0: 285, y0: 354, x1: 320, y1: 363 } },
        { text: 'Charger', confidence: 45, bbox: { x0: 423, y0: 406, x1: 470, y1: 415 } },
      ]);

      expect(anchors).toHaveLength(1);
      expect(anchors[0].words.map((word) => word.text)).toEqual(['CTUAL']);
    });

    it('splits duplicate-OCR bridges between ACTUAL and CHARGED columns', () => {
      const words = [
        { text: 'ACTUAL', confidence: 80, bbox: { x0: 265, y0: 330, x1: 315, y1: 342 } },
        { text: 'WEIGHT', confidence: 76, bbox: { x0: 266, y0: 345, x1: 318, y1: 357 } },
        { text: 'WEIGHT(kg)', confidence: 61, bbox: { x0: 300, y0: 344, x1: 365, y1: 357 } },
        { text: 'CHARGED', confidence: 79, bbox: { x0: 382, y0: 330, x1: 442, y1: 342 } },
        { text: 'WEIGHT', confidence: 74, bbox: { x0: 383, y0: 345, x1: 438, y1: 357 } },
      ];

      const anchors = findWeightAnchors(words);
      expect(anchors).toHaveLength(2);
      expect(anchors[0].bbox.x1).toBeLessThan(anchors[1].bbox.x0 + 5);
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

    it('keeps adjacent ACTUAL and CHARGED values in their own columns', () => {
      const anchors = [
        {
          bbox: { x0: 300, y0: 258, x1: 360, y1: 280, height: 22 },
          words: [{ text: 'ACTUAL', bbox: { x0: 300, y0: 258, x1: 360, y1: 280 } }],
        },
        {
          bbox: { x0: 404, y0: 249, x1: 462, y1: 272, height: 23 },
          words: [{ text: 'CHARGED', bbox: { x0: 404, y0: 249, x1: 462, y1: 272 } }],
        },
      ];
      const words = [
        { text: '117.5', confidence: 94, bbox: { x0: 300, y0: 292, x1: 328, y1: 309 } },
        { text: '152.0', confidence: 96, bbox: { x0: 404, y0: 286, x1: 430, y1: 304 } },
      ];
      const regions = findWeightValueRegions(words, anchors, {
        imageHeight: 860,
        verticalWindowRatio: 0.18,
        horizontalTolerancePx: 120,
      });

      expect(
        regions
          .map((region) => ({ text: region.originalText, x0: region.bbox.x0 }))
          .sort((a, b) => a.x0 - b.x0)
      ).toEqual([
        { text: '117.5', x0: 300 },
        { text: '152.0', x0: 404 },
      ]);
    });

    it('uses a damaged decimal-shaped OCR token directly below a confirmed header', () => {
      const anchors = [
        {
          bbox: { x0: 247, y0: 170, x1: 277, y1: 179, height: 9 },
          words: [{ text: 'CHARGED', bbox: { x0: 247, y0: 170, x1: 277, y1: 179 } }],
        },
      ];
      const words = [
        { text: '»N.n', confidence: 0, bbox: { x0: 246, y0: 193, x1: 263, y1: 201 } },
      ];
      const regions = findWeightValueRegions(words, anchors, {
        imageHeight: 1024,
        verticalWindowRatio: 0.18,
        horizontalTolerancePx: 120,
      });

      expect(regions).toHaveLength(1);
      expect(regions[0].originalText).toBe('»N.n');
    });
    it('finds a value below a damaged ACTUAL header while ignoring Charger product text', () => {
      const words = [
        { text: 'CTUAL', confidence: 38, bbox: { x0: 285, y0: 354, x1: 320, y1: 363 } },
        { text: 'SHT(kg)', confidence: 28, bbox: { x0: 356, y0: 361, x1: 398, y1: 371 } },
        { text: '150.8', confidence: 70, bbox: { x0: 278, y0: 367, x1: 312, y1: 401 } },
        { text: 'Charger', confidence: 45, bbox: { x0: 423, y0: 406, x1: 470, y1: 415 } },
      ];
      const anchors = findWeightAnchors(words);
      const regions = findWeightValueRegions(words, anchors, {
        imageHeight: 768,
        verticalWindowRatio: 0.18,
        horizontalTolerancePx: 120,
      });

      expect(regions).toHaveLength(1);
      expect(regions[0].originalText).toBe('150.8');
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

    it('uses one shared precision for sibling actual and charged weight values', () => {
      const regions = [
        { originalText: '40.00' },
        { originalText: '40' },
      ];

      expect(formatSharedReplacementWeight(40, regions)).toBe('40.00');
      expect(formatSharedReplacementWeight(40.5, regions)).toBe('40.50');
    });

    it('does not round away decimals that came from the mapping sheet', () => {
      expect(formatSharedReplacementWeight(170.55, [{ originalText: '122.5' }])).toBe('170.55');
      expect(formatSharedReplacementWeight(368.84, [{ originalText: '159.8' }])).toBe('368.84');
    });
  });

  describe('weightColumnKind', () => {
    it('classifies actual weight headers', () => {
      expect(weightColumnKind('ACTUAL WEIGHT')).toBe('actual');
      expect(weightColumnKind('CTUAL')).toBe('actual');
      expect(weightColumnKind('actual')).toBe('actual');
    });

    it('classifies charged weight headers', () => {
      expect(weightColumnKind('CHARGED WEIGHT')).toBe('charged');
      expect(weightColumnKind('CHARGEABLE')).toBe('charged');
      expect(weightColumnKind('chargd')).toBe('charged');
    });

    it('returns null for non-weight text', () => {
      expect(weightColumnKind('SAID TO CONTAIN')).toBeNull();
      expect(weightColumnKind('Box Dimensions')).toBeNull();
    });
  });

  describe('classifyWeightRegion', () => {
    it('tags regions from ACTUAL anchors as actual', () => {
      const region = { anchorText: 'ACTUAL WEIGHT' };
      expect(classifyWeightRegion(region, 0, [])).toBe('actual');
    });

    it('tags regions from CHARGED anchors as charged', () => {
      const region = { anchorText: 'CHARGED WEIGHT' };
      expect(classifyWeightRegion(region, 1, [])).toBe('charged');
    });

    it('falls back to anchor index when anchor text is ambiguous', () => {
      const region = { anchorText: 'WEIGHT' };
      const anchors = [
        { words: [{ text: 'WEIGHT' }] },
        { words: [{ text: 'WEIGHT' }] },
      ];
      expect(classifyWeightRegion(region, 0, anchors)).toBe('actual');
      expect(classifyWeightRegion(region, 1, anchors)).toBe('charged');
    });
  });

  describe('findWeightValueRegions kind tagging', () => {
    it('tags located values with their column kind', () => {
      const anchors = [
        {
          bbox: { x0: 300, y0: 258, x1: 360, y1: 280, height: 22 },
          words: [{ text: 'ACTUAL', bbox: { x0: 300, y0: 258, x1: 360, y1: 280 } }],
        },
        {
          bbox: { x0: 404, y0: 249, x1: 462, y1: 272, height: 23 },
          words: [{ text: 'CHARGED', bbox: { x0: 404, y0: 249, x1: 462, y1: 272 } }],
        },
      ];
      const words = [
        { text: '117.5', confidence: 94, bbox: { x0: 300, y0: 292, x1: 328, y1: 309 } },
        { text: '152.0', confidence: 96, bbox: { x0: 404, y0: 286, x1: 430, y1: 304 } },
      ];
      const regions = findWeightValueRegions(words, anchors, {
        imageHeight: 860,
        verticalWindowRatio: 0.18,
        horizontalTolerancePx: 120,
      });

      expect(regions).toHaveLength(2);
      const actualRegion = regions.find((r) => r.originalText === '117.5');
      const chargedRegion = regions.find((r) => r.originalText === '152.0');
      expect(actualRegion.kind).toBe('actual');
      expect(chargedRegion.kind).toBe('charged');
    });
  });
});
