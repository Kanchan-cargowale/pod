'use strict';

const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');

const config = require('../config');
const logger = require('../utils/logger');
const storage = require('./storage.service');
const { zipDirectory } = require('./zip.service');
const { WorkerPool } = require('./workerPool.service');
const { rasterizePdf } = require('./pdfRasterizer.service');

// A single shared pool serves every job; the pool itself bounds how many
// images are OCR'd/edited in parallel regardless of how many jobs are
// in flight, so the server stays responsive under bursty upload traffic.
const pool = new WorkerPool(config.workerPoolSize);

const jobs = new Map(); // jobId -> in-memory job state (mirrors the on-disk JSON)

async function preserveFailedInput(filePath, outputsDir, preferredFilename = path.basename(filePath)) {
  const outputFilename = path.basename(preferredFilename);
  const candidate = path.join(outputsDir, outputFilename);
  await fs.copyFile(filePath, candidate);
  return outputFilename;
}

function isPdfPath(filePath) {
  return path.extname(filePath).toLowerCase() === '.pdf';
}

async function prepareInputFile(filePath, index, tempUploadsDir, renderPdf = rasterizePdf) {
  const sourceFilename = path.basename(filePath);
  if (!isPdfPath(filePath)) {
    return {
      filePath,
      sourceFilename,
      workFilename: sourceFilename,
      pageNumber: null,
      pageCount: null,
    };
  }

  const pageDirectory = path.join(
    tempUploadsDir || path.dirname(filePath),
    'pdf-pages',
    String(index + 1)
  );
  const [page] = await renderPdf(filePath, pageDirectory);
  if (!page) {
    const error = new Error('PDF renderer did not return its single page');
    error.code = 'PDF_RASTER_INCOMPLETE';
    throw error;
  }
  return {
    filePath: page.filePath,
    sourceFilename,
    workFilename: `pdf-${index + 1}.jpg`,
    pageNumber: 1,
    pageCount: 1,
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const runnerCount = Math.min(items.length, Math.max(1, Number(concurrency) || 1));
  const runners = Array.from({ length: runnerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      // Each runner completes conversion + OCR before taking another file.
      // This gives live progress without launching every Poppler process at once.
      // eslint-disable-next-line no-await-in-loop
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function newJobState(jobId, totalFiles) {
  return {
    jobId,
    status: 'queued', // queued | processing | completed | failed
    totalFiles,
    processedFiles: 0,
    matchedFiles: 0,
    unmatchedFiles: 0,
    createdAt: new Date().toISOString(),
    startedAt: null, // set when OCR/editing actually begins
    completedAt: null,
    durationMs: null, // completedAt - startedAt, for "how long did it take"
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
    current.completedAt = new Date().toISOString();
    current.durationMs = Date.now() - new Date(current.startedAt || current.createdAt).getTime();
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

  await runWithConcurrency(imagePaths, config.workerPoolSize, async (inputPath, index) => {
    let item;
    try {
      item = await prepareInputFile(inputPath, index, tempUploadsDir);
    } catch (error) {
      const sourceFilename = path.basename(inputPath);
      const result = {
        originalFilename: sourceFilename,
        filename: sourceFilename,
        sourceType: 'pdf',
        sourcePageNumber: 1,
        sourcePageCount: 1,
        status: 'error',
        errorCode: error.code || 'pdf_rasterization_failed',
        reason: error.message,
        downloadable: false,
      };
      state.processedFiles += 1;
      state.unmatchedFiles += 1;
      state.results.push(result);
      state.updatedAt = new Date().toISOString();
      await persist(state);
      return;
    }

    const { filePath, sourceFilename, workFilename, pageNumber, pageCount } = item;
    const filename = path.basename(workFilename || filePath);
    const outputPath = path.join(outputsDir, filename);

    const result = await pool
      .run({ filePath, outputPath, idWeightMap, filenameHint: sourceFilename })
      .then((result) => ({
        originalFilename: sourceFilename,
        sourceType: pageNumber ? 'pdf' : 'image',
        sourcePageNumber: pageNumber,
        sourcePageCount: pageCount,
        filename: result.outputFilename || filename,
        ...result,
      }))
      .catch(async (err) => {
        if (err.code === 'ETASKTIMEOUT') {
          const outputFilename = await preserveFailedInput(filePath, outputsDir, filename);
          return {
            originalFilename: sourceFilename,
            sourceType: pageNumber ? 'pdf' : 'image',
            sourcePageNumber: pageNumber,
            sourcePageCount: pageCount,
            filename: outputFilename,
            outputFilename,
            status: 'error',
            errorCode: 'processing_timeout',
            reason: `${err.message}; original image preserved so the batch can finish`,
            processingMs: err.timeoutMs,
            downloadable: true,
          };
        }

        try {
          const recovered = await pool.run({
            filePath,
            outputPath,
            idWeightMap,
            filenameHint: sourceFilename,
            preserveOnly: true,
            preserveReason: err.message,
          });
          return {
            originalFilename: sourceFilename,
            sourceType: pageNumber ? 'pdf' : 'image',
            sourcePageNumber: pageNumber,
            sourcePageCount: pageCount,
            filename: recovered.outputFilename || filename,
            ...recovered,
          };
        } catch (scanErr) {
          const outputFilename = await preserveFailedInput(filePath, outputsDir, filename);
          return {
            originalFilename: sourceFilename,
            sourceType: pageNumber ? 'pdf' : 'image',
            sourcePageNumber: pageNumber,
            sourcePageCount: pageCount,
            filename: outputFilename,
            outputFilename,
            status: 'error',
            reason: `${err.message}; ID recovery failed: ${scanErr.message}`,
            downloadable: true,
          };
        }
      });

    state.processedFiles += 1;
    if (result.status === 'ok') state.matchedFiles += 1;
    else state.unmatchedFiles += 1;
    state.results.push(result);
    state.updatedAt = new Date().toISOString();
    await persist(state);
  });

  const zipPath = storage.jobZipFile(jobId);
  await zipDirectory(outputsDir, zipPath);

  if (tempUploadsDir) {
    await fs.rm(tempUploadsDir, { recursive: true, force: true }).catch(() => {});
  }

  state.status = 'completed';
  state.zipReady = true;
  state.completedAt = new Date().toISOString();
  state.durationMs = Date.now() - new Date(state.startedAt || state.createdAt).getTime();
  state.updatedAt = new Date().toISOString();
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

function getSelectedZipPath(jobId, suffix = '') {
  const suffixPart = suffix ? `-${suffix}` : '';
  return path.join(config.outputsDir, `${jobId}-selected${suffixPart}.zip`);
}

function getOutputsDir(jobId) {
  return storage.jobOutputsDir(jobId);
}

async function shutdown() {
  await pool.shutdown();
}

module.exports = {
  createJob,
  getJob,
  getZipPath,
  getSelectedZipPath,
  getOutputsDir,
  shutdown,
  prepareInputFile,
  runWithConcurrency,
  _pool: pool,
};
