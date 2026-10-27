# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base

# Sharp needs libvips; fontconfig is needed so SVG->raster text overlays
# render with a real sans-serif font inside the container.
#
# fonts-liberation matters for appearance matching, not just for having "a"
# font: these POD templates are printed in an Arial/Helvetica-metric face, and
# Liberation Sans is metrically compatible with Arial. With only DejaVu
# installed, every candidate family collapsed to DejaVu Sans and replacement
# digits were visibly wider and rounder than the surrounding print.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    poppler-utils \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tessdata ./tessdata
# Bundled label typefaces, registered at runtime by src/config/fonts.js.
COPY fonts ./fonts

ENV NODE_ENV=production \
    STORAGE_DIR=/app/storage \
    TESSDATA_DIR=/app/tessdata

RUN mkdir -p /app/storage/uploads /app/storage/outputs /app/storage/jobs

EXPOSE 3000

CMD ["node", "src/server.js"]
