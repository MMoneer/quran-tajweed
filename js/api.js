/**
 * Quran.com API Client with Caching Layer
 */
const QuranAPI = (() => {
  const BASE_URL = 'https://api.quran.com/api/v4';
  const CACHE_PREFIX = 'quran_cache_v1_';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days cache TTL

  /**
   * Helper to fetch data with localStorage cache
   * @param {string} key Cache key suffix
   * @param {string} url Request URL (for paginated: base URL without &page= param)
   * @param {Object} [options] Optional settings
   * @param {boolean} [options.paginate=false] Whether to fetch all pages
   * @param {number} [options.perPage=50] Items per page for paginated requests
   * @param {number} [options.delayMs=0] Delay between paginated requests (ms)
   * @param {function} [options.extractItems] Function to extract items from paginated response
   * @returns {Promise<any>}
   */
  async function fetchWithCache(key, url, options = {}) {
    const cacheKey = `${CACHE_PREFIX}${key}`;
    const cached = localStorage.getItem(cacheKey);

    if (cached) {
      try {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL_MS) {
          return data;
        }
      } catch (e) {
        console.warn('Failed to parse cached data, fetching fresh:', e);
        localStorage.removeItem(cacheKey);
      }
    }

    try {
      let data;

      if (options.paginate) {
        const allItems = [];
        let page = 1;
        let totalPages = 1;
        const perPage = options.perPage || 50;

        while (page <= totalPages) {
          const separator = url.includes('?') ? '&' : '?';
          const resp = await fetch(`${url}${separator}page=${page}&per_page=${perPage}`);
          if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
          const json = await resp.json();
          if (options.extractItems) {
            allItems.push(...options.extractItems(json));
          }
          totalPages = json.pagination?.total_pages || 1;
          page++;
          if (page <= totalPages && options.delayMs > 0) {
            await new Promise(r => setTimeout(r, options.delayMs));
          }
        }
        data = allItems;
      } else {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        data = await response.json();
      }

      localStorage.setItem(cacheKey, JSON.stringify({
        data,
        timestamp: Date.now()
      }));

      return data;
    } catch (error) {
      console.error(`API Fetch Error [${url}]:`, error);
      if (cached) {
        try {
          const { data } = JSON.parse(cached);
          console.warn('Using expired cache as fallback due to network error');
          return data;
        } catch (_) {}
      }
      throw error;
    }
  }

  /**
   * Fetch list of all 114 Surahs — IndexedDB first, then API
   * @returns {Promise<Array>} List of chapters
   */
  async function getChapters() {
    try {
      const idbChapters = await DataStore.getChapters();
      if (idbChapters) return idbChapters;
    } catch (e) {
      console.warn('IndexedDB getChapters failed, falling back to API:', e);
    }
    const data = await fetchWithCache('chapters', `${BASE_URL}/chapters`);
    return data.chapters;
  }

  /**
   * Fetch specific chapter metadata
   * @param {number} id Chapter ID
   * @returns {Promise<Object>} Chapter details
   */
  async function getChapterDetails(id) {
    const data = await fetchWithCache(`chapter_${id}`, `${BASE_URL}/chapters/${id}`);
    return data.chapter;
  }

  /**
   * Fetch all verses for a Surah with Uthmani Tajweed text
   * @param {number} chapterNumber Surah ID
   * @returns {Promise<Array>} List of verses
   */
  async function getSurahTajweed(chapterNumber) {
    const data = await fetchWithCache(
      `tajweed_chapter_${chapterNumber}`,
      `${BASE_URL}/quran/verses/uthmani_tajweed?chapter_number=${chapterNumber}`
    );
    return data.verses;
  }

  /**
   * Fetch all verses for a Surah with per-word QPC Hafs encoding.
   * Uses word-level text_qpc_hafs for proper KFGQPC font glyph mapping.
   * @param {number} chapterNumber Surah ID
   * @returns {Promise<Array>} List of verses with word-level data
   */
  async function getSurahWithQPC(chapterNumber) {
    return fetchWithCache(
      `surah_qpc_${chapterNumber}`,
      `${BASE_URL}/verses/by_chapter/${chapterNumber}?words=true&word_fields=text_qpc_hafs,text_uthmani_tajweed,page_number`,
      {
        paginate: true,
        perPage: 50,
        delayMs: 100,
        extractItems: (json) => json.verses
      }
    );
  }

  /**
   * Clear all cached surah data to free up localStorage space
   */
  function clearLocalCache() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    console.log(`Cleared ${keysToRemove.length} cached items from localStorage`);
  }

  /**
   * Load surah data — IndexedDB first, then fetch from API or legacy script tag.
   * @param {number} surahId Surah ID (1-114)
   * @returns {Promise<Object>} Surah data with verses and page_breaks
   */
  async function getSurahLocal(surahId) {
    // 1. Try IndexedDB first (fastest, works for both modes)
    try {
      const idbSurah = await DataStore.getSurah(surahId);
      if (idbSurah) return idbSurah;
    } catch (e) {
      console.warn(`IndexedDB getSurah(${surahId}) failed:`, e);
    }

    // 2. Online-only mode: fetch from API (saves to IndexedDB for next time)
    if (localStorage.getItem('quran_online_only') === 'true') {
      return fetchSurahOnline(surahId);
    }

    // 3. Fallback: load via <script> tag (legacy bundled data)
    const varName = `_sd_${surahId}`;
    if (window[varName]) {
      return window[varName];
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `data/${surahId}.js`;
      script.onload = () => {
        if (window[varName]) {
          resolve(window[varName]);
        } else {
          reject(new Error(`Variable ${varName} not found after loading script`));
        }
        script.remove();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error(`Failed to load data/${surahId}.js`));
      };
      document.head.appendChild(script);
    });
  }

  /**
   * Fetch surah data from Quran.com API for online-only mode
   * @param {number} surahId
   * @returns {Promise<Object>} Surah data with verses and page_breaks
   */
  async function fetchSurahOnline(surahId) {
    // Fetch chapter metadata and verses in parallel
    const [chapterData, versesData] = await Promise.all([
      fetchWithCache(`chapter_${surahId}`, `${BASE_URL}/chapters/${surahId}`),
      fetchAllVerses(surahId)
    ]);

    const chapterMeta = chapterData.chapter;
    const allVerses = versesData;

    // Compute page_breaks
    const pageBreaks = [];
    let lastPage = null;
    for (let i = 0; i < allVerses.length; i++) {
      const word = allVerses[i]?.words?.find(w => w.char_type_name === 'word');
      const pg = word?.page_number || i + 1;
      if (pg !== lastPage) {
        pageBreaks.push(i + 1);
        lastPage = pg;
      }
    }

    const surahData = {
      surah_id: surahId,
      name_arabic: chapterMeta?.name_arabic || '',
      name_english: chapterMeta?.name_english || '',
      bismillah_pre: chapterMeta?.bismillah_pre || false,
      revelation_place: chapterMeta?.revelation_place || '',
      verses_count: allVerses.length,
      verses: allVerses,
      page_breaks: pageBreaks
    };

    // Save to IndexedDB for faster loads next time (localStorage has 5-10MB limit)
    try {
      await DataStore.saveSurah(surahData);
    } catch (e) {
      console.warn('Failed to save to IndexedDB:', e);
    }

    return surahData;
  }

  /**
   * Fetch all verses for a surah, using max per_page to minimize requests
   * @param {number} surahId
   * @returns {Promise<Array>}
   */
  async function fetchAllVerses(surahId) {
    // Use larger page size to reduce number of requests (API supports up to 200)
    const PER_PAGE = 200;
    const allVerses = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const resp = await fetch(
        `${BASE_URL}/verses/by_chapter/${surahId}?words=true&word_fields=text_qpc_hafs,text_uthmani_tajweed,page_number&page=${page}&per_page=${PER_PAGE}`
      );
      if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
      const json = await resp.json();
      allVerses.push(...json.verses);
      totalPages = json.pagination.total_pages;
      page++;
    }

    return allVerses;
  }

  return {
    getChapters,
    getChapterDetails,
    getSurahTajweed,
    getSurahWithQPC,
    getSurahLocal,
    clearLocalCache
  };
})();
