'use strict';

module.exports = {
  // A "weight-like" numeric token: 1-6 integer digits, optional decimal part.
  NUMERIC_TOKEN: /^\d{1,6}(?:\.\d{1,3})?$/,
  // Anchors that indicate a weight column header on a courier label / POD.
  WEIGHT_ANCHOR: /weight/i,
  // Tesseract sometimes reads ACTUAL/CHARGED but drops the word WEIGHT on
  // the next line. These qualifiers still identify the intended columns.
  WEIGHT_COLUMN_QUALIFIER: /^(?:actual|charged|chargeable)$/i,
  // Strip anything that isn't a digit, used to normalize OCR'd shipment IDs.
  NON_DIGIT: /\D/g,
};
