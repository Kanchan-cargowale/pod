# Courier Label Editor

Bulk courier/POD label weight editor. Upload a batch of JPG/PNG shipment
labels plus an Excel mapping of `Shipment ID -> New Weight`, and get back a
ZIP where each label has had its printed weight value(s) replaced —
pixel-for-pixel identical everywhere else — with the new weight from the
mapping sheet.

This was built and validated against a real Delhivery "LM POD" label and a
real `WeightUpdateTemplate.xlsx` mapping file (see `tests/fixtures/`). The
included tests run the **actual** OCR + image-editing pipeline against those
real files, not mocks.

## How it works

1. **Upload** — `POST /api/jobs` with `images` (one or more JPG/PNG files)
   and `mapping` (an `.xlsx` with `ID` and `Weight` columns).
2. **OCR** — each image is run through Tesseract.js (a real, local OCR
   engine — no cloud calls), producing word-level text + bounding boxes.
3. **Match** — `src/services/labelMatcher.service.js`:
   - Finds which shipment ID (from the mapping) is printed on the label,
     via exact match with a bounded-Levenshtein fuzzy fallback for OCR
     misreads.
   - Finds every "WEIGHT" column header on the page, then looks directly
     below each one (within a configurable vertical window and horizontal
     column tolerance) for the printed numeric value belonging to that
     column. This is anchor-based and generalizes across labels where a
     "weight" header sits above its value, rather than hard-coding pixel
     coordinates for one template.
4. **Edit** — `src/services/imageEditor.service.js` uses Sharp to:
   - Sample the real local background color around each matched value box
     (not just assume white), ignoring any table rule crossing the sample.
   - Shrink the clearing rectangle around detected table rules so printed
     border lines (e.g. the vertical line left of a value) are never erased.
   - Paint over just that region and re-render the new weight as text,
     sampling the value's own pixels for size/ink and cross-checking them
     against other numeric words on the same page (box dimensions, counts)
     so the replacement matches the image's typography even when the
     original value is faint or blurred, leaving every other pixel
     byte-identical.
5. **Scale** — each image is OCR'd + edited inside a dedicated
   `worker_threads` worker (`src/workers/imageProcessor.worker.js`), pooled
   by `src/services/workerPool.service.js`, so hundreds of labels are
   processed truly in parallel across CPU cores, not just interleaved on
   one event loop.
6. **Deliver** — once every image in the batch is processed, the outputs
   directory is zipped (`archiver`) and made available at
   `GET /api/jobs/:id/download`.

Processing runs asynchronously: the upload call returns immediately with a
`jobId`; the client polls `GET /api/jobs/:id` for progress and downloads the
ZIP once `status` is `completed`. This is deliberate — a single HTTP request
blocking on hundreds of OCR passes would time out long before the batch
finishes.

## Why OCR "column matching" instead of pure regex

Courier POD/label templates vary in layout, but nearly all of them print a
"WEIGHT" (or "ACTUAL WEIGHT" / "CHARGED WEIGHT") header directly above the
numeric value. Rather than hard-coding pixel coordinates for one carrier's
template (fragile) or blindly replacing the first decimal number found on
the page (wrong — invoice values, box counts, EWB numbers are all numbers
too), the matcher anchors on the header text itself and only considers
numeric tokens in the same column, below the header, within a bounded
vertical window. If no such anchor+value pair is found, the label is
flagged `id_matched_no_weight_region` rather than silently guessing.

## Handling real-world phone photos (fragmented IDs)

Clean scans are easy. Phone photos of a paper POD - skewed, shadowed,
lower-resolution - are not. The most common real-world failure found
during testing: Tesseract splitting a large, bold barcode ID into several
separate word tokens instead of reading it as one string (e.g. "309030935"
read as `"30"`, `"903"`, `"0"`, `"935"`). A naive single-word match then
reports the ID as "not found" even though it's genuinely on the page.

`labelMatcher.service.js` handles this with a reconstruction pass
(`buildMergedNumericCandidates`): nearby numeric OCR fragments are chained
together in left-to-right reading order (tolerant of the vertical drift a
tilted photo introduces) and tested as merged candidates against the
mapping sheet, in addition to plain single-word matches. A clean
single-token exact match is always preferred when one exists; the
reconstruction only kicks in as a fallback. See
`tests/unit/fragmentedId.test.js`, which is a regression test built from a
real fragmented OCR read on `tests/fixtures/real_world_2.jpg`.

If a label still comes back `unmatched`, both the API response and the web
UI now show `detectedNumbers` — every numeric token (and merged
candidate) Tesseract actually found on that page — so you can compare it
against your mapping sheet's ID column directly instead of guessing why it
failed.

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

