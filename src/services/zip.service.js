'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.heic', '.heif', '.jfif', '.jpe', '.jpeg', '.jpg',
  '.png', '.tif', '.tiff', '.webp',
]);

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Zips image files directly inside `sourceDir` into `destZipPath`.
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
    const imagePaths = selectedPaths === null
      ? fs.readdirSync(sourceDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && isImageFile(entry.name))
        .map((entry) => path.join(sourceDir, entry.name))
      : selectedPaths.filter(isImageFile);
    for (const filePath of imagePaths) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const name = path.basename(filePath);
      archive.file(filePath, { name });
    }
    archive.finalize();
  });
}

module.exports = { zipDirectory };
