'use strict';

const path = require('path');
const { WorkerPool } = require('../../src/services/workerPool.service');

describe('WorkerPool', () => {
  it('times out a stuck image task and replaces the worker', async () => {
    const pool = new WorkerPool(1, 10);
    const startedAt = Date.now();

    await expect(
      pool.run({
        filePath: path.join(__dirname, '..', 'fixtures', 'sample_label.jpeg'),
        outputPath: path.join(__dirname, '..', 'fixtures', '_tmp_timeout_output.jpeg'),
        idWeightMap: new Map([['307775718', 900]]),
      })
    ).rejects.toMatchObject({
      code: 'ETASKTIMEOUT',
      timeoutMs: 10,
    });

    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(pool.workers).toHaveLength(1);
    expect(pool.pending.size).toBe(0);

    await pool.shutdown();
  });
});
