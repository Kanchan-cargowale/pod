'use strict';

const path = require('path');
const request = require('supertest');

const createApp = require('../../src/app');
const storage = require('../../src/services/storage.service');
const jobService = require('../../src/services/job.service');

jest.setTimeout(180000); // OCR over a 4032x3024 real photo can take up to ~60-90s in CI

const IMAGE_FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample_label.jpeg');
const ROTATED_IMAGE_FIXTURE = path.join(__dirname, '..', 'fixtures', 'real_world_1.jpeg');
const MAPPING_FIXTURE = path.join(__dirname, '..', 'fixtures', 'WeightUpdateTemplate.xlsx');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('POST /api/jobs (end-to-end with real files)', () => {
  let app;

  beforeAll(async () => {
    await storage.ensureDirs();
    app = createApp();
  });

  afterAll(async () => {
    await jobService.shutdown();
  });

  it('detects the shipment ID and weight columns on the real POD label, then replaces the weight', async () => {
    const createRes = await request(app)
      .post('/api/jobs')
      .attach('images', IMAGE_FIXTURE)
      .attach('mapping', MAPPING_FIXTURE)
      .expect(202);

    expect(createRes.body.jobId).toBeDefined();
    expect(createRes.body.totalFiles).toBe(1);
    expect(createRes.body.mappingRows).toBe(2);

    const { jobId } = createRes.body;

    // Poll until the background job finishes.
    let job;
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const statusRes = await request(app).get(`/api/jobs/${jobId}`).expect(200);
      job = statusRes.body;
      if (job.status === 'completed' || job.status === 'failed') break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(2000);
    }

    expect(job.status).toBe('completed');
    expect(job.matchedFiles).toBe(1);
    expect(job.unmatchedFiles).toBe(0);

    const [result] = job.results;
    expect(result.status).toBe('ok');
    expect(result.shipmentId).toBe('307775718');
    expect(result.filename).toBe('307775718.jpeg');
    expect(result.outputFilename).toBe('307775718.jpeg');
    expect(result.newWeight).toBe(900);
    expect(result.replacedRegions).toHaveLength(2);
    for (const region of result.replacedRegions) {
      // A confirmed sibling cell can be inferred from table/header geometry
      // even when OCR reads only one of the two identical printed values.
      expect(['802.91', '']).toContain(region.originalText);
      expect(region.newText).toBe('900.00');
    }

    const downloadRes = await request(app).get(`/api/jobs/${jobId}/download`).expect(200);
    expect(downloadRes.headers['content-type']).toMatch(/zip/);

    const fs = require('fs');
    const zipPath = jobService.getZipPath(jobId);
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.existsSync(path.join(jobService.getOutputsDir(jobId), '307775718.jpeg'))).toBe(true);
    const stat = fs.statSync(zipPath);
    expect(stat.size).toBeGreaterThan(1000);

    // A ZIP's local file header signature is "PK\x03\x04".
    const header = Buffer.alloc(4);
    const fd = fs.openSync(zipPath, 'r');
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    expect(header.slice(0, 2).toString('utf8')).toBe('PK');
  });

  it('rejects a job with no images', async () => {
    await request(app)
      .post('/api/jobs')
      .attach('mapping', MAPPING_FIXTURE)
      .expect(400);
  });

  it('preserves an unmatched review image and renames it from the scanned header ID', async () => {
    const ExcelJS = require('exceljs');
    const fs = require('fs');
    const os = require('os');
    const reviewMapping = path.join(os.tmpdir(), `pod-review-${Date.now()}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Weights');
    sheet.addRow(['ID', 'Weight']);
    sheet.addRow(['999999999', 15]);
    await workbook.xlsx.writeFile(reviewMapping);

    try {
      const createRes = await request(app)
        .post('/api/jobs')
        .attach('images', IMAGE_FIXTURE)
        .attach('mapping', reviewMapping)
        .expect(202);
      let job;
      for (let i = 0; i < 120; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        job = (await request(app).get(`/api/jobs/${createRes.body.jobId}`).expect(200)).body;
        if (job.status === 'completed' || job.status === 'failed') break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
      }
      expect(job.status).toBe('completed');
      expect(job.results[0].status).toBe('unmatched');
      expect(job.results[0].downloadable).toBe(true);
      expect(job.results[0].outputFilename).toBe('307775718.jpeg');
      expect(fs.existsSync(path.join(jobService.getOutputsDir(job.jobId), '307775718.jpeg'))).toBe(true);

      await request(app)
        .post(`/api/jobs/${job.jobId}/download-selected`)
        .send({ filenames: ['307775718.jpeg'] })
        .expect(200);
    } finally {
      fs.rmSync(reviewMapping, { force: true });
    }
  });

  it('downloads selected images that are ready while the job is still processing', async () => {
    const fs = require('fs');
    const jobId = `processing-selected-${Date.now()}`;
    const outputFilename = 'ready-label.jpg';

    await storage.ensureJobDirs(jobId);
    fs.copyFileSync(IMAGE_FIXTURE, path.join(jobService.getOutputsDir(jobId), outputFilename));
    await storage.writeJobMeta(jobId, {
      jobId,
      status: 'processing',
      totalFiles: 2,
      processedFiles: 1,
      matchedFiles: 1,
      unmatchedFiles: 0,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
      updatedAt: new Date().toISOString(),
      results: [
        {
          status: 'ok',
          filename: outputFilename,
          outputFilename,
          downloadable: true,
        },
      ],
      error: null,
      zipReady: false,
    });

    try {
      const downloadRes = await request(app)
        .post(`/api/jobs/${jobId}/download-selected`)
        .send({ filenames: [outputFilename, 'not-ready-yet.jpg'] })
        .expect(200);

      expect(downloadRes.headers['content-type']).toMatch(/zip/);
      expect(downloadRes.headers['x-selected-ready-count']).toBe('1');
      expect(downloadRes.headers['x-selected-requested-count']).toBe('2');
    } finally {
      await storage.removeJob(jobId);
    }
  });

  it('auto-orients an EXIF-rotated label instead of falsely reporting a rotation error', async () => {
    const ExcelJS = require('exceljs');
    const fs = require('fs');
    const autoOrientMapping = path.join(
      __dirname,
      '..',
      'fixtures',
      '_tmp_auto_orient_mapping.xlsx'
    );
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['LR', 'Weight']);
    sheet.addRow(['298806377', 152]);
    await workbook.xlsx.writeFile(autoOrientMapping);

    let createRes;
    try {
      createRes = await request(app)
        .post('/api/jobs')
        .attach('images', ROTATED_IMAGE_FIXTURE, {
          filename: 'LM_POD_298806377.jpeg',
          contentType: 'image/jpeg',
        })
        .attach('mapping', autoOrientMapping)
        .expect(202);
    } finally {
      fs.unlinkSync(autoOrientMapping);
    }

    const { jobId } = createRes.body;
    let job;
    for (let i = 0; i < 120; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const statusRes = await request(app).get(`/api/jobs/${jobId}`).expect(200);
      job = statusRes.body;
      if (job.status === 'completed' || job.status === 'failed') break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }

    expect(job.status).toBe('completed');
    expect(job.matchedFiles).toBe(1);
    expect(job.unmatchedFiles).toBe(0);
    expect(job.results).toHaveLength(1);
    expect(job.results[0]).toMatchObject({
      status: 'ok',
      shipmentId: '298806377',
      filename: '298806377.jpeg',
      outputFilename: '298806377.jpeg',
      newWeight: 152,
    });
    expect(job.results[0].replacedRegions.length).toBeGreaterThan(0);
    expect(job.results[0].errorCode).not.toBe('image_rotation');
  });

  it('rejects a job with no mapping workbook', async () => {
    await request(app)
      .post('/api/jobs')
      .attach('images', IMAGE_FIXTURE)
      .expect(400);
  });

  it('returns 404 for an unknown job id', async () => {
    await request(app).get('/api/jobs/does-not-exist').expect(404);
  });
});
