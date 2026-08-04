'use strict';

require('dotenv').config();
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  port: Number(process.env.PORT || process.env.DEV_PORT || 3000),
  storageDir: process.env.STORAGE_DIR || path.join(ROOT, 'storage'),
  uploadsDir: path.join(process.env.STORAGE_DIR || path.join(ROOT, 'storage'), 'uploads'),
  outputsDir: path.join(process.env.STORAGE_DIR || path.join(ROOT, 'storage'), 'outputs'),
  jobsDir: path.join(process.env.STORAGE_DIR || path.join(ROOT, 'storage'), 'jobs'),

  // OCR / tesseract
  tessdataDir: process.env.TESSDATA_DIR || path.join(ROOT, 'tessdata'),
  ocrLanguage: process.env.OCR_LANGUAGE || 'eng',
  ocrMinConfidence: Number(process.env.OCR_MIN_CONFIDENCE || 40),

  // Concurrency
  workerPoolSize: Number(process.env.WORKER_POOL_SIZE || Math.max(1, os.cpus().length - 1)),
  maxConcurrentUploads: Number(process.env.MAX_FILES_PER_JOB || 1000),
  maxUploadFileSizeMb: Number(process.env.MAX_UPLOAD_FILE_SIZE_MB || 25),

  // Matching heuristics (see services/labelMatcher.service.js)
  matching: {
    // Vertical window (fraction of image height) to search below a "WEIGHT" anchor
    // for the numeric value that belongs to that column.
    verticalSearchWindowRatio: Number(process.env.MATCH_VERTICAL_WINDOW_RATIO || 0.18),
    // Horizontal tolerance (px) added to each side of an anchor's bounding box
    // when looking for a value token in the same column.
    horizontalTolerancePx: Number(process.env.MATCH_HORIZONTAL_TOLERANCE_PX || 120),
    // Max Levenshtein distance allowed for fuzzy shipment ID matching.
    idFuzzyMaxDistance: Number(process.env.ID_FUZZY_MAX_DISTANCE || 1),
  },

  retentionHours: Number(process.env.JOB_RETENTION_HOURS || 24),
};
