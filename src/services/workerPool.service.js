'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');
const logger = require('../utils/logger');

const WORKER_SCRIPT = path.join(__dirname, '..', 'workers', 'imageProcessor.worker.js');

class WorkerPool {
  /**
   * @param {number} size number of persistent worker_threads to spawn
   */
  constructor(size, taskTimeoutMs = config.imageProcessingTimeoutMs) {
    this.size = size;
    this.taskTimeoutMs = taskTimeoutMs;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map(); // worker -> {taskId, resolve, reject, timer}
    this.retiring = new Set();
    this.nextTaskId = 1;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    for (let i = 0; i < this.size; i += 1) {
      this._spawnWorker();
    }
  }

  _spawnWorker() {
    const worker = new Worker(WORKER_SCRIPT);

    worker.on('message', (msg) => {
      const inFlight = this.pending.get(worker);
      if (inFlight && inFlight.taskId === msg.taskId) {
        this.pending.delete(worker);
        if (inFlight.timer) clearTimeout(inFlight.timer);
        if (msg.ok) inFlight.resolve(msg.result);
        else inFlight.reject(Object.assign(new Error(msg.error.message), { stack: msg.error.stack }));
      }
      if (this.workers.includes(worker)) this.idle.push(worker);
      this._drainQueue();
    });

    worker.on('error', (err) => {
      logger.error('Worker thread crashed', { error: err.message });
      const inFlight = this.pending.get(worker);
      if (inFlight) {
        this.pending.delete(worker);
        if (inFlight.timer) clearTimeout(inFlight.timer);
        inFlight.reject(err);
      }
      this._replaceWorker(worker);
    });

    worker.on('exit', (code) => {
      if (this.retiring.delete(worker)) return;
      if (code !== 0) {
        logger.warn('Worker thread exited unexpectedly', { code });
      }
    });

    this.workers.push(worker);
    this.idle.push(worker);
  }

  _replaceWorker(deadWorker) {
    if (!this.workers.includes(deadWorker)) return;
    this.workers = this.workers.filter((w) => w !== deadWorker);
    this.idle = this.idle.filter((w) => w !== deadWorker);
    this._spawnWorker();
    this._drainQueue();
  }

  async _timeoutWorker(worker) {
    const inFlight = this.pending.get(worker);
    if (!inFlight) return;

    this.pending.delete(worker);
    const timeoutSeconds = Math.round(this.taskTimeoutMs / 1000);
    const err = Object.assign(
      new Error(`Image processing timed out after ${timeoutSeconds}s`),
      { code: 'ETASKTIMEOUT', timeoutMs: this.taskTimeoutMs }
    );

    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    this.retiring.add(worker);
    try {
      // Do not start another Tesseract WASM instance until the timed-out one
      // has actually released its CPU and memory. Immediate replacement under
      // load compounds contention and causes the rest of the batch to time out.
      await worker.terminate();
    } catch (terminateErr) {
      logger.warn('Timed-out worker termination failed', { error: terminateErr.message });
    } finally {
      this.retiring.delete(worker);
    }

    if (this._started) this._spawnWorker();
    inFlight.reject(err);
    this._drainQueue();
  }

  _drainQueue() {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.shift();
      const task = this.queue.shift();
      if (this.taskTimeoutMs > 0) {
        task.timer = setTimeout(() => this._timeoutWorker(worker), this.taskTimeoutMs);
        task.timer.unref();
      }
      this.pending.set(worker, task);
      worker.postMessage({ type: 'task', taskId: task.taskId, payload: task.payload });
    }
  }

  /**
   * Submits a single image-processing task to the pool. Resolves with
   * the worker's result object once processed.
   */
  run(payload) {
    if (!this._started) this.start();
    const taskId = this.nextTaskId++;
    return new Promise((resolve, reject) => {
      this.queue.push({ taskId, payload, resolve, reject });
      this._drainQueue();
    });
  }

  async shutdown() {
    this._started = false;
    for (const inFlight of this.pending.values()) {
      if (inFlight.timer) clearTimeout(inFlight.timer);
    }
    this.pending.clear();
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise((resolve) => {
            w.once('exit', resolve);
            w.postMessage({ type: 'shutdown' });
            setTimeout(() => {
              w.terminate().then(resolve).catch(resolve);
            }, 5000).unref();
          })
      )
    );
    this.workers = [];
    this.idle = [];
  }
}

module.exports = { WorkerPool };
