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
 * @returns {Promise<{text: string, words: Array<{text:string, confidence:number, bbox:{x0:number,y0:number,x1:number,y1:number}}>}>}
 */
async function recognize(image) {
  const worker = await getWorker();
  const { data } = await worker.recognize(image, {}, { blocks: true, text: true });

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
