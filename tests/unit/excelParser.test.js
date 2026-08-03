'use strict';

const path = require('path');
const { parseWeightMapping } = require('../../src/services/excelParser.service');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'WeightUpdateTemplate.xlsx');

describe('excelParser.service', () => {
  it('parses the real WeightUpdateTemplate.xlsx into an ID -> Weight map', async () => {
    const { map, rows, warnings } = await parseWeightMapping(FIXTURE);

    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(2);

    expect(map.get('307775718')).toBe(900);
    expect(map.get('307479457')).toBe(500);
    expect(map.size).toBe(2);
  });

  it('throws a helpful error when ID/Weight columns cannot be found', async () => {
    // Reuse the fixture file's path but simulate the "no columns" case by
    // asserting on a workbook we know is well-formed - this test instead
    // verifies the function's contract via a malformed in-memory workbook.
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Foo', 'Bar']);
    sheet.addRow(['x', 'y']);

    const tmpPath = path.join(__dirname, '..', 'fixtures', '_tmp_bad_mapping.xlsx');
    await workbook.xlsx.writeFile(tmpPath);

    await expect(parseWeightMapping(tmpPath)).rejects.toThrow(/ID.*Weight/i);

    const fs = require('fs');
    fs.unlinkSync(tmpPath);
  });

  it('accepts LR as the shipment ID column header', async () => {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['LR', 'New Weight']);
    sheet.addRow([307869128, 425]);

    const tmpPath = path.join(__dirname, '..', 'fixtures', '_tmp_lr_mapping.xlsx');
    await workbook.xlsx.writeFile(tmpPath);

    try {
      const { map, warnings } = await parseWeightMapping(tmpPath);
      expect(map.get('307869128')).toBe(425);
      expect(warnings).toEqual([]);
    } finally {
      const fs = require('fs');
      fs.unlinkSync(tmpPath);
    }
  });
});
