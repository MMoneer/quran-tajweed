/**
 * PageIndex — lazy-loaded mushaf page → ayah lookup.
 *
 * The Quran.com API exposes `page_number` per word. From that we derive
 * an ayah-level map: for each (surah, ayah), the page containing that
 * ayah's first word, and for each page, the range of ayahs it contains.
 *
 * This map is built on first call to `build()` by walking all imported
 * surahs through `DataStore.getSurah(id)`. The walk runs once per session
 * and is cached in module scope.
 *
 * Online-only mode (no chapters imported) cannot build the map; in that
 * case `getCached()` returns null and callers should fall back to
 * ayah/surah modes.
 */
const PageIndex = (() => {
  let cached = null;
  let building = null;
  const TOTAL_SURAHS = 114;

  /**
   * Mirrors `dataImporter.computePageBreaks`: take page_number from the
   * first word of each ayah. One entry per ayah in surah order.
   */
  function extractPagePerAyah(verses) {
    const result = [];
    for (let i = 0; i < verses.length; i++) {
      const v = verses[i];
      const word = (v && Array.isArray(v.words))
        ? v.words.find(w => w && w.char_type_name === 'word')
        : null;
      result.push(word ? word.page_number : (i + 1));
    }
    return result;
  }

  /**
   * Build the full map by walking every imported surah. Idempotent:
   * second call returns the same promise.
   */
  async function build() {
    if (cached) return cached;
    if (building) return building;
    const pending = (async () => {
      if (typeof DataStore === 'undefined'
          || typeof DataStore.getSurah !== 'function'
          || typeof DataStore.getImportedSurahIds !== 'function') {
        return null;
      }
      let ids = [];
      try {
        ids = await DataStore.getImportedSurahIds();
      } catch (e) {
        console.warn('PageIndex.build: getImportedSurahIds failed', e);
        return null;
      }
      const ayahToPage = [];
      const surahStartPages = [];
      const pageRanges = new Map();
      let indexedSurahs = 0;
      for (const id of ids) {
        let surahData = null;
        try {
          surahData = await DataStore.getSurah(id);
        } catch (e) {
          continue;
        }
        if (!surahData || !Array.isArray(surahData.verses)) continue;
        indexedSurahs += 1;
        if (typeof PageMap !== 'undefined') PageMap.applyPageFixes(surahData);
        const pagePerAyah = extractPagePerAyah(surahData.verses);
        ayahToPage[id] = pagePerAyah;
        if (pagePerAyah.length > 0) {
          surahStartPages[id] = pagePerAyah[0];
        }
        // Build per-page ranges for this surah.
        let i = 0;
        while (i < pagePerAyah.length) {
          const page = pagePerAyah[i];
          const fromAyah = i + 1;
          let j = i + 1;
          while (j < pagePerAyah.length && pagePerAyah[j] === page) {
            j++;
          }
          const toAyah = j; // last ayah on this page (1-indexed, inclusive)
          const existing = pageRanges.get(page);
          if (!existing) {
            pageRanges.set(page, {
              fromSurah: id,
              fromAyah,
              toSurah: id,
              toAyah,
            });
          } else {
            // Page spans multiple surahs — extend the range forward.
            existing.toSurah = id;
            existing.toAyah = toAyah;
          }
          i = j;
        }
      }
      const result = {
        ayahToPage,
        surahStartPages,
        pageRanges,
      };
      // Memoize only a build that actually indexed at least one surah. An
      // all-empty result (nothing imported yet) must NOT be cached, or
      // page-based planning stays dead for the whole session even after an
      // import adds surahs. Returning it uncached lets the next call retry.
      if (indexedSurahs > 0) {
        cached = result;
      }
      return result;
    })();
    building = pending;
    // Clear the in-flight marker once the build settles, success or failure,
    // so a failed (or all-empty) build never poisons `building`. Handlers are
    // attached after the assignment so a synchronously-settled body cannot
    // clear the marker before it is stored.
    pending.then(
      () => { if (building === pending) building = null; },
      () => { if (building === pending) building = null; }
    );
    return pending;
  }

  function getCached() {
    return cached;
  }

  function reset() {
    cached = null;
    building = null;
  }

  return {
    build,
    getCached,
    reset,
    TOTAL_SURAHS,
  };
})();

if (typeof window !== 'undefined') window.PageIndex = PageIndex;
if (typeof module !== 'undefined' && module.exports) module.exports = PageIndex;