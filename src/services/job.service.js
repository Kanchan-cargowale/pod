'use strict';

const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');

const config = require('../config');
const logger = require('../utils/logger');
const storage = require('./storage.service');
const { zipDirectory } = require('./zip.service');
const { WorkerPool } = require('./workerPool.service');

// A single shared pool serves every job; the pool itself bounds how many
// images are OCR'd/edited in parallel regardless of how many jobs are
// in flight, so the server stays responsive under bursty upload traffic.
const pool = new WorkerPool(config.workerPoolSize);

const jobs = new Map(); // jobId -> in-memory job state (mirrors the on-disk JSON)

function newJobState(jobId, totalFiles) {
  return {
    jobId,
    status: 'queued', // queued | processing | completed | failed
    totalFiles,
    processedFiles: 0,
    matchedFiles: 0,
    unmatchedFiles: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    durationMs: null,
    updatedAt: new Date().toISOString(),
    results: [],
    error: null,
    zipReady: false,
  };
}

async function persist(state) {
  jobs.set(state.jobId, state);
  await storage.writeJobMeta(state.jobId, state);
}

/**
 * Kicks off processing for a batch of already-uploaded image files.
 * Returns immediately with the jobId; processing continues in the
 * background and progress can be polled via getJob().
 *
 * @param {{ imagePaths: string[], idWeightMap: Map<string, number> }} params
 */
async function createJob({ imagePaths, idWeightMap, tempUploadsDir }) {
  const jobId = randomUUID();
  await storage.ensureJobDirs(jobId);

  const state = newJobState(jobId, imagePaths.length);
  await persist(state);

  // Fire-and-forget: the HTTP handler does not await this.
  runJob(jobId, imagePaths, idWeightMap, tempUploadsDir).catch(async (err) => {
    logger.error('Job failed', { jobId, error: err.message });
    const current = jobs.get(jobId) || state;
    current.status = 'failed';
    current.error = err.message;
    current.updatedAt = new Date().toISOString();
    await persist(current);
  });

  return jobId;
}

async function runJob(jobId, imagePaths, idWeightMap, tempUploadsDir) {
  pool.start();

  const state = jobs.get(jobId);
  state.status = 'processing';
  state.startedAt = new Date().toISOString();
  await persist(state);

  const outputsDir = storage.jobOutputsDir(jobId);

  const tasks = imagePaths.map((filePath) => {
    const filename = path.basename(filePath);
    const outputPath = path.join(outputsDir, filename);

    return pool
      .run({ filePath, outputPath, idWeightMap })
      .then((result) => ({ filename, ...result }))
      .catch((err) => ({ filename, status: 'error', reason: err.message }))
      .then(async (result) => {
        state.processedFiles += 1;
        if (result.status === 'ok') state.matchedFiles += 1;
        else state.unmatchedFiles += 1;
        state.results.push(result);
        state.updatedAt = new Date().toISOString();
        await persist(state);
        return result;
      });
  });

  await Promise.all(tasks);

  const zipPath = storage.jobZipFile(jobId);
  await zipDirectory(outputsDir, zipPath);

  if (tempUploadsDir) {
    await fs.rm(tempUploadsDir, { recursive: true, force: true }).catch(() => {});
  }

  state.status = 'completed';
  state.zipReady = true;
  state.completedAt = new Date().toISOString();
  state.durationMs = Math.max(
    0,
    new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime()
  );
  state.updatedAt = state.completedAt;
  await persist(state);
}

async function getJob(jobId) {
  if (jobs.has(jobId)) return jobs.get(jobId);
  const fromDisk = await storage.readJobMeta(jobId);
  if (fromDisk) jobs.set(jobId, fromDisk);
  return fromDisk;
}

function getZipPath(jobId) {
  return storage.jobZipFile(jobId);
}

function getOutputsDir(jobId) {
  return storage.jobOutputsDir(jobId);
}

async function shutdown() {
  await pool.shutdown();
}

module.exports = { createJob, getJob, getZipPath, getOutputsDir, shutdown, _pool: pool };
