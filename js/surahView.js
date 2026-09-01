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

  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeDeltaX = 0;
  let isSwiping = false;
  let swipeOverlay = null;
  let swipeHintLeft = null;
  let swipeHintRight = null;

  /**
   * Initialize reader view for a specific Surah
   * @param {number} surahId
   */
  async function loadSurah(surahId) {
    currentSurahId = parseInt(surahId);
    const generation = ++loadGeneration;
    
    const container = document.getElementById('surah-content-container');
    const loading = document.getElementById('reader-loading');
    const headerInfo = document.getElementById('header-surah-info');
    
    // Reset view
    container.innerHTML = '';
    loading.style.display = 'flex';
    headerInfo.innerHTML = '';

    // Show legend footer collapsed by default (click to expand)
    const legend = document.getElementById('tajweed-legend');
    legend.classList.add('visible', 'collapsed');
    // Add padding for collapsed legend header
    const readerCard = document.querySelector('.surah-viewer-card');
    if (readerCard) readerCard.style.paddingBottom = '50px';

    try {
      // Performance monitoring
      const perfStart = performance.now();

      // Fetch Surah data from local JSON file
      const surahData = await QuranAPI.getSurahLocal(currentSurahId);
      if (generation !== loadGeneration) return;

      const fetchTime = performance.now() - perfStart;
      console.log(`[Perf] Data fetch: ${fetchTime.toFixed(1)}ms for surah ${currentSurahId}`);

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
      console.log(`[Perf] Render: ${renderTime.toFixed(1)}ms (${surahData.verses.length} verses)`);
      
      // Setup page navigation buttons
      setupPageNavigation();
      showPageNavButtons();

      // Update nav buttons states
      updateNavigationControls();
      
      // Setup navigation listeners
      setupNavigationListeners();
      setupSwipeNavigation();
      
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
      
      if (window._pendingAyahScroll) {
        const targetAyah = window._pendingAyahScroll;
        window._pendingAyahScroll = null;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToAyah(targetAyah);
          });
        });
      } else if (window._pendingPageScroll) {
        const targetPage = window._pendingPageScroll;
        window._pendingPageScroll = null;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToPage(targetPage);
          });
        });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

    } catch (error) {
      if (generation !== loadGeneration) return;
      console.error(`Failed to load Surah ${currentSurahId}:`, error);
      container.innerHTML = `
        <div class="error-container" style="text-align: center; padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; color: var(--accent); margin-bottom: 12px;"></i>
          <p>عذراً، فشل تحميل آيات السورة المباركة. يرجى التحقق من الاتصال بالإنترنت.</p>
          <button id="btn-retry-reader" class="btn-action" style="margin: 16px auto 0 auto;">إعادة المحاولة</button>
        </div>
      `;
      loading.style.display = 'none';
      
      document.getElementById('btn-retry-reader')?.addEventListener('click', () => loadSurah(currentSurahId));
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
    * Build page-to-surah mapping for current surah
    */
  function scrollToPage(pageNumber) {
    const pageSection = document.querySelector(`.page-section[data-page-number="${pageNumber}"]`);
    if (pageSection) {
      pageSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    return false;
  }

  function scrollToAyah(ayahNumber) {
    // Convert local ayah number to global verse ID
    let globalId = ayahNumber;
    if (currentSurahVerses.length > 0 && ayahNumber >= 1 && ayahNumber <= currentSurahVerses.length) {
      globalId = currentSurahVerses[ayahNumber - 1].id;
    }
    const verseEl = document.querySelector(`.verse[data-ayah="${globalId}"]`);
    if (verseEl) {
      const prevJuzDivider = verseEl.previousElementSibling;
      if (prevJuzDivider && prevJuzDivider.classList.contains('juz-divider')) {
        prevJuzDivider.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        const parentJuzDivider = verseEl.closest('.page-section')?.previousElementSibling;
        if (parentJuzDivider && parentJuzDivider.classList.contains('juz-divider')) {
          parentJuzDivider.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          verseEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

    for (let i = SURAH_START_PAGES.length - 1; i >= 0; i--) {
      if (SURAH_START_PAGES[i] <= pageNumber) {
        return i + 1;
      }
    }
    return 1;
  }

  /**
    * Find surah ID for a given part number
    */
  function findSurahForPart(partNumber) {
    const juzInfo = JUZ_DATA.find(j => j.juz === partNumber);
    if (!juzInfo) return currentSurahId;
    return juzInfo.surah;
  }

  /**
    * Populate part selector dropdown
    */
  function populatePartSelector() {
    const select = document.getElementById('part-number-select');
    if (!select) return;
    
    // Check if already populated
    if (select.options.length > 1) return;
    
    for (let i = 1; i <= 30; i++) {
      const option = document.createElement('option');
      option.value = i;
      option.textContent = `الجزء ${i}`;
      select.appendChild(option);
    }
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
    * Navigate to a specific part
    */
  function goToPart(partNumber) {
    partNumber = parseInt(partNumber);
    if (isNaN(partNumber) || partNumber < 1 || partNumber > 30) return;
    
    const juzInfo = JUZ_DATA.find(j => j.juz === partNumber);
    if (!juzInfo) return;

    if (juzInfo.surah === currentSurahId) {
      scrollToAyah(juzInfo.ayah);
    } else {
      window._pendingAyahScroll = juzInfo.ayah;
      const targetHash = `#surah/${juzInfo.surah}`;
      if (window.location.hash === targetHash) {
        loadSurah(juzInfo.surah);
      } else {
        window.location.hash = targetHash;
      }
    }
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
    * Hide reader elements when leaving the view
    */
  function cleanup() {
    exitSelectionMode();
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
    window._swipeNavSetup = false;
  }

  /**
   * Remove the verse play/copy popup if present
   */
  function removePlayPopup() {
    document.querySelector('.verse-play-popup')?.remove();
  }

  /**
   * Position a floating element above the audio player when visible
   */
  function positionFloatingElement(el) {
    const audioPlayer = document.querySelector('.audio-player.visible');
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

    // Reposition selection bar when audio player visibility changes
    const audioPlayerEl = document.querySelector('.audio-player');
    if (audioPlayerEl) {
      const observer = new MutationObserver(() => {
        const bar = document.getElementById('selection-bar');
        if (bar) positionFloatingElement(bar);
      });
      observer.observe(audioPlayerEl, { attributes: true, attributeFilter: ['class'] });
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
        const header = document.querySelector('.app-header');
        const fixedNav = document.querySelector('#fixed-nav.visible');
        const topOffset =
          (header?.offsetHeight || 0) + (fixedNav?.offsetHeight || 0) + 12;
        const audioPlayer = document.querySelector('.audio-player.visible');
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

      // Create popup with play + copy buttons
      const popup = document.createElement('div');
      popup.className = 'verse-play-popup';
      popup.innerHTML = `
        <button class="verse-play-btn" title="تشغيل من هذه الآية" aria-label="تشغيل من هذه الآية">
          <i class="fa-solid fa-play"></i>
        </button>
        <button class="verse-copy-btn" title="نسخ الآية" aria-label="نسخ الآية">
          <i class="fa-regular fa-copy"></i>
        </button>
      `;

      // Position popup near the verse
      verse.style.position = 'relative';
      verse.appendChild(popup);

      // Handle play button click
      popup.querySelector('.verse-play-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        popup.remove();
        AudioPlayer.playAyah(ayahId);
      });

      // Handle copy button click
      popup.querySelector('.verse-copy-btn').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        popup.remove();
        await VerseClipboard.copyVerseSet([ayahId], currentSurahVerses, currentSurahData?.name_arabic || '', 'تم نسخ الآية');
      });

      // Auto-remove popup after 5 seconds
      setTimeout(() => {
        if (popup.parentNode) popup.remove();
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
        await VerseClipboard.copyVerseSet(
          ids,
          currentSurahVerses,
          currentSurahData?.name_arabic || '',
          `تم نسخ الصفحة ${VerseClipboard.toArabicDigits(pageNumber)} · ${VerseClipboard.formatAyahCount(ids.length)}`
        );
      }
    });
    
    // Page navigation
    const btnGoPage = document.getElementById('btn-go-page');
    const pageInput = document.getElementById('page-number-input');
    
    btnGoPage?.addEventListener('click', () => {
      goToPage(pageInput.value);
    });
    
    pageInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        goToPage(pageInput.value);
      }
    });

    // Custom page spinner buttons
    document.querySelectorAll('.page-spinner-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = parseInt(pageInput.value) || 1;
        const dir = btn.dataset.dir;
        const newVal = dir === 'up' ? Math.min(val + 1, 604) : Math.max(val - 1, 1);
        pageInput.value = newVal;
        goToPage(newVal);
      });
    });

    // Part navigation
    const btnGoPart = document.getElementById('btn-go-part');
    const partSelect = document.getElementById('part-number-select');
    
    btnGoPart?.addEventListener('click', () => {
      if (partSelect.value) {
        goToPart(partSelect.value);
      }
    });
    
    partSelect?.addEventListener('change', () => {
      if (partSelect.value) {
        goToPart(partSelect.value);
      }
    });
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

    // Reset to page 1
    currentPageNumber = 1;
    pageNumDisplay.textContent = '1';
    prevBtn.disabled = true;
    nextBtn.disabled = false;

    // Create Intersection Observer to track current page
    pageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const pageNum = parseInt(entry.target.dataset.pageNumber);
          if (!isNaN(pageNum)) {
            currentPageNumber = pageNum;
            pageNumDisplay.textContent = pageNum;
            prevBtn.disabled = pageNum <= 1;
            nextBtn.disabled = pageNum >= 604;
          }
        }
      });
    }, {
      rootMargin: '-40% 0px -40% 0px',
      threshold: 0
    });

    // Observe all page sections
    document.querySelectorAll('.page-section').forEach(section => {
      pageObserver.observe(section);
    });

    // Add click handlers
    prevBtn.onclick = () => {
      if (currentPageNumber > 1) {
        scrollToPage(currentPageNumber - 1);
      }
    };

    nextBtn.onclick = () => {
      if (currentPageNumber < 604) {
        scrollToPage(currentPageNumber + 1);
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
    window._swipeNavSetup = true;

    const container = document.getElementById('surah-content-container');
    if (!container) return;

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

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      swipeStartX = touch.clientX;
      swipeStartY = touch.clientY;
      swipeDeltaX = 0;
      isSwiping = false;
      container.classList.remove('swiping', 'snapping-back');
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
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
      if (swipeDeltaX > 20 && currentSurahId > 1) {
        // Swiping right → previous surah
        swipeHintLeft.classList.add('visible');
        swipeHintRight.classList.remove('visible');
      } else if (swipeDeltaX < -20 && currentSurahId < 114) {
        // Swiping left → next surah
        swipeHintRight.classList.add('visible');
        swipeHintLeft.classList.remove('visible');
      } else {
        swipeHintLeft.classList.remove('visible');
        swipeHintRight.classList.remove('visible');
      }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
      if (!isSwiping) return;

      isSwiping = false;
      document.body.classList.remove('swipe-active');
      swipeOverlay.classList.remove('active');
      swipeHintLeft.classList.remove('visible');
      swipeHintRight.classList.remove('visible');

      const absDx = Math.abs(swipeDeltaX);

      if (absDx >= THRESHOLD) {
        // Determine direction: RTL → right = prev, left = next
        const direction = swipeDeltaX > 0 ? 'prev' : 'next';
        const targetId = direction === 'prev' ? currentSurahId - 1 : currentSurahId + 1;

        if (targetId >= 1 && targetId <= 114) {
          // Animate slide out then navigate
          const slideOut = swipeDeltaX > 0 ? 300 : -300;
          container.classList.add('swiping');
          container.classList.remove('snapping-back');
          container.style.transform = `translateX(${slideOut}px)`;
          container.style.opacity = '0.5';

          setTimeout(() => {
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
    }, { passive: true });

    container.addEventListener('touchcancel', () => {
      if (!isSwiping) return;
      isSwiping = false;
      document.body.classList.remove('swipe-active');
      swipeOverlay.classList.remove('active');
      swipeHintLeft.classList.remove('visible');
      swipeHintRight.classList.remove('visible');
      snapBack(container);
    }, { passive: true });
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
    populatePartSelector,
    toggleFixedNav,
    scrollToPage,
    showPageNavButtons,
    hidePageNavButtons
  };
})();
