'use strict';

const sharp = require('sharp');

const {
  inferActualSiblingRegion,
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
});
