'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs/promises');

const {
  rasterizePdf,
  assertPdfSignature,
} = require('../../src/services/pdfRasterizer.service');
const { prepareInputFile, runWithConcurrency } = require('../../src/services/job.service');

describe('pdfRasterizer.service', () => {
  let tempDir;
  let pdfPath;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pod-pdf-test-'));
    pdfPath = path.join(tempDir, 'labels.pdf');
    await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n% test fixture'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects a file whose extension lies about its PDF content', async () => {
    const invalid = path.join(tempDir, 'invalid.pdf');
    await fs.writeFile(invalid, 'not a pdf');
    await expect(assertPdfSignature(invalid)).rejects.toMatchObject({ code: 'INVALID_PDF' });
  });

  it('renders only the first page directly to one high-quality JPEG work item', async () => {
    const calls = [];
    const outputDir = path.join(tempDir, 'pages');
    const execute = async (executable, args) => {
      calls.push({ executable, args });
      const prefix = args[args.length - 1];
      await fs.writeFile(`${prefix}.jpg`, 'single page');
      return { stdout: '', stderr: '' };
    };

    const pages = await rasterizePdf(pdfPath, outputDir, {
      runCommand: execute,
      pdftoppmPath: 'test-pdftoppm',
      density: 200,
      jpegQuality: 95,
      normalizeOrientation: false,
    });

    expect(pages).toEqual([{
      filePath: path.join(outputDir, 'page.jpg'),
      pageNumber: 1,
      pageCount: 1,
    }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      '-jpeg', '-jpegopt', 'quality=95', '-r', '200', '-f', '1', '-l', '1', '-singlefile',
      pdfPath, path.join(outputDir, 'page'),
    ]);
  });

  it('fails clearly when Poppler returns without the expected page image', async () => {
    const execute = jest.fn(async () => ({ stdout: '', stderr: '' }));
    await expect(rasterizePdf(pdfPath, path.join(tempDir, 'pages'), {
      runCommand: execute,
      pdftoppmPath: 'test-pdftoppm',
      normalizeOrientation: false,
    })).rejects.toMatchObject({ code: 'PDF_RASTER_INCOMPLETE' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('single-page PDF job preparation', () => {
  it('keeps images unchanged and prepares one PDF page with source metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pod-expand-test-'));
    try {
      const imagePath = path.join(root, 'label.jpg');
      const pdfPath = path.join(root, 'batch.pdf');
      await Promise.all([
        fs.writeFile(imagePath, 'image'),
        fs.writeFile(pdfPath, '%PDF-1.4'),
      ]);
      const renderPdf = jest.fn(async (source, outputDir) => [{
        filePath: path.join(outputDir, 'page.jpg'),
        pageNumber: 1,
        pageCount: 1,
      }]);

      const image = await prepareInputFile(imagePath, 0, root, renderPdf);
      const pdf = await prepareInputFile(pdfPath, 1, root, renderPdf);

      expect(image).toMatchObject({
        filePath: imagePath,
        sourceFilename: 'label.jpg',
        pageNumber: null,
      });
      expect(pdf).toMatchObject({
        sourceFilename: 'batch.pdf',
        workFilename: 'pdf-2.jpg',
        pageNumber: 1,
        pageCount: 1,
      });
      expect(renderPdf).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('passes a PDF renderer failure back to the per-file pipeline', async () => {
    const error = Object.assign(new Error('renderer missing'), { code: 'PDF_RENDERER_UNAVAILABLE' });
    await expect(prepareInputFile(
      'C:\\uploads\\broken.pdf', 0, 'C:\\uploads', async () => { throw error; }
    )).rejects.toMatchObject({ code: 'PDF_RENDERER_UNAVAILABLE' });
  });

  it('bounds complete conversion and OCR pipelines while reporting each completion', async () => {
    let active = 0;
    let maxActive = 0;
    const completed = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed.push(value);
      active -= 1;
    });

    expect(maxActive).toBe(2);
    expect(completed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
