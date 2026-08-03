'use strict';

const fs = require('fs');
const archiver = require('archiver');

/**
 * Zips every file directly inside `sourceDir` into `destZipPath`.
 * Returns a promise that resolves with the final archive size in bytes.
 */
function zipDirectory(sourceDir, destZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(archive.pointer()));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

module.exports = { zipDirectory };
