'use strict';

const sharp = require('sharp');

const {
  inferActualSiblingRegion,
  inferSiblingFromAnchors,
  inferSiblingFromTableRules,
  inferWeightRegionsFromAnchors,
  inferSingleWeightRegionFromAnchor,
  isRegionWithinWeightValueBand,
  reconcileHeaderOwnedWeightRegions,
  findWeightHeaderQualifiers,
  inferWeightRegionsFromTable,
  localizeWeightInkInCells,
} = require('../../src/services/weightRegionFallback.service');

describe('weightRegionFallback.service', () => {
  it('infers an ACTUAL value box from equal-width table columns beside CHARGED', async () => {
    const image = Buffer.from(
      '<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="400" height="300" fill="white" />' +
        '<path d="M100 60V220 M160 60V220 M220 60V220" stroke="black" stroke-width="2" />' +
        '</svg>'
    );
    const anchors = [
      {
        bbox: { x0: 168, y0: 100, x1: 205, y1: 115, height: 15 },
        words: [{ text: 'CHARGED', bbox: { x0: 168, y0: 100, x1: 205, y1: 115 } }],
      },
    ];
    const regions = [
      {
        bbox: { x0: 168, y0: 140, x1: 195, y1: 152 },
        originalText: 'N.n',
        anchorText: 'CHARGED',
      },
    ];

    const inferred = await inferActualSiblingRegion(
      image,
      anchors,
      regions,
      { width: 400, height: 300 }
    );

    expect(inferred).toHaveLength(1);
    expect(inferred[0].bbox).toEqual({ x0: 108, y0: 140, x1: 135, y1: 152 });
  });

  it('uses header geometry to recover a missing CHARGED value when only ACTUAL was read', () => {
    const anchors = [
      {
        bbox: { x0: 300, y0: 100, x1: 390, y1: 130 },
        words: [{ text: 'ACTUAL WEIGHT' }],
      },
      {
        bbox: { x0: 470, y0: 100, x1: 575, y1: 130 },
        words: [{ text: 'CHARGED WEIGHT' }],
      },
    ];
    const inferred = inferSiblingFromAnchors(
      anchors,
      [{
        bbox: { x0: 315, y0: 158, x1: 380, y1: 180 },
        originalText: '80.00',
        anchorText: 'ACTUAL WEIGHT',
      }],
      { width: 1200, height: 800 }
    );

    expect(inferred).toHaveLength(1);
    expect(inferred[0].anchorText).toMatch(/CHARGED/);
    expect(inferred[0].bbox.y0).toBe(158);
    expect(inferred[0].bbox.x0).toBeCloseTo(492.5, 1);
  });

  it('recovers the second column when OCR reads both headers only as WEIGHT', () => {
    const anchors = [
      { bbox: { x0: 263, y0: 274, x1: 310, y1: 305 }, words: [{ text: 'WEIGH' }] },
      { bbox: { x0: 382, y0: 274, x1: 437, y1: 305 }, words: [{ text: '[WEIGHT' }] },
    ];
    const inferred = inferSiblingFromAnchors(
      anchors,
      [{
        bbox: { x0: 278, y0: 310, x1: 305, y1: 318 },
        originalText: '40',
        anchorText: 'WEIGH',
      }],
      { width: 1024, height: 674 }
    );

    expect(inferred).toHaveLength(1);
    expect(inferred[0].anchorText).toMatch(/CHARGED/);
    expect(inferred[0].bbox.x0).toBeGreaterThan(390);
    expect(inferred[0].bbox.y0).toBe(310);
  });

  it('uses adjacent equal-width table rules when header OCR cannot name the sibling', async () => {
    const image = Buffer.from(
      '<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="400" height="300" fill="white" />' +
        '<path d="M100 60V220 M160 60V220 M220 60V220" stroke="black" stroke-width="2" />' +
        '</svg>'
    );
    const inferred = await inferSiblingFromTableRules(
      image,
      [],
      [{
        bbox: { x0: 108, y0: 140, x1: 135, y1: 152 },
        originalText: '40',
        anchorText: 'ACTUAL WEIGHT',
      }],
      { width: 400, height: 300 }
    );

    expect(inferred).toHaveLength(1);
    expect(inferred[0].bbox).toEqual({ x0: 168, y0: 140, x1: 195, y1: 152 });
    expect(inferred[0].anchorText).toMatch(/CHARGED/);
  });

  it('prefers table borders when a clipped header centre points inside the ACTUAL cell', async () => {
    const image = Buffer.from(
      '<svg width="1024" height="708" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="1024" height="708" fill="white" />' +
        '<path d="M264 260V520 M382 260V520 M488 260V520" stroke="black" stroke-width="2" />' +
        '</svg>'
    );
    const anchors = [
      { bbox: { x0: 273, y0: 274, x1: 338, y1: 305 }, words: [{ text: 'ACTUAL WEIGHT' }] },
      // Reproduces clipped OCR whose centre gives an unsafe ~84px shift.
      { bbox: { x0: 360, y0: 274, x1: 419, y1: 305 }, words: [{ text: 'WEIGHT' }] },
    ];
    const inferred = await inferActualSiblingRegion(
      image,
      anchors,
      [{
        bbox: { x0: 277, y0: 310, x1: 305, y1: 319 },
        originalText: '40',
        anchorText: 'ACTUAL WEIGHT',
      }],
      { width: 1024, height: 708 },
      anchors.map((anchor) => ({ text: anchor.words[0].text, bbox: anchor.bbox }))
    );

    expect(inferred).toHaveLength(1);
    expect(inferred[0].anchorText).toMatch(/CHARGED/);
    expect(inferred[0].bbox.x0).toBeGreaterThanOrEqual(390);
    expect(inferred[0].bbox.x0).toBeLessThan(405);
  });

  it('does not invent CHARGED inside a SAID TO CONTAIN product cell', async () => {
    const image = Buffer.from(
      '<svg width="1024" height="700" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="1024" height="700" fill="white" />' +
        '<path d="M210 300V560 M365 300V560 M520 300V560" stroke="black" stroke-width="2" />' +
        '</svg>'
    );
    const anchors = [{
      bbox: { x0: 225, y0: 315, x1: 345, y1: 348 },
      words: [{ text: 'ACTUAL WEIGHT', bbox: { x0: 225, y0: 315, x1: 345, y1: 348 } }],
    }];
    const words = [
      ...anchors[0].words,
      { text: 'SAID', bbox: { x0: 382, y0: 315, x1: 420, y1: 330 } },
      { text: 'TO', bbox: { x0: 425, y0: 315, x1: 445, y1: 330 } },
      { text: 'CONTAIN', bbox: { x0: 380, y0: 332, x1: 465, y1: 348 } },
    ];
    const inferred = await inferActualSiblingRegion(
      image,
      anchors,
      [{
        bbox: { x0: 230, y0: 370, x1: 266, y1: 381 },
        originalText: '64.6',
        anchorText: 'ACTUAL WEIGHT',
      }],
      { width: 1024, height: 700 },
      words
    );

    expect(inferred).toEqual([]);
  });

  it('does not infer a sibling from table rules when SAID TO CONTAIN is the adjacent header', async () => {
    const image = Buffer.from(
      '<svg width="1024" height="700" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="1024" height="700" fill="white" />' +
        '<path d="M210 300V560 M365 300V560 M520 300V560" stroke="black" stroke-width="2" />' +
        '</svg>'
    );
    const anchors = [{
      bbox: { x0: 225, y0: 315, x1: 345, y1: 348 },
      words: [{ text: 'ACTUAL WEIGHT', bbox: { x0: 225, y0: 315, x1: 345, y1: 348 } }],
    }];
    const words = [
      ...anchors[0].words,
      { text: 'SAID', bbox: { x0: 382, y0: 315, x1: 420, y1: 330 } },
      { text: 'TO', bbox: { x0: 425, y0: 315, x1: 445, y1: 330 } },
      { text: 'CONTAIN', bbox: { x0: 380, y0: 332, x1: 465, y1: 348 } },
    ];
    const regions = [{
      bbox: { x0: 230, y0: 370, x1: 266, y1: 381 },
      originalText: '64.6',
      anchorText: 'ACTUAL WEIGHT',
      kind: 'actual',
    }];

    const tableInferred = await inferSiblingFromTableRules(
      image,
      anchors,
      regions,
      { width: 1024, height: 700 }
    );
    const inferred = await inferActualSiblingRegion(
      image,
      anchors,
      regions,
      { width: 1024, height: 700 },
      words
    );

    expect(tableInferred).toHaveLength(1);
    expect(inferred).toEqual([]);
  });

  it('finds proportionally sized weight columns on a high-resolution page', async () => {
    const image = Buffer.from(
      '<svg width="1600" height="600" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="1600" height="600" fill="white" />' +
        '<path d="M100 130V500 M500 130V500 M650 130V500 M800 130V500 M880 130V500" ' +
        'stroke="black" stroke-width="3" />' +
        '<text x="520" y="205" font-size="24" fill="black">ACTUAL WEIGHT</text>' +
        '<text x="675" y="205" font-size="24" fill="black">CHARGED</text>' +
        '<text x="525" y="275" font-size="24" fill="black">80.00</text>' +
        '<text x="675" y="275" font-size="24" fill="black">80.00</text>' +
        '</svg>'
    );

    const regions = await inferWeightRegionsFromTable(
      image,
      { width: 1600, height: 600 },
      []
    );

    expect(regions).toHaveLength(2);
    expect(regions[0].bbox.x0).toBeGreaterThan(500);
    expect(regions[1].bbox.x0).toBeGreaterThan(650);
  });

  it('derives the value row below the headers instead of using a merged OCR box', async () => {
    const image = Buffer.from(
      '<svg width="800" height="500" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="800" height="500" fill="white" />' +
        '<path d="M200 150V400 M300 150V400 M400 150V400 M200 210H400" ' +
        'stroke="black" stroke-width="2" />' +
        '<text x="210" y="180" font-size="14">ACTUAL</text>' +
        '<text x="210" y="200" font-size="14">WEIGHT(kg)</text>' +
        '<text x="310" y="180" font-size="14">CHARGED</text>' +
        '<text x="310" y="200" font-size="14">WEIGHT(kg)</text>' +
        '<text x="212" y="232" font-size="14">40</text>' +
        '<text x="312" y="232" font-size="14">33.59</text>' +
        '</svg>'
    );
    const anchors = [
      { bbox: { x0: 200, y0: 165, x1: 275, y1: 205 }, words: [{ text: 'ACTUAL WEIGHT' }] },
      { bbox: { x0: 300, y0: 165, x1: 380, y1: 205 }, words: [{ text: 'CHARGED WEIGHT' }] },
    ];
    // These reproduce the unsafe enhanced-OCR shape: each box spans header + value.
    const mergedWords = [
      { text: '1140', bbox: { x0: 210, y0: 175, x1: 235, y1: 234 } },
      { text: '113359', bbox: { x0: 310, y0: 175, x1: 355, y1: 234 } },
    ];

    const regions = await inferWeightRegionsFromAnchors(
      image,
      anchors,
      mergedWords,
      { width: 800, height: 500 }
    );

    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.bbox.y0).toBeGreaterThan(210);
      expect(region.bbox.y1 - region.bbox.y0).toBeLessThan(20);
    }
    expect(regions[0].anchorText).toMatch(/ACTUAL/);
    expect(regions[1].anchorText).toMatch(/CHARGED/);
  });

  it('tags inferred regions with explicit kind fields', async () => {
    const image = Buffer.from(
      '<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="400" height="300" fill="white" />' +
        '<path d="M100 60V220 M160 60V220 M220 60V220" stroke="black" stroke-width="2" />' +
        '</svg>'
    );
    const anchors = [
      {
        bbox: { x0: 168, y0: 100, x1: 205, y1: 115, height: 15 },
        words: [{ text: 'CHARGED', bbox: { x0: 168, y0: 100, x1: 205, y1: 115 } }],
      },
    ];
    const regions = [
      {
        bbox: { x0: 168, y0: 140, x1: 195, y1: 152 },
        originalText: 'N.n',
        anchorText: 'CHARGED',
      },
    ];

    const inferred = await inferActualSiblingRegion(
      image,
      anchors,
      regions,
      { width: 400, height: 300 }
    );

    expect(inferred).toHaveLength(1);
    expect(inferred[0].kind).toBe('actual');
  });

  it('does not mistake signature-row ink for a missing weight value', async () => {
    const image = Buffer.from(
      '<svg width="800" height="700" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="800" height="700" fill="white" />' +
        '<path d="M200 190V660 M350 190V660" stroke="black" stroke-width="2" />' +
        '<text x="225" y="620" font-size="22" fill="black">SHIPPER SIGN</text>' +
        '</svg>'
    );
    const anchors = [{
      bbox: { x0: 220, y0: 235, x1: 330, y1: 270 },
      words: [{ text: 'ACTUAL WEIGHT' }],
    }];

    const regions = await inferSingleWeightRegionFromAnchor(
      image,
      anchors,
      [],
      { width: 800, height: 700 }
    );

    expect(regions).toHaveLength(1);
    expect(regions[0].bbox.y0).toBeGreaterThan(anchors[0].bbox.y1);
    expect(regions[0].bbox.y1).toBeLessThan(350);
  });

  it('rejects any final fallback region that drifts into the signature row', () => {
    const anchors = [
      { bbox: { x0: 210, y0: 330, x1: 330, y1: 365 } },
      // False OCR anchor closer in x, but located in the signature section.
      { bbox: { x0: 335, y0: 590, x1: 390, y1: 612 } },
    ];
    const meta = { width: 1080, height: 768 };

    expect(isRegionWithinWeightValueBand(
      { bbox: { x0: 220, y0: 385, x1: 275, y1: 400 } },
      anchors,
      meta
    )).toBe(true);
    expect(isRegionWithinWeightValueBand(
      { bbox: { x0: 338, y0: 616, x1: 384, y1: 623 } },
      anchors,
      meta
    )).toBe(false);
  });

  it('snaps CHARGED back from SAID TO CONTAIN and preserves both header-owned fields', () => {
    const words = [
      { text: 'ACTUAL', confidence: 90, bbox: { x0: 235, y0: 312, x1: 284, y1: 321 } },
      { text: 'CHARGED', confidence: 90, bbox: { x0: 354, y0: 315, x1: 414, y1: 324 } },
      { text: 'CONTAIN', confidence: 75, bbox: { x0: 474, y0: 331, x1: 529, y1: 343 } },
      { text: '60.00', confidence: 93, bbox: { x0: 236, y0: 345, x1: 270, y1: 375 } },
      { text: '45.85', confidence: 67, bbox: { x0: 353, y0: 359, x1: 389, y1: 368 } },
      { text: 'EMAN', confidence: 20, bbox: { x0: 469, y0: 360, x1: 511, y1: 371 } },
    ];
    const reconciled = reconcileHeaderOwnedWeightRegions([
      {
        kind: 'actual',
        bbox: { x0: 236, y0: 345, x1: 270, y1: 375 },
        originalText: '60.00',
      },
      {
        kind: 'charged',
        bbox: { x0: 467, y0: 358, x1: 478, y1: 369 },
        originalText: '45.85',
      },
    ], words, { width: 1118, height: 787 });

    expect(reconciled).toHaveLength(2);
    expect(reconciled[0].kind).toBe('actual');
    expect(reconciled[1].kind).toBe('charged');
    expect(reconciled[1].bbox).toEqual(words[4].bbox);
    expect(reconciled[1].cellBounds.x0).toBeGreaterThan(340);
    expect(reconciled[1].cellBounds.x1).toBeLessThan(474);
  });

  it('recreates a missing CHARGED region when both qualifiers prove the schema', () => {
    const words = [
      { text: 'ACTUAL', confidence: 90, bbox: { x0: 300, y0: 300, x1: 350, y1: 314 } },
      { text: 'CHARGED', confidence: 90, bbox: { x0: 410, y0: 300, x1: 475, y1: 314 } },
      { text: 'SAID', confidence: 90, bbox: { x0: 520, y0: 300, x1: 555, y1: 314 } },
      { text: '90.00', confidence: 90, bbox: { x0: 305, y0: 338, x1: 345, y1: 352 } },
      { text: '61.56', confidence: 80, bbox: { x0: 415, y0: 339, x1: 455, y1: 353 } },
    ];
    const reconciled = reconcileHeaderOwnedWeightRegions([
      { kind: 'actual', bbox: words[3].bbox, originalText: '90.00' },
    ], words, { width: 1100, height: 780 });

    expect(reconciled.map((region) => region.kind)).toEqual(['actual', 'charged']);
    expect(reconciled[1].bbox).toEqual(words[4].bbox);
  });

  it('recovers both ruled cells when a dark scan keeps CHARGED, WEIGHT and CONTAIN but loses ACTUAL', () => {
    const words = [
      { text: '[CRaRGED', confidence: 0, bbox: { x0: 324, y0: 303, x1: 380, y1: 334 } },
      { text: 'WEIGHT(kg)', confidence: 34, bbox: { x0: 329, y0: 328, x1: 402, y1: 340 } },
      { text: '_[contam', confidence: 41, bbox: { x0: 437, y0: 327, x1: 481, y1: 334 } },
    ];

    const reconciled = reconcileHeaderOwnedWeightRegions([
      {
        kind: 'actual',
        bbox: { x0: 273, y0: 537, x1: 369, y1: 544 },
        originalText: 'a.',
      },
    ], words, { width: 1024, height: 809 });

    expect(reconciled.map((region) => region.kind)).toEqual(['actual', 'charged']);
    expect(reconciled[0].cellBounds.x1).toBe(reconciled[1].cellBounds.x0);
    expect(reconciled[1].cellBounds.x1).toBeLessThan(437);
    expect(reconciled[0].bbox.y0).toBeGreaterThanOrEqual(343);
    expect(reconciled[0].bbox.y1).toBeLessThan(390);
  });

  it('does not create CHARGED from a single ACTUAL cell followed by CONTAIN', () => {
    const words = [
      { text: 'ACTUAL', confidence: 90, bbox: { x0: 260, y0: 249, x1: 310, y1: 264 } },
      { text: 'WEIGHT(kg)', confidence: 80, bbox: { x0: 260, y0: 265, x1: 361, y1: 279 } },
      { text: 'CONTAIN', confidence: 90, bbox: { x0: 395, y0: 250, x1: 470, y1: 266 } },
      { text: '1274.25', confidence: 90, bbox: { x0: 260, y0: 293, x1: 310, y1: 303 } },
    ];
    const input = [{
      kind: 'actual',
      bbox: words[3].bbox,
      originalText: '1274.25',
    }];

    const reconciled = reconcileHeaderOwnedWeightRegions(
      input,
      words,
      { width: 1024, height: 757 }
    );

    expect(reconciled).toEqual(input);
  });

  it('uses aligned column headers instead of the higher-confidence charged footnote', () => {
    const words = [
      { text: 'ACTUAL', confidence: 95, bbox: { x0: 541, y0: 692, x1: 643, y1: 709 } },
      { text: 'CHARGED', confidence: 92, bbox: { x0: 796, y0: 692, x1: 922, y1: 710 } },
      { text: 'SAID', confidence: 94, bbox: { x0: 1054, y0: 692, x1: 1114, y1: 710 } },
      { text: '218.07', confidence: 96, bbox: { x0: 543, y0: 783, x1: 634, y1: 802 } },
      { text: '218.03', confidence: 95, bbox: { x0: 796, y0: 783, x1: 889, y1: 802 } },
      { text: 'charged', confidence: 99, bbox: { x0: 864, y0: 1100, x1: 930, y1: 1116 } },
      { text: 'weight', confidence: 99, bbox: { x0: 965, y0: 1100, x1: 1002, y1: 1117 } },
    ];
    const meta = { width: 2370, height: 1658 };
    const qualifiers = findWeightHeaderQualifiers(words, meta);
    expect(qualifiers.charged).toBe(words[1]);
    const regions = reconcileHeaderOwnedWeightRegions([
      { kind: 'actual', originalText: '218.07', bbox: { x0: 543, y0: 782, x1: 889, y1: 803 } },
    ], words, meta);

    expect(regions).toHaveLength(2);
    expect(regions[0].bbox).toEqual(words[3].bbox);
    expect(regions[1].bbox).toEqual(words[4].bbox);
    expect(regions[0].cellBounds.x1).toBe(regions[1].cellBounds.x0);
  });

  it('does not use a charged footnote as the only proof of a second weight field', () => {
    const words = [
      { text: 'ACTUAL', confidence: 90, bbox: { x0: 240, y0: 260, x1: 295, y1: 273 } },
      { text: 'charged', confidence: 99, bbox: { x0: 340, y0: 450, x1: 391, y1: 461 } },
      { text: 'weight', confidence: 99, bbox: { x0: 395, y0: 450, x1: 437, y1: 461 } },
    ];
    // Even a footnote inside the broad header search band must fail the
    // ACTUAL/CHARGED row-alignment test.
    expect(findWeightHeaderQualifiers(words, { width: 1100, height: 800 }).charged).toBeUndefined();
  });

  it('recovers both exact value boxes from damaged CHARCED rather than stale footer geometry', () => {
    const words = [
      { text: 'ACTUAL', confidence: 54, bbox: { x0: 274, y0: 286, x1: 317, y1: 319 } },
      { text: '[cHarcED', confidence: 19, bbox: { x0: 376, y0: 295, x1: 429, y1: 321 } },
      { text: 'WEIGHT(kg', confidence: 4, bbox: { x0: 274, y0: 313, x1: 374, y1: 324 } },
      { text: 'SAID', confidence: 80, bbox: { x0: 479, y0: 294, x1: 512, y1: 307 } },
      { text: '3.47', confidence: 87, bbox: { x0: 274, y0: 339, x1: 297, y1: 348 } },
      { text: '20.0', confidence: 96, bbox: { x0: 378, y0: 330, x1: 400, y1: 350 } },
      { text: 'charged', confidence: 99, bbox: { x0: 399, y0: 468, x1: 424, y1: 483 } },
    ];
    const regions = reconcileHeaderOwnedWeightRegions([
      { kind: 'actual', bbox: { x0: 281, y0: 478, x1: 368, y1: 499 } },
      { kind: 'charged', bbox: { x0: 382, y0: 478, x1: 469, y1: 499 } },
    ], words, { width: 1024, height: 692 });
    expect(regions.map((region) => region.kind)).toEqual(['actual', 'charged']);
    expect(regions.map((region) => region.originalText)).toEqual(['3.47', '20.0']);
    expect(regions.map((region) => region.bbox)).toEqual([words[4].bbox, words[5].bbox]);
    expect(regions[0].cellBounds.x1).toBe(regions[1].cellBounds.x0);
  });

  it.each(['Charger', 'Chargers', 'Charges', 'Charging'])(
    'does not authorize a charged cell from product text %s', (text) => {
      const words = [
        { text: 'ACTUAL', confidence: 90, bbox: { x0: 274, y0: 295, x1: 317, y1: 310 } },
        { text, confidence: 99, bbox: { x0: 376, y0: 295, x1: 429, y1: 310 } },
      ];
      expect(findWeightHeaderQualifiers(words, { width: 1024, height: 692 }).charged).toBeUndefined();
    }
  );

  it('prefers clean enhanced values over tall merged boxes in both proven columns', () => {
    const words = [
      { text: 'ACTUAL', confidence: 96, bbox: { x0: 218, y0: 279, x1: 262, y1: 287 } },
      { text: 'CHARGED', confidence: 96, bbox: { x0: 328, y0: 275, x1: 381, y1: 288 } },
      { text: 'SAID', confidence: 80, bbox: { x0: 438, y0: 275, x1: 463, y1: 284 } },
      { text: '90.29', confidence: 38, bbox: { x0: 215, y0: 307, x1: 247, y1: 338 } },
      { text: '98.20', confidence: 48, bbox: { x0: 328, y0: 305, x1: 356, y1: 336 } },
      { text: '98.29', confidence: 96, bbox: { x0: 218, y0: 319, x1: 247, y1: 333 } },
      { text: '98.29', confidence: 96, bbox: { x0: 328, y0: 318, x1: 356, y1: 326 } },
    ];
    const regions = reconcileHeaderOwnedWeightRegions([
      { kind: 'actual', originalText: '90.29', bbox: words[3].bbox },
      { kind: 'charged', originalText: '98.20', bbox: words[4].bbox },
    ], words, { width: 1024, height: 751 });
    expect(regions.map((region) => region.originalText)).toEqual(['98.29', '98.29']);
    expect(regions.map((region) => region.bbox)).toEqual([words[5].bbox, words[6].bbox]);
  });

  it('includes faint upper strokes instead of localizing only the bottom of old digits', async () => {
    const image = Buffer.from(
      '<svg width="1024" height="809" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="1024" height="809" fill="#b0b0b0" />' +
        '<path d="M217 300V500 M324 300V500 M217 340H324" stroke="#555" stroke-width="2" />' +
        '<path d="M223 354V366 M239 354V366 M254 354V366" stroke="#888" stroke-width="2" />' +
        '<path d="M223 364H232 M239 364H248 M254 364H264" stroke="#777" stroke-width="4" />' +
        '<rect x="220" y="390" width="100" height="15" fill="#a0a0a0" />' +
        '</svg>'
    );
    const [region] = await localizeWeightInkInCells(image, [{
      kind: 'actual',
      bbox: { x0: 223, y0: 362, x1: 264, y1: 367 },
      cellBounds: { x0: 217, x1: 324 },
      headerBottom: 340,
    }]);

    expect(region.inkLocalized).toBe(true);
    expect(region.bbox.y0).toBeGreaterThan(341);
    expect(region.bbox.y0).toBeLessThanOrEqual(354);
    expect(region.bbox.y1).toBeGreaterThanOrEqual(366);
    expect(region.bbox.y1).toBeLessThan(380);
    expect(region.bbox.x0).toBeGreaterThan(218);
    expect(region.bbox.x1).toBeGreaterThanOrEqual(264);
    expect(region.bbox.x1).toBeLessThan(324);
  });

  it('corrects a single ACTUAL boundary that drifted left into the BOXES column', () => {
    const [region] = reconcileHeaderOwnedWeightRegions([{
      kind: 'actual',
      bbox: { x0: 260, y0: 293, x1: 299, y1: 303 },
      cellBounds: { x0: 214.55, x1: 395 },
    }], [{ text: 'acruaL', confidence: 65, bbox: { x0: 260, y0: 249, x1: 310, y1: 264 } }],
    { width: 1024, height: 757 });

    expect(region.cellBounds.x0).toBeCloseTo(255.904);
    expect(region.cellBounds.x1).toBe(395);
    expect(region.bbox).toEqual({ x0: 260, y0: 293, x1: 299, y1: 303 });
  });
});
