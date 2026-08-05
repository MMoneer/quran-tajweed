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
  function continueInit() {
    // 1. Initialize settings & customization values
    SettingsManager.init();

    // 2. Initialize Audio Player
    AudioPlayer.init();

    // 3. Initialize Surah List Index
    SurahIndex.init();

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

      // Match pattern: #surah/(\d+)
      const surahMatch = hash.match(/^#surah\/(\d+)$/);

      // Reset all sections to inactive first
      indexSection.classList.remove('active');
      readerSection.classList.remove('active');
      rulesSection?.classList.remove('active');

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
      } else if (surahMatch) {
        const surahId = surahMatch[1];
        readerSection.classList.add('active');
        SurahViewer.loadSurah(surahId);
      } else {
        // Default to Surah Index list
        indexSection.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'instant' });
        SurahViewer.cleanup();
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
    // Index button in header
    const btnIndex = document.getElementById('btn-index');
    btnIndex?.addEventListener('click', () => {
      window.location.hash = '';
    });

    // Tajweed rules button in header
    const btnTajweedRules = document.getElementById('btn-tajweed-rules');
    btnTajweedRules?.addEventListener('click', () => {
      window.location.hash = '#tajweed';
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
