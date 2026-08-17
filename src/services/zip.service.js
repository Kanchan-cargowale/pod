'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

/**
 * Zips every file directly inside `sourceDir` into `destZipPath`.
 * Returns a promise that resolves with the final archive size in bytes.
 */
function zipDirectory(sourceDir, destZipPath, selectedPaths = null) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(archive.pointer()));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);

    archive.pipe(output);
    if (selectedPaths && selectedPaths.length) {
      for (const filePath of selectedPaths) {
        const name = path.basename(filePath);
        archive.file(filePath, { name });
      }
    } else {
      archive.directory(sourceDir, false);
    }
    archive.finalize();
  });
}

module.exports = { zipDirectory };
