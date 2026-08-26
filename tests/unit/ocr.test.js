'use strict';

jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));
const Tesseract = require('tesseract.js');
const ocr = require('../../src/services/ocr.service');

it('scopes sparse/header OCR options to one recognition, preserving default page OCR', async () => {
  const recognize = jest.fn().mockResolvedValue({ data: { text: '', blocks: [] } });
  const terminate = jest.fn();
  Tesseract.createWorker.mockResolvedValue({ recognize, terminate });
  try {
    await ocr.recognize(Buffer.from('header'), { psm: 11, whitelist: '0123456789' });
    await ocr.recognize(Buffer.from('page'));
    expect(recognize.mock.calls[0][1]).toEqual({
      tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789',
    });
    expect(recognize.mock.calls[1][1]).toEqual({});
    expect(Tesseract.createWorker).toHaveBeenCalledTimes(1);
  } finally {
    await ocr.terminate();
  }
});
