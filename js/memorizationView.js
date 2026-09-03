/**
 * MemorizationView — Phase 3 dashboard.
 *
 * Renders the memorization UI into #memorization-section by gluing together:
 *   - MemorizationEngine (scheduling, state transitions, badges, stats)
 *   - IndexedDbAdapter  (offline persistence)
 *   - QuranMetaService  (Quran position math)
 *   - DateUtils         (local-calendar dates)
 *   - BackupValidator   (export/import validation & migration)
 *
 * This module deliberately contains NO scheduling / business logic. It only
 * renders the state, calls engine methods on user action, and persists the
 * result. Routing is owned by App (setupRouter).
 *
 * Exposed as the global `MemorizationView` with a small surface:
 *   - init() : construct adapter, load + persist state, wire storage listener.
 *   - render(): re-render the dashboard into the current section.
 *   - destroy(): clear timers and remove transient nodes (e.g. undo toast).
 */
const MemorizationView = (() => {
  const DAILY_REVIEW_LIMIT = 10;
  const UNDO_WINDOW_MS = 5000;

  const STATUS_LABEL_AR = Object.freeze({
    learning: 'قيد التعلم',
    reviewing: 'مراجعة',
    consolidating: 'تثبيت',
    stable: 'مستقر',
    mastered: 'متقن',
  });

  const BADGE_META = Object.freeze({
    first_portion:    { icon: '🌱', label: 'أول جزء' },
    streak_7:         { icon: '🔥', label: 'سلسلة ٧ أيام' },
    streak_30:        { icon: '🏆', label: 'سلسلة ٣٠ يوماً' },
    ayahs_100:        { icon: '📖', label: '١٠٠ آية' },
    ayahs_500:        { icon: '📚', label: '٥٠٠ آية' },
    ayahs_1000:       { icon: '🏅', label: '١٠٠٠ آية' },
    first_mastered:   { icon: '⭐', label: 'أول إتقان' },
  });

  const STATUS_ORDER = [
    'learning', 'reviewing', 'consolidating', 'stable', 'mastered',
  ];

  let adapter = null;
  let state = null;
  let surahNameMap = null;
  let undoTimerHandle = null;
  let undoCountdownHandle = null;
  let lastRenderedSignature = null;
  let initPromise = null;

  /**
   * Best-effort: convert a Latin number to Arabic-Indic digits using
   * VerseClipboard.toArabicDigits when available, otherwise fall back to a
   * tiny inline implementation. Always returns a string.
   */
  function toArabicDigits(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
    if (typeof VerseClipboard !== 'undefined' && typeof VerseClipboard.toArabicDigits === 'function') {
      return VerseClipboard.toArabicDigits(n);
    }
    const AR = '٠١٢٣٤٥٦٧٨٩';
    return String(n).replace(/\d/g, d => AR[d]);
  }

  /**
   * Lazily fetch the surah-name map from DataStore (offline-first). Cached
   * after the first call. Falls back to numeric labels if DataStore is
   * missing or empty (e.g. user is in "online-only" mode without chapters
   * downloaded yet).
   */
  async function ensureSurahNameMap() {
    if (surahNameMap) return surahNameMap;
    surahNameMap = {};
    try {
      if (typeof DataStore !== 'undefined' && typeof DataStore.getChapters === 'function') {
        const list = await DataStore.getChapters();
        if (Array.isArray(list)) {
          for (const ch of list) {
            if (ch && (ch.id !== undefined) && ch.name_arabic) {
              surahNameMap[ch.id] = ch.name_arabic;
            }
          }
        }
      }
    } catch (e) {
      console.warn('MemorizationView: failed to load surah name map', e);
    }
    return surahNameMap;
  }

  /**
   * Format a single surah's Arabic name, falling back to "سورة N" if the
   * chapters list has not been loaded yet.
   */
  function formatSurahName(surahId) {
    if (surahNameMap && surahNameMap[surahId]) return surahNameMap[surahId];
    return `سورة ${toArabicDigits(surahId)}`;
  }

  /**
   * Pretty Arabic label for an ayah range. Examples:
   *   formatAyahRange(2, 1, 2, 5)   → "سورة البقرة — الآيات ١ إلى ٥"
   *   formatAyahRange(2, 285, 2, 286)→ "سورة البقرة — الآيات ٢٨٥ إلى ٢٨٦"
   *   formatAyahRange(2, 286, 3, 1)  → "سورة البقرة ٢٨٦ → سورة آل عمران ١"
   */
  function formatAyahRange(fromSurah, fromAyah, toSurah, toAyah) {
    if (fromSurah === toSurah) {
      return `${formatSurahName(fromSurah)} — الآيات ${toArabicDigits(fromAyah)} إلى ${toArabicDigits(toAyah)}`;
    }
    return `${formatSurahName(fromSurah)} ${toArabicDigits(fromAyah)} ← ${formatSurahName(toSurah)} ${toArabicDigits(toAyah)}`;
  }

  /**
   * Pretty Arabic label for the daily memorization target, respecting
   * `targetType`:
   *   'ayahs' → "{N} آيات / يوم"
   *   'surah' → "سورة كاملة / يوم"
   *   'page'  → "صفحة كاملة / يوم"
   */
  function formatPlanDailyTarget(plan) {
    const amount = (plan && Number.isFinite(plan.dailyAmount)) ? plan.dailyAmount : 5;
    const type = (plan && plan.targetType) ? plan.targetType : 'ayahs';
    if (type === 'surah') return 'سورة كاملة / يوم';
    if (type === 'page') return 'صفحة كاملة / يوم';
    return `${toArabicDigits(amount)} آيات / يوم`;
  }

  function statusLabel(status) {
    return STATUS_LABEL_AR[status] || status;
  }

  function badgeMeta(id) {
    return BADGE_META[id] || { icon: '🎖️', label: id };
  }

  /**
   * Escape a string so it is safe to interpolate into HTML. Defensive —
   * all our inputs are strings/numbers, but a single mistake here is
   * enough to break rendering.
   */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Tiny one-shot toast helper used for transient feedback (save success,
   * import failure, undo, etc.). Distinct from the 5-second undo toast —
   * this one is short-lived and informational.
   */
  function showTransientToast(message, isError = false) {
    const node = document.createElement('div');
    node.className = 'app-toast visible memorization-flash-toast' + (isError ? ' error' : '');
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(() => {
      node.classList.remove('visible');
      setTimeout(() => node.remove(), 300);
    }, 2200);
  }

  function clearUndoTimers() {
    if (undoTimerHandle) {
      clearTimeout(undoTimerHandle);
      undoTimerHandle = null;
    }
    if (undoCountdownHandle) {
      clearInterval(undoCountdownHandle);
      undoCountdownHandle = null;
    }
    const existing = document.getElementById('memorization-undo-toast');
    if (existing) existing.remove();
  }

  /**
   * Persist the current state. Surfaces a transient toast on failure so
   * the user knows the change was not durable.
   */
  async function persist(messageOnSuccess, messageOnError) {
    if (!adapter || !state) return;
    try {
      await adapter.saveState(state);
      if (messageOnSuccess) showTransientToast(messageOnSuccess, false);
    } catch (e) {
      console.error('MemorizationView: saveState failed', e);
      showTransientToast(messageOnError || 'تعذر حفظ التغيير. يرجى المحاولة مجدداً.', true);
    }
  }

  // ---------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------

  async function init() {
    // Idempotent guard — if init() is called twice (e.g. on hot-reload or by
    // a caller that didn't await the first call), return the same promise.
    if (initPromise) return initPromise;
    initPromise = (async () => {
      adapter = new IndexedDbAdapter();
      try {
        const loaded = await adapter.loadState();
        if (loaded && typeof loaded === 'object' && loaded.version === MemorizationEngine.SCHEMA_VERSION) {
          state = loaded;
        } else {
          state = MemorizationEngine.createInitialState();
        }
      } catch (e) {
        console.error('MemorizationView: loadState failed; using fresh state', e);
        state = MemorizationEngine.createInitialState();
      }

      // Roll day forward if the stored day is stale.
      MemorizationEngine.ensureCurrentDay(state);

      // Best-effort: warm the surah name cache for richer labels.
      await ensureSurahNameMap();

      // Cross-tab sync: when another tab updates state, re-render.
      window.addEventListener('storage', (event) => {
        if (!event || !event.key) return;
        if (event.key === 'quran_memorization_update') {
          // Reload on the next tick so we don't race with the writer tab.
          reloadFromStorage();
        }
      });

      // In-tab cross-instance sync (e.g. two MemorizationView instances).
      window.addEventListener('quran_memorization_state_changed', () => {
        reloadFromStorage();
      });
    })();
    return initPromise;
  }

  async function reloadFromStorage() {
    if (!adapter) return;
    try {
      const loaded = await adapter.loadState();
      if (loaded && typeof loaded === 'object') {
        state = loaded;
        MemorizationEngine.ensureCurrentDay(state);
        render();
      }
    } catch (e) {
      console.warn('MemorizationView: reloadFromStorage failed', e);
    }
  }

  function emitCrossTabUpdate() {
    try {
      localStorage.setItem('quran_memorization_update', String(Date.now()));
    } catch (e) {
      /* private mode etc — non-fatal */
    }
    try {
      window.dispatchEvent(new Event('quran_memorization_state_changed'));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function getContainer() {
    return document.getElementById('memorization-content-container');
  }

  function render() {
    // Defense in depth: if init() hasn't completed yet, await it before
    // rendering. This protects callers (e.g. cross-tab storage events) that
    // arrive before the initial state load finishes.
    if (!state && initPromise) {
      initPromise.then(() => {
        if (state) render();
      }).catch((e) => {
        console.error('MemorizationView.render: init failed', e);
      });
      return;
    }
    if (!state) return;
    MemorizationEngine.ensureCurrentDay(state);

    const container = getContainer();
    if (!container) return;

    clearUndoTimers();

    const summary = MemorizationEngine.getDailyTaskSummary(state, DAILY_REVIEW_LIMIT);
    const stats = MemorizationEngine.getStatistics(state, DAILY_REVIEW_LIMIT);

    const html = [
      renderHeader(),
      renderPlanCard(summary),
      renderNewMemorizationCard(summary),
      renderReviewsCard(summary),
      renderBacklogAlert(summary),
      renderStatsSection(stats),
      renderBadgesSection(stats),
      renderBackupSection(),
    ].join('\n');

    container.innerHTML = html;
    wireActions(summary);
    lastRenderedSignature = computeRenderSignature(state, summary);
  }

  function computeRenderSignature(stateObj, summaryObj) {
    try {
      return JSON.stringify({
        plan: stateObj.plan,
        day: stateObj.day,
        stats: stateObj.stats,
        itemsLen: stateObj.items.length,
        due: summaryObj.dueReviews.map(it => it.id + ':' + it.status + ':' + it.interval),
        remaining: summaryObj.remainingReviewIds.length,
        badges: stateObj.badges,
      });
    } catch (e) {
      return Math.random().toString(36).slice(2);
    }
  }

  // ---------------------------------------------------------------------
  // Plan editor modal
  // ---------------------------------------------------------------------

  function surahListOptionsHtml(selectedSurah) {
    const ids = Object.keys(surahNameMap || {}).map(n => parseInt(n, 10)).filter(Number.isFinite).sort((a, b) => a - b);
    if (ids.length === 0) {
      return Array.from({ length: QuranMetaService.TOTAL_SURAHS }, (_, i) => i + 1)
        .map(id => `<option value="${id}" ${id === selectedSurah ? 'selected' : ''}>${toArabicDigits(id)}</option>`)
        .join('');
    }
    return ids.map(id => `<option value="${id}" ${id === selectedSurah ? 'selected' : ''}>${esc(surahNameMap[id])} (${toArabicDigits(id)})</option>`).join('');
  }

  function buildPlanEditorModalHtml(plan) {
    const targetType = (plan && plan.targetType) ? plan.targetType : 'ayahs';
    const dailyAmount = (plan && Number.isFinite(plan.dailyAmount)) ? plan.dailyAmount : 5;
    const currentSurah = (plan && Number.isInteger(plan.currentSurah)) ? plan.currentSurah : 1;
    const currentAyah = (plan && Number.isInteger(plan.currentAyah)) ? plan.currentAyah : 1;
    const showStepper = targetType === 'ayahs';
    const surahOptions = surahListOptionsHtml(currentSurah);
    const surahMax = QuranMetaService.getSurahAyahCount(currentSurah);
    return `
      <div class="plan-editor-row">
        <label class="plan-editor-label">نوع الهدف</label>
        <div class="plan-editor-mode-segmented" role="radiogroup" aria-label="نوع الهدف">
          <button type="button" class="plan-editor-mode-btn ${targetType === 'ayahs' ? 'active' : ''}" data-mode="ayahs" role="radio" aria-checked="${targetType === 'ayahs'}">آيات</button>
          <button type="button" class="plan-editor-mode-btn ${targetType === 'surah' ? 'active' : ''}" data-mode="surah" role="radio" aria-checked="${targetType === 'surah'}">سورة</button>
          <button type="button" class="plan-editor-mode-btn ${targetType === 'page' ? 'active' : ''}" data-mode="page" role="radio" aria-checked="${targetType === 'page'}">صفحة</button>
        </div>
      </div>

      <div class="plan-editor-row" id="plan-editor-stepper-row" ${showStepper ? '' : 'hidden'}>
        <label class="plan-editor-label" for="plan-editor-amount">عدد الآيات اليومي</label>
        <div class="plan-editor-stepper">
          <button type="button" class="plan-editor-stepper-btn" id="plan-editor-amount-dec" aria-label="إنقاص">−</button>
          <input type="number" min="1" value="${esc(String(dailyAmount))}" id="plan-editor-amount" class="plan-editor-stepper-input" inputmode="numeric">
          <button type="button" class="plan-editor-stepper-btn" id="plan-editor-amount-inc" aria-label="زيادة">+</button>
        </div>
      </div>

      <div class="plan-editor-row">
        <label class="plan-editor-label" for="plan-editor-surah">السورة</label>
        <select id="plan-editor-surah" class="plan-editor-select">
          ${surahOptions}
        </select>
      </div>

      <div class="plan-editor-row">
        <label class="plan-editor-label" for="plan-editor-ayah">الآية</label>
        <div class="plan-editor-ayah-row">
          <input type="number" min="1" max="${esc(String(surahMax))}" value="${esc(String(currentAyah))}" id="plan-editor-ayah" class="plan-editor-ayah-input" inputmode="numeric">
          <span class="plan-editor-ayah-max" id="plan-editor-ayah-max">${toArabicDigits(surahMax)}</span>
        </div>
      </div>

      <div class="plan-editor-actions">
        <button type="button" class="memorization-btn memorization-btn-ghost" id="plan-editor-cancel">إلغاء</button>
        <button type="button" class="memorization-btn memorization-btn-primary" id="plan-editor-save">حفظ التغييرات</button>
      </div>
    `;
  }

  let planEditorDialog = null;

  function ensurePlanEditorDialog() {
    if (planEditorDialog) return planEditorDialog;
    planEditorDialog = document.createElement('dialog');
    planEditorDialog.className = 'plan-editor-modal';
    planEditorDialog.id = 'plan-editor-modal';
    planEditorDialog.setAttribute('aria-labelledby', 'plan-editor-title');
    const heading = document.createElement('h3');
    heading.id = 'plan-editor-title';
    heading.className = 'plan-editor-title';
    heading.textContent = 'خطة الحفظ';
    planEditorDialog.appendChild(heading);
    const body = document.createElement('div');
    body.id = 'plan-editor-body';
    planEditorDialog.appendChild(body);
    document.body.appendChild(planEditorDialog);
    planEditorDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      closePlanEditor();
    });
    return planEditorDialog;
  }

  function openPlanEditor() {
    ensureSurahNameMap();
    const dialog = ensurePlanEditorDialog();
    const body = dialog.querySelector('#plan-editor-body');
    body.innerHTML = buildPlanEditorModalHtml(state ? state.plan : null);
    wirePlanEditor();
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closePlanEditor() {
    if (planEditorDialog && planEditorDialog.open) {
      planEditorDialog.close();
    }
  }

  function wirePlanEditor() {
    const dialog = planEditorDialog;
    if (!dialog) return;

    dialog.querySelectorAll('.plan-editor-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        dialog.querySelectorAll('.plan-editor-mode-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
        const stepperRow = dialog.querySelector('#plan-editor-stepper-row');
        if (stepperRow) {
          if (mode === 'ayahs') stepperRow.removeAttribute('hidden');
          else stepperRow.setAttribute('hidden', '');
        }
      });
    });

    const dec = dialog.querySelector('#plan-editor-amount-dec');
    const inc = dialog.querySelector('#plan-editor-amount-inc');
    const amountInput = dialog.querySelector('#plan-editor-amount');
    function readAmount() {
      if (!amountInput) return 5;
      const raw = parseInt(amountInput.value, 10);
      return Number.isFinite(raw) && raw > 0 ? raw : 5;
    }
    function writeAmount(n) {
      if (!amountInput) return;
      amountInput.value = String(n);
      if (dec) dec.disabled = n <= 1;
    }
    dec?.addEventListener('click', () => writeAmount(Math.max(1, readAmount() - 1)));
    inc?.addEventListener('click', () => writeAmount(readAmount() + 1));
    writeAmount(readAmount());

    const surahSelect = dialog.querySelector('#plan-editor-surah');
    const ayahInput = dialog.querySelector('#plan-editor-ayah');
    const ayahMaxSpan = dialog.querySelector('#plan-editor-ayah-max');
    surahSelect?.addEventListener('change', () => {
      const id = parseInt(surahSelect.value, 10);
      const max = QuranMetaService.getSurahAyahCount(id);
      if (ayahInput) {
        ayahInput.setAttribute('max', String(max));
        const current = parseInt(ayahInput.value, 10);
        if (!Number.isFinite(current) || current < 1 || current > max) {
          ayahInput.value = '1';
        }
      }
      if (ayahMaxSpan) ayahMaxSpan.textContent = toArabicDigits(max);
    });

    dialog.querySelector('#plan-editor-cancel')?.addEventListener('click', closePlanEditor);

    dialog.querySelector('#plan-editor-save')?.addEventListener('click', onSavePlanEditor);
  }

  async function onSavePlanEditor() {
    const dialog = planEditorDialog;
    if (!dialog || !state) return;

    const modeBtn = dialog.querySelector('.plan-editor-mode-btn.active');
    const targetType = modeBtn ? modeBtn.dataset.mode : 'ayahs';
    const amountInput = dialog.querySelector('#plan-editor-amount');
    const dailyAmount = amountInput ? Math.max(1, parseInt(amountInput.value, 10) || 5) : 5;
    const surahSelect = dialog.querySelector('#plan-editor-surah');
    const ayahInput = dialog.querySelector('#plan-editor-ayah');
    const currentSurah = surahSelect ? parseInt(surahSelect.value, 10) : 1;
    const currentAyah = ayahInput ? parseInt(ayahInput.value, 10) : 1;

    if (!QuranMetaService.validatePosition(currentSurah, currentAyah)) {
      showTransientToast('موقع غير صالح. تحقق من السورة والآية.', true);
      return;
    }

    try {
      if (state.plan.isActive) {
        MemorizationEngine.updatePlanPointer(state, {
          currentSurah,
          currentAyah,
          targetType,
          dailyAmount,
        });
      } else {
        MemorizationEngine.activatePlan(state, {
          targetType,
          dailyAmount,
          currentSurah,
          currentAyah,
        });
        MemorizationEngine.ensureCurrentDay(state);
      }
      await persist('تم تحديث خطة الحفظ.', 'تعذر حفظ الخطة. حاول مجدداً.');
      closePlanEditor();
      render();
    } catch (e) {
      console.error('MemorizationView: save plan failed', e);
      showTransientToast((e && e.message) || 'تعذر حفظ الخطة.', true);
    }
  }

  function renderHeader() {
    return `
      <div class="memorization-header">
        <i class="fa-solid fa-graduation-cap memorization-header-icon"></i>
        <h2>الحفظ والمراجعة</h2>
        <p>نظام التكرار المتباعد لحفظ القرآن الكريم</p>
      </div>
    `;
  }

  function renderPlanCard(summary) {
    const plan = state.plan;
    if (!plan.isActive) {
      return `
        <section class="memorization-card memorization-plan-card">
          <div class="memorization-card-title">
            <i class="fa-solid fa-flag"></i>
            <span>ابدأ خطة حفظ جديدة</span>
          </div>
          <p class="memorization-card-sub">
            اختر طريقة الحفظ ونقطة البداية، وسيقوم النظام بتحديد نطاق اليوم تلقائياً.
          </p>
          <button type="button" id="mem-start-plan" class="memorization-btn memorization-btn-primary">
            <i class="fa-solid fa-pen-to-square"></i>
            <span>اختر خطة الحفظ</span>
          </button>
        </section>
      `;
    }

    if (plan.isCompleted) {
      return `
        <section class="memorization-card memorization-plan-card memorization-plan-completed">
          <div class="memorization-card-title">
            <i class="fa-solid fa-circle-check"></i>
            <span>اكتملت الخطة</span>
          </div>
          <p class="memorization-card-sub">
            ما شاء الله، لقد أتممت حفظ نطاق الخطة بالكامل. بارك الله فيك!
          </p>
          <button type="button" id="mem-stop-plan" class="memorization-btn memorization-btn-ghost">
            <i class="fa-solid fa-xmark"></i>
            <span>إيقاف الخطة</span>
          </button>
        </section>
      `;
    }

    return `
      <section class="memorization-card memorization-plan-card memorization-plan-active">
        <div class="memorization-card-title">
          <i class="fa-solid fa-bullseye"></i>
          <span>خطة الحفظ النشطة</span>
        </div>
        <div class="memorization-plan-info">
          <div class="memorization-plan-info-row">
            <span class="memorization-info-label">الهدف اليومي</span>
            <span class="memorization-info-value">${formatPlanDailyTarget(plan)}</span>
          </div>
          <div class="memorization-plan-info-row">
            <span class="memorization-info-label">الموقع الحالي</span>
            <span class="memorization-info-value">سورة ${formatSurahName(plan.currentSurah)} — الآية ${toArabicDigits(plan.currentAyah)}</span>
          </div>
        </div>
        <div class="memorization-plan-buttons">
          <button type="button" id="mem-edit-plan" class="memorization-btn memorization-btn-ghost">
            <i class="fa-solid fa-pen-to-square"></i>
            <span>تعديل الخطة</span>
          </button>
          <button type="button" id="mem-stop-plan" class="memorization-btn memorization-btn-ghost">
            <i class="fa-solid fa-pause"></i>
            <span>إيقاف الخطة</span>
          </button>
        </div>
      </section>
    `;
  }

  function renderNewMemorizationCard(summary) {
    const plan = state.plan;
    if (!plan.isActive || plan.isCompleted) {
      if (!plan.isActive) {
        return `
          <section class="memorization-card memorization-new-card memorization-new-card-empty">
            <div class="memorization-card-title">
              <i class="fa-solid fa-bookmark"></i>
              <span>حفظ اليوم</span>
            </div>
            <p class="memorization-card-sub">
              ابدأ خطة حفظ جديدة ليتم تحديد نطاق اليوم تلقائياً.
            </p>
          </section>
        `;
      }
      return '';
    }

    const nm = summary.newMemorization;
    if (!nm || !nm.count) {
      return `
        <section class="memorization-card memorization-new-card memorization-new-card-empty">
          <div class="memorization-card-title">
            <i class="fa-solid fa-bookmark"></i>
            <span>حفظ اليوم</span>
          </div>
          <p class="memorization-card-sub">لا يوجد نطاق جديد للحفظ.</p>
        </section>
      `;
    }

    const rangeLabel = formatAyahRange(nm.fromSurah, nm.fromAyah, nm.toSurah, nm.toAyah);
    const completed = summary.newMemorizationCompleted;

    if (completed) {
      return `
        <section class="memorization-card memorization-new-card memorization-new-card-done">
          <div class="memorization-card-title">
            <i class="fa-solid fa-circle-check"></i>
            <span>حفظ اليوم</span>
          </div>
          <div class="memorization-range">${esc(rangeLabel)}</div>
          <div class="memorization-new-done-note">
            <i class="fa-solid fa-check"></i>
            <span>تم تسجيل حفظ هذا النطاق اليوم. بارك الله فيك!</span>
          </div>
        </section>
      `;
    }

    return `
      <section class="memorization-card memorization-new-card">
        <div class="memorization-card-title">
          <i class="fa-solid fa-bookmark"></i>
          <span>حفظ اليوم</span>
        </div>
        <div class="memorization-range memorization-range-primary">${esc(rangeLabel)}</div>
        <p class="memorization-card-sub">
          احفظ هذا النطاق ثم اضغط زر "تم الحفظ" لتسجيله والانتقال إلى مراجعات اليوم.
        </p>
        <button type="button" id="mem-complete-new" class="memorization-btn memorization-btn-primary">
          <i class="fa-solid fa-check"></i>
          <span>تم الحفظ</span>
        </button>
      </section>
    `;
  }

  function renderReviewsCard(summary) {
    if (!summary.dueReviews || summary.dueReviews.length === 0) {
      return `
        <section class="memorization-card memorization-reviews-card">
          <div class="memorization-card-title">
            <i class="fa-solid fa-rotate"></i>
            <span>مراجعات اليوم</span>
          </div>
          <div class="memorization-empty-state">
            <i class="fa-solid fa-star-and-crescent"></i>
            <p>لا توجد مراجعات مستحقة اليوم، بارك الله فيك!</p>
          </div>
        </section>
      `;
    }

    const completedSet = new Set(summary.completedReviewIds || []);
    const itemsHtml = summary.dueReviews.map(item => renderReviewItem(item, completedSet.has(item.id))).join('\n');

    return `
      <section class="memorization-card memorization-reviews-card">
        <div class="memorization-card-title">
          <i class="fa-solid fa-rotate"></i>
          <span>مراجعات اليوم</span>
          <span class="memorization-card-counter">${toArabicDigits(summary.dueReviews.length)}</span>
        </div>
        <div class="memorization-review-list">${itemsHtml}</div>
      </section>
    `;
  }

  function renderReviewItem(item, isCompleted) {
    const rangeLabel = formatAyahRange(item.fromSurah, item.fromAyah, item.toSurah, item.toAyah);
    const label = statusLabel(item.status);
    const itemId = esc(item.id);
    const statusClass = `memorization-status-${item.status}`;
    const disabled = isCompleted ? 'disabled' : '';

    return `
      <div class="memorization-review-item ${isCompleted ? 'memorization-review-done' : ''}" data-item-id="${itemId}">
        <div class="memorization-review-head">
          <div class="memorization-review-range">${esc(rangeLabel)}</div>
          <div class="memorization-review-meta">
            <span class="memorization-status-badge ${statusClass}">${esc(label)}</span>
            <button type="button" class="memorization-btn-link memorization-reset-item" data-item-id="${itemId}" title="إعادة ضبط الحفظ">
              <i class="fa-solid fa-arrow-rotate-left"></i>
              <span>إعادة ضبط</span>
            </button>
          </div>
        </div>
        <div class="memorization-rating-group rating-btn-group" role="group" aria-label="تقييم المراجعة">
          <button type="button" class="memorization-rating-btn memorization-rating-fail" data-rating="1" data-item-id="${itemId}" ${disabled} title="فشل">
            <span class="memorization-rating-num">١</span>
            <span class="memorization-rating-label">فشل</span>
          </button>
          <button type="button" class="memorization-rating-btn memorization-rating-hard" data-rating="2" data-item-id="${itemId}" ${disabled} title="صعب">
            <span class="memorization-rating-num">٢</span>
            <span class="memorization-rating-label">صعب</span>
          </button>
          <button type="button" class="memorization-rating-btn memorization-rating-good" data-rating="3" data-item-id="${itemId}" ${disabled} title="جيد">
            <span class="memorization-rating-num">٣</span>
            <span class="memorization-rating-label">جيد</span>
          </button>
          <button type="button" class="memorization-rating-btn memorization-rating-easy" data-rating="4" data-item-id="${itemId}" ${disabled} title="سهل">
            <span class="memorization-rating-num">٤</span>
            <span class="memorization-rating-label">سهل</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderBacklogAlert(summary) {
    const remaining = summary.remainingReviewIds ? summary.remainingReviewIds.length : 0;
    if (remaining <= 0) return '';
    return `
      <div class="memorization-backlog-alert" role="status">
        <i class="fa-solid fa-circle-info"></i>
        <span>لديك ${toArabicDigits(remaining)} مراجعات إضافية متراكمة، سيتم ترتيبها تلقائياً لاحقاً.</span>
      </div>
    `;
  }

  function renderStatsSection(stats) {
    const cards = [
      { icon: '🔥', label: 'السلسلة الحالية', value: toArabicDigits(stats.currentStreak || 0), sub: 'يوم متتالٍ' },
      { icon: '🏆', label: 'أطول سلسلة', value: toArabicDigits(stats.longestStreak || 0), sub: 'يوم' },
      { icon: '📖', label: 'مجموع الآيات المحفوظة', value: toArabicDigits(stats.totalMemorizedAyahs || 0), sub: 'آية' },
      { icon: '📝', label: 'إجمالي المراجعات', value: toArabicDigits(stats.totalReviews || 0), sub: 'مراجعة' },
    ];
    const cardsHtml = cards.map(c => `
      <div class="memorization-stat-card">
        <div class="memorization-stat-icon" aria-hidden="true">${c.icon}</div>
        <div class="memorization-stat-body">
          <div class="memorization-stat-label">${esc(c.label)}</div>
          <div class="memorization-stat-value">${esc(c.value)}</div>
          <div class="memorization-stat-sub">${esc(c.sub)}</div>
        </div>
      </div>
    `).join('');

    const badges = STATUS_ORDER.map(s => {
      const count = (stats.byStatus && stats.byStatus[s]) || 0;
      if (count <= 0) return '';
      return `
        <div class="memorization-status-badge memorization-status-badge-large memorization-status-${s}">
          <span>${esc(statusLabel(s))}</span>
          <span class="memorization-status-count">${toArabicDigits(count)}</span>
        </div>
      `;
    }).filter(Boolean).join('');

    const statusSection = badges
      ? `<div class="memorization-status-list">${badges}</div>`
      : `<p class="memorization-card-sub">لم تحفظ أي نطاق بعد. ابدأ خطة الحفظ لتظهر الإحصاءات.</p>`;

    return `
      <section class="memorization-card memorization-stats-card">
        <div class="memorization-card-title">
          <i class="fa-solid fa-chart-line"></i>
          <span>إحصاءات الحفظ</span>
        </div>
        <div class="memorization-stats-grid stats-cards-grid">${cardsHtml}</div>
        <div class="memorization-stats-statuses">
          <h4 class="memorization-subhead">توزيع النطاقات حسب المرحلة</h4>
          ${statusSection}
        </div>
      </section>
    `;
  }

  function renderBadgesSection(stats) {
    const earned = Array.isArray(state.badges) ? state.badges : [];
    if (earned.length === 0) {
      return `
        <section class="memorization-card memorization-badges-card">
          <div class="memorization-card-title">
            <i class="fa-solid fa-medal"></i>
            <span>الإنجازات</span>
          </div>
          <p class="memorization-card-sub">لم تحصل على أي إنجاز بعد. تابع حفظك ومراجعاتك اليومية لتكسب أوسمة.</p>
        </section>
      `;
    }
    const items = earned.map(id => {
      const meta = badgeMeta(id);
      return `
        <div class="memorization-badge">
          <div class="memorization-badge-icon" aria-hidden="true">${meta.icon}</div>
          <div class="memorization-badge-label">${esc(meta.label)}</div>
        </div>
      `;
    }).join('');
    return `
      <section class="memorization-card memorization-badges-card">
        <div class="memorization-card-title">
          <i class="fa-solid fa-medal"></i>
          <span>الإنجازات</span>
          <span class="memorization-card-counter">${toArabicDigits(earned.length)}</span>
        </div>
        <div class="memorization-badges-flex badges-flex">${items}</div>
      </section>
    `;
  }

  function renderBackupSection() {
    return `
      <section class="memorization-card memorization-backup-card">
        <div class="memorization-card-title">
          <i class="fa-solid fa-database"></i>
          <span>النسخ الاحتياطي</span>
        </div>
        <p class="memorization-card-sub">
          صدّر بيانات حفظك إلى ملف لاستعادتها لاحقاً، أو استورد نسخة احتياطية لاستبدال الحالة الحالية.
        </p>
        <div class="memorization-backup-actions">
          <button type="button" id="mem-export-backup" class="memorization-btn memorization-btn-primary">
            <i class="fa-solid fa-download"></i>
            <span>تصدير نسخة احتياطية</span>
          </button>
          <label for="mem-import-backup-input" class="memorization-btn memorization-btn-ghost memorization-btn-label" tabindex="0">
            <i class="fa-solid fa-upload"></i>
            <span>استيراد نسخة احتياطية</span>
          </label>
          <input type="file" id="mem-import-backup-input" accept="application/json,.json" hidden>
        </div>
        <div id="mem-import-feedback" class="memorization-import-feedback" role="status"></div>
      </section>
    `;
  }

  // ---------------------------------------------------------------------
  // Action wiring
  // ---------------------------------------------------------------------

  function wireActions(summary) {
    const startBtn = document.getElementById('mem-start-plan');
    startBtn?.addEventListener('click', onStartPlan);

    const editBtn = document.getElementById('mem-edit-plan');
    editBtn?.addEventListener('click', openPlanEditor);

    const stopBtn = document.getElementById('mem-stop-plan');
    stopBtn?.addEventListener('click', onStopPlan);

    const completeBtn = document.getElementById('mem-complete-new');
    completeBtn?.addEventListener('click', onCompleteNew);

    document.querySelectorAll('.memorization-rating-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const rating = parseInt(btn.dataset.rating, 10);
        const itemId = btn.dataset.itemId;
        if (!itemId || !Number.isFinite(rating)) return;
        onReview(itemId, rating);
      });
    });

    document.querySelectorAll('.memorization-reset-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const itemId = btn.dataset.itemId;
        if (!itemId) return;
        onResetItem(itemId);
      });
    });

    const exportBtn = document.getElementById('mem-export-backup');
    exportBtn?.addEventListener('click', onExportBackup);

    const importInput = document.getElementById('mem-import-backup-input');
    importInput?.addEventListener('change', onImportBackup);
  }

  async function onStartPlan() {
    openPlanEditor();
  }

  async function onStopPlan() {
    if (!confirm('هل أنت متأكد من إيقاف خطة الحفظ الحالية؟ ستبقى المراجعات قائمة لكن لن يتم تحديد نطاق جديد.')) {
      return;
    }
    MemorizationEngine.deactivatePlan(state);
    try {
      await adapter.saveState(state);
      emitCrossTabUpdate();
      showTransientToast('تم إيقاف الخطة.');
      render();
    } catch (e) {
      console.error('MemorizationView: failed to stop plan', e);
      showTransientToast('تعذر حفظ التغيير. حاول مجدداً.', true);
    }
  }

  async function onCompleteNew() {
    MemorizationEngine.completeNewMemorization(state);
    try {
      await adapter.saveState(state);
      emitCrossTabUpdate();
      showTransientToast('ما شاء الله! تم تسجيل حفظك.');
      render();
    } catch (e) {
      console.error('MemorizationView: failed to record new memorization', e);
      showTransientToast('تعذر حفظ التقدم. حاول مجدداً.', true);
    }
  }

  async function onReview(itemId, rating) {
    MemorizationEngine.reviewItem(state, itemId, rating);
    try {
      await adapter.saveState(state);
      emitCrossTabUpdate();
    } catch (e) {
      console.error('MemorizationView: failed to persist review', e);
      // Best-effort: undo the in-memory mutation if persistence failed so
      // the UI does not show progress that did not actually save.
      try { MemorizationEngine.undoLastReview(state); } catch (e2) { /* ignore */ }
      showTransientToast('تعذر حفظ المراجعة. حاول مجدداً.', true);
      return;
    }
    render();
    showUndoToast();
  }

  async function onResetItem(itemId) {
    const item = state.items.find(it => it.id === itemId);
    if (!item) return;
    const rangeLabel = formatAyahRange(item.fromSurah, item.fromAyah, item.toSurah, item.toAyah);
    if (!confirm(`هل تريد إعادة ضبط "${rangeLabel}" إلى بداية مرحلة التعلم؟`)) {
      return;
    }
    const ok = MemorizationEngine.resetItem(state, itemId);
    if (!ok) return;
    try {
      await adapter.saveState(state);
      emitCrossTabUpdate();
      showTransientToast('تمت إعادة ضبط النطاق.');
      render();
    } catch (e) {
      console.error('MemorizationView: failed to persist reset', e);
      try { MemorizationEngine.undoLastReview(state); } catch (e2) { /* ignore */ }
      showTransientToast('تعذر حفظ التغيير. حاول مجدداً.', true);
    }
  }

  // ---------------------------------------------------------------------
  // Undo toast
  // ---------------------------------------------------------------------

  function showUndoToast() {
    clearUndoTimers();

    const toast = document.createElement('div');
    toast.className = 'memorization-undo-toast undo-toast';
    toast.id = 'memorization-undo-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const message = document.createElement('span');
    message.className = 'memorization-undo-msg';
    message.textContent = 'تم تسجيل المراجعة';

    const countdown = document.createElement('span');
    countdown.className = 'memorization-undo-countdown';
    countdown.textContent = String(UNDO_WINDOW_MS / 1000);

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'memorization-undo-btn';
    undoBtn.textContent = 'تراجع';

    toast.appendChild(message);
    toast.appendChild(countdown);
    toast.appendChild(undoBtn);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));

    let remainingMs = UNDO_WINDOW_MS;
    undoCountdownHandle = setInterval(() => {
      remainingMs -= 250;
      if (remainingMs <= 0) {
        countdown.textContent = '٠';
      } else {
        countdown.textContent = String(Math.ceil(remainingMs / 1000));
      }
    }, 250);

    let used = false;
    const finalize = () => {
      clearUndoTimers();
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 250);
    };

    undoBtn.addEventListener('click', async () => {
      if (used) return;
      used = true;
      const restored = MemorizationEngine.undoLastReview(state);
      if (!restored) {
        finalize();
        return;
      }
      try {
        await adapter.saveState(state);
        emitCrossTabUpdate();
        showTransientToast('تم التراجع عن آخر مراجعة.');
        render();
      } catch (e) {
        console.error('MemorizationView: undo save failed', e);
        showTransientToast('تعذر حفظ التراجع.', true);
      }
      finalize();
    });

    undoTimerHandle = setTimeout(finalize, UNDO_WINDOW_MS);
  }

  // ---------------------------------------------------------------------
  // Backup / restore
  // ---------------------------------------------------------------------

  function onExportBackup() {
    try {
      const json = BackupValidator.exportBackup(state);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const today = DateUtils.getLocalDateString();
      const a = document.createElement('a');
      a.href = url;
      a.download = `quran-memorization-backup-${today}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 100);
      showTransientToast('تم تصدير النسخة الاحتياطية.');
    } catch (e) {
      console.error('MemorizationView: export failed', e);
      showTransientToast('تعذر تصدير النسخة الاحتياطية.', true);
    }
  }

  async function onImportBackup(event) {
    const input = event.target;
    const file = input && input.files && input.files[0];
    const feedback = document.getElementById('mem-import-feedback');
    if (!file) return;
    if (feedback) {
      feedback.textContent = 'جاري التحقق من الملف...';
      feedback.classList.remove('error', 'success');
    }
    let rawText;
    try {
      rawText = await file.text();
    } catch (e) {
      if (feedback) {
        feedback.textContent = 'تعذر قراءة الملف.';
        feedback.classList.add('error');
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      if (feedback) {
        feedback.textContent = 'الملف ليس JSON صالحاً.';
        feedback.classList.add('error');
      }
      return;
    }

    // Migrate legacy shapes first, then run the strict validator.
    let candidate = parsed;
    if (parsed && parsed.version !== BackupValidator.SCHEMA_VERSION) {
      try {
        candidate = BackupValidator.migrateBackup(parsed);
      } catch (e) {
        if (feedback) {
          feedback.textContent = 'الملف غير قابل للاستيراد: ' + (e.message || 'بيانات غير صالحة');
          feedback.classList.add('error');
        }
        return;
      }
    }

    const result = BackupValidator.validateBackup(candidate);
    if (!result.valid) {
      if (feedback) {
        feedback.textContent = 'الملف غير صالح: ' + (result.error || 'سبب غير معروف');
        feedback.classList.add('error');
      }
      return;
    }

    const ok = confirm('سيتم استبدال بيانات الحفظ الحالية بمحتوى هذا الملف. هل تريد المتابعة؟');
    if (!ok) {
      input.value = '';
      if (feedback) feedback.textContent = '';
      return;
    }

    // Roll day forward on the imported state so the user lands on today.
    state = result.sanitizedData;
    MemorizationEngine.ensureCurrentDay(state);
    await ensureSurahNameMap();
    try {
      await adapter.saveState(state);
      emitCrossTabUpdate();
      if (feedback) {
        feedback.textContent = 'تم استيراد النسخة الاحتياطية بنجاح.';
        feedback.classList.remove('error');
        feedback.classList.add('success');
      }
      showTransientToast('تم استيراد النسخة الاحتياطية.');
      render();
    } catch (e) {
      console.error('MemorizationView: import save failed', e);
      if (feedback) {
        feedback.textContent = 'تم التحقق من الملف لكن تعذر حفظه محلياً.';
        feedback.classList.add('error');
      }
    }
    input.value = '';
  }

  // ---------------------------------------------------------------------
  // destroy (called by router on leaving the section)
  // ---------------------------------------------------------------------

  function destroy() {
    clearUndoTimers();
    const container = getContainer();
    if (container) container.innerHTML = '';
    lastRenderedSignature = null;
  }

  return {
    init,
    render,
    destroy,
    openPlanEditor,
    closePlanEditor,
    DAILY_REVIEW_LIMIT,
    UNDO_WINDOW_MS,
  };
})();

if (typeof window !== 'undefined') {
  window.MemorizationView = MemorizationView;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MemorizationView;
}