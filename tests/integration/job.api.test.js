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
    expect(result.newWeight).toBe(900);
    expect(result.replacedRegions).toHaveLength(2);
    for (const region of result.replacedRegions) {
      expect(region.originalText).toBe('802.91');
      expect(region.newText).toBe('900.00');
    }

    const downloadRes = await request(app).get(`/api/jobs/${jobId}/download`).expect(200);
    expect(downloadRes.headers['content-type']).toMatch(/zip/);

    const fs = require('fs');
    const zipPath = jobService.getZipPath(jobId);
    expect(fs.existsSync(zipPath)).toBe(true);
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
    for (let i = 0; i < 60; i += 1) {
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
