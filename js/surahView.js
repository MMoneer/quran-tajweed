/**
 * Surah Reader / Viewer Component
 */
const SurahViewer = (() => {
  let currentSurahId = null;
  let currentSurahVerses = [];
  let currentSurahData = null;
  let loadGeneration = 0;
  let selectionMode = false;
  let selectedVerses = new Set();
  let selectionAnchorId = null;
  let suppressNextVerseClick = false;
  let pageObserver = null;
  let currentPageNumber = 1;
  // Last actually-seen mushaf page (tracked silently; only persisted
  // when the user LEAVES the reader — see flushReadingPosition).
  let lastSeenPage = null;
  // Two-page spread: borrowed adjacent-surah data cache (surahId -> surahData)
  // for cross-surah openings. Reset on every loadSurah.
  let spreadBorrowed = {};
  // In-flight page rebuilds for the current spread layout (see
  // whenLayoutSettled): cross-surah pages are filled asynchronously.
  let spreadFillPromise = null;

  // Opt-in perf timing. Enable with `localStorage.setItem('quran-perf','1')`.
  function logPerf(msg) {
    try {
      if (localStorage.getItem('quran-perf') === '1') console.log(msg);
    } catch (e) { /* storage unavailable */ }
  }

  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeDeltaX = 0;
  let isSwiping = false;
  let swipeOverlay = null;
  let swipeHintLeft = null;
  let swipeHintRight = null;
  // Bound swipe listeners + pending navigation timer, tracked so cleanup can
  // remove them (the container outlives the reader view, so leaked listeners
  // would accumulate on every re-entry).
  let swipeContainer = null;
  let swipeHandlers = null;
  let swipeNavTimer = null;

  // Two-page spread: gap after an edge-triggered cross-surah jump during
  // which further wheel events are ignored (the next surah is loading).
  const SPREAD_EDGE_LOCK_MS = 700;
  let spreadEdgeNavAt = 0;

  /**
   * Initialize reader view for a specific Surah
   * @param {number} surahId
   */
  async function loadSurah(surahId) {
    // Switching surahs is NOT leaving the reader — keep tracking
    // silently, just reset for the new surah.
    lastSeenPage = null;
    spreadBorrowed = {};
    spreadFillPromise = null;
    currentSurahId = parseInt(surahId);
    const generation = ++loadGeneration;
    
    const container = document.getElementById('surah-content-container');
    const loading = document.getElementById('reader-loading');
    const headerInfo = document.getElementById('header-surah-info');
    
    // Reset view
    clearAyahHighlight();
    container.innerHTML = '';
    loading.style.display = 'flex';
    headerInfo.innerHTML = '';

    // Show legend footer collapsed by default (click to expand)
    const legend = document.getElementById('tajweed-legend');
    legend.classList.add('visible', 'collapsed');
    // Add padding for collapsed legend header — not in immersive reading
    // (CSS pins the card padding there; inline padding would fight it).
    const readerCard = document.querySelector('.surah-viewer-card');
    if (readerCard && !document.body.classList.contains('immersive-read')) {
      readerCard.style.paddingBottom = '50px';
    }

    try {
      // Performance monitoring
      const perfStart = performance.now();

      // Fetch Surah data from local JSON file
      const surahData = await QuranAPI.getSurahLocal(currentSurahId);
      if (generation !== loadGeneration) return;

      const fetchTime = performance.now() - perfStart;
      logPerf(`[Perf] Data fetch: ${fetchTime.toFixed(1)}ms for surah ${currentSurahId}`);

      currentSurahVerses = surahData.verses || [];
      currentSurahData = surahData;
      exitSelectionMode();

      // Render header info in app navbar
      headerInfo.innerHTML = `
        <div class="header-surah-badge">
          <i class="fa-solid fa-book-open"></i>
          <span>سورة ${surahData.name_arabic}</span>
        </div>
      `;

      // Render reader content with page divisions
      const renderStart = performance.now();
      PageRenderer.renderSurahWithPages(surahData);
      const renderTime = performance.now() - renderStart;
      logPerf(`[Perf] Render: ${renderTime.toFixed(1)}ms (${surahData.verses.length} verses)`);

      // Two-page spread: group sections into mushaf openings (exclusive
      // with dynamic page view — the settings toggle enforces this).
      if (isSpreadMode()) buildSpreadLayout();

      // Dynamic page view: fit mushaf pages to ~98dvh when enabled
      if (typeof DynamicPage !== 'undefined') DynamicPage.onSurahRendered();
      
      // Setup page navigation buttons
      setupPageNavigation();
      showPageNavButtons();

      // Update nav buttons states
      updateNavigationControls();
      
      // Setup navigation listeners
      setupNavigationListeners();
      setupSwipeNavigation();
      setupSpreadEdgeNavigation();
      
      // Load audio player for this surah (with optional start ayah)
      const startAyah = window._pendingAyahScroll || 1;
      AudioPlayer.loadSurah(surahId, surahData.name_arabic, surahData.verses_count, startAyah, surahData.verses);

      // Populate part selector (only once)
      populatePartSelector();
      
      // Show fixed navigation bar
      toggleFixedNav(true);
      
      loading.style.display = 'none';

      // Preload next/previous surahs in background for instant navigation
      preloadAdjacentSurahs(currentSurahId);
      
      // Cross-view jump target (search result, bookmark, page/part field).
      // It is resolved only AFTER the layout settles: the auto-fit resizes
      // every page box ~150ms after the render and spread pages are rebuilt
      // asynchronously, so scrolling now would target geometry that is about
      // to move (that is what landed ayah jumps a page too far).
      const targetAyah = parseInt(window._pendingAyahScroll, 10);
      const targetPage = parseInt(window._pendingPageScroll, 10);
      window._pendingAyahScroll = null;
      window._pendingPageScroll = null;

      if (!isNaN(targetAyah) || !isNaN(targetPage)) {
        whenLayoutSettled(generation).then((ready) => {
          if (!ready) return;
          // One frame so the settled layout is painted before it is measured.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (generation !== loadGeneration) return;
            // Instant jump: a smooth scroll would sweep the page counter
            // through every intermediate page on the way to the target.
            if (!isNaN(targetAyah)) scrollToAyah(targetAyah, 'auto');
            else scrollToPage(targetPage, 'auto');
          }));
        });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

    } catch (error) {
      if (generation !== loadGeneration) return;
      console.error(`Failed to load Surah ${currentSurahId}:`, error);
      const unavailable = error && error.code === 'SURAH_NOT_AVAILABLE';
      const message = unavailable
        ? (error.offline
          ? 'هذه السورة غير محفوظة على جهازك، وأنت غير متصل بالإنترنت. اتصل بالإنترنت ثم أعد المحاولة.'
          : 'هذه السورة غير محفوظة على جهازك وتعذر جلبها من الخادم. يمكنك إعادة تحميل بيانات القرآن من الإعدادات.')
        : 'عذراً، فشل تحميل آيات السورة المباركة. يرجى التحقق من الاتصال بالإنترنت.';
      const settingsCta = unavailable && !error.offline
        ? '<button id="btn-goto-refetch" class="btn-action" style="margin: 12px auto 0 auto;">الإعدادات → إعادة تحميل البيانات</button>'
        : '';
      container.innerHTML = `
        <div class="error-container" style="text-align: center; padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; color: var(--accent); margin-bottom: 12px;"></i>
          <p>${message}</p>
          <button id="btn-retry-reader" class="btn-action" style="margin: 16px auto 0 auto;">إعادة المحاولة</button>
          ${settingsCta}
        </div>
      `;
      loading.style.display = 'none';
      
      document.getElementById('btn-retry-reader')?.addEventListener('click', () => loadSurah(currentSurahId));
      document.getElementById('btn-goto-refetch')?.addEventListener('click', () => {
        const drawer = document.getElementById('settings-drawer');
        if (drawer && !drawer.classList.contains('open')) {
          document.getElementById('btn-settings')?.click();
        }
        document.getElementById('btn-refetch-data')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  /**
   * Preload adjacent surahs in background for instant navigation
   * @param {number} currentId
   */
  function preloadAdjacentSurahs(currentId) {
    const toPreload = [];
    if (currentId > 1) toPreload.push(currentId - 1);
    if (currentId < 114) toPreload.push(currentId + 1);

    for (const id of toPreload) {
      // Fire and forget - don't await
      QuranAPI.getSurahLocal(id).catch(() => {});
    }
  }

  /**
    * Update next/prev navigation buttons visibility and hashes
    */
  function updateNavigationControls() {
    const btnPrev = document.getElementById('btn-prev-surah');
    const btnNext = document.getElementById('btn-next-surah');

    if (currentSurahId > 1) {
      btnPrev.style.visibility = 'visible';
      btnPrev.onclick = () => {
        window.location.hash = `#surah/${currentSurahId - 1}`;
      };
    } else {
      btnPrev.style.visibility = 'hidden';
    }

    if (currentSurahId < 114) {
      btnNext.style.visibility = 'visible';
      btnNext.onclick = () => {
        window.location.hash = `#surah/${currentSurahId + 1}`;
      };
    } else {
      btnNext.style.visibility = 'hidden';
    }
  }

  /**
   * Two-page spread (mushaf opening) support.
   *
   * Pairing is global and fixed like the printed mushaf: [1,2] [3,4] …
   * [603,604] — 302 openings. In RTL the first DOM child renders on the
   * RIGHT, so the odd page (anchor) is always placed first.
   */
  function isSpreadMode() {
    // Wide screens only: below 768px the two columns collapse anyway, so
    // the reader stays single-page (and DynamicPage fits it as usual).
    if (window.innerWidth < 768) return false;
    // Whole-reading fallback: the fitter couldn't fit two columns at the
    // readable floor, so the reader behaves as a single page for now.
    if (document.body.classList.contains('spread-overflow')) return false;
    try {
      if (typeof SettingsManager !== 'undefined' && SettingsManager.state) {
        return !!SettingsManager.state.settings.spreadView;
      }
    } catch (e) { /* fall through to class check */ }
    return document.body.classList.contains('spread-mode');
  }

  /**
   * Spread containing page n → [anchor(odd/right), second(even/left|null)].
   */
  function spreadForPage(n) {
    n = Math.max(1, Math.min(604, parseInt(n) || 1));
    const anchor = (n % 2 === 1) ? n : n - 1;
    const second = anchor + 1 <= 604 ? anchor + 1 : null;
    return [anchor, second];
  }

  /**
   * True when the current surah is the ONLY surah on `page`: then its
   * already-rendered `.page-section` is a complete mushaf page and can be
   * reused as-is. Shared boundary pages (two surahs on one page, or pages
   * owned by a neighbour) must be rebuilt whole from every surah on them.
   */
  function ownPageIsComplete(page) {
    if (typeof PageMap === 'undefined') return true; // fall back to old behaviour
    const owners = PageMap.surahsOnPage(page);
    return owners.length === 1 && owners[0] === currentSurahId;
  }

  /**
   * Loaded surah-data objects that a rebuilt mushaf section was assembled
   * from (recorded in data-surahs by fillBorrowedPages).
   */
  function pageSurahsData(section) {
    const ids = (section?.dataset.surahs || '').split(',').map(n => parseInt(n)).filter(n => n);
    return ids.map(id => (id === currentSurahId ? currentSurahData : spreadBorrowed[id])).filter(Boolean);
  }

  /**
   * Own pages are reused straight from renderSurahWithPages, whose surah
   * heading/bismillah lived in the top banner (hidden in spread mode). Put
   * the heading back inline when this page is the current surah's first page.
   */
  function injectOwnSurahHeading(section, page) {
    if (typeof PageMap === 'undefined' || !currentSurahData) return;
    if (!PageMap.surahStartsOnPage(currentSurahId, page)) return;
    if (section.querySelector('.mushaf-surah-title')) return;
    section.insertAdjacentHTML('afterbegin', PageRenderer.mushafSurahTitleHTML(currentSurahData));
  }

  /**
   * Group the rendered `.page-section` nodes into `.spread-row` openings.
   * Pages the current surah owns alone reuse their own section; every
   * other page (foreign or shared between surahs) is rebuilt as a full
   * mushaf page by fillBorrowedPages().
   */
  function buildSpreadLayout() {
    const container = document.getElementById('surah-content-container');
    if (!container || container.querySelector('.spread-row')) return;
    const sections = [...container.querySelectorAll(':scope > .page-section')];
    if (!sections.length) return;

    // The mushaf opening has no scroll stop of its own, so the whole top
    // banner (surah title, meta details, bismillah) is dropped in spread mode.
    // A surah beginning mid-page is announced by the inline title instead.
    const banner = container.querySelector(':scope > .surah-header-banner');
    if (banner) banner.remove();

    const pages = sections.map(s => parseInt(s.dataset.pageNumber)).filter(n => !isNaN(n));
    if (!pages.length) return;
    const minP = Math.min(...pages);
    const maxP = Math.max(...pages);
    const [firstAnchor] = spreadForPage(minP);
    const [lastAnchor] = spreadForPage(maxP);

    const gen = loadGeneration;
    const frag = document.createDocumentFragment();
    for (let anchor = firstAnchor; anchor <= lastAnchor; anchor += 2) {
      const [, second] = spreadForPage(anchor);
      const row = document.createElement('div');
      row.className = 'spread-row';
      row.dataset.anchor = String(anchor);
      if (second) row.dataset.second = String(second);

      [anchor, second].forEach(p => {
        if (!p) return;
        const existing = container.querySelector(`:scope > .page-section[data-page-number="${p}"]`);
        if (existing && ownPageIsComplete(p)) {
          injectOwnSurahHeading(existing, p);
          row.appendChild(existing);
          return;
        }
        // Foreign or shared page → rebuilt whole from its surahs.
        if (existing) existing.remove();
        const ph = document.createElement('div');
        ph.className = 'spread-placeholder';
        ph.dataset.page = String(p);
        ph.dataset.owner = String(findSurahForPage(p));
        ph.innerHTML = `<div class="spinner"></div><p>جارٍ تحميل الصفحة ${p}…</p>`;
        row.appendChild(ph);
      });
      frag.appendChild(row);
    }
    container.appendChild(frag);
    // Rebuilds are async: a jump that lands on a borrowed page must wait
    // for it (see whenLayoutSettled).
    spreadFillPromise = fillBorrowedPages(gen);
  }

  /**
   * Replace spread placeholders with complete mushaf pages assembled from
   * every surah that shares the page (cached). Failures become a goto card.
   */
  async function fillBorrowedPages(gen) {
    const placeholders = [...document.querySelectorAll('.spread-placeholder[data-page]')];
    let replaced = false;
    for (const ph of placeholders) {
      const page = parseInt(ph.dataset.page);
      if (isNaN(page)) {
        markSpreadFailed(ph);
        continue;
      }
      try {
        const owners = (typeof PageMap !== 'undefined')
          ? PageMap.surahsOnPage(page)
          : [findSurahForPage(page)];
        const list = [];
        let failed = false;
        for (const owner of owners) {
          let data = (owner === currentSurahId) ? currentSurahData : spreadBorrowed[owner];
          if (!data) {
            data = await QuranAPI.getSurahLocal(owner);
            if (gen !== loadGeneration || !isSpreadMode()) return;
            if (owner !== currentSurahId) spreadBorrowed[owner] = data;
          }
          if (!data) { failed = true; break; }
          list.push(data);
        }
        const html = failed ? '' : PageRenderer.buildMushafPage(page, list);
        if (gen !== loadGeneration || !isSpreadMode() || !ph.isConnected) return;
        if (!html) {
          markSpreadFailed(ph);
          continue;
        }
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const section = tmp.firstElementChild;
        if (!section) {
          markSpreadFailed(ph);
          continue;
        }
        section.setAttribute('data-mushaf', '1');
        section.setAttribute('data-surahs', owners.join(','));
        ph.replaceWith(section);
        replaced = true;
      } catch (err) {
        if (gen !== loadGeneration) return;
        markSpreadFailed(ph);
      }
    }
    // Rebuilt pages changed the row content → refit (their height counts).
    if (replaced && typeof DynamicPage !== 'undefined' && DynamicPage.refit) {
      DynamicPage.refit();
    }
  }

  function markSpreadFailed(ph) {
    if (!ph.isConnected) return;
    const owner = ph.dataset.owner;
    const page = ph.dataset.page;
    ph.classList.add('failed');
    ph.innerHTML = `<p>الصفحة ${page} في سورة أخرى</p>` +
      `<button type="button" data-goto-surah="${owner}">انتقل للسورة</button>`;
  }

  /**
   * Rebuild the flat single-page column for the current surah. Shared
   * boundary pages are replaced by foreign mushaf pages while spread, so
   * the flat view is regenerated from the surah data instead of unwrapped.
   */
  function flattenSpreadLayout() {
    const container = document.getElementById('surah-content-container');
    if (!container) return;
    if (currentSurahData) {
      PageRenderer.renderSurahWithPages(currentSurahData);
      return;
    }
    // Fallback (no in-memory data): unwrap whatever own sections remain.
    container.querySelectorAll('.page-section[data-mushaf], .spread-placeholder')
      .forEach(el => el.remove());
    const rows = [...container.querySelectorAll('.spread-row')];
    if (!rows.length) return;
    const sections = [];
    rows.forEach(row => {
      [...row.querySelectorAll(':scope > .page-section')].forEach(s => sections.push(s));
    });
    sections.sort((a, b) => parseInt(a.dataset.pageNumber) - parseInt(b.dataset.pageNumber));
    const firstRow = rows[0];
    sections.forEach(s => firstRow.parentNode.insertBefore(s, firstRow));
    rows.forEach(r => r.remove());
  }

  /**
   * Called by SettingsManager when the spread toggle changes (and on
   * every settings apply — no-ops when nothing needs doing). Rebuilds the
   * layout AND the page observer (which watches rows in spread mode,
   * sections otherwise), preserving the current position.
   */
  function refreshSpreadLayout() {
    const container = document.getElementById('surah-content-container');
    if (!container) return;
    const spreadOn = isSpreadMode();
    const hasRows = !!container.querySelector('.spread-row');
    if (spreadOn && hasRows) return;
    if (!spreadOn && !hasRows) return;
    // Nothing rendered yet (e.g. settings init) → loadSurah builds it.
    if (!container.querySelector('.page-section')) return;

    const keep = currentPageNumber;
    if (spreadOn) buildSpreadLayout();
    else flattenSpreadLayout();
    setupPageNavigation();

    // Restore position (setup above resets to the first page).
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    const disp = document.getElementById('page-nav-current');
    if (keep && prevBtn && nextBtn && disp) {
      if (spreadOn) {
        const [a, b] = spreadForPage(keep);
        setSpreadIndicator(a, b, prevBtn, nextBtn, disp);
      } else {
        setSidePageIndicator(keep, prevBtn, nextBtn, disp);
      }
      scrollToPage(keep, 'auto');
    }
  }

  /**
   * Resolve when the page geometry of the CURRENT render is final:
   * spread pages are rebuilt asynchronously (fillBorrowedPages) and the
   * auto-fit resizes every page box ~150ms after the render. Jumping
   * before that lands on the wrong page, because the snap points move
   * underneath the scroll.
   * @param {number} generation - loadSurah generation of the caller
   * @returns {Promise<boolean>} false when the view changed meanwhile
   */
  async function whenLayoutSettled(generation) {
    if (spreadFillPromise) {
      try { await spreadFillPromise; } catch (e) { /* placeholders remain */ }
    }
    if (generation !== loadGeneration) return false;
    if (typeof DynamicPage !== 'undefined' && typeof DynamicPage.whenSettled === 'function') {
      await DynamicPage.whenSettled();
    }
    return generation === loadGeneration;
  }

  /**
   * True while a single mushaf page (or opening) fills the screen: the
   * auto-fit is applied, so pages ARE the reading unit and the column
   * snaps to page starts. Spread always runs with the fit (settings force
   * it), so the fit class alone is the authoritative signal.
   */
  function isPageFitMode() {
    return document.body.classList.contains('dynamic-page-mode');
  }

  // How long the jump-target highlight stays on the verse.
  const AYAH_HIGHLIGHT_MS = 6000;
  let ayahHighlightTimer = null;

  /**
   * Remove the jump-target highlight (and its pending timer).
   */
  function clearAyahHighlight() {
    if (ayahHighlightTimer) {
      clearTimeout(ayahHighlightTimer);
      ayahHighlightTimer = null;
    }
    document.querySelectorAll('.verse.ayah-target')
      .forEach(el => el.classList.remove('ayah-target'));
  }

  /**
   * Mark a verse as the jump destination, so it is obvious WHICH ayah a
   * search result / bookmark landed on (.verse.ayah-target in styles.css).
   * Purely visual (background only — no border/padding), so the page
   * geometry the jump just targeted does not shift. Auto-clears after
   * AYAH_HIGHLIGHT_MS so the mushaf page returns to its clean state.
   * @param {HTMLElement} verseEl
   */
  function highlightAyah(verseEl) {
    if (!verseEl) return;
    clearAyahHighlight();
    verseEl.classList.add('ayah-target');
    ayahHighlightTimer = setTimeout(() => {
      ayahHighlightTimer = null;
      verseEl.classList.remove('ayah-target');
    }, AYAH_HIGHLIGHT_MS);
  }

  function scrollToPage(pageNumber, behavior = 'smooth') {
    const n = parseInt(pageNumber);
    if (isSpreadMode() && !isNaN(n)) {
      const [anchor] = spreadForPage(n);
      const row = document.querySelector(`.spread-row[data-anchor="${anchor}"]`);
      if (row) {
        row.scrollIntoView({ behavior, block: 'start' });
        return true;
      }
    }
    const pageSection = document.querySelector(`.page-section[data-page-number="${pageNumber}"]`);
    if (pageSection) {
      pageSection.scrollIntoView({ behavior, block: 'start' });
      return true;
    }
    return false;
  }

  function scrollToAyah(ayahNumber, behavior = 'smooth') {
    // Convert local ayah number to global verse ID
    let globalId = ayahNumber;
    if (currentSurahVerses.length > 0 && ayahNumber >= 1 && ayahNumber <= currentSurahVerses.length) {
      globalId = currentSurahVerses[ayahNumber - 1].id;
    }
    const verseEl = document.querySelector(`.verse[data-ayah="${globalId}"]`);
    if (verseEl) {
      // Mark the destination so the user sees which ayah the jump landed on
      // (visual only — no layout change, so the scroll below stays exact).
      highlightAyah(verseEl);
      // Page-fit modes (auto-fit page / two-page spread): one page IS one
      // screen, so scrolling to the verse itself leaves the view unaligned
      // with any page start (the page's own beginning, or the opening's
      // other page, ends up above/below the fold) — and the mandatory page
      // snap then pulls the view to a neighbouring page. Land on the page
      // that contains the verse instead: the whole page, verse included, is
      // already one screen tall.
      if (isPageFitMode()) {
        const page = parseInt(verseEl.closest('.page-section')?.dataset.pageNumber, 10);
        if (!isNaN(page) && scrollToPage(page, behavior)) return true;
      }
      const prevJuzDivider = verseEl.previousElementSibling;
      if (prevJuzDivider && prevJuzDivider.classList.contains('juz-divider')) {
        prevJuzDivider.scrollIntoView({ behavior, block: 'start' });
      } else {
        const parentJuzDivider = verseEl.closest('.page-section')?.previousElementSibling;
        if (parentJuzDivider && parentJuzDivider.classList.contains('juz-divider')) {
          parentJuzDivider.scrollIntoView({ behavior, block: 'start' });
        } else {
          verseEl.scrollIntoView({ behavior, block: 'start' });
        }
      }
      return true;
    }
    return false;
  }

  /**
    * Find surah ID for a given page number
    */
  function findSurahForPage(pageNumber) {
    if (pageNumber < 1 || pageNumber > 604) return currentSurahId;

    // A shared page starts several surahs; the reader belongs to the FIRST
    // surah that has verses on it (e.g. page 600 -> 100, not 102).
    if (typeof PageMap !== 'undefined' && typeof PageMap.surahsOnPage === 'function') {
      const owners = PageMap.surahsOnPage(pageNumber);
      if (owners.length) return owners[0];
    }

    for (let i = SURAH_START_PAGES.length - 1; i >= 0; i--) {
      if (SURAH_START_PAGES[i] <= pageNumber) {
        return i + 1;
      }
    }
    return 1;
  }

  /**
    * Mushaf label for a hizb-quarter entry, e.g. "الحزب 5"، "ربع الحزب 5"،
    * "نصف الحزب 5"، "ثلاثة أرباع الحزب 5".
    */
  function hizbQuarterLabel(entry) {
    const pos = ((entry.rub - 1) % 4) + 1;
    if (pos === 1) return `الحزب ${entry.hizb}`;
    if (pos === 2) return `ربع الحزب ${entry.hizb}`;
    if (pos === 3) return `نصف الحزب ${entry.hizb}`;
    return `ثلاثة أرباع الحزب ${entry.hizb}`;
  }

  /**
    * Find surah ID for a given rub (quarter) number 1..240.
    * Falls back to juz lookup when the quarter table is unavailable.
    */
  function findSurahForPart(partNumber) {
    const rub = parseInt(partNumber);
    if (!isNaN(rub) && typeof HIZB_QUARTER_DATA !== 'undefined') {
      const entry = HIZB_QUARTER_DATA.find(e => e.rub === rub);
      if (entry) return entry.surah;
    }
    const juzInfo = (typeof JUZ_DATA !== 'undefined')
      ? JUZ_DATA.find(j => j.juz === parseInt(partNumber))
      : null;
    if (!juzInfo) return currentSurahId;
    return juzInfo.surah;
  }

  let selectedPartRub = null;
  let readerDropdown = null;
  let homeDropdown = null;
  let homeSelectedPartRub = null;

  const READER_DROPDOWN_IDS = {
    root: 'part-dropdown',
    btn: 'part-dropdown-btn',
    panel: 'part-dropdown-panel',
    label: 'part-dropdown-label',
    list: 'part-dropdown-list'
  };

  /**
    * Fill a custom part dropdown list with one sticky group per juz
    * (30 groups), each holding its 8 quarters as two-line items:
    * preview line + muted label line (like the reference app).
    */
  function populatePartList(list) {
    if (!list || list.childElementCount > 0) return;

    const frag = document.createDocumentFragment();
    const hasQuarters = typeof HIZB_QUARTER_DATA !== 'undefined'
      && Array.isArray(HIZB_QUARTER_DATA);

    if (hasQuarters) {
      for (let juz = 1; juz <= 30; juz++) {
        const header = document.createElement('div');
        header.className = 'part-group-title';
        header.textContent = `الجزء ${juz}`;
        frag.appendChild(header);

        HIZB_QUARTER_DATA
          .filter(e => e.juz === juz)
          .forEach(entry => {
            const label = hizbQuarterLabel(entry);
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'part-item'
              + ((((entry.rub - 1) % 4) === 0) ? ' hizb-start' : '');
            item.setAttribute('role', 'option');
            item.dataset.rub = entry.rub;
            item.dataset.short = `${label} · ${entry.surahName} ${entry.ayah}`;
            item.innerHTML =
              `<span class="part-item-preview">${entry.preview}…</span>` +
              `<span class="part-item-sub">${label} · ${entry.surahName} ${entry.ayah} · ص ${entry.page}</span>`;
            frag.appendChild(item);
          });
      }
    } else if (typeof JUZ_DATA !== 'undefined') {
      JUZ_DATA.forEach(j => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'part-item';
        item.setAttribute('role', 'option');
        item.dataset.rub = j.juz;
        item.dataset.short = `الجزء ${j.juz}`;
        item.innerHTML =
          `<span class="part-item-preview">الجزء ${j.juz}</span>` +
          `<span class="part-item-sub">صفحة ${j.page}</span>`;
        frag.appendChild(item);
      });
    }

    list.appendChild(frag);
  }

  /**
    * Wire one custom part dropdown instance: open/close/selection.
    * Desktop: panel floats under the button. Mobile: panel is fixed
    * and centered (native pickers can't be styled, so we render our own).
    * Returns { populate, getSelected } or null when DOM ids are missing.
    */
  function createPartDropdown(ids, onSelect) {
    const root = document.getElementById(ids.root);
    const btn = document.getElementById(ids.btn);
    const panel = document.getElementById(ids.panel);
    const label = document.getElementById(ids.label);
    const list = document.getElementById(ids.list);
    if (!root || !btn || !panel || !label || !list) return null;

    let selectedRub = null;

    const populate = () => populatePartList(list);

    const close = () => {
      panel.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    };

    const open = () => {
      populate();
      panel.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      if (window.innerWidth <= 900) {
        const rect = btn.getBoundingClientRect();
        panel.style.top = `${rect.bottom + 6}px`;
      } else {
        panel.style.top = '';
      }
      panel.querySelector('.part-item.selected')
        ?.scrollIntoView({ block: 'nearest' });
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.classList.contains('open')) close();
      else open();
    });

    document.addEventListener('click', (e) => {
      if (!root.contains(e.target)) close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.part-item');
      if (!item) return;
      panel.querySelectorAll('.part-item.selected')
        .forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedRub = parseInt(item.dataset.rub);
      label.textContent = item.dataset.short || 'اختر…';
      close();
      if (onSelect) onSelect(selectedRub);
    });

    return { populate, getSelected: () => selectedRub };
  }

  function ensureReaderDropdown() {
    if (!readerDropdown) {
      readerDropdown = createPartDropdown(READER_DROPDOWN_IDS, (rub) => {
        selectedPartRub = rub;
        goToPart(rub);
      });
    }
    return readerDropdown;
  }

  function populatePartSelector() {
    ensureReaderDropdown()?.populate();
  }

  function setupPartDropdown() {
    if (window._partDropdownSetup) return;
    window._partDropdownSetup = true;
    ensureReaderDropdown();
  }

  /**
    * Navigate to a specific page number
    */
  function goToPage(pageNumber) {
    pageNumber = parseInt(pageNumber);
    if (isNaN(pageNumber) || pageNumber < 1 || pageNumber > 604) return;
    
    const surahId = findSurahForPage(pageNumber);
    if (surahId === currentSurahId) {
      scrollToPage(pageNumber);
    } else {
      const targetHash = `#surah/${surahId}`;
      window._pendingPageScroll = pageNumber;
      if (window.location.hash === targetHash) {
        loadSurah(surahId);
      } else {
        window.location.hash = targetHash;
      }
    }
  }

  /**
    * Navigate to a specific hizb quarter (rub 1..240).
    * Falls back to juz navigation when the quarter table is unavailable.
    */
  function goToPart(partNumber) {
    partNumber = parseInt(partNumber);
    if (isNaN(partNumber)) return;

    let target = null;
    if (typeof HIZB_QUARTER_DATA !== 'undefined' && partNumber >= 1 && partNumber <= 240) {
      target = HIZB_QUARTER_DATA.find(e => e.rub === partNumber) || null;
    } else if (typeof JUZ_DATA !== 'undefined' && partNumber >= 1 && partNumber <= 30) {
      target = JUZ_DATA.find(j => j.juz === partNumber) || null;
    }
    if (!target) return;

    if (target.surah === currentSurahId) {
      scrollToAyah(target.ayah);
    } else {
      window._pendingAyahScroll = target.ayah;
      const targetHash = `#surah/${target.surah}`;
      if (window.location.hash === targetHash) {
        loadSurah(target.surah);
      } else {
        window.location.hash = targetHash;
      }
    }
  }

  /**
    * Reject more than 3 digits in a page number input (pages are 1..604).
    */
  function limitPageInputDigits(input) {
    if (!input) return;
    const clamp = () => {
      if (input.value && input.value.length > 3) {
        input.value = input.value.slice(0, 3);
      }
    };
    input.addEventListener('input', clamp);
    input.addEventListener('change', clamp);
  }

  /**
    * Wire a page-jump field: number input (max 3 digits), go button, Enter
    * key, and spinner buttons — spinners scoped to this field's own wrapper
    * so the reader nav and the home quick-nav never cross-wire.
    */
  function wirePageNavField(inputId, goBtnId, onGo) {
    const input = document.getElementById(inputId);
    const goBtn = document.getElementById(goBtnId);
    if (!input) return null;
    limitPageInputDigits(input);

    goBtn?.addEventListener('click', () => onGo(input.value));
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') onGo(input.value);
    });

    const scope = input.closest('.page-input-wrapper') || document;
    scope.querySelectorAll('.page-spinner-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = parseInt(input.value) || 1;
        const dir = btn.dataset.dir;
        const newVal = dir === 'up' ? Math.min(val + 1, 604) : Math.max(val - 1, 1);
        input.value = newVal;
        onGo(newVal);
      });
    });
    return input;
  }

  /**
    * Show/hide fixed navigation bar
    */
  function toggleFixedNav(show) {
    const fixedNav = document.getElementById('fixed-nav');
    const appMain = document.querySelector('.app-main');
    
    if (!fixedNav) return;
    
    if (show) {
      fixedNav.classList.add('visible');
      // Calculate nav height dynamically after it's visible
      setTimeout(() => {
        const navHeight = fixedNav.offsetHeight;
        const header = document.querySelector('.app-header');
        const headerHeight = header ? header.offsetHeight : 72;
        if (appMain) {
          appMain.style.marginTop = `${headerHeight + navHeight + 8}px`;
        }
      }, 50);
      appMain?.classList.add('with-fixed-nav');
    } else {
      fixedNav.classList.remove('visible');
      appMain?.classList.remove('with-fixed-nav');
      if (appMain) {
        appMain.style.marginTop = '';
      }
    }
  }

  /**
   * Persist the last seen page as a "stop" (surah + page).
   * Called ONLY when truly leaving the reader (cleanup) or when the
   * browser tab closes/hides — NOT when switching between surahs.
   */
  let lastFlushKey = null;
  let lastFlushTime = 0;

  function flushReadingPosition() {
    try {
      if (typeof QuranBookmarks === 'undefined') return;
      if (!currentSurahId || lastSeenPage == null) return;
      // Idempotent: pagehide + visibilitychange(hidden) often fire
      // together on tab close — skip same-position repeats within 2s.
      const key = `${currentSurahId}:${lastSeenPage}`;
      const now = Date.now();
      if (key === lastFlushKey && (now - lastFlushTime) < 2000) return;
      lastFlushKey = key;
      lastFlushTime = now;
      QuranBookmarks.recordPageVisit(
        currentSurahId, lastSeenPage, currentSurahData?.name_arabic || '');
    } catch (e) { /* history is best-effort */ }
  }

  /**
    * Hide reader elements when leaving the view
    */
  function cleanup() {
    // Leaving the reader counts as a "stop": save last seen page first
    // (before currentSurahData is cleared below).
    flushReadingPosition();
    // Invalidate any in-flight load: a late-resolving fetch must not render
    // into the now-hidden section or toggle global nav/audio.
    loadGeneration++;
    lastSeenPage = null;
    exitSelectionMode();
    clearAyahHighlight();
    currentSurahData = null;
    AudioPlayer.stop();
    currentSurahVerses = [];
    document.getElementById('tajweed-legend').classList.remove('visible');
    document.getElementById('tajweed-legend').classList.remove('collapsed');
    document.getElementById('header-surah-info').innerHTML = '';
    const readerCard = document.querySelector('.surah-viewer-card');
    if (readerCard) readerCard.style.paddingBottom = '';
    hidePageNavButtons();
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    toggleFixedNav(false);
    // Remove swipe navigation elements
    if (swipeOverlay) {
      swipeOverlay.remove();
      swipeOverlay = null;
    }
    if (swipeHintLeft) {
      swipeHintLeft.remove();
      swipeHintLeft = null;
    }
    if (swipeHintRight) {
      swipeHintRight.remove();
      swipeHintRight = null;
    }
    document.body.classList.remove('swipe-active');
    teardownSwipeNavigation();
  }

  /**
   * Remove the verse play/copy popup if present
   */
  function removePlayPopup() {
    document.querySelector('.verse-play-popup')?.remove();
    if (playPopupReposition) {
      playPopupReposition();
      playPopupReposition = null;
    }
  }

  // Detaches the scroll/resize listeners of the currently open popup.
  let playPopupReposition = null;

  /**
   * Place the verse play/copy popup as a body-level popover.
   *
   * Design contract: the bubble ALWAYS floats above its verse,
   * horizontally centered, arrow pointing down — identical on every
   * verse, including the first line of a page. It is appended to
   * document.body (position:fixed, z-index above all reader chrome),
   * so no ancestor overflow or stacking context can clip or cover it.
   */
  function placePlayPopup(popup, verse) {
    const GAP = 8; // original margin-bottom: floats 8px above the verse
    const vr = verse.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;

    // Center on the verse, clamped so the bubble never leaves the viewport.
    const centerX = vr.left + vr.width / 2;
    const half = pw / 2;
    const left = Math.min(
      Math.max(centerX, half + 8),
      window.innerWidth - half - 8
    );

    // Always above the verse; clamped to the viewport top so it paints OVER
    // fixed chrome instead of hiding behind it — never below, never off-screen.
    const top = Math.max(vr.top - ph - GAP, 8);

    popup.style.left = Math.round(left) + 'px';
    popup.style.top = Math.round(top) + 'px';

    // Arrow tracks the verse center when clamping shifts the bubble.
    const edge = left - half;
    const ax = Math.min(Math.max(centerX - edge, 18), pw - 18);
    popup.style.setProperty('--arrow-x', Math.round(ax) + 'px');
  }

  /**
   * The audio player as it actually occupies the screen right now.
   * While immersive the tray is an overlay hidden behind an
   * ImmersiveReader class — treat it as absent unless the bottom
   * chrome is open, so floating elements don't leave a gap above an
   * invisible bar.
   */
  function screenAudioPlayer() {
    const player = document.querySelector('.audio-player.visible');
    if (!player) return null;
    const body = document.body;
    if (body.classList.contains('immersive-read') &&
        !body.classList.contains('immersive-bottom-open')) {
      return null;
    }
    return player;
  }

  /**
   * Position a floating element above the audio player when visible
   */
  function positionFloatingElement(el) {
    const audioPlayer = screenAudioPlayer();
    el.style.bottom = audioPlayer ? `${audioPlayer.offsetHeight + 16}px` : '24px';
  }

  /**
   * Enter multi-select mode with an initially selected verse
   * (that verse becomes the range anchor)
   */
  function enterSelectionMode(firstAyahId) {
    selectionMode = true;
    document.body.classList.add('selection-active');
    removePlayPopup();
    selectedVerses.add(firstAyahId);
    selectionAnchorId = firstAyahId;
    applySelectionClasses();
    createSelectionBar();
    updateSelectionBar();
  }

  /**
   * Exit multi-select mode and clear all highlights
   */
  function exitSelectionMode() {
    selectionMode = false;
    selectedVerses.clear();
    selectionAnchorId = null;
    document.body.classList.remove('selection-active');
    document.querySelectorAll('.verse.ayah-selected').forEach(el => el.classList.remove('ayah-selected'));
    document.getElementById('selection-bar')?.remove();
  }

  /**
   * Toggle one verse inside selection mode.
   * Anchor behavior (Google Photos pattern):
   * - Selecting a verse moves the anchor to it (for future range operations).
   * - Deselecting a verse does NOT move the anchor.
   * - Range operations (Shift+Click / long-press) are additive: they never
   *   clear prior selections, only extend them.
   * Exits mode automatically when the last verse is deselected.
   */
  function toggleVerseSelection(ayahId) {
    if (selectedVerses.has(ayahId)) selectedVerses.delete(ayahId);
    else {
      selectedVerses.add(ayahId);
      selectionAnchorId = ayahId;
    }

    if (selectedVerses.size === 0) {
      exitSelectionMode();
      return;
    }
    applySelectionClasses();
    updateSelectionBar();
  }

  /**
   * Local index of a verse inside currentSurahVerses (ordered by id)
   */
  function ayahIndexById(id) {
    return currentSurahVerses.findIndex(v => v.id === id);
  }

  /**
   * Select every verse between the anchor and target (inclusive),
   * in either direction, across page boundaries.
   * Range operations are additive: they never clear prior selections
   * and never move the anchor. This matches the Google Photos model
   * where Shift+Click extends rather than replaces.
   */
  function selectRange(fromId, toId) {
    const a = ayahIndexById(fromId);
    const b = ayahIndexById(toId);
    if (a < 0 || b < 0) return;

    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) selectedVerses.add(currentSurahVerses[i].id);

    applySelectionClasses();
    updateSelectionBar();
  }

  /**
   * Sync .ayah-selected classes with the selectedVerses set
   */
  function applySelectionClasses() {
    document.querySelectorAll('.verse.ayah-selected').forEach(el => {
      if (!selectedVerses.has(parseInt(el.dataset.ayah))) el.classList.remove('ayah-selected');
    });
    selectedVerses.forEach(id => {
      const el = document.querySelector(`.verse[data-ayah="${id}"]`);
      if (el) el.classList.add('ayah-selected');
    });
  }

  /**
   * Create the contextual action bar (once)
   */
  function createSelectionBar() {
    if (document.getElementById('selection-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'selection-bar';
    bar.className = 'selection-bar';
    bar.innerHTML = `
      <button class="selection-close" id="btn-clear-selection" title="إلغاء التحديد" aria-label="إلغاء التحديد">
        <i class="fa-solid fa-xmark"></i>
      </button>
      <span class="selection-count" id="selection-count"></span>
      <button class="selection-copy" id="btn-copy-selection" aria-label="نسخ الآيات المحددة">
        <i class="fa-regular fa-copy"></i>
        <span>نسخ</span>
      </button>
    `;
    document.body.appendChild(bar);
    positionFloatingElement(bar);

    bar.querySelector('#btn-clear-selection').addEventListener('click', exitSelectionMode);

    bar.querySelector('#btn-copy-selection').addEventListener('click', async () => {
      const ok = await VerseClipboard.copyVerseSet(
        [...selectedVerses],
        currentSurahVerses,
        currentSurahData?.name_arabic || '',
        `تم نسخ ${VerseClipboard.formatAyahCount(selectedVerses.size)}`
      );
      if (ok) exitSelectionMode();
    });
  }

  /**
   * Refresh counter text and keep the bar clear of the audio player
   */
  function updateSelectionBar() {
    const counter = document.getElementById('selection-count');
    if (counter) counter.textContent = VerseClipboard.formatAyahCount(selectedVerses.size);
    const bar = document.getElementById('selection-bar');
    if (bar) positionFloatingElement(bar);
  }

  /**
    * Setup event listeners for page/part navigation (once only)
    */
  function setupNavigationListeners() {
    if (window._surahNavListenersSetup) return;
    window._surahNavListenersSetup = true;

    // Browser/tab close (or hide on mobile): persist the stop position.
    // localStorage writes are still allowed in the pagehide handler.
    window.addEventListener('pagehide', flushReadingPosition);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushReadingPosition();
    });

    // Reposition selection bar when audio player visibility changes
    // (also when ImmersiveReader opens/closes the overlay tray)
    const audioPlayerEl = document.querySelector('.audio-player');
    if (audioPlayerEl) {
      const observer = new MutationObserver(() => {
        const bar = document.getElementById('selection-bar');
        if (bar) positionFloatingElement(bar);
      });
      observer.observe(audioPlayerEl, { attributes: true, attributeFilter: ['class'] });
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // Listen for ayah changes from audio player
    window.addEventListener('ayahchange', (e) => {
      const ayahId = e.detail.ayahId;
      document.querySelectorAll('.verse.ayah-active').forEach(el => el.classList.remove('ayah-active'));
      const target = document.querySelector(`.verse[data-ayah="${ayahId}"]`);
      if (target) {
        target.classList.add('ayah-active');

        // Account for the fixed header + fixed nav at the top and the
        // audio player at the bottom so the verse is not judged "visible"
        // while it is actually hidden behind those fixed elements.
        // In immersive reading the chrome hides behind body classes
        // (ImmersiveReader) — only OPEN chrome covers the verse.
        const immersive = document.body.classList.contains('immersive-read');
        const immersiveBottomOpen = immersive &&
          document.body.classList.contains('immersive-bottom-open');
        const immersiveTopOpen = immersive &&
          document.body.classList.contains('immersive-top-open');
        const header = document.querySelector('.app-header');
        const fixedNav = document.querySelector('#fixed-nav.visible');
        const topOffset = immersive
          ? (immersiveTopOpen ? (header?.offsetHeight || 0) + (fixedNav?.offsetHeight || 0) + 12 : 0)
          : (header?.offsetHeight || 0) + (fixedNav?.offsetHeight || 0) + 12;
        const audioPlayer = immersive
          ? (immersiveBottomOpen ? document.querySelector('.audio-player.visible') : null)
          : document.querySelector('.audio-player.visible');
        const bottomOffset = audioPlayer?.offsetHeight || 0;

        const rect = target.getBoundingClientRect();
        const isVisible =
          rect.top >= topOffset &&
          rect.bottom <= window.innerHeight - bottomOffset;

        if (!isVisible) {
          // `.verse` has `scroll-margin-top: 140px` (200px on mobile),
          // so `block: 'start'` lands the verse just below the fixed header/nav.
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });

    // Verse click → select verse + show play popup (or multi-select toggle)
    document.addEventListener('click', (e) => {
      if (suppressNextVerseClick) {
        suppressNextVerseClick = false;
        return;
      }

      const verse = e.target.closest('.verse');
      if (!verse) return;

      const ayahId = parseInt(verse.dataset.ayah);
      if (isNaN(ayahId)) return;

      // A verse on a rebuilt mushaf page that belongs to a NEIGHBOUR surah:
      // selection, audio and copy all resolve against the CURRENT surah's
      // data, so they would misbehave. Navigate to the owning surah instead.
      const mushafSection = verse.closest('.page-section[data-mushaf]');
      if (mushafSection && !currentSurahVerses.some(v => v.id === ayahId)) {
        for (const data of pageSurahsData(mushafSection)) {
          const idx = data.verses?.findIndex(v => v.id === ayahId) ?? -1;
          if (idx >= 0) {
            window._pendingAyahScroll = idx + 1;
            const targetHash = `#surah/${data.surah_id}`;
            if (window.location.hash === targetHash) loadSurah(data.surah_id);
            else window.location.hash = targetHash;
            break;
          }
        }
        return;
      }

      // Ctrl/Cmd+Shift+Click → enter mode anchored here, or extend range from
      // the anchor to this verse. Safe: modifier-click defaults in browsers
      // only apply to links, verses are plain <span> elements.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (!selectionMode) enterSelectionMode(ayahId);
        else if (selectionAnchorId != null) selectRange(selectionAnchorId, ayahId);
        return;
      }

      // Shift+Click inside selection mode → extend range from the anchor.
      // Outside selection mode it is ignored (normal popup behavior).
      if (e.shiftKey && selectionMode && selectionAnchorId != null) {
        selectRange(selectionAnchorId, ayahId);
        return;
      }

      // Ctrl/Cmd+click → enter/toggle multi-select mode (anchor follows)
      if (e.ctrlKey || e.metaKey) {
        if (!selectionMode) enterSelectionMode(ayahId);
        else toggleVerseSelection(ayahId);
        return;
      }

      if (selectionMode) {
        toggleVerseSelection(ayahId);
        return;
      }

      // Remove existing popup if any
      removePlayPopup();

      // Select this verse visually (playback highlight)
      document.querySelectorAll('.verse.ayah-active').forEach(el => el.classList.remove('ayah-active'));
      verse.classList.add('ayah-active');

      // Update player position (without playing)
      AudioPlayer.setAyahPosition(ayahId);

      // Create popup with play + copy + bookmark buttons
      const popup = document.createElement('div');
      popup.className = 'verse-play-popup';
      // NOTE: verse.dataset.ayah holds the GLOBAL verse id (e.g. Baqarah
      // ayah 253 === global id 260). User bookmarks store the LOCAL ayah
      // number within the surah, so convert here. Audio/copy keep the
      // global id, which is what they expect.
      const ayahIdx = ayahIndexById(ayahId);
      const localAyahNumber = ayahIdx >= 0 ? ayahIdx + 1 : null;
      const alreadySaved = (typeof QuranBookmarks !== 'undefined') &&
        localAyahNumber != null &&
        QuranBookmarks.isAyahBookmarked(currentSurahId, localAyahNumber);
      popup.innerHTML = `
        <button class="verse-play-btn" title="تشغيل من هذه الآية" aria-label="تشغيل من هذه الآية">
          <i class="fa-solid fa-play"></i>
        </button>
        <button class="verse-copy-btn" title="نسخ الآية" aria-label="نسخ الآية">
          <i class="fa-regular fa-copy"></i>
        </button>
        <button class="verse-copy-btn verse-bookmark-btn${alreadySaved ? ' bookmarked' : ''}" title="حفظ مرجع" aria-label="حفظ مرجع">
          <i class="fa-${alreadySaved ? 'solid' : 'regular'} fa-bookmark"></i>
        </button>
      `;

      // Body-portal popover: always above the verse, centered,
      // painted above all reader chrome (see placePlayPopup).
      document.body.appendChild(popup);
      placePlayPopup(popup, verse);

      // Keep the popover glued to its verse while open (scroll/resize).
      if (playPopupReposition) playPopupReposition();
      const onPopupReposition = () => {
        if (!popup.isConnected || !verse.isConnected) return;
        placePlayPopup(popup, verse);
      };
      document.addEventListener('scroll', onPopupReposition, true);
      window.addEventListener('resize', onPopupReposition);
      playPopupReposition = () => {
        document.removeEventListener('scroll', onPopupReposition, true);
        window.removeEventListener('resize', onPopupReposition);
      };

      // Handle play button click
      popup.querySelector('.verse-play-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        removePlayPopup();
        AudioPlayer.playAyah(ayahId);
      });

      // Handle copy button click
      popup.querySelector('.verse-copy-btn:not(.verse-bookmark-btn)').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        removePlayPopup();
        await VerseClipboard.copyVerseSet([ayahId], currentSurahVerses, currentSurahData?.name_arabic || '', 'تم نسخ الآية');
      });

      // Handle bookmark button click (toggle user ayah bookmark, max 10 FIFO)
      popup.querySelector('.verse-bookmark-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        removePlayPopup();
        if (typeof QuranBookmarks === 'undefined') return;
        if (localAyahNumber == null) {
          VerseClipboard.showToast('تعذر حفظ المرجع', 'error');
          return;
        }
        const surahName = currentSurahData?.name_arabic || '';
        const nowSaved = QuranBookmarks.toggleAyahBookmark(
          currentSurahId, localAyahNumber, surahName);
        if (nowSaved == null) {
          VerseClipboard.showToast('تعذر حفظ المرجع', 'error');
        } else {
          VerseClipboard.showToast(
            nowSaved ? `تم حفظ المرجع (سورة ${surahName} - الآية ${localAyahNumber})` : 'تم حذف المرجع',
            nowSaved ? 'success' : 'error');
        }
      });

      // Auto-remove popup after 5 seconds
      setTimeout(() => {
        if (popup.parentNode) removePlayPopup();
      }, 5000);
    });

    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
      if (selectionMode) return; // selection mode exits only via X / Escape
      if (!e.target.closest('.verse') && !e.target.closest('.verse-play-popup')) {
        removePlayPopup();
      }
    });

    // Long-press (~500ms) on a verse: enters multi-select mode (mobile),
    // or — when already in selection mode — selects the range from the last
    // individually selected verse up to this one (Google Photos pattern).
    // Cancelled when the finger moves >10px (scroll intent) or lifts early.
    let pressTimer = null;
    let pressOrigin = null;
    document.addEventListener('pointerdown', (e) => {
      const verse = e.target.closest('.verse');
      if (!verse) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const ayahId = parseInt(verse.dataset.ayah);
      if (isNaN(ayahId)) return;
      // Neighbour-surah verses on a rebuilt mushaf page navigate on tap
      // (see click handler) — never enter selection mode here.
      if (verse.closest('.page-section[data-mushaf]') &&
          !currentSurahVerses.some(v => v.id === ayahId)) return;
      pressOrigin = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        suppressNextVerseClick = true;
        if (selectionMode && selectionAnchorId != null && selectionAnchorId !== ayahId) {
          selectRange(selectionAnchorId, ayahId);
        } else {
          enterSelectionMode(ayahId);
        }
        if (navigator.vibrate) navigator.vibrate(30);
      }, 500);
    });
    document.addEventListener('pointermove', (e) => {
      if (pressTimer && pressOrigin &&
          Math.hypot(e.clientX - pressOrigin.x, e.clientY - pressOrigin.y) > 10) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });
    ['pointerup', 'pointercancel'].forEach(evt =>
      document.addEventListener(evt, () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      })
    );

    // Escape exits selection mode
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selectionMode) exitSelectionMode();
    });

    // Contextual copy actions rendered by PageRenderer (re-built each surah,
    // so these are delegated): copy whole surah / copy a single mushaf page
    document.addEventListener('click', async (e) => {
      // Failed spread placeholder → jump to the owning surah
      const goBtn = e.target.closest('[data-goto-surah]');
      if (goBtn) {
        window.location.hash = `#surah/${goBtn.dataset.gotoSurah}`;
        return;
      }

      const surahBtn = e.target.closest('.copy-surah-btn');
      if (surahBtn && currentSurahVerses.length) {
        const ids = currentSurahVerses.map(v => v.id);
        await VerseClipboard.copyVerseSet(
          ids,
          currentSurahVerses,
          currentSurahData?.name_arabic || '',
          `تم نسخ السورة كاملة · ${VerseClipboard.formatAyahCount(ids.length)}`
        );
        return;
      }

      const pageBtn = e.target.closest('.copy-page-btn');
      if (pageBtn) {
        const pageNumber = pageBtn.dataset.pageNumber;
        const section = document.querySelector(`.page-section[data-page-number="${pageNumber}"]`);
        if (!section) return;
        const ids = [...section.querySelectorAll('.verse[data-ayah]')]
          .map(el => parseInt(el.dataset.ayah))
          .filter(n => !isNaN(n));
        if (!ids.length) return;
        // Rebuilt mushaf pages span one or more surahs; the flat pages and
        // this surah's own pages resolve against the current surah.
        let srcVerses = currentSurahVerses;
        let srcName = currentSurahData?.name_arabic || '';
        if (section.dataset.mushaf) {
          const list = pageSurahsData(section);
          srcVerses = [];
          list.forEach(d => { if (d.verses) srcVerses = srcVerses.concat(d.verses); });
          srcName = list.map(d => d.name_arabic || '').filter(Boolean).join(' - ');
        }
        await VerseClipboard.copyVerseSet(
          ids,
          srcVerses,
          srcName,
          `تم نسخ الصفحة ${VerseClipboard.toArabicDigits(pageNumber)} · ${VerseClipboard.formatAyahCount(ids.length)}`
        );
      }
    });
    
    // Page navigation (input + go button + spinners scoped to this wrapper;
    // input rejects more than 3 digits)
    wirePageNavField('page-number-input', 'btn-go-page',
      (value) => goToPage(value));

    // Part navigation (custom dropdown)
    setupPartDropdown();

    const btnGoPart = document.getElementById('btn-go-part');

    btnGoPart?.addEventListener('click', () => {
      if (selectedPartRub) {
        goToPart(selectedPartRub);
      } else {
        document.getElementById('part-dropdown-btn')?.click();
      }
    });
  }

  /**
    * Navigate the home quick-nav part dropdown to a rub (1..240).
    * Uses the quarter table when available, else the juz table.
    */
  function homeGoToRub(rub) {
    if (typeof HIZB_QUARTER_DATA !== 'undefined') {
      const entry = HIZB_QUARTER_DATA.find(e => e.rub === rub);
      if (entry) {
        QuranBookmarks.navigateToAyah(entry.surah, entry.ayah);
        return;
      }
    }
    if (typeof JUZ_DATA !== 'undefined') {
      const juz = JUZ_DATA.find(j => j.juz === rub);
      if (juz) QuranBookmarks.navigateToAyah(juz.surah, juz.ayah);
    }
  }

  /**
    * Home quick-nav under the tabs: page-jump field + part dropdown.
    * Mirrors the reader nav, but navigates away from the home view via
    * QuranBookmarks. Called once from app.js after init.
    */
  function setupHomeQuickNav() {
    if (window._homeQuickNavSetup) return;
    window._homeQuickNavSetup = true;

    wirePageNavField('home-page-number-input', 'btn-home-go-page', (value) => {
      const page = parseInt(value);
      if (isNaN(page) || page < 1 || page > 604) return;
      QuranBookmarks.navigateToPage(findSurahForPage(page), page);
    });

    homeDropdown = createPartDropdown({
      root: 'home-part-dropdown',
      btn: 'home-part-dropdown-btn',
      panel: 'home-part-dropdown-panel',
      label: 'home-part-dropdown-label',
      list: 'home-part-dropdown-list'
    }, (rub) => {
      homeSelectedPartRub = rub;
      homeGoToRub(rub);
    });

    document.getElementById('btn-home-go-part')?.addEventListener('click', () => {
      if (homeSelectedPartRub) {
        homeGoToRub(homeSelectedPartRub);
      } else {
        document.getElementById('home-part-dropdown-btn')?.click();
      }
    });
  }

  /**
   * Update the side page indicator + prev/next button states.
   * Single place so button clicks (optimistic) and the page
   * observer always agree on the current page number.
   */
  function setSidePageIndicator(pageNum, prevBtn, nextBtn, pageNumDisplay) {
    if (isNaN(pageNum) || pageNum < 1 || pageNum > 604) return;
    currentPageNumber = pageNum;
    lastSeenPage = pageNum;
    pageNumDisplay.textContent = pageNum;
    prevBtn.disabled = pageNum <= 1;
    nextBtn.disabled = pageNum >= 604;
  }

  /**
   * Spread-mode side indicator: shows the opening range "a - b" and tracks
   * the anchor (odd/right page) as the current page for bookmarks/resume.
   */
  function setSpreadIndicator(anchor, second, prevBtn, nextBtn, pageNumDisplay) {
    if (isNaN(anchor) || anchor < 1 || anchor > 604) return;
    currentPageNumber = anchor;
    lastSeenPage = anchor;
    pageNumDisplay.textContent = second ? `${anchor} - ${second}` : `${anchor}`;
    prevBtn.disabled = anchor <= 1;
    nextBtn.disabled = (second || anchor) >= 604;
  }

  /**
   * Setup page navigation buttons with Intersection Observer
   */
  function setupPageNavigation() {
    // Clean up previous observer if any
    if (pageObserver) {
      pageObserver.disconnect();
    }

    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    const pageNumDisplay = document.getElementById('page-nav-current');
    const setPage = (n) => setSidePageIndicator(n, prevBtn, nextBtn, pageNumDisplay);
    const setSpread = (a, b) => setSpreadIndicator(a, b, prevBtn, nextBtn, pageNumDisplay);
    const spreadOn = isSpreadMode();

    // Reset to the first mushaf page of THIS surah (not hardcoded 1:
    // e.g. Al-Baqarah starts at page 2) — or straight to a pending
    // cross-surah jump target so the counter never flashes an
    // intermediate value before the instant jump lands.
    const pendingPage = parseInt(window._pendingPageScroll);
    const hasPending = !isNaN(pendingPage) && pendingPage >= 1 && pendingPage <= 604;
    if (spreadOn) {
      const firstRow = document.querySelector('.spread-row[data-anchor]');
      const [pAnchor, pSecond] = spreadForPage(hasPending ? pendingPage : 1);
      if (hasPending) {
        setSpread(pAnchor, pSecond);
      } else if (firstRow) {
        setSpread(parseInt(firstRow.dataset.anchor), parseInt(firstRow.dataset.second) || null);
      } else {
        const firstSection = document.querySelector('.page-section[data-page-number]');
        const n = parseInt(firstSection?.dataset.pageNumber) || 1;
        const [a, b] = spreadForPage(n);
        setSpread(a, b);
      }
    } else {
      const firstSection = document.querySelector('.page-section[data-page-number]');
      setPage(
        hasPending
          ? pendingPage
          : (parseInt(firstSection?.dataset.pageNumber) || 1)
      );
    }

    // Track the page under a thin "reading line" just below the fixed
    // header/nav (top-anchored band). The old centered 20% band
    // (rootMargin -40%/-40%, threshold 0) switched the counter as soon
    // as the NEXT page touched the viewport middle, and when two pages
    // shared the band the last callback entry won arbitrarily — leaving
    // the counter stuck (e.g. 13) after jumping back to a short page
    // (e.g. 12) whose body never reaches the middle. Top-anchored +
    // uppermost-wins gives hysteresis: the counter flips only once the
    // old page has fully passed the reading line.
    const headerH = document.querySelector('.app-header')?.offsetHeight || 72;
    const navH = document.querySelector('#fixed-nav')?.offsetHeight || 56;
    const topInset = headerH + navH + 8;
    const visibleSections = new Map();
    pageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        // Spread mode observes rows (keyed by anchor); single mode observes pages
        const key = spreadOn ? entry.target.dataset.anchor : entry.target.dataset.pageNumber;
        const num = parseInt(key);
        if (isNaN(num)) return;
        if (entry.isIntersecting) visibleSections.set(num, entry);
        else visibleSections.delete(num);
      });
      if (!visibleSections.size) return;
      // Uppermost section wins: keeps the old page while the boundary
      // is still crossing the line (no premature flip, no flicker).
      // Live getBoundingClientRect (not the cached entry rect) so sections
      // reported in different callback batches are ranked consistently.
      let winner = null;
      let winnerTop = Infinity;
      visibleSections.forEach(entry => {
        const top = entry.target.getBoundingClientRect().top;
        if (top < winnerTop) { winnerTop = top; winner = entry; }
      });
      if (spreadOn) {
        const anchor = parseInt(winner.target.dataset.anchor);
        const second = parseInt(winner.target.dataset.second) || null;
        if (anchor !== currentPageNumber) setSpread(anchor, second);
      } else {
        const pageNum = parseInt(winner.target.dataset.pageNumber);
        if (pageNum !== currentPageNumber) setPage(pageNum);
      }
    }, {
      rootMargin: `-${topInset}px 0px -60% 0px`,
      threshold: 0
    });

    // Observe all page sections (or spread rows in spread mode)
    document.querySelectorAll(spreadOn ? '.spread-row' : '.page-section').forEach(section => {
      pageObserver.observe(section);
    });

    // Add click handlers (optimistic: update the counter immediately so
    // a second click during the smooth scroll targets the right page;
    // the observer confirms on arrival. If the target page is not in
    // this surah (e.g. past its last page), fall back to cross-surah
    // navigation instead of leaving the counter out of sync.
    // Spread mode turns whole leaves: anchor ±2 (odd anchors 1..603).
    const hasPage = (n) =>
      !!document.querySelector(`.page-section[data-page-number="${n}"]`);
    const hasSpread = (anchor) =>
      !!document.querySelector(`.spread-row[data-anchor="${anchor}"]`);
    const scrollToSpread = (anchor) => {
      const row = document.querySelector(`.spread-row[data-anchor="${anchor}"]`);
      if (!row) return false;
      row.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    };
    prevBtn.onclick = () => {
      if (isSpreadMode()) {
        if (currentPageNumber > 1) {
          const target = Math.max(1, currentPageNumber - 2);
          const [anchor, second] = spreadForPage(target);
          if (hasSpread(anchor)) {
            setSpread(anchor, second);
            scrollToSpread(anchor);
          } else {
            goToPage(anchor);
          }
        }
        return;
      }
      if (currentPageNumber > 1) {
        const target = currentPageNumber - 1;
        if (hasPage(target)) {
          setPage(target);
          scrollToPage(target);
        } else {
          goToPage(target);
        }
      }
    };

    nextBtn.onclick = () => {
      if (isSpreadMode()) {
        if (currentPageNumber < 604) {
          const target = Math.min(603, currentPageNumber + 2);
          const [anchor, second] = spreadForPage(target);
          if (hasSpread(anchor)) {
            setSpread(anchor, second);
            scrollToSpread(anchor);
          } else {
            goToPage(anchor);
          }
        }
        return;
      }
      if (currentPageNumber < 604) {
        const target = currentPageNumber + 1;
        if (hasPage(target)) {
          setPage(target);
          scrollToPage(target);
        } else {
          goToPage(target);
        }
      }
    };
  }

  /**
   * Show page navigation buttons
   */
  function showPageNavButtons() {
    document.getElementById('page-nav-buttons')?.classList.add('visible');
  }

  /**
   * Hide page navigation buttons
   */
  function hidePageNavButtons() {
    document.getElementById('page-nav-buttons')?.classList.remove('visible');
  }

  function setupSwipeNavigation() {
    if (window._swipeNavSetup) return;

    const container = document.getElementById('surah-content-container');
    if (!container) return;
    window._swipeNavSetup = true;
    swipeContainer = container;

    // Create overlay element
    swipeOverlay = document.createElement('div');
    swipeOverlay.className = 'swipe-overlay';
    document.body.appendChild(swipeOverlay);

    // Create hint arrows
    swipeHintLeft = document.createElement('div');
    swipeHintLeft.className = 'swipe-hint swipe-hint-left';
    swipeHintLeft.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    document.body.appendChild(swipeHintLeft);

    swipeHintRight = document.createElement('div');
    swipeHintRight.className = 'swipe-hint swipe-hint-right';
    swipeHintRight.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    document.body.appendChild(swipeHintRight);

    const THRESHOLD = 80;
    const MAX_DRAG = 200;

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      swipeStartX = touch.clientX;
      swipeStartY = touch.clientY;
      swipeDeltaX = 0;
      isSwiping = false;
      container.classList.remove('swiping', 'snapping-back');
    };

    const onTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      if (selectionMode) return;
      const touch = e.touches[0];
      const dx = touch.clientX - swipeStartX;
      const dy = touch.clientY - swipeStartY;

      // Determine if this is a horizontal swipe (not vertical scroll)
      if (!isSwiping) {
        // Need at least 10px movement to decide direction
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // If vertical movement is dominant, abort swipe
        if (Math.abs(dy) > Math.abs(dx)) return;
        // Must be on mobile/tablet (touch device)
        if (!matchMedia('(pointer: coarse)').matches) return;
        isSwiping = true;
        document.body.classList.add('swipe-active');
        swipeOverlay.classList.add('active');
      }

      if (!isSwiping) return;

      e.preventDefault();

      // Clamp delta with resistance at edges
      swipeDeltaX = dx;
      const absDx = Math.abs(swipeDeltaX);
      const clampedDelta = absDx > MAX_DRAG
        ? Math.sign(swipeDeltaX) * (MAX_DRAG + (absDx - MAX_DRAG) * 0.3)
        : swipeDeltaX;

      // Apply transform
      container.classList.add('swiping');
      container.classList.remove('snapping-back');
      container.style.transform = `translateX(${clampedDelta}px)`;

      // Show/hide hint arrows based on direction and current surah bounds
      // RTL: swipe right = next surah, swipe left = previous surah
      if (swipeDeltaX > 20 && currentSurahId < 114) {
        // Swiping right → next surah
        swipeHintRight.classList.add('visible');
        swipeHintLeft.classList.remove('visible');
      } else if (swipeDeltaX < -20 && currentSurahId > 1) {
        // Swiping left → previous surah
        swipeHintLeft.classList.add('visible');
        swipeHintRight.classList.remove('visible');
      } else {
        swipeHintLeft.classList.remove('visible');
        swipeHintRight.classList.remove('visible');
      }
    };

    const onTouchEnd = (e) => {
      if (!isSwiping) return;

      isSwiping = false;
      document.body.classList.remove('swipe-active');
      swipeOverlay.classList.remove('active');
      swipeHintLeft.classList.remove('visible');
      swipeHintRight.classList.remove('visible');

      const absDx = Math.abs(swipeDeltaX);

      if (absDx >= THRESHOLD) {
        // RTL: swipe right = next surah, swipe left = previous surah
        const direction = swipeDeltaX > 0 ? 'next' : 'prev';
        const targetId = direction === 'next' ? currentSurahId + 1 : currentSurahId - 1;

        if (targetId >= 1 && targetId <= 114) {
          // Animate slide out then navigate
          const slideOut = swipeDeltaX > 0 ? 300 : -300;
          container.classList.add('swiping');
          container.classList.remove('snapping-back');
          container.style.transform = `translateX(${slideOut}px)`;
          container.style.opacity = '0.5';

          swipeNavTimer = setTimeout(() => {
            swipeNavTimer = null;
            container.style.transform = '';
            container.style.opacity = '';
            container.classList.remove('swiping');
            window.location.hash = `#surah/${targetId}`;
          }, 250);
        } else {
          snapBack(container);
        }
      } else {
        snapBack(container);
      }
    };

    const onTouchCancel = () => {
      if (!isSwiping) return;
      isSwiping = false;
      document.body.classList.remove('swipe-active');
      swipeOverlay.classList.remove('active');
      swipeHintLeft.classList.remove('visible');
      swipeHintRight.classList.remove('visible');
      snapBack(container);
    };

    swipeHandlers = {
      touchstart: onTouchStart,
      touchmove: onTouchMove,
      touchend: onTouchEnd,
      touchcancel: onTouchCancel
    };
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchCancel, { passive: true });
  }

  /**
   * Remove the swipe listeners and cancel any pending swipe navigation.
   * The container persists across reader views, so without this every
   * re-entry would add another listener set; the tracked timer is also
   * cleared so it cannot navigate after the reader is left.
   */
  function teardownSwipeNavigation() {
    if (swipeContainer && swipeHandlers) {
      swipeContainer.removeEventListener('touchstart', swipeHandlers.touchstart);
      swipeContainer.removeEventListener('touchmove', swipeHandlers.touchmove);
      swipeContainer.removeEventListener('touchend', swipeHandlers.touchend);
      swipeContainer.removeEventListener('touchcancel', swipeHandlers.touchcancel);
      swipeContainer.style.transform = '';
      swipeContainer.style.opacity = '';
      swipeContainer.classList.remove('swiping', 'snapping-back');
    }
    swipeContainer = null;
    swipeHandlers = null;
    if (swipeNavTimer) {
      clearTimeout(swipeNavTimer);
      swipeNavTimer = null;
    }
    window._swipeNavSetup = false;
  }

  /**
   * Two-page spread only: continuous reading across surah boundaries via
   * the mouse wheel. When the reader rests on the LAST opening of the
   * surah and the user scrolls down (deltaY > 0), jump to the next mushaf
   * page (it belongs to the next surah, so goToPage reloads the reader and
   * lands on it). The mirror happens on the FIRST opening scrolling up.
   *
   * Arrow Down/Up drive the same page-turn: they delegate to the side
   * page buttons (which already turn one opening and cross surahs at the
   * edges), so keyboard matches the mouse exactly.
   *
   * Single-page mode is deliberately untouched: there the reader still
   * stops at the surah's end. Bound listeners are added once; the
   * handlers are inert unless spread mode is actually rendering.
   */
  function setupSpreadEdgeNavigation() {
    if (window._spreadEdgeNavSetup) return;
    window._spreadEdgeNavSetup = true;

    const OVERLAY_SELECTOR =
      '.settings-drawer, .modal-overlay, .header-dropdown, ' +
      '.part-dropdown-panel, .part-dropdown-list';
    const FIELD_SELECTOR =
      'input, textarea, select, [contenteditable="true"]';

    window.addEventListener('wheel', (e) => {
      if (e.deltaY === 0) return;
      if (!isSpreadMode()) return;
      const reader = document.getElementById('surah-reader-section');
      if (!reader || !reader.classList.contains('active')) return;
      // Wheel inside an own-scrolling overlay must stay there.
      if (e.target && e.target.closest && e.target.closest(OVERLAY_SELECTOR)) return;

      const container = document.getElementById('surah-content-container');
      const rows = container ? container.querySelectorAll('.spread-row') : null;
      if (!rows || !rows.length) return;
      const firstRow = rows[0];
      const lastRow = rows[rows.length - 1];
      const firstAnchor = parseInt(firstRow.dataset.anchor);
      const lastAnchor = parseInt(lastRow.dataset.anchor);
      if (isNaN(firstAnchor) || isNaN(lastAnchor)) return;
      // Last page actually shown by the final opening (its second page when
      // it has one), so a shared boundary page isn't "next" again.
      const lastVisible = parseInt(lastRow.dataset.second) || lastAnchor;

      const now = Date.now();
      if (now - spreadEdgeNavAt < SPREAD_EDGE_LOCK_MS) return;

      if (e.deltaY > 0 && currentPageNumber >= lastAnchor) {
        const next = lastVisible + 1;
        if (next <= 604) {
          spreadEdgeNavAt = now;
          goToPage(next);
        }
      } else if (e.deltaY < 0 && currentPageNumber <= firstAnchor) {
        const prev = firstAnchor - 1;
        if (prev >= 1) {
          spreadEdgeNavAt = now;
          goToPage(prev);
        }
      }
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!isSpreadMode() || selectionMode) return;
      const reader = document.getElementById('surah-reader-section');
      if (!reader || !reader.classList.contains('active')) return;
      // An open drawer/modal keeps the keyboard to itself.
      const drawer = document.getElementById('settings-drawer');
      if (drawer && drawer.classList.contains('open')) return;
      const t = e.target;
      if (t && t.closest && t.closest(FIELD_SELECTOR + ', ' + OVERLAY_SELECTOR)) return;

      const btn = document.getElementById(
        e.key === 'ArrowDown' ? 'btn-next-page' : 'btn-prev-page'
      );
      if (!btn || btn.disabled) return;
      e.preventDefault();
      btn.click();
    });
  }

  function snapBack(container) {
    container.classList.remove('swiping');
    container.classList.add('snapping-back');
    container.style.transform = '';
    setTimeout(() => {
      container.classList.remove('snapping-back');
    }, 200);
  }

  return {
    loadSurah,
    cleanup,
    setupNavigationListeners,
    setupSwipeNavigation,
    setupHomeQuickNav,
    populatePartSelector,
    toggleFixedNav,
    scrollToPage,
    scrollToAyah,
    showPageNavButtons,
    hidePageNavButtons,
    isSpreadMode,
    refreshSpreadLayout,
    buildSpreadLayout,
    flattenSpreadLayout,
    setupPageNavigation
  };
})();
