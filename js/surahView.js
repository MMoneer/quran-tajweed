/**
 * Surah Reader / Viewer Component
 */
const SurahViewer = (() => {
  let currentSurahId = null;
  let currentSurahVerses = [];
  let currentSurahData = null;
  let loadGeneration = 0;

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
      
      // Update nav buttons states
      updateNavigationControls();
      
      // Setup navigation listeners
      setupNavigationListeners();
      
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
    AudioPlayer.stop();
    currentSurahVerses = [];
    document.getElementById('tajweed-legend').classList.remove('visible');
    document.getElementById('tajweed-legend').classList.remove('collapsed');
    document.getElementById('header-surah-info').innerHTML = '';
    const readerCard = document.querySelector('.surah-viewer-card');
    if (readerCard) readerCard.style.paddingBottom = '';
    toggleFixedNav(false);
  }

  /**
    * Setup event listeners for page/part navigation (once only)
    */
  function setupNavigationListeners() {
    if (window._surahNavListenersSetup) return;
    window._surahNavListenersSetup = true;

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

    // Verse click → select verse + show play popup
    document.addEventListener('click', (e) => {
      const verse = e.target.closest('.verse');
      if (!verse) return;

      // Remove existing popup if any
      const existingPopup = document.querySelector('.verse-play-popup');
      if (existingPopup) existingPopup.remove();

      // Check if click was on the popup itself
      if (e.target.closest('.verse-play-popup')) return;

      const ayahId = parseInt(verse.dataset.ayah);
      if (isNaN(ayahId)) return;

      // Select this verse visually
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
        const text = VerseClipboard.buildCopyText([ayahId], currentSurahVerses, currentSurahData?.name_arabic || '');
        const ok = await VerseClipboard.copyToClipboard(text);
        if (ok) VerseClipboard.showToast('تم نسخ الآية');
        else VerseClipboard.showToast('تعذّر النسخ', 'error');
      });

      // Auto-remove popup after 5 seconds
      setTimeout(() => {
        if (popup.parentNode) popup.remove();
      }, 5000);
    });

    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.verse') && !e.target.closest('.verse-play-popup')) {
        const popup = document.querySelector('.verse-play-popup');
        if (popup) popup.remove();
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

  return {
    loadSurah,
    cleanup,
    setupNavigationListeners,
    populatePartSelector,
    toggleFixedNav,
    scrollToPage
  };
})();
