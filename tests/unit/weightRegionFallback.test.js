'use strict';

const sharp = require('sharp');

const {
  inferActualSiblingRegion,
  inferSiblingFromAnchors,
  inferSiblingFromTableRules,
  inferWeightRegionsFromAnchors,
  inferWeightRegionsFromTable,
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
});
