'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const excelParser = require('../services/excelParser.service');
const jobService = require('../services/job.service');

async function createJob(req, res) {
  const images = req.files?.images || [];
  const mappingFile = req.files?.mapping?.[0];

  if (!images.length) {
    return res.status(400).json({ error: 'At least one image (field "images") is required' });
  }
  if (!mappingFile) {
    return res.status(400).json({ error: 'A mapping workbook (field "mapping") is required' });
  }

  const { map, rows, warnings } = await excelParser.parseWeightMapping(mappingFile.path);
  if (map.size === 0) {
    return res.status(400).json({ error: 'Mapping workbook contained no valid ID -> Weight rows' });
  }

  const imagePaths = images.map((f) => f.path);
  const jobId = await jobService.createJob({
    imagePaths,
    idWeightMap: map,
    tempUploadsDir: req.uploadBatchDir,
  });

  // The mapping file itself lives in the same temp batch dir and will be
  // cleaned up alongside the images once the job finishes; no separate
  // handling needed here.
  void mappingFile;

  return res.status(202).json({
    jobId,
    totalFiles: imagePaths.length,
    mappingRows: rows.length,
    mappingWarnings: warnings,
    statusUrl: `/api/jobs/${jobId}`,
    downloadUrl: `/api/jobs/${jobId}/download`,
  });
}

async function getJobStatus(req, res) {
  const job = await jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
}

async function downloadJobZip(req, res) {
  const job = await jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') {
    return res.status(409).json({ error: `Job is not ready yet (status: ${job.status})` });
  }

  const zipPath = jobService.getZipPath(req.params.id);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Result archive not found' });
  }

  return res.download(zipPath, `${path.basename(zipPath)}`);
}

async function downloadSelectedZip(req, res, next) {
  const job = await jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!['processing', 'completed', 'failed'].includes(job.status)) {
    return res.status(409).json({
      error: `No processed images are ready to download yet (status: ${job.status})`,
    });
  }

  let filenames = [];
  try {
    filenames = req.body.filenames || [];
    if (!Array.isArray(filenames) || !filenames.length) {
      return res.status(400).json({ error: 'A non-empty filenames array is required' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const safeFilenames = filenames.map((name) => path.basename(name));
  const selectedPaths = [];
  const outputsDir = jobService.getOutputsDir(req.params.id);
  for (const name of safeFilenames) {
    const candidate = path.join(outputsDir, name);
    if (fs.existsSync(candidate)) selectedPaths.push(candidate);
  }

  if (!selectedPaths.length) {
    return res.status(404).json({
      error: 'None of the selected images are ready yet. Try again after a few more files process.',
    });
  }

  const zipPath = jobService.getSelectedZipPath(req.params.id, randomUUID());
  const { zipDirectory } = require('../services/zip.service');
  const { ensureJobDirs } = require('../services/storage.service');

  await ensureJobDirs(req.params.id);
  await zipDirectory(outputsDir, zipPath, selectedPaths);

  res.setHeader('X-Selected-Ready-Count', String(selectedPaths.length));
  res.setHeader('X-Selected-Requested-Count', String(safeFilenames.length));
  return res.download(zipPath, `selected-labels-${req.params.id}.zip`, (err) => {
    fs.rm(zipPath, { force: true }, () => {});
    if (err) next(err);
  });
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

async function previewImage(req, res) {
  const job = await jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const safeName = path.basename(req.params.filename);
  const filePath = path.join(jobService.getOutputsDir(req.params.id), safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Image not found (job may still be processing)' });
  }

  const ext = path.extname(safeName).toLowerCase();
  res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  return fs.createReadStream(filePath).pipe(res);
}

module.exports = { createJob, getJobStatus, downloadJobZip, downloadSelectedZip, previewImage };
