'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const config = require('../config');

function jobUploadsDir(jobId) {
  return path.join(config.uploadsDir, jobId);
}

function jobOutputsDir(jobId) {
  return path.join(config.outputsDir, jobId);
}

function jobMetaFile(jobId) {
  return path.join(config.jobsDir, `${jobId}.json`);
}

function jobZipFile(jobId) {
  return path.join(config.outputsDir, `${jobId}.zip`);
}

async function ensureDirs() {
  await fs.mkdir(config.uploadsDir, { recursive: true });
  await fs.mkdir(config.outputsDir, { recursive: true });
  await fs.mkdir(config.jobsDir, { recursive: true });
}

async function ensureJobDirs(jobId) {
  await fs.mkdir(jobUploadsDir(jobId), { recursive: true });
  await fs.mkdir(jobOutputsDir(jobId), { recursive: true });
}

async function writeJobMeta(jobId, meta) {
  await fs.writeFile(jobMetaFile(jobId), JSON.stringify(meta, null, 2), 'utf8');
}

async function readJobMeta(jobId) {
  try {
    const raw = await fs.readFile(jobMetaFile(jobId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function jobMetaExistsSync(jobId) {
  return fsSync.existsSync(jobMetaFile(jobId));
}

async function removeJob(jobId) {
  await fs.rm(jobUploadsDir(jobId), { recursive: true, force: true });
  await fs.rm(jobOutputsDir(jobId), { recursive: true, force: true });
  await fs.rm(jobZipFile(jobId), { force: true });
  await fs.rm(jobMetaFile(jobId), { force: true });
}

module.exports = {
  jobUploadsDir,
  jobOutputsDir,
  jobMetaFile,
  jobZipFile,
  ensureDirs,
  ensureJobDirs,
  writeJobMeta,
  readJobMeta,
  jobMetaExistsSync,
  removeJob,
};
