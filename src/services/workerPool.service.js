'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

const WORKER_SCRIPT = path.join(__dirname, '..', 'workers', 'imageProcessor.worker.js');

class WorkerPool {
  /**
   * @param {number} size number of persistent worker_threads to spawn
   */
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map(); // worker -> {taskId, resolve, reject}
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
        if (msg.ok) inFlight.resolve(msg.result);
        else inFlight.reject(Object.assign(new Error(msg.error.message), { stack: msg.error.stack }));
      }
      this.idle.push(worker);
      this._drainQueue();
    });

    worker.on('error', (err) => {
      logger.error('Worker thread crashed', { error: err.message });
      const inFlight = this.pending.get(worker);
      if (inFlight) {
        this.pending.delete(worker);
        inFlight.reject(err);
      }
      this._replaceWorker(worker);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn('Worker thread exited unexpectedly', { code });
      }
    });

    this.workers.push(worker);
    this.idle.push(worker);
  }

  _replaceWorker(deadWorker) {
    this.workers = this.workers.filter((w) => w !== deadWorker);
    this.idle = this.idle.filter((w) => w !== deadWorker);
    this._spawnWorker();
    this._drainQueue();
  }

  _drainQueue() {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.shift();
      const task = this.queue.shift();
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
