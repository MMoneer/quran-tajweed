/**
 * Bulk Data Importer — fetches Quran data from API and stores in IndexedDB
 */
const DataImporter = (() => {
  const BASE_URL = 'https://api.quran.com/api/v4';
  let isImporting = false;
  let abortController = null;

  /**
   * Import the chapters list from API and save to DataStore
   * @returns {Promise<Array>}
   */
  async function importChapterList() {
    const resp = await fetch(`${BASE_URL}/chapters`);
    if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
    const data = await resp.json();
    await DataStore.saveChapters(data.chapters);
    return data.chapters;
  }

  /**
   * Fetch one surah with QPC Hafs data (paginated)
   * @param {number} surahId
   * @param {AbortSignal} signal
   * @returns {Promise<Array>} verses
   */
  async function fetchSurahVerses(surahId, signal) {
    const allVerses = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const resp = await fetch(
        `${BASE_URL}/verses/by_chapter/${surahId}?words=true&word_fields=text_qpc_hafs,text_uthmani_tajweed,page_number&page=${page}&per_page=50`,
        { signal }
      );
      if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
      const json = await resp.json();
      allVerses.push(...json.verses);
      totalPages = json.pagination.total_pages;
      page++;
      if (page <= totalPages) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    return allVerses;
  }

  /**
   * Import a single surah with retry logic
   * @param {number} surahId
   * @param {AbortSignal} signal
   * @param {Object} chapterMeta - Chapter metadata from chapters list
   * @returns {Promise<Object>} surah data object
   */
  async function importSingleSurah(surahId, signal, chapterMeta) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const verses = await fetchSurahVerses(surahId, signal);
        const surahData = {
          surah_id: surahId,
          name_arabic: chapterMeta?.name_arabic || '',
          name_english: chapterMeta?.name_english || '',
          bismillah_pre: chapterMeta?.bismillah_pre || false,
          revelation_place: chapterMeta?.revelation_place || '',
          verses_count: verses.length,
          verses,
          page_breaks: computePageBreaks(verses)
        };
        await DataStore.saveSurah(surahData);
        return surahData;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
        console.warn(`Attempt ${attempt + 1} failed for surah ${surahId}:`, err.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    console.error(`Skipping surah ${surahId} after 3 failed attempts:`, lastError.message);
    return null;
  }

  /**
   * Compute page_breaks array from verses (indices where page changes)
   * @param {Array} verses
   * @returns {Array<number>}
   */
  function computePageBreaks(verses) {
    const breaks = [];
    let lastPage = null;
    for (let i = 0; i < verses.length; i++) {
      const word = verses[i]?.words?.find(w => w.char_type_name === 'word');
      const page = word?.page_number || i + 1;
      if (page !== lastPage) {
        breaks.push(i + 1);
        lastPage = page;
      }
    }
    return breaks;
  }

  /**
   * Start the bulk import process
   * @param {Function} onProgress - callback({ current, total, surahId, name })
   * @param {Function} onComplete - callback({ success, failed, skipped })
   * @param {Function} onError - callback(error)
   */
  async function startImport(onProgress, onComplete, onError) {
    if (isImporting) return;
    isImporting = true;
    abortController = new AbortController();
    const signal = abortController.signal;

    let success = 0;
    let failed = 0;

    try {
      const chaptersList = await importChapterList();
      const chaptersMap = {};
      for (const ch of chaptersList) {
        chaptersMap[ch.id] = ch;
      }

      for (let surahId = 1; surahId <= 114; surahId++) {
        if (signal.aborted) break;

        const meta = chaptersMap[surahId];
        onProgress({
          current: surahId,
          total: 114,
          surahId,
          name: meta?.name_arabic || ''
        });

        const result = await importSingleSurah(surahId, signal, meta);
        if (result) {
          success++;
        } else {
          failed++;
        }

        if (surahId < 114 && !signal.aborted) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      if (!signal.aborted) {
        onComplete({ success, failed, skipped: 0 });
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        onError(err);
      }
    } finally {
      isImporting = false;
      abortController = null;
    }
  }

  /**
   * Cancel the ongoing import
   */
  function cancelImport() {
    if (abortController) {
      abortController.abort();
    }
    isImporting = false;
  }

  return {
    startImport,
    cancelImport,
    get isImporting() { return isImporting; }
  };
})();