The server listens on `PORT` (default `3000`). Open **http://localhost:3000** in
a browser for the web UI: drop in your label images and mapping workbook,
click "Process batch", and watch results appear live as each label finishes
- edited weight column, matched shipment ID, and a thumbnail of the actual
output image, plus a "Download ZIP" button once the batch completes.

If you'd rather drive it without a browser, see the API section below.

### Docker

```bash
docker compose up --build
```

## API

### `POST /api/jobs`

`multipart/form-data`:

| field     | type          | required | notes                                   |
|-----------|---------------|----------|------------------------------------------|
| `images`  | file[]        | yes      | JPG/PNG, up to `MAX_FILES_PER_JOB`       |
| `mapping` | file          | yes      | `.xlsx` with `ID` and `Weight` columns   |

Response `202`:
```json
{
  "jobId": "b008143e-eb2b-48c2-b8d0-52c09e1463e7",
  "totalFiles": 80,
  "mappingRows": 2,
  "mappingWarnings": [],
  "statusUrl": "/api/jobs/b008143e-.../",
  "downloadUrl": "/api/jobs/b008143e-.../download"
}
```

### `GET /api/jobs/:id`

```json
{
  "jobId": "...",
  "status": "processing", // queued | processing | completed | failed
  "totalFiles": 80,
  "processedFiles": 47,
  "matchedFiles": 45,
  "unmatchedFiles": 2,
  "startedAt": "2026-08-04T10:15:30.000Z", // when OCR/editing began
  "completedAt": null,                    // set on completion/failure
  "durationMs": null,                     // total processing time once done
  "results": [
    {
      "filename": "LM_POD_....jpeg",
      "status": "ok",
      "shipmentId": "307775718",
      "newWeight": 900,
      "processingMs": 4123,               // per-image OCR + edit time
      "replacedRegions": [
        { "originalText": "802.91", "newText": "900.00", "bbox": { "...": "..." } }
      ]
    }
  ]
}
```

The web UI surfaces the same timing: a live "Time" stat in the results
header (ticks while processing, freezes at the total once done) and a
per-file "Time" row on each result card.

`status` per file: `ok`, `unmatched` (no ID from the mapping found on the
page), `id_matched_no_weight_region` (ID found, but no weight column could
be located — flagged for manual review), or `error`.

### `GET /api/jobs/:id/preview/:filename`

Streams a single edited label image inline (used by the web UI to show
each result as it finishes). Only available for files with `status: "ok"`.

### `GET /api/jobs/:id/download`

Streams the result ZIP once `status` is `completed`.

## Configuration

See `.env.example`. Key knobs:

- `WORKER_POOL_SIZE` — number of persistent worker threads (defaults to
  CPU count - 1).
- `OCR_MIN_CONFIDENCE` — minimum Tesseract word confidence to trust for ID
  matching.
- `MATCH_VERTICAL_WINDOW_RATIO` / `MATCH_HORIZONTAL_TOLERANCE_PX` — tune
  these if a carrier's template places the weight value unusually far from
  its header.

## OCR language data

Tesseract.js needs `eng.traineddata`. It's pre-fetched into `tessdata/` in
this repo so the service runs fully offline. If you need to regenerate it
or add another language:

```bash
curl -L -o tessdata/<lang>.traineddata.gz \
  https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/<lang>.traineddata.gz
```

## Testing

```bash
npm test              # everything
npm run test:unit     # matcher + Excel parser logic (fast, no OCR)
npm run test:integration  # full pipeline against tests/fixtures/ (real OCR, ~15-90s)
```

The integration test uploads the real sample POD label and mapping sheet in
this repo, waits for the background job to finish, and asserts:
- the correct shipment ID (`307775718`) was found,
- both weight columns were correctly matched and replaced with the mapped
  weight (`900`, formatted as `900.00` to match the original precision),
- a valid ZIP is produced and downloadable.

## Known limitations / next steps for a larger deployment

- Job state is in-memory + a JSON file per job on local disk. For a
  multi-instance deployment, swap `storage.service.js` for Redis/Postgres
  and the ZIP for S3/GCS — the rest of the pipeline is unaffected.
- OCR runs on CPU via Tesseract.js/WASM. For very high throughput, the same
  `labelMatcher.service.js` logic can sit behind a GPU-accelerated OCR
  engine (e.g. a PaddleOCR microservice called over HTTP from
  `ocr.service.js`) without touching the matching/editing code.
- The anchor-based column matching handles the common "header above value"
  layout (validated against a real Delhivery LM POD). Wildly different
  templates (e.g. weight printed to the left of its label) would need an
  additional matching strategy alongside the vertical-anchor one.
