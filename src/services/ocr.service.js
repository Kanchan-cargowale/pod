'use strict';

const Tesseract = require('tesseract.js');
const config = require('../config');

let workerPromise = null;

/**
 * Lazily creates (and caches) a single Tesseract worker for this process/
 * worker-thread. Each worker thread in the pool gets its own instance -
 * this function is called from within workers/imageProcessor.worker.js.
 */
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(config.ocrLanguage, 1, {
      langPath: config.tessdataDir,
      cachePath: config.tessdataDir,
      gzip: true,
      logger: () => {}, // silence per-tile progress logs in production
    });
  }
  return workerPromise;
}

/**
 * Runs OCR over an image and returns a flat, normalized list of words
 * with bounding boxes, independent of tesseract.js's nested block/
 * paragraph/line structure.
 *
 * @param {string|Buffer} image path or buffer
 * @param {{psm?: number, whitelist?: string}} [options] scoped to this recognition
 * @returns {Promise<{text: string, words: Array<{text:string, confidence:number, bbox:{x0:number,y0:number,x1:number,y1:number}}>}>}
 */
async function recognize(image, options = {}) {
  const worker = await getWorker();
  // Per-recognition parameters are restored by Tesseract after the call;
  // a digits-only header probe must never affect the next full-page pass.
  const parameters = {};
  if (options.psm !== undefined) parameters.tessedit_pageseg_mode = String(options.psm);
  if (options.whitelist !== undefined) parameters.tessedit_char_whitelist = options.whitelist;
  const { data } = await worker.recognize(image, parameters, { blocks: true, text: true });

  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          words.push({
            text: word.text,
            confidence: word.confidence,
            bbox: { ...word.bbox },
          });
        }
      }
    }
  }

  return { text: data.text, words };
}

async function terminate() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

module.exports = { recognize, terminate };
