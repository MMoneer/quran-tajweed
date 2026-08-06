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
  async function ensureIndexBuilt() {
    const container = document.getElementById('surah-grid');
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

  return {
    normalizeArabic,
    verseNormalizedText,
    loadSurahNameMap,
    ensureIndexBuilt,
    runSearch,
    RECENT_KEY,
    RECENT_MAX,
    HISTORY_SHOW,
    DEBOUNCE_MS
  };
})();
