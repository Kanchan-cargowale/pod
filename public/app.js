(() => {
  const form = document.getElementById('upload-form');
  const imagesInput = document.getElementById('images');
  const mappingInput = document.getElementById('mapping');
  const imagesDrop = document.getElementById('images-drop');
  const mappingDrop = document.getElementById('mapping-drop');
  const imagesCount = document.getElementById('images-count');
  const imagesList = document.getElementById('images-list');
  const mappingName = document.getElementById('mapping-name');
  const mappingState = document.getElementById('mapping-state');
  const submitBtn = document.getElementById('submit-btn');
  const formError = document.getElementById('form-error');
  const mappingWarnings = document.getElementById('mapping-warnings');
  const workspaceTitle = document.getElementById('workspace-title');
  const emptyState = document.getElementById('empty-state');
  const progressFill = document.getElementById('progress-bar-fill');
  const progressPercent = document.getElementById('progress-percent');
  const jobIdLabel = document.getElementById('job-id');
  const statTotal = document.getElementById('stat-total');
  const statProcessed = document.getElementById('stat-processed');
  const statMatched = document.getElementById('stat-matched');
  const statUnmatched = document.getElementById('stat-unmatched');
  const statTime = document.getElementById('stat-time');
  const activityIndicator = document.getElementById('activity-indicator');
  const activityText = document.getElementById('activity-text');
  const resultCount = document.getElementById('result-count');
  const resultsGrid = document.getElementById('results-grid');
  const downloadSelectedBtn = document.getElementById('download-selected-btn');
  const selectAllBtn = document.getElementById('select-all-btn');
  const unselectAllBtn = document.getElementById('unselect-all-btn');
  const resetBtn = document.getElementById('reset-btn');
  const cardTemplate = document.getElementById('result-card-template');
  const filterTabs = [...document.querySelectorAll('.filter-tab')];
  const previewDialog = document.getElementById('preview-dialog');
  const previewImage = document.getElementById('preview-image');
  const previewTitle = document.getElementById('preview-title');
  const previewClose = document.getElementById('preview-close');

  const state = {
    apiOnline: false,
    currentFilter: 'all',
    currentJobId: null,
    pollTimer: null,
    lastResults: [],
    isDownloading: false,
    selectedFilenames: new Set(),
  };

  checkHealth();
  wireDropzone(imagesDrop, imagesInput, updateImageSelection);
  wireDropzone(mappingDrop, mappingInput, updateMappingSelection);
  wireFilters();
  wirePreviewDialog();
  wireSelectionControls();

  form.addEventListener('submit', submitBatch);
  downloadSelectedBtn.addEventListener('click', downloadSelected);
  resetBtn.addEventListener('click', resetToEmptyState);

  function wireSelectionControls() {
    selectAllBtn.addEventListener('click', () => {
      state.lastResults
        .filter((result) => result.downloadable !== false && result.outputFilename)
        .forEach((result) => state.selectedFilenames.add(result.outputFilename));
      renderResults();
      updateSelectionCount();
    });

    unselectAllBtn.addEventListener('click', () => {
      state.selectedFilenames.clear();
      renderResults();
      updateSelectionCount();
    });
  }

  function updateSelectionCount() {
    const count = state.selectedFilenames.size;
    const total = state.lastResults.length;
    if (count === 0) {
      downloadSelectedBtn.disabled = true;
      downloadSelectedBtn.querySelector('span:last-child').textContent = 'Download Selected';
    } else if (count === total && total > 0) {
      downloadSelectedBtn.disabled = false;
      downloadSelectedBtn.querySelector('span:last-child').textContent = `Download All (${count})`;
    } else {
      downloadSelectedBtn.disabled = false;
      downloadSelectedBtn.querySelector('span:last-child').textContent = `Download Selected (${count})`;
    }
  }

  async function downloadSelected(event) {
    event.preventDefault();
    if (state.isDownloading || !state.currentJobId) return;
    if (!state.selectedFilenames.size) {
      showError('Select at least one image to download.');
      return;
    }

    state.isDownloading = true;
    downloadSelectedBtn.setAttribute('aria-disabled', 'true');

    try {
      const response = await fetch(
        `/api/jobs/${state.currentJobId}/download-selected`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: [...state.selectedFilenames] }),
          cache: 'no-store',
        }
      );
      if (!response.ok) {
        const body = await parseJsonResponse(response);
        throw new Error(body.error || 'Could to download the selected images.');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] || `selected-labels-${state.currentJobId}.zip`;
      const objectUrl = URL.createObjectURL(blob);
      const saveLink = document.createElement('a');
      saveLink.href = objectUrl;
      saveLink.download = filename;
      document.body.append(saveLink);
      saveLink.click();
      saveLink.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      showError(error.message || 'Could not download the selected images.');
    } finally {
      state.isDownloading = false;
      downloadSelectedBtn.removeAttribute('aria-disabled');
    }
  }

  function wireDropzone(dropzone, input, onChange) {
    input.addEventListener('change', onChange);

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove('drag-over');
      });
    });

    dropzone.addEventListener('drop', (event) => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      input.files = files;
      onChange();
    });
  }

  function wireFilters() {
    filterTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        state.currentFilter = tab.dataset.filter;
        filterTabs.forEach((item) => item.classList.toggle('is-active', item === tab));
        renderResults();
      });
    });
  }

  function wirePreviewDialog() {
    previewClose.addEventListener('click', () => previewDialog.close());
    previewDialog.addEventListener('click', (event) => {
      if (event.target === previewDialog) previewDialog.close();
    });
  }

  async function checkHealth() {
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (!response.ok) throw new Error('Health check failed');
      const body = await response.json();
      state.apiOnline = body.status === 'ok';
    } catch (error) {
      state.apiOnline = false;
    }

  }

  function updateImageSelection() {
    const files = [...imagesInput.files];
    imagesCount.textContent = files.length === 1 ? '1 selected' : `${files.length} selected`;
    imagesList.innerHTML = '';

    const visibleFiles = files.slice(0, 5);
    visibleFiles.forEach((file) => {
      const item = document.createElement('li');
      const fileName = document.createElement('span');
      const fileSize = document.createElement('span');
      fileName.className = 'file-name';
      fileSize.className = 'file-size';
      fileName.textContent = file.name;
      fileSize.textContent = formatBytes(file.size);
      item.append(fileName, fileSize);
      imagesList.append(item);
    });

    if (files.length > visibleFiles.length) {
      const item = document.createElement('li');
      item.textContent = `${files.length - visibleFiles.length} more files queued`;
      imagesList.append(item);
    }
  }

  function updateMappingSelection() {
    const file = mappingInput.files[0];
    mappingName.textContent = file ? file.name : 'Choose Excel workbook';
    mappingState.textContent = file ? formatBytes(file.size) : 'Required';
  }

  async function submitBatch(event) {
    event.preventDefault();
    clearMessages();
    await checkHealth();

    if (!imagesInput.files.length || !mappingInput.files.length) {
      showError('Choose at least one label image and one mapping workbook.');
      return;
    }

    if (!state.apiOnline) {
      showError('The backend is not reachable. Start the server and try again.');
      return;
    }

    const formData = new FormData();
    [...imagesInput.files].forEach((file) => formData.append('images', file));
    formData.append('mapping', mappingInput.files[0]);

    setSubmitting(true, 'Uploading');
    resetJobView();
    emptyState.hidden = true;
    workspaceTitle.textContent = 'Uploading files';
    jobIdLabel.textContent = 'Sending your batch';
    setActivityState('uploading');

    try {
      const response = await fetch('/api/jobs', { method: 'POST', body: formData });
      const body = await parseJsonResponse(response);

      if (!response.ok) {
        showError(body.error || 'Upload failed.');
        setSubmitting(false);
        renderResults();
        return;
      }

      state.currentJobId = body.jobId;
      workspaceTitle.textContent = 'Processing batch';
      jobIdLabel.textContent = `0 of ${body.totalFiles ?? 0} files`;
      statTotal.textContent = body.totalFiles ?? 0;
      emptyState.hidden = true;
      setSubmitting(true, 'Processing');
      setActivityState('processing');
      showMappingWarnings(body.mappingWarnings || []);
      pollJob(body.jobId);
    } catch (error) {
      showError('Could not upload the batch. Check the server log for details.');
      setSubmitting(false);
      renderResults();
    }
  }

  async function parseJsonResponse(response) {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
  }

  function pollJob(jobId) {
    if (state.pollTimer) clearInterval(state.pollTimer);

    const tick = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        const job = await parseJsonResponse(response);

        if (!response.ok) {
          throw new Error(job.error || 'Status request failed');
        }

        renderJob(jobId, job);

        if (job.status === 'completed' || job.status === 'failed') {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          setSubmitting(false);

          if (job.status === 'completed') {
            workspaceTitle.textContent = 'Batch complete';
            setActivityState('completed');
            downloadSelectedBtn.hidden = false;
            selectAllBtn.hidden = false;
            unselectAllBtn.hidden = false;
            resetBtn.hidden = false;
            state.selectedFilenames.clear();
            state.lastResults
              .filter((result) => result.downloadable !== false && result.outputFilename)
              .forEach((result) => state.selectedFilenames.add(result.outputFilename));
            updateSelectionCount();
          } else {
            workspaceTitle.textContent = 'Batch failed';
            setActivityState('failed');
            showError(job.error || 'Job failed.');
          }
        }
      } catch (error) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        setSubmitting(false);
        setActivityState('failed');
        showError(error.message || 'Lost connection while polling job status.');
      }
    };

    tick();
    state.pollTimer = setInterval(tick, 1500);
  }

  function renderJob(jobId, job) {
    state.currentJobId = jobId;
    state.lastResults = job.results || [];

    const total = job.totalFiles || 0;
    const processed = job.processedFiles || 0;
    const percent = total ? Math.round((processed / total) * 100) : 0;

    statTotal.textContent = total;
    statProcessed.textContent = processed;
    statMatched.textContent = job.matchedFiles || 0;
    statUnmatched.textContent = job.unmatchedFiles || 0;
    statTime.textContent = elapsedTimeText(job);
    progressPercent.textContent = `${percent}%`;
    progressFill.style.width = `${percent}%`;
    jobIdLabel.textContent = `${processed} of ${total} files`;
    setActivityState(job.status || 'processing');

    if (job.status === 'completed') {
      downloadSelectedBtn.hidden = false;
      selectAllBtn.hidden = false;
      unselectAllBtn.hidden = false;
      resetBtn.hidden = false;
    }

    renderResults();
  }

  function renderResults() {
    const filtered = state.lastResults.filter(matchesCurrentFilter);
    resultsGrid.innerHTML = '';
    resultCount.textContent = filtered.length === 1 ? '1 result' : `${filtered.length} results`;
    emptyState.hidden = state.lastResults.length > 0 || Boolean(state.currentJobId);

    filtered.forEach((result) => {
      resultsGrid.append(buildCard(state.currentJobId, result));
    });

    if (state.lastResults.length > 0) {
      downloadSelectedBtn.hidden = false;
      selectAllBtn.hidden = false;
      unselectAllBtn.hidden = false;
      resetBtn.hidden = false;
    }

    updateSelectionCount();
  }

  function matchesCurrentFilter(result) {
    if (state.currentFilter === 'all') return true;
    if (state.currentFilter === 'ok') return result.status === 'ok';
    if (state.currentFilter === 'error') return result.status === 'error';
    return result.status !== 'ok' && result.status !== 'error';
  }

  function buildCard(jobId, result) {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector('.result-card');
    const checkbox = node.querySelector('.card-select-input');
    const thumbButton = node.querySelector('.thumb-button');
    const img = node.querySelector('.card-image');
    const placeholder = node.querySelector('.card-placeholder');
    const badge = node.querySelector('.status-badge');
    const filename = node.querySelector('.card-filename');
    const idValue = node.querySelector('.card-id-value');
    const shipmentRow = node.querySelector('.shipment-row');
    const weightRow = node.querySelector('.weight-row');
    const weightValues = node.querySelector('.weight-values');
    const reason = node.querySelector('.card-reason');
    const timeRow = node.querySelector('.time-row');
    const timeValue = node.querySelector('.card-time-value');

    const status = result.status || 'unknown';
    const artifactFilename = result.outputFilename || result.filename;
    const previewUrl = `/api/jobs/${jobId}/preview/${encodeURIComponent(artifactFilename)}`;

    card.dataset.status = status;
    card.dataset.filename = artifactFilename || '';
    checkbox.disabled = !artifactFilename || result.downloadable === false;
    checkbox.checked = state.selectedFilenames.has(artifactFilename);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedFilenames.add(artifactFilename);
      else state.selectedFilenames.delete(artifactFilename);
      updateSelectionCount();
    });
    filename.textContent = artifactFilename || result.filename || 'Unknown file';
    filename.title = artifactFilename || result.filename || '';
    badge.textContent = formatStatus(status);
    badge.classList.add(status);

    if (artifactFilename) {
      img.src = previewUrl;
      img.alt = `${status === 'ok' ? 'Edited' : 'Scanned'} label preview for ${artifactFilename}`;
      placeholder.remove();
      thumbButton.addEventListener('click', () => openPreview(previewUrl, artifactFilename));
    }

    if (status === 'ok') {
      idValue.textContent = result.shipmentId || '-';
      renderWeightChanges(weightValues, result);
      reason.remove();
    } else {
      if (!artifactFilename) {
        img.remove();
        placeholder.style.display = 'grid';
        if (result.errorCode === 'image_rotation') {
          placeholder.querySelector('.placeholder-text').textContent = 'Fix image rotation';
        }
        thumbButton.disabled = true;
      }
      idValue.textContent = result.shipmentId || '-';
      if (!result.shipmentId) shipmentRow.remove();
      weightRow.remove();
      reason.textContent = buildReasonText(result);
    }

    if (Number.isFinite(result.processingMs)) {
      timeValue.textContent = formatDuration(result.processingMs);
    } else {
      timeRow.remove();
    }

    return node;
  }

  function renderWeightChanges(container, result) {
    const regions = result.replacedRegions || [];

    if (!regions.length) {
      const value = document.createElement('span');
      value.className = 'weight-new';
      value.textContent = result.newWeight ?? 'Updated';
      container.append(value);
      return;
    }

    regions.forEach((region) => {
      const row = document.createElement('span');
      row.className = 'weight-change';

      const oldValue = document.createElement('span');
      oldValue.className = 'weight-old';
      oldValue.textContent = region.originalText || '-';

      const arrow = document.createElement('span');
      arrow.textContent = 'to';

      const newValue = document.createElement('span');
      newValue.className = 'weight-new';
      newValue.textContent = region.newText || result.newWeight || '-';

      row.append(oldValue, arrow, newValue);
      container.append(row);
    });
  }

  function buildReasonText(result) {
    let text = result.reason || 'This label needs review.';

    if (result.status === 'unmatched' && result.detectedNumbers?.length) {
      const numbers = result.detectedNumbers.slice(0, 14).join(', ');
      const suffix = result.detectedNumbers.length > 14 ? '...' : '';
      text += ` Numbers found: ${numbers}${suffix}`;
    }

    if (result.status === 'id_matched_no_weight_region' && result.detectedWeightAnchors?.length) {
      text += ` Weight headers found: ${result.detectedWeightAnchors.join(' | ')}`;
    }

    return text;
  }

  function openPreview(src, title) {
    previewImage.src = src;
    previewImage.alt = `Edited label preview for ${title}`;
    previewTitle.textContent = title || 'Preview';

    if (typeof previewDialog.showModal === 'function') {
      previewDialog.showModal();
    } else {
      window.open(src, '_blank', 'noopener');
    }
  }

  function resetJobView() {
    if (state.pollTimer) clearInterval(state.pollTimer);

    // Do not carry an Errors/Review filter from the previous batch into a new
    // job; doing so makes valid live previews appear to be missing.
    state.currentFilter = 'all';
    filterTabs.forEach((tab) =>
      tab.classList.toggle('is-active', tab.dataset.filter === 'all')
    );
    state.currentJobId = null;
    state.lastResults = [];
    workspaceTitle.textContent = 'Preparing batch';
    jobIdLabel.textContent = 'Getting files ready';
    statTotal.textContent = '0';
    statProcessed.textContent = '0';
    statMatched.textContent = '0';
    statUnmatched.textContent = '0';
    statTime.textContent = '-';
    setActivityState('queued');
    progressPercent.textContent = '0%';
    progressFill.style.width = '0%';
    downloadSelectedBtn.hidden = true;
    downloadSelectedBtn.disabled = true;
    selectAllBtn.hidden = true;
    unselectAllBtn.hidden = true;
    resetBtn.hidden = true;
    renderResults();
  }

  function resetToEmptyState() {
    form.reset();
    updateImageSelection();
    updateMappingSelection();
    clearMessages();
    resetJobView();
    workspaceTitle.textContent = 'Ready when you are';
    jobIdLabel.textContent = 'Choose files to begin';
    setActivityState('idle');
    state.currentFilter = 'all';
    filterTabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.filter === 'all'));
    setSubmitting(false);
    state.selectedFilenames.clear();
  }

  function setSubmitting(isSubmitting, label = 'Process batch') {
    submitBtn.disabled = isSubmitting;
    submitBtn.querySelector('span:last-child').textContent = label;
  }

  function setActivityState(status) {
    const normalized = String(status || 'idle');
    const labels = {
      idle: 'Ready',
      uploading: 'Uploading files',
      queued: 'Preparing',
      processing: 'Processing files',
      completed: 'Complete',
      failed: 'Needs attention',
    };
    activityText.textContent = labels[normalized] || 'Processing files';
    activityIndicator.className = `activity-pill is-${normalized}`;
  }

  function clearMessages() {
    formError.hidden = true;
    formError.textContent = '';
    mappingWarnings.hidden = true;
    mappingWarnings.textContent = '';
  }

  function showError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function showMappingWarnings(warnings) {
    if (!warnings.length) return;
    mappingWarnings.textContent = warnings.slice(0, 4).join(' ');
    mappingWarnings.hidden = false;
  }

  function formatStatus(status) {
    return String(status || 'unknown').replaceAll('_', ' ');
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '-';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
  }

  function elapsedTimeText(job) {
    if (Number.isFinite(job.durationMs)) return formatDuration(job.durationMs);
    if (job.status !== 'processing') return '-';
    const startedAt = job.startedAt || job.createdAt;
    if (!startedAt) return '-';
    return formatDuration(Date.now() - new Date(startedAt).getTime());
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

})();
