/**
 * First-Run Wizard — shown on first launch when no data in IndexedDB
 */
const FirstRunWizard = (() => {
  let modal, progressArea, errorArea, progressFill, progressText, errorText;
  let initialized = false;
  let importCallback = null;
  let onlineCallback = null;

  function ensureInit() {
    if (initialized) return;
    initialized = true;
    modal = document.getElementById('first-run-modal');
    progressArea = document.getElementById('wizard-progress-area');
    errorArea = document.getElementById('wizard-error-area');
    progressFill = document.getElementById('wizard-progress-fill');
    progressText = document.getElementById('wizard-progress-text');
    errorText = document.getElementById('wizard-error-text');

    document.getElementById('btn-wizard-import')?.addEventListener('click', () => {
      if (importCallback) importCallback();
    });

    document.getElementById('btn-wizard-online')?.addEventListener('click', () => {
      if (onlineCallback) onlineCallback();
    });

    document.getElementById('btn-wizard-cancel')?.addEventListener('click', () => {
      DataImporter.cancelImport();
      progressArea.style.display = 'none';
      const actions = document.querySelector('.modal-actions');
      const desc = document.querySelector('.modal-description');
      if (actions) actions.style.display = 'flex';
      if (desc) desc.style.display = 'block';
    });

    document.getElementById('btn-wizard-retry')?.addEventListener('click', () => {
      if (importCallback) importCallback();
    });
  }

  function show() {
    ensureInit();
    if (modal) modal.style.display = 'flex';
    if (progressArea) progressArea.style.display = 'none';
    if (errorArea) errorArea.style.display = 'none';
  }

  function hide() {
    ensureInit();
    if (modal) modal.style.display = 'none';
  }

  function updateProgress(current, total, name) {
    ensureInit();
    const pct = Math.round((current / total) * 100);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.textContent = `جاري تحميل السور... ${current}/${total}`;
  }

  function showProgress() {
    ensureInit();
    if (progressArea) progressArea.style.display = 'block';
    if (errorArea) errorArea.style.display = 'none';
    const actions = document.querySelector('.modal-actions');
    const desc = document.querySelector('.modal-description');
    if (actions) actions.style.display = 'none';
    if (desc) desc.style.display = 'none';
  }

  function showError(message) {
    ensureInit();
    if (errorArea) errorArea.style.display = 'block';
    if (errorText) errorText.textContent = message;
    if (progressArea) progressArea.style.display = 'none';
  }

  function onImport(callback) {
    importCallback = callback;
  }

  function onOnlineOnly(callback) {
    onlineCallback = callback;
  }

  return {
    show,
    hide,
    onImport,
    onOnlineOnly,
    updateProgress,
    showProgress,
    showError
  };
})();
