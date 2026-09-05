/**
 * Single Page Application Routing & Lifecycle Controller
 */
const App = (() => {
  
  /**
   * Initialize App Components and Router
   */
  async function init() {
    // 0. Initialize IndexedDB
    try {
      await DataStore.initDB();
    } catch (e) {
      console.error('IndexedDB initialization failed:', e);
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:2rem;font-family:sans-serif;">
          <div>
            <h2 style="color:#ff4444;">خطأ في قاعدة البيانات</h2>
            <p style="color:#888;margin-top:1rem;">فشل في إعداد قاعدة البيانات المحلية. يرجى تمسح بيانات المتصفح أو استخدام متصفح آخر.</p>
          </div>
        </div>`;
      return;
    }

    // 0b. Register Service Worker for offline app-shell caching
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
          .catch((e) => console.error('SW registration failed:', e));
      });
      // When a new SW activates (skipWaiting + clients.claim), the open page
      // may still be running STALE js from the old cache (static assets are
      // cache-first while navigation is network-first, so index.html can be
      // newer than the scripts it loads). Reload once so HTML and scripts
      // come from the same version.
      let _reloadScheduled = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_reloadScheduled) return;
        _reloadScheduled = true;
        window.location.reload();
      });
    }

    // 1. Check for first-run
    const onlineOnly = localStorage.getItem('quran_online_only') === 'true';
    const hasData = await DataStore.hasData();

    if (!hasData && !onlineOnly) {
      FirstRunWizard.show();
      FirstRunWizard.onImport(startImportAndInit);
      FirstRunWizard.onOnlineOnly(() => {
        localStorage.setItem('quran_online_only', 'true');
        FirstRunWizard.hide();
        continueInit();
      });
      return;
    }

    continueInit();
  }

  /**
   * Start import from wizard, then re-initialize
   */
  function startImportAndInit() {
    FirstRunWizard.showProgress();
    DataImporter.startImport(
      (progress) => {
        FirstRunWizard.updateProgress(progress.current, progress.total, progress.name);
      },
      (result) => {
        FirstRunWizard.hide();
        init();
      },
      (error) => {
        FirstRunWizard.showError(error.message || 'حدث خطأ غير متوقع');
      }
    );
  }

  /**
   * Continue with normal app initialization
   */
  async function continueInit() {
    // 1. Initialize settings & customization values
    SettingsManager.init();

    // 2. Initialize Audio Player
    AudioPlayer.init();

    // 3. Initialize Surah List Index
    SurahIndex.init();

    // 3b. Initialize Memorization view (loads persisted state from IndexedDB,
    //     warms caches). MUST be awaited before setupRouter() so the initial
    //     route handler can call MemorizationView.render() with state loaded.
    if (typeof MemorizationView !== 'undefined') {
      try {
        await MemorizationView.init();
      } catch (e) {
        console.error('MemorizationView.init failed:', e);
      }
    }

    // 4. Setup SPA router
    setupRouter();

    // 5. Setup global/UI event listeners
    setupGlobalEventListeners();
  }

  /**
   * Hash Change SPA Router
   */
  function setupRouter() {
    const handleRoute = () => {
      const hash = window.location.hash;
      const indexSection = document.getElementById('surah-index-section');
      const readerSection = document.getElementById('surah-reader-section');
      const rulesSection = document.getElementById('tajweed-rules-section');
      const memorizationSection = document.getElementById('memorization-section');
      const helpSection = document.getElementById('help-section');

      // Match pattern: #surah/(\d+)
      const surahMatch = hash.match(/^#surah\/(\d+)$/);

      // Reset all sections to inactive first
      indexSection.classList.remove('active');
      readerSection.classList.remove('active');
      rulesSection?.classList.remove('active');
      memorizationSection?.classList.remove('active');
      helpSection?.classList.remove('active');

      if (hash === '#tajweed') {
        // Tajweed rules reference page
        rulesSection?.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'instant' });
        try { SurahViewer.cleanup(); } catch(e) { console.error('cleanup error:', e); }
        if (typeof TajweedRules !== 'undefined') {
          try {
            TajweedRules.render();
          } catch(e) {
            console.error('TajweedRules.render error:', e);
            if (rulesSection) rulesSection.innerHTML = '<div style="padding:2rem;color:red;">Error: ' + e.message + '</div>';
          }
        } else {
          console.error('TajweedRules not loaded');
          if (rulesSection) rulesSection.innerHTML = '<div style="padding:2rem;color:red;">TajweedRules not loaded</div>';
        }
      } else if (hash === '#memorization') {
        memorizationSection?.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'instant' });
        try { SurahViewer.cleanup(); } catch(e) { console.error('cleanup error:', e); }
        if (typeof MemorizationView !== 'undefined') {
          try {
            MemorizationView.render();
          } catch (e) {
            console.error('MemorizationView.render error:', e);
            if (memorizationSection) {
              memorizationSection.innerHTML =
                '<div style="padding:2rem;color:red;">' + (e && e.message ? e.message : 'render error') + '</div>';
            }
          }
        } else {
          console.error('MemorizationView not loaded');
        }
      } else if (hash === '#help') {
        // Help / Instructions page
        helpSection?.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'instant' });
        try { SurahViewer.cleanup(); } catch(e) { console.error('cleanup error:', e); }
      } else if (surahMatch) {
        const surahId = surahMatch[1];
        readerSection.classList.add('active');
        SurahViewer.loadSurah(surahId);
      } else {
        // Default to Surah Index list
        indexSection.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'instant' });
        SurahViewer.cleanup();
        if (typeof QuranSearch !== 'undefined') {
          QuranSearch.restoreIfActive();
        }
      }
    };

    // Listen to hashchange
    window.addEventListener('hashchange', handleRoute);
    
    // Run router on first load
    handleRoute();
  }

  /**
   * General UI elements action listeners
   */
  function setupGlobalEventListeners() {
    // Header button: home navigation on desktop, dropdown toggle on mobile
    const btnMenu = document.getElementById('btn-menu');
    const headerDropdown = document.getElementById('header-dropdown');

    btnMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        // Mobile: toggle dropdown menu
        if (headerDropdown && btnMenu) {
          const rect = btnMenu.getBoundingClientRect();
          headerDropdown.style.top = (rect.bottom + 8) + 'px';
          headerDropdown.style.right = (window.innerWidth - rect.right) + 'px';
        }
        headerDropdown?.classList.toggle('open');
        btnMenu?.setAttribute('aria-expanded', headerDropdown?.classList.contains('open') ? 'true' : 'false');
      } else {
        // Desktop: navigate to home
        const hash = window.location.hash;
        if (hash === '' || hash === '#') {
          if (typeof QuranSearch !== 'undefined') {
            QuranSearch.clearSearch();
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          window.location.hash = '';
        }
      }
    });

    // Close dropdown when clicking outside (mobile only)
    document.addEventListener('click', (e) => {
      if (headerDropdown && !headerDropdown.contains(e.target) && e.target !== btnMenu) {
        headerDropdown.classList.remove('open');
        btnMenu?.setAttribute('aria-expanded', 'false');
      }
    });

    // Close dropdown on Escape key (mobile only)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && headerDropdown?.classList.contains('open')) {
        headerDropdown.classList.remove('open');
        btnMenu?.setAttribute('aria-expanded', 'false');
      }
    });

    // Index/Home button in dropdown (mobile)
    const btnIndex = document.getElementById('btn-index');
    btnIndex?.addEventListener('click', () => {
      headerDropdown?.classList.remove('open');
      const hash = window.location.hash;
      if (hash === '' || hash === '#') {
        if (typeof QuranSearch !== 'undefined') {
          QuranSearch.clearSearch();
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        window.location.hash = '';
      }
    });

    // Settings button in dropdown
    const btnSettingsDropdown = document.getElementById('btn-settings-dropdown');
    btnSettingsDropdown?.addEventListener('click', () => {
      headerDropdown?.classList.remove('open');
      const settingsDrawer = document.getElementById('settings-drawer');
      const drawerOverlay = document.getElementById('drawer-overlay');
      settingsDrawer?.classList.add('open');
      drawerOverlay?.classList.add('visible');
    });

    // Tajweed rules button in dropdown
    const btnTajweedRulesDropdown = document.getElementById('btn-tajweed-rules-dropdown');
    btnTajweedRulesDropdown?.addEventListener('click', () => {
      headerDropdown?.classList.remove('open');
      window.location.hash = '#tajweed';
    });

    // Memorization button in dropdown (mobile)
    const btnMemorizationDropdown = document.getElementById('btn-memorization-dropdown');
    btnMemorizationDropdown?.addEventListener('click', () => {
      headerDropdown?.classList.remove('open');
      window.location.hash = '#memorization';
    });

    // Help button in dropdown
    const btnHelpDropdown = document.getElementById('btn-help-dropdown');
    btnHelpDropdown?.addEventListener('click', () => {
      headerDropdown?.classList.remove('open');
      window.location.hash = '#help';
    });

    // Desktop header icons (always visible on desktop, hidden on mobile via CSS)
    document.getElementById('btn-tajweed-rules')?.addEventListener('click', () => {
      window.location.hash = '#tajweed';
    });
    document.getElementById('btn-memorization')?.addEventListener('click', () => {
      window.location.hash = '#memorization';
    });
    document.getElementById('btn-help')?.addEventListener('click', () => {
      window.location.hash = '#help';
    });

    // Scroll to top button
    const btnScrollTop = document.getElementById('btn-scroll-top');
    btnScrollTop?.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Show/hide scroll to top based on scroll position
    window.addEventListener('scroll', () => {
      if (window.scrollY > 300) {
        btnScrollTop?.classList.add('visible');
      } else {
        btnScrollTop?.classList.remove('visible');
      }
    });
  }

  return {
    init
  };
})();

// Initialize when DOM is fully ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
