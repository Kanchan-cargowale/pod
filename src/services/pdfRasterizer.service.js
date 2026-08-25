'use strict';

const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const sharp = require('sharp');

const config = require('../config');

function commandError(executable, message, stderr = '') {
  const error = new Error(`${message}${stderr ? `: ${stderr.trim()}` : ''}`);
  error.code = path.basename(executable).toLowerCase().startsWith('pdftoppm')
    ? 'PDF_RENDERER_UNAVAILABLE'
    : 'PDF_INSPECTION_FAILED';
  return error;
}

function runCommand(executable, args, timeoutMs = config.pdfRasterTimeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const error = new Error(`PDF command timed out after ${Math.round(timeoutMs / 1000)}s`);
      error.code = 'PDF_RASTER_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(commandError(
          executable,
          `PDF renderer executable was not found (${executable}); install Poppler or set PDFTOPPM_PATH/PDFINFO_PATH`
        ));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(commandError(executable, `PDF command exited with code ${code}`, stderr));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function assertPdfSignature(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || signature.toString('ascii') !== '%PDF-') {
      const error = new Error('Uploaded .pdf file does not contain a valid PDF signature');
      error.code = 'INVALID_PDF';
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function normalizePdfLabelOrientation(imagePath, quality) {
  const metadata = await sharp(imagePath).metadata();
  if (!metadata.width || !metadata.height || metadata.height <= metadata.width * 1.08) return false;

  // These PDFs contain a landscape POD scan placed sideways on a portrait
  // page. Correct it before OCR so the worker does not spend a full pass on
  // text it cannot read before trying its 90-degree fallback.
  const rotated = await sharp(imagePath)
    .rotate(90)
    .jpeg({ quality })
    .toBuffer();
  await fs.writeFile(imagePath, rotated);
  return true;
}

async function rasterizePdf(filePath, outputDirectory, options = {}) {
  const execute = options.runCommand || runCommand;
  const pdftoppmPath = options.pdftoppmPath || config.pdftoppmPath;
  const density = Math.max(100, Math.min(400, Number(options.density || config.pdfRasterDensity)));
  const jpegQuality = Math.max(85, Math.min(100, Number(
    options.jpegQuality || config.pdfRasterJpegQuality
  )));

  await assertPdfSignature(filePath);
  await fs.mkdir(outputDirectory, { recursive: true });
  const outputPrefix = path.join(outputDirectory, 'page');
  await execute(pdftoppmPath, [
    '-jpeg',
    '-jpegopt', `quality=${jpegQuality}`,
    '-r', String(density),
    '-f', '1',
    '-l', '1',
    '-singlefile',
    filePath,
    outputPrefix,
  ], config.pdfRasterTimeoutMs);

  const outputPath = `${outputPrefix}.jpg`;
  try {
    await fs.access(outputPath);
  } catch {
    const error = new Error('PDF renderer did not produce the expected single-page image');
    error.code = 'PDF_RASTER_INCOMPLETE';
    throw error;
  }

  if (options.normalizeOrientation !== false) {
    await normalizePdfLabelOrientation(outputPath, jpegQuality);
  }

  return [{ filePath: outputPath, pageNumber: 1, pageCount: 1 }];
}

module.exports = {
  rasterizePdf,
  assertPdfSignature,
  normalizePdfLabelOrientation,
  runCommand,
};
