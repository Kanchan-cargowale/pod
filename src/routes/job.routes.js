'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { assignBatchId, uploadFields } = require('../middleware/upload.middleware');
const controller = require('../controllers/job.controller');

const router = express.Router();

// POST /api/jobs
// multipart/form-data:
//   images   - one or more .jpg/.png label files
//   mapping  - one .xlsx workbook with "ID" / "Weight" columns
router.post('/', assignBatchId, uploadFields, asyncHandler(controller.createJob));

// GET /api/jobs/:id
router.get('/:id', asyncHandler(controller.getJobStatus));

// GET /api/jobs/:id/download
router.get('/:id/download', asyncHandler(controller.downloadJobZip));

// GET /api/jobs/:id/preview/:filename - stream an edited image inline
router.get('/:id/preview/:filename', asyncHandler(controller.previewImage));

module.exports = router;
