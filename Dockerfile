# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base

# Sharp needs libvips; fontconfig is needed so SVG->raster text overlays
# render with a real sans-serif font inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    fontconfig \
    fonts-dejavu-core \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tessdata ./tessdata

ENV NODE_ENV=production \
    STORAGE_DIR=/app/storage \
    TESSDATA_DIR=/app/tessdata

RUN mkdir -p /app/storage/uploads /app/storage/outputs /app/storage/jobs

EXPOSE 3000

CMD ["node", "src/server.js"]
