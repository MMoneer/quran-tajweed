/**
 * Surah Index (Table of Contents) Component
 */
const SurahIndex = (() => {
  let chaptersList = [];

  /**
   * Initialize the Surah index
   */
  async function init() {
    setupSearch();
    await loadChapters();
  }

  /**
   * Load chapters from API or cache, and render
   */
  async function loadChapters() {
    const grid = document.getElementById('surah-grid');
    const loading = document.getElementById('index-loading');
    
    // Show skeleton loaders while loading
    showSkeletons(grid);
    loading.style.display = 'flex';

    try {
      chaptersList = await QuranAPI.getChapters();
      renderChapters(chaptersList);
      loading.style.display = 'none';
    } catch (error) {
      console.error('Failed to load surahs:', error);
      grid.innerHTML = `
        <div class="error-container" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; color: var(--accent); margin-bottom: 12px;"></i>
          <p>عذراً، فشل تحميل قائمة السور. يرجى التحقق من اتصال الإنترنت والمحاولة مجدداً.</p>
          <button id="btn-retry-index" class="btn-action" style="margin: 16px auto 0 auto;">إعادة المحاولة</button>
        </div>
      `;
      loading.style.display = 'none';
      
      document.getElementById('btn-retry-index')?.addEventListener('click', loadChapters);
    }
  }

  /**
   * Render loading skeletons
   * @param {HTMLElement} container Grid element
   */
  function showSkeletons(container) {
    container.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton-card';
      container.appendChild(skeleton);
    }
  }

  /**
   * Render Chapters into grid
   * @param {Array} chapters List of chapters to render
   */
  function renderChapters(chapters) {
    const grid = document.getElementById('surah-grid');
    grid.innerHTML = '';

    if (chapters.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-magnifying-glass" style="font-size: 24px; margin-bottom: 8px;"></i>
          <p>لا توجد نتائج تطابق بحثك.</p>
        </div>
      `;
      return;
    }

    chapters.forEach(surah => {
      const card = document.createElement('div');
      card.className = 'surah-card';
      card.setAttribute('data-id', surah.id);

      const revelationPlaceAr = surah.revelation_place === 'makkah' ? 'مكية' : 'مدنية';
      
      card.innerHTML = `
        <div class="surah-card-right">
          <div class="surah-number"><span>${surah.id}</span></div>
          <div class="surah-meta-info">
            <span class="surah-title-en">${surah.name_simple}</span>
            <span class="surah-sub-en">
              ${surah.translated_name.name}
              <span class="dot"></span>
              ${surah.verses_count} آية
            </span>
          </div>
        </div>
        <div class="surah-card-left">
          <span class="surah-title-ar">${surah.name_arabic}</span>
          <span class="surah-sub-ar">${revelationPlaceAr}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        // Navigate to the surah reader via hash routing
        window.location.hash = `#surah/${surah.id}`;
      });

      grid.appendChild(card);
    });
  }

  /**
   * Set up Search Filter logic
   */
  function setupSearch() {
    const searchInput = document.getElementById('surah-search');
    const btnClear = document.getElementById('clear-search');

    searchInput?.addEventListener('input', (e) => {
      const query = e.target.value.trim().toLowerCase();
      
      // Clear button visibility
      if (btnClear) {
        btnClear.style.display = query.length > 0 ? 'flex' : 'none';
      }

      // Filter chapters list
      const filtered = chaptersList.filter(surah => {
        const idMatch = surah.id.toString() === query;
        const nameSimpleMatch = surah.name_simple.toLowerCase().includes(query);
        const nameArabicMatch = surah.name_arabic.includes(query);
        const translatedMatch = surah.translated_name.name.toLowerCase().includes(query);
        const placeMatch = (surah.revelation_place === 'makkah' ? 'مكية' : 'مدنية').includes(query) || 
                            surah.revelation_place.toLowerCase().includes(query);

        return idMatch || nameSimpleMatch || nameArabicMatch || translatedMatch || placeMatch;
      });

      renderChapters(filtered);
    });

    btnClear?.addEventListener('click', () => {
      searchInput.value = '';
      btnClear.style.display = 'none';
      renderChapters(chaptersList);
      searchInput.focus();
    });
  }

  return {
    init
  };
})();
