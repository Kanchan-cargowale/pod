'use strict';

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const multer = require('multer');
const config = require('../config');

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const ALLOWED_MAPPING_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
const ALLOWED_MAPPING_EXTS = new Set(['.xlsx', '.xls']);

/** Assigns a fresh batch id (used as the temp-upload directory name) before multer runs. */
function assignBatchId(req, res, next) {
  req.uploadBatchId = randomUUID();
  const dir = path.join(config.uploadsDir, `tmp-${req.uploadBatchId}`);
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) return next(err);
    req.uploadBatchDir = dir;
    return next();
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.uploadBatchDir),
  filename: (req, file, cb) => {
    // Preserve original name but strip any path segments for safety.
    const safeName = path.basename(file.originalname).replace(/[^\w.\-]/g, '_');
    cb(null, safeName);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (file.fieldname === 'images') {
    const okByMime = ALLOWED_IMAGE_TYPES.has(file.mimetype);
    const okByExt = ALLOWED_IMAGE_EXTS.has(ext);
    if (!okByMime && !okByExt) {
      return cb(new Error(`Unsupported image type: ${file.originalname} (only JPG/PNG allowed)`));
    }
  } else if (file.fieldname === 'mapping') {
    const okByMime = ALLOWED_MAPPING_TYPES.has(file.mimetype);
    const okByExt = ALLOWED_MAPPING_EXTS.has(ext);
    if (!okByMime && !okByExt) {
      return cb(new Error(`Unsupported mapping file type: ${file.originalname} (only .xlsx/.xls allowed)`));
    }
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.maxUploadFileSizeMb * 1024 * 1024,
    files: config.maxConcurrentUploads + 1, // +1 for the mapping file
  },
});

const uploadFields = upload.fields([
  { name: 'images', maxCount: config.maxConcurrentUploads },
  { name: 'mapping', maxCount: 1 },
]);

module.exports = { assignBatchId, uploadFields };
