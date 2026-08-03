'use strict';

const ExcelJS = require('exceljs');

/**
 * Parses a "Shipment ID -> New Weight" mapping workbook.
 *
 * Expected shape (header names are matched case/whitespace-insensitively,
 * so "ID ", "Shipment Id", "AWB" etc. all resolve to the id column, and
 * "Weight", "New Weight", "Weight (kg)" all resolve to the weight column):
 *
 *   | ID        | Weight |
 *   |-----------|--------|
 *   | 307775718 | 900    |
 *   | 307479457 | 500    |
 *
 * @param {string} filePath absolute path to the .xlsx file
 * @returns {Promise<{ map: Map<string, number>, rows: Array, warnings: string[] }>}
 */
async function parseWeightMapping(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error('Workbook has no worksheets');
  }

  const headerRow = sheet.getRow(1);
  const columnIndex = { id: null, weight: null };

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const normalized = String(cell.value || '').trim().toLowerCase();
    if (columnIndex.id === null && /\b(id|awb|lr|shipment|reference)\b/.test(normalized)) {
      columnIndex.id = colNumber;
    }
    if (columnIndex.weight === null && /weight/.test(normalized)) {
      columnIndex.weight = colNumber;
    }
  });

  if (!columnIndex.id || !columnIndex.weight) {
    throw new Error(
      'Could not detect "ID" and "Weight" columns in the first row of the mapping sheet'
    );
  }

  const map = new Map();
  const rows = [];
  const warnings = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header

    const rawId = row.getCell(columnIndex.id).value;
    const rawWeight = row.getCell(columnIndex.weight).value;

    if (rawId === null || rawId === undefined || rawId === '') return;

    const id = String(rawId).trim();
    const weight = Number(rawWeight);

    if (!id) return;
    if (Number.isNaN(weight)) {
      warnings.push(`Row ${rowNumber}: weight "${rawWeight}" is not numeric, skipped`);
      return;
    }

    if (map.has(id)) {
      warnings.push(`Row ${rowNumber}: duplicate ID "${id}", keeping first occurrence`);
      return;
    }

    map.set(id, weight);
    rows.push({ id, weight });
  });

  return { map, rows, warnings };
}

module.exports = { parseWeightMapping };
