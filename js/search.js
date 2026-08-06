/**
 * Full-Text Quran Search Module
 * - Diacritic-insensitive matching via normalized text index
 * - Lazy persistent index build (IndexedDB 'search_index' store)
 * - Tajweed-rendered results with word-level highlight
 * - In-session state preservation + recent searches history
 */
const QuranSearch = (() => {
  const RECENT_KEY = 'quran_recent_searches';
  const RECENT_MAX = 8;
  const HISTORY_SHOW = 5;
  const DEBOUNCE_MS = 300;

  // In-session search state (survives navigation, cleared on reload)
  let activeQuery = null;
  let activeResults = [];
  let searchGeneration = 0;
  let surahNameMap = {};
  let indexBuildPromise = null;

  /**
   * Normalize Arabic for search: strip diacritics, normalize letters
   * @param {string} text
   * @returns {string}
   */
  function normalizeArabic(text) {
    return text
      .replace(/[\u064B-\u0658\u0670\u06D6-\u06ED\u06E1]/g, '')
      .replace(/\u0640/g, '')
      .replace(/[أإآٱٲٳ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Compute the normalized index text for one verse
   * @param {Object} verse
   * @returns {string}
   */
  function verseNormalizedText(verse) {
    const words = (verse.words || [])
      .filter(w => w.char_type_name === 'word')
      .map(w => w.text_qpc_hafs || '');
    return normalizeArabic(words.join(' '));
  }

  /**
   * Load the surah name map (id -> name_arabic)
   * @returns {Promise<Object>}
   */
  async function loadSurahNameMap() {
    if (Object.keys(surahNameMap).length > 0) return surahNameMap;
    const chapters = await QuranAPI.getChapters();
    const map = {};
    for (const ch of chapters) map[ch.id] = ch.name_arabic || '';
    surahNameMap = map;
    return map;
  }

  /**
   * Build the search index for any surahs missing one (lazy, incremental)
   * Shows progress in the grid container while building.
   * @returns {Promise<void>}
   */
  function ensureIndexBuilt() {
    if (indexBuildPromise) return indexBuildPromise;
    indexBuildPromise = (async () => {
      const container = document.getElementById('surah-grid');
      if (!container) return;
      const indexed = await DataStore.getIndexedSurahIds();
      const indexedSet = new Set(indexed);
      const missing = [];
      for (let id = 1; id <= 114; id++) {
        if (!indexedSet.has(id)) missing.push(id);
      }
      if (missing.length === 0) return;

      for (let i = 0; i < missing.length; i++) {
        const id = missing[i];
        container.innerHTML = `
          <div class="index-loading" style="grid-column: 1/-1; text-align: center; padding: 40px;">
            <div class="spinner"></div>
            <p>جاري بناء فهرس البحث... ${i + 1}/${missing.length}</p>
          </div>
        `;
        try {
          const surahData = await QuranAPI.getSurahLocal(id);
          if (surahData && surahData.verses) {
            const entries = surahData.verses.map((v, i) => ({
              ayah: i + 1,
              verse_id: v.id,
              normalized: verseNormalizedText(v)
            }));
            await DataStore.saveSearchIndex(id, entries);
          }
        } catch (e) {
          console.warn(`Search index build skipped surah ${id}:`, e.message);
        }
      }
    })();
    indexBuildPromise.finally(() => { indexBuildPromise = null; }).catch(() => {});
    return indexBuildPromise;
  }

  /**
   * Execute a search across the full index
   * @param {string} rawQuery - raw user input (un-normalized)
   * @returns {Promise<Array|null>} results or null if superseded
   */
  async function runSearch(rawQuery) {
    const query = normalizeArabic(rawQuery);
    if (!query) return [];

    const generation = ++searchGeneration;
    await ensureIndexBuilt();

    const records = await DataStore.getSearchIndex();
    if (generation !== searchGeneration) return null;

    const results = [];
    for (const record of records) {
      for (const entry of record.entries) {
        if (entry.normalized.includes(query)) {
          results.push({
            surah_id: record.surah_id,
            ayah: entry.ayah,
            verse_id: entry.verse_id,
            normalized: entry.normalized
          });
        }
      }
    }
    results.sort((a, b) => a.surah_id - b.surah_id || a.ayah - b.ayah);
    return results;
  }

  /**
   * Find which word indices in a normalized ayah text contain the match range
   * @param {string} normalized - full normalized ayah text (words joined by single spaces)
   * @param {string} query - normalized query
   * @returns {Set<number>} word indices (0-based, over 'word' char_type words)
   */
  function findMatchedWordIndices(normalized, query) {
    const matches = new Set();
    const startIdx = normalized.indexOf(query);
    if (startIdx === -1) return matches;
    const endIdx = startIdx + query.length - 1;

    let pos = 0;
    const wordCount = normalized.split(' ').length;
    for (let i = 0; i < wordCount; i++) {
      const spaceIdx = normalized.indexOf(' ', pos);
      const wordEnd = (spaceIdx === -1 ? normalized.length : spaceIdx) - 1;
      if (pos <= endIdx && wordEnd >= startIdx) matches.add(i);
      pos = spaceIdx === -1 ? normalized.length : spaceIdx + 1;
    }
    return matches;
  }

  /**
   * Convert a number to Arabic-Indic digits
   * @param {number|string} num
   * @returns {string}
   */
  function toArabicIndic(num) {
    return String(num).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
  }

  /**
   * Build one result row's HTML string
   * @param {Object} result - { surah_id, ayah, verse_id, normalized }
   * @param {string} query - normalized query
   * @param {Object} nameMap - surah_id -> name_arabic
   * @returns {Promise<string>}
   */
  async function buildResultRow(result, query, nameMap) {
    const surahData = await QuranAPI.getSurahLocal(result.surah_id);
    const verse = surahData?.verses?.[result.ayah - 1];
    const nameAr = nameMap[result.surah_id] || `سورة ${result.surah_id}`;

    let ayahHtml = '';
    if (verse && verse.words) {
      const matchedIndices = findMatchedWordIndices(result.normalized, query);
      let wordIdx = 0;
      for (const word of verse.words) {
        if (word.char_type_name === 'word') {
          const wHtml = PageRenderer.buildWordHTML(word);
          ayahHtml += matchedIndices.has(wordIdx)
            ? `<mark class="search-highlight">${wHtml}</mark>`
            : wHtml;
          ayahHtml += '\u200C ';
          wordIdx++;
        } else if (word.char_type_name === 'end') {
          ayahHtml += PageRenderer.buildWordHTML(word);
        }
      }
    }
    ayahHtml = PageRenderer.wrapNormalMadd(ayahHtml);

    return `
      <div class="search-result-item" data-surah="${result.surah_id}" data-verse-id="${result.verse_id}" data-ayah="${result.ayah}">
        <div class="result-label">${nameAr} / الآية ${toArabicIndic(result.ayah)}</div>
        <div class="result-ayah" dir="rtl">${ayahHtml}</div>
      </div>
    `;
  }

  /**
   * Render a list of results into the surah-grid container
   * Renders first CHUNK rows, then appends via "عرض المزيد" button.
   * @param {Array} results
   * @param {string} rawQuery
   */
  async function renderResults(results, rawQuery) {
    const renderGeneration = searchGeneration;
    const container = document.getElementById('surah-grid');
    const query = normalizeArabic(rawQuery);
    const nameMap = await loadSurahNameMap();

    if (results.length === 0) {
      if (renderGeneration !== searchGeneration) return;
      container.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-magnifying-glass" style="font-size: 24px; margin-bottom: 8px;"></i>
          <p>لا توجد نتائج تطابق بحثك.</p>
        </div>
      `;
      return;
    }

    const CHUNK = 200;
    const total = results.length;
    let index = 0;
    let html = `
      <div class="search-results-info">
        <i class="fa-solid fa-magnifying-glass"></i>
        <span>عدد النتائج: ${toArabicIndic(total)}</span>
      </div>
    `;

    async function renderNextChunk() {
      const end = Math.min(index + CHUNK, total);
      for (let i = index; i < end; i++) {
        html += await buildResultRow(results[i], query, nameMap);
      }
      index = end;

      let loadMore = '';
      if (index < total) {
        loadMore = `
          <div style="grid-column: 1/-1; text-align: center; padding: 16px;">
            <button id="btn-load-more-results" class="btn-action">عرض المزيد من النتائج (${toArabicIndic(total - index)})</button>
          </div>
        `;
      }
      if (renderGeneration !== searchGeneration) return;
      container.innerHTML = html + loadMore;
      wireResultClick(container);

      const btn = document.getElementById('btn-load-more-results');
      if (btn) {
        btn.addEventListener('click', () => {
          btn.remove();
          renderNextChunk();
        });
      }
    }

    await renderNextChunk();
  }

  /**
   * Wire click handlers on result rows
   * @param {HTMLElement} container
   */
  function wireResultClick(container) {
    container.querySelectorAll('.search-result-item').forEach(item => {
      if (item.dataset.bound) return;
      item.dataset.bound = '1';
      item.addEventListener('click', () => {
        const surahId = item.dataset.surah;
        const ayah = item.dataset.ayah;
        window._pendingAyahScroll = parseInt(ayah, 10);
        window.location.hash = `#surah/${surahId}`;
      });
    });
  }

  /**
   * Get recent searches from localStorage (most-recent-first)
   * @returns {string[]}
   */
  function getRecentSearches() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn('Failed to parse recent searches:', e);
      return [];
    }
  }

  /**
   * Persist recent searches (capped, deduped)
   * @param {string[]} arr
   */
  function saveRecentSearches(arr) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(arr.slice(0, RECENT_MAX)));
  }

  /**
   * Record a query after a search runs
   * @param {string} query
   */
  function addRecentSearch(query) {
    const q = query.trim();
    if (!q) return;
    const arr = getRecentSearches().filter(x => x !== q);
    arr.unshift(q);
    saveRecentSearches(arr);
  }

  /**
   * Remove a single recent search
   * @param {string} query
   */
  function removeRecentSearch(query) {
    saveRecentSearches(getRecentSearches().filter(x => x !== query));
  }

  /**
   * Clear all recent searches
   */
  function clearRecentSearches() {
    saveRecentSearches([]);
  }

  /**
   * Create the recent-searches dropdown element (lazy, once)
   * @returns {HTMLElement}
   */
  function getDropdown() {
    let dropdown = document.getElementById('recent-searches-dropdown');
    if (dropdown) return dropdown;

    dropdown = document.createElement('div');
    dropdown.className = 'recent-searches-dropdown';
    dropdown.id = 'recent-searches-dropdown';
    dropdown.hidden = true;
    document.querySelector('.search-wrapper').appendChild(dropdown);
    return dropdown;
  }

  /**
   * Render dropdown contents for the given searches list
   * @param {HTMLElement} dropdown
   * @param {string[]} searches
   */
  function renderDropdown(dropdown, searches) {
    const items = searches
      .map(q => `
        <div class="recent-search-item">
          <button type="button" class="recent-search-query">
            <i class="fa-solid fa-clock-rotate-left"></i>
            <span>${q}</span>
          </button>
          <button type="button" class="recent-search-remove" data-q="${q}" title="حذف">✕</button>
        </div>
      `).join('');

    dropdown.innerHTML = `
      <div class="recent-header">البحث الأخير</div>
      ${items || '<div class="recent-empty">لا يوجد بحث سابق</div>'}
      <button type="button" id="btn-clear-recent" class="recent-clear-all">
        <i class="fa-solid fa-trash-can"></i> مسح السجل
      </button>
    `;

    dropdown.querySelectorAll('.recent-search-query').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.querySelector('span').textContent;
        document.getElementById('surah-search').value = q;
        dropdown.hidden = true;
        QuranSearch.execute(q);
      });
    });

    dropdown.querySelectorAll('.recent-search-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeRecentSearch(btn.dataset.q);
        refreshDropdown();
      });
    });

    const btnClear = document.getElementById('btn-clear-recent');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        clearRecentSearches();
        refreshDropdown();
      });
    }
  }

  /**
   * Show the dropdown if the input is empty and there is history
   */
  function showDropdown() {
    const input = document.getElementById('surah-search');
    const dropdown = getDropdown();
    const searches = getRecentSearches().slice(0, HISTORY_SHOW);
    if (!input.value.trim() && searches.length > 0) {
      renderDropdown(dropdown, searches);
      dropdown.hidden = false;
    } else {
      dropdown.hidden = true;
    }
  }

  /**
   * Refresh dropdown contents after history changes
   */
  function refreshDropdown() {
    const dropdown = document.getElementById('recent-searches-dropdown');
    if (!dropdown || dropdown.hidden) return;
    const searches = getRecentSearches().slice(0, HISTORY_SHOW);
    if (searches.length === 0) {
      dropdown.hidden = true;
      return;
    }
    renderDropdown(dropdown, searches);
  }

  /**
   * Public entry point: run a search, persist state + history
   * @param {string} rawQuery
   */
  async function execute(rawQuery) {
    const query = rawQuery.trim();
    const input = document.getElementById('surah-search');
    const btnClear = document.getElementById('clear-search');
    if (input) input.value = query;
    if (btnClear) btnClear.style.display = query ? 'flex' : 'none';

    if (!normalizeArabic(query)) {
      showGrid();
      return;
    }

    const results = await runSearch(query);
    if (results === null) return;

    activeQuery = query;
    activeResults = results;
    addRecentSearch(query);
    renderResults(results, query);
  }

  /**
   * Render the full surah grid (delegates to SurahIndex) and clear search state
   */
  function showGrid() {
    activeQuery = null;
    activeResults = [];
    if (typeof SurahIndex !== 'undefined') {
      SurahIndex.showGrid();
    }
  }

  /**
   * Clear the active search: reset input, hide dropdown, show grid
   */
  function clearSearch() {
    activeQuery = null;
    activeResults = [];
    const input = document.getElementById('surah-search');
    const btnClear = document.getElementById('clear-search');
    if (input) input.value = '';
    if (btnClear) btnClear.style.display = 'none';
    const dropdown = document.getElementById('recent-searches-dropdown');
    if (dropdown) dropdown.hidden = true;
    if (typeof SurahIndex !== 'undefined') {
      SurahIndex.showGrid();
    }
  }

  /**
   * Restore the active search on return to the index view
   */
  function restoreIfActive() {
    if (!activeQuery) return;
    const input = document.getElementById('surah-search');
    const btnClear = document.getElementById('clear-search');
    if (input) input.value = activeQuery;
    if (btnClear) btnClear.style.display = 'flex';
    renderResults(activeResults, activeQuery);
  }

  /**
   * Set up the search input, clear button, and dropdown listeners
   */
  function setup() {
    const input = document.getElementById('surah-search');
    const btnClear = document.getElementById('clear-search');
    if (!input) return;

    let debounceTimer;

    input.addEventListener('input', () => {
      const query = input.value.trim();
      if (btnClear) btnClear.style.display = query ? 'flex' : 'none';
      clearTimeout(debounceTimer);

      const dropdown = document.getElementById('recent-searches-dropdown');
      if (dropdown) dropdown.hidden = true;

      if (!query) {
        showGrid();
        return;
      }
      debounceTimer = setTimeout(() => execute(query), DEBOUNCE_MS);
    });

    input.addEventListener('focus', showDropdown);

    input.addEventListener('blur', () => {
      setTimeout(() => {
        const dropdown = document.getElementById('recent-searches-dropdown');
        if (dropdown) dropdown.hidden = true;
      }, 150);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(debounceTimer);
        execute(input.value.trim());
      }
      if (e.key === 'Escape') {
        const dropdown = document.getElementById('recent-searches-dropdown');
        if (dropdown) dropdown.hidden = true;
      }
    });

    btnClear?.addEventListener('click', () => {
      input.value = '';
      clearSearch();
      input.focus();
      showDropdown();
    });
  }

  return {
    normalizeArabic,
    verseNormalizedText,
    loadSurahNameMap,
    ensureIndexBuilt,
    runSearch,
    findMatchedWordIndices,
    toArabicIndic,
    buildResultRow,
    renderResults,
    getRecentSearches,
    addRecentSearch,
    removeRecentSearch,
    clearRecentSearches,
    showDropdown,
    refreshDropdown,
    execute,
    showGrid,
    clearSearch,
    restoreIfActive,
    setup,
    RECENT_KEY,
    RECENT_MAX,
    HISTORY_SHOW,
    DEBOUNCE_MS
  };
})();
