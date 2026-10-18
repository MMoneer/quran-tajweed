/**
 * First-Run Wizard — shown on first launch when no data in IndexedDB
 */
const FirstRunWizard = (() => {
  let modal, progressArea, errorArea, progressFill, progressText, errorText, continueBtn;
  let initialized = false;
  let importCallback = null;
  let onlineCallback = null;
  let continueCallback = null;

  function ensureInit() {
    if (initialized) return;
    initialized = true;
    modal = document.getElementById('first-run-modal');
    progressArea = document.getElementById('wizard-progress-area');
    errorArea = document.getElementById('wizard-error-area');
    progressFill = document.getElementById('wizard-progress-fill');
    progressText = document.getElementById('wizard-progress-text');
    errorText = document.getElementById('wizard-error-text');
    continueBtn = document.getElementById('btn-wizard-continue');

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

    continueBtn?.addEventListener('click', () => {
      if (continueCallback) continueCallback();
    });
  }

  function show() {
    ensureInit();
    if (modal) modal.style.display = 'flex';
    if (progressArea) progressArea.style.display = 'none';
    if (errorArea) errorArea.style.display = 'none';
    if (continueBtn) continueBtn.style.display = 'none';
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
    if (continueBtn) continueBtn.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = 'جاري تحميل السور... 0/114';
    const actions = document.querySelector('.modal-actions');
    const desc = document.querySelector('.modal-description');
    if (actions) actions.style.display = 'none';
    if (desc) desc.style.display = 'none';
  }

  /**
   * @param {string} message
   * @param {boolean} [showContinue=false] Show a "continue" button alongside
   *   retry (for partial-success states the user may want to proceed from).
   */
  function showError(message, showContinue = false) {
    ensureInit();
    if (errorArea) errorArea.style.display = 'block';
    if (errorText) errorText.textContent = message;
    if (progressArea) progressArea.style.display = 'none';
    if (continueBtn) continueBtn.style.display = showContinue ? '' : 'none';
    // showProgress() hid these; restore them so the recovery controls
    // (retry / online-only) and the explanation are reachable again.
    const actions = document.querySelector('.modal-actions');
    const desc = document.querySelector('.modal-description');
    if (actions) actions.style.display = 'flex';
    if (desc) desc.style.display = 'block';
  }

  function onImport(callback) {
    importCallback = callback;
  }

  function onOnlineOnly(callback) {
    onlineCallback = callback;
  }

  function onContinue(callback) {
    continueCallback = callback;
  }

  return {
    show,
    hide,
    onImport,
    onOnlineOnly,
    onContinue,
    updateProgress,
    showProgress,
    showError
  };
})();
