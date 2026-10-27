(() => {
  const form = document.getElementById('remarks-form');
  const filesInput = document.getElementById('remarks-files');
  const dropzone = document.getElementById('remarks-drop');
  const filesCount = document.getElementById('remarks-files-count');
  const filesList = document.getElementById('remarks-files-list');
  const submit = document.getElementById('remarks-submit');
  const errorBox = document.getElementById('remarks-error');
  const reset = document.getElementById('remarks-reset');
  const download = document.getElementById('remarks-download');
  const workspaceTitle = document.getElementById('remarks-workspace-title');
  const activity = document.getElementById('remarks-activity');
  const activityText = document.getElementById('remarks-activity-text');
  const progressPercent = document.getElementById('remarks-progress-percent');
  const progressCopy = document.getElementById('remarks-progress-copy');
  const progressFill = document.getElementById('remarks-progress-fill');
  const total = document.getElementById('remarks-total');
  const processed = document.getElementById('remarks-processed');
  const withCount = document.getElementById('remarks-with-count');
  const withoutCount = document.getElementById('remarks-without-count');
  const errorCount = document.getElementById('remarks-error-count');
  const search = document.getElementById('remarks-id-search');
  const clearSearch = document.getElementById('remarks-search-clear');
  const resultCount = document.getElementById('remarks-result-count');
  const empty = document.getElementById('remarks-empty');
  const results = document.getElementById('remarks-results');
  const withGrid = document.getElementById('with-remarks-grid');
  const withoutGrid = document.getElementById('without-remarks-grid');
  const withBadge = document.getElementById('with-remarks-badge');
  const withoutBadge = document.getElementById('without-remarks-badge');
  const withEmpty = document.getElementById('with-remarks-empty');
  const withoutEmpty = document.getElementById('without-remarks-empty');
  const errors = document.getElementById('remarks-errors');
  const errorList = document.getElementById('remarks-error-list');
  const template = document.getElementById('remarks-card-template');
  const dialog = document.getElementById('remarks-preview-dialog');
  const previewClose = document.getElementById('remarks-preview-close');
  const previewTitle = document.getElementById('remarks-preview-title');
  const previewSubtitle = document.getElementById('remarks-preview-subtitle');
  const previewImage = document.getElementById('remarks-preview-image');
  const previewOverlays = document.getElementById('remarks-preview-overlays');

  const state = { jobId: null, results: [], pollTimer: null, generation: 0 };

  wireDropzone();
  form.addEventListener('submit', submitBatch);
  reset.addEventListener('click', resetPage);
  search.addEventListener('input', renderResults);
  clearSearch.addEventListener('click', () => {
    search.value = '';
    clearSearch.hidden = true;
    renderResults();
    search.focus();
  });
  previewClose.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

  function wireDropzone() {
    filesInput.addEventListener('change', updateFiles);
    ['dragenter', 'dragover'].forEach((name) => dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach((name) => dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('drag-over');
    }));
    dropzone.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files?.length) return;
      filesInput.files = event.dataTransfer.files;
      updateFiles();
    });
  }

  function updateFiles() {
    const files = [...filesInput.files];
    filesCount.textContent = files.length === 1 ? '1 selected' : `${files.length} selected`;
    filesList.replaceChildren();
    files.slice(0, 8).forEach((file) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      const size = document.createElement('span');
      name.className = 'file-name';
      size.className = 'file-size';
      name.textContent = file.name;
      size.textContent = formatBytes(file.size);
      item.append(name, size);
      filesList.append(item);
    });
    if (files.length > 8) {
      const item = document.createElement('li');
      item.textContent = `${files.length - 8} more files selected`;
      filesList.append(item);
    }
  }

  async function submitBatch(event) {
    event.preventDefault();
    showError('');
    if (!filesInput.files.length) {
      showError('Choose at least one POD image or PDF.');
      return;
    }
    resetJobView();
    setSubmitting(true, 'Uploading');
    setActivity('uploading');
    workspaceTitle.textContent = 'Uploading POD files';
    const data = new FormData();
    [...filesInput.files].forEach((file) => data.append('images', file));
    try {
      const response = await fetch('/api/jobs/remarks-check', { method: 'POST', body: data });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error || 'Upload failed.');
      state.jobId = body.jobId;
      download.href = `/api/jobs/${body.jobId}/download`;
      total.textContent = body.totalFiles || 0;
      workspaceTitle.textContent = 'Checking POD remarks';
      progressCopy.textContent = `0 of ${body.totalFiles || 0} files`;
      setActivity('processing');
      setSubmitting(true, 'Checking');
      poll(body.jobId, state.generation);
    } catch (error) {
      setSubmitting(false);
      setActivity('failed');
      workspaceTitle.textContent = 'Upload failed';
      showError(error.message || 'Could not upload the batch.');
    }
  }

  async function poll(jobId, generation) {
    if (generation !== state.generation) return;
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
      const job = await parseJson(response);
      if (!response.ok) throw new Error(job.error || 'Status request failed.');
      renderJob(job);
      if (job.status === 'completed' || job.status === 'failed') {
        setSubmitting(false);
        if (job.status === 'completed') {
          workspaceTitle.textContent = 'Remarks check complete';
          setActivity('completed');
          download.hidden = false;
          reset.hidden = false;
        } else {
          workspaceTitle.textContent = 'Remarks check failed';
          setActivity('failed');
          showError(job.error || 'The remarks job failed.');
        }
        return;
      }
      state.pollTimer = window.setTimeout(() => poll(jobId, generation), 1500);
    } catch (error) {
      setSubmitting(false);
      setActivity('failed');
      workspaceTitle.textContent = 'Connection lost';
      showError(error.message || 'Could not read job status.');
    }
  }

  function renderJob(job) {
    state.results = job.results || [];
    const count = job.totalFiles || 0;
    const done = job.processedFiles || 0;
    const percent = count ? Math.round(done / count * 100) : 0;
    total.textContent = count;
    processed.textContent = done;
    withCount.textContent = job.withRemarksFiles || 0;
    withoutCount.textContent = job.withoutRemarksFiles || 0;
    errorCount.textContent = job.errorFiles || 0;
    progressPercent.textContent = `${percent}%`;
    progressFill.style.width = `${percent}%`;
    progressCopy.textContent = `${done} of ${count} pages`;
    setActivity(job.status || 'processing');
    renderResults();
  }

  function renderResults() {
    const query = search.value.trim().toLowerCase();
    clearSearch.hidden = !query;
    const visible = state.results.filter((result) => !query ||
      String(result.shipmentId || result.detectedImageId || '').toLowerCase().includes(query));
    const withRemarks = visible.filter((result) => result.status === 'with_remarks');
    const withoutRemarks = visible.filter((result) => result.status === 'without_remarks');
    const failed = visible.filter((result) => !['with_remarks', 'without_remarks'].includes(result.status));

    withGrid.replaceChildren(...withRemarks.map(buildCard));
    withoutGrid.replaceChildren(...withoutRemarks.map(buildCard));
    withBadge.textContent = withRemarks.length;
    withoutBadge.textContent = withoutRemarks.length;
    withEmpty.hidden = withRemarks.length > 0;
    withoutEmpty.hidden = withoutRemarks.length > 0;
    resultCount.textContent = query
      ? `${visible.length} of ${state.results.length} results`
      : `${state.results.length} ${state.results.length === 1 ? 'result' : 'results'}`;

    errorList.replaceChildren(...failed.map((result) => {
      const row = document.createElement('div');
      row.textContent = `${result.originalFilename || result.filename || 'File'} — ${result.reason || 'Could not analyze this POD'}`;
      return row;
    }));
    errors.hidden = failed.length === 0;
    empty.hidden = state.results.length > 0 || Boolean(state.jobId);
    results.hidden = state.results.length === 0;
  }

  function buildCard(result) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector('.remarks-card');
    const thumb = node.querySelector('.thumb-button');
    const img = node.querySelector('.card-image');
    const placeholder = node.querySelector('.card-placeholder');
    const filename = node.querySelector('.card-filename');
    const badge = node.querySelector('.status-badge');
    const idText = node.querySelector('.card-id-text');
    const copyButton = node.querySelector('.copy-id-button');
    const copyLabel = node.querySelector('.copy-id-label');
    const copyStatus = node.querySelector('.copy-id-status');
    const source = node.querySelector('.remarks-source');
    const resultText = node.querySelector('.remarks-result');
    const confidence = node.querySelector('.remarks-confidence');
    const time = node.querySelector('.remarks-time');
    const regionCount = node.querySelector('.remark-region-count');
    const artifact = result.outputFilename || result.filename;
    const previewUrl = `/api/jobs/${state.jobId}/preview/${encodeURIComponent(artifact)}`;
    const id = String(result.shipmentId || result.detectedImageId || '').trim();

    card.dataset.status = result.status;
    filename.textContent = result.originalFilename || artifact || 'Unknown file';
    filename.title = filename.textContent;
    badge.textContent = result.hasRemarks ? 'Remarks' : 'No remarks';
    badge.classList.add(result.status);
    idText.textContent = id || 'Not read';
    if (id) wireCopy(copyButton, copyLabel, copyStatus, id);
    else copyButton.remove();
    source.textContent = result.sourceType === 'pdf'
      ? `PDF page ${result.sourcePageNumber || 1}${result.sourcePageCount ? ` of ${result.sourcePageCount}` : ''}`
      : 'Image';
    const areas = result.remarkRegions?.length || 0;
    resultText.textContent = result.hasRemarks
      ? `${areas} adverse remark ${areas === 1 ? 'area' : 'areas'} detected`
      : 'No adverse remark meaning detected';
    confidence.textContent = `${Math.round(result.remarkConfidence || 0)}%`;
    time.textContent = formatDuration(result.processingMs);
    if (areas) {
      regionCount.hidden = false;
      regionCount.textContent = `${areas} ${areas === 1 ? 'area' : 'areas'}`;
    }
    if (artifact) {
      img.src = previewUrl;
      img.alt = `POD ${id || filename.textContent}`;
      img.addEventListener('error', () => {
        img.remove();
        placeholder.style.display = 'grid';
      }, { once: true });
      thumb.addEventListener('click', () => openPreview(previewUrl, result));
    } else {
      img.remove();
      placeholder.style.display = 'grid';
      thumb.disabled = true;
    }
    return node;
  }

  function wireCopy(button, label, status, id) {
    button.setAttribute('aria-label', `Copy LR ID ${id}`);
    button.title = `Copy ${id}`;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await copyText(id);
        button.classList.add('is-copied');
        label.textContent = 'Copied';
        status.textContent = `LR ID ${id} copied.`;
      } catch {
        button.classList.add('has-error');
        label.textContent = 'Failed';
        status.textContent = `Could not copy LR ID ${id}.`;
      }
      window.setTimeout(() => {
        button.disabled = false;
        button.classList.remove('is-copied', 'has-error');
        label.textContent = 'Copy';
        status.textContent = '';
      }, 1600);
    });
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('Copy failed');
  }

  function openPreview(url, result) {
    previewTitle.textContent = result.shipmentId ? `LR ${result.shipmentId}` : (result.originalFilename || 'POD preview');
    previewSubtitle.textContent = result.hasRemarks
      ? `${result.remarkRegions?.length || 0} adverse remark area(s) detected`
      : 'No adverse remark meaning detected';
    previewImage.src = url;
    previewImage.alt = previewTitle.textContent;
    previewOverlays.replaceChildren();
    const size = result.remarkAnalysis;
    if (size?.imageWidth && size?.imageHeight) {
      addOverlays(result.remarkRegions || [], false, size.imageWidth, size.imageHeight);
      addOverlays(result.excludedRegions || [], true, size.imageWidth, size.imageHeight);
    }
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else window.open(url, '_blank', 'noopener');
  }

  function addOverlays(regions, excluded, width, height) {
    regions.forEach((region) => {
      const box = document.createElement('span');
      box.className = `remark-overlay${excluded ? ' is-excluded' : ''}`;
      box.style.left = `${region.bbox.x0 / width * 100}%`;
      box.style.top = `${region.bbox.y0 / height * 100}%`;
      box.style.width = `${(region.bbox.x1 - region.bbox.x0) / width * 100}%`;
      box.style.height = `${(region.bbox.y1 - region.bbox.y0) / height * 100}%`;
      previewOverlays.append(box);
    });
  }

  function resetJobView() {
    state.generation += 1;
    if (state.pollTimer) window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.jobId = null;
    state.results = [];
    search.value = '';
    clearSearch.hidden = true;
    total.textContent = '0';
    processed.textContent = '0';
    withCount.textContent = '0';
    withoutCount.textContent = '0';
    errorCount.textContent = '0';
    progressPercent.textContent = '0%';
    progressFill.style.width = '0%';
    progressCopy.textContent = 'Preparing files';
    download.hidden = true;
    reset.hidden = true;
    renderResults();
  }

  function resetPage() {
    form.reset();
    updateFiles();
    resetJobView();
    workspaceTitle.textContent = 'Ready when you are';
    progressCopy.textContent = 'Choose files to begin';
    setActivity('idle');
    setSubmitting(false);
    showError('');
  }

  function setSubmitting(active, label = 'Check remarks') {
    submit.disabled = active;
    submit.querySelector('span:last-child').textContent = label;
  }

  function setActivity(status) {
    const names = {
      idle: 'Ready', uploading: 'Uploading files', queued: 'Preparing',
      processing: 'Analyzing PODs', completed: 'Complete', failed: 'Needs attention',
    };
    activity.className = `activity-pill is-${status}`;
    activityText.textContent = names[status] || 'Analyzing PODs';
  }

  function showError(message) {
    errorBox.hidden = !message;
    errorBox.textContent = message;
  }

  async function parseJson(response) {
    try { return await response.json(); } catch { return {}; }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }
})();
