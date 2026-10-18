/**
 * Mushaf page map — which surahs occupy a given page (1..604).
 *
 * SURAH_START_PAGES lives in data/juz-data.js; SURAH_END_PAGES below is the
 * page of each surah's LAST verse (generated from the Quran.com chapters API,
 * then corrected against the QDC page layout, index 0 = surah 1). Both are
 * monotonic, so a page's surahs are a contiguous run. Unlike data/, this file
 * is source and may be edited.
 */
const SURAH_END_PAGES = [
  1, 49, 76, 106, 127, 150, 176, 186, 207, 221,
  235, 248, 255, 261, 267, 281, 293, 304, 312, 321,
  331, 341, 349, 359, 366, 376, 385, 396, 404, 410,
  414, 417, 427, 434, 440, 445, 452, 458, 467, 476,
  482, 489, 495, 498, 502, 506, 510, 515, 517, 520,
  523, 525, 528, 531, 534, 537, 541, 545, 548, 551,
  552, 554, 555, 557, 559, 561, 564, 566, 568, 570,
  571, 573, 575, 577, 578, 580, 581, 583, 584, 586,
  586, 587, 589, 590, 590, 591, 592, 593, 594, 595,
  595, 596, 596, 597, 597, 598, 598, 599, 599, 600,
  600, 600, 601, 601, 601, 602, 602, 602, 603, 603,
  603, 604, 604, 604
];

/**
 * Page corrections for the Quran.com v4 API.
 *
 * `/verses/by_chapter` (v4) reports a page_number that disagrees with the
 * actual mushaf layout for these 56 ayahs. The QDC endpoint used by
 * quran.com's reader — and quran.com/page/N — has the correct values.
 * Uncorrected, rebuilt boundary pages drop the previous surah's tail
 * (e.g. 80:41-42 on page 586, before At-Takwir).
 *
 * Entries: [surahId, fromAyah, toAyah, correctPage].
 */
const AYAH_PAGE_FIXES = [
  [5, 77, 77, 120], [5, 83, 83, 121], [5, 90, 90, 122],
  [6, 131, 131, 145],
  [55, 17, 18, 531], [55, 41, 41, 532], [55, 68, 69, 533],
  [68, 16, 16, 564], [69, 35, 35, 567], [70, 40, 40, 569],
  [74, 18, 18, 575], [79, 16, 16, 583],
  [80, 41, 42, 586],
  [83, 5, 6, 588], [83, 34, 34, 589],
  [84, 25, 25, 590],
  [87, 11, 15, 592],
  [88, 23, 26, 593],
  [89, 23, 23, 594],
  [90, 19, 20, 595],
  [92, 10, 14, 596],
  [94, 3, 8, 597],
  [96, 13, 19, 598],
  [98, 6, 7, 599],
  [100, 6, 9, 600]
];

const PageMap = (() => {
  const start = (i) => SURAH_START_PAGES[i];
  const end = (i) => SURAH_END_PAGES[i];

  /**
   * First and last page of a surah (1-based surah id).
   */
  function surahStartPage(surahId) { return start(surahId - 1); }
  function surahEndPage(surahId) { return end(surahId - 1); }

  /**
   * All surahs (ids, ascending) that have verses on `page`.
   */
  function surahsOnPage(page) {
    const ids = [];
    for (let i = 0; i < SURAH_START_PAGES.length; i++) {
      if (start(i) <= page && page <= end(i)) ids.push(i + 1);
    }
    return ids;
  }

  /**
   * True when more than one surah shares `page` (a mushaf boundary page).
   */
  function isSharedPage(page) {
    return surahsOnPage(page).length > 1;
  }

  /**
   * True when `surahId` begins on `page` (its title belongs inline there).
   */
  function surahStartsOnPage(surahId, page) {
    return surahStartPage(surahId) === page;
  }

  /**
   * Correct the page of one ayah when the API value is known to be wrong.
   * Returns `page` unchanged for every ayah outside the correction table.
   */
  function correctAyahPage(surahId, ayah, page) {
    const sid = parseInt(surahId);
    const num = parseInt(ayah);
    for (const [s, from, to, fixed] of AYAH_PAGE_FIXES) {
      if (s === sid && num >= from && num <= to) return fixed;
    }
    return page;
  }

  /**
   * Mirror of the importers' page-break computation, run on corrected
   * page numbers.
   */
  function pageBreaksFromVerses(verses) {
    const breaks = [];
    let lastPage = null;
    for (let i = 0; i < verses.length; i++) {
      const word = verses[i]?.words?.find(w => w && w.char_type_name === 'word');
      const page = word ? word.page_number : i + 1;
      if (page !== lastPage) {
        breaks.push(i + 1);
        lastPage = page;
      }
    }
    return breaks;
  }

  /**
   * Apply AYAH_PAGE_FIXES to a loaded surah in place: update the affected
   * verses' word/verse page numbers and recompute `page_breaks`. Idempotent,
   * so it is safe on already-corrected or cached data.
   */
  function applyPageFixes(surahData) {
    if (!surahData || !Array.isArray(surahData.verses)) return surahData;
    const sid = surahData.surah_id;
    let changed = false;
    for (const verse of surahData.verses) {
      if (!verse || !Array.isArray(verse.words)) continue;
      const firstWord = verse.words.find(w => w && w.char_type_name === 'word');
      if (!firstWord) continue;
      const ayah = verse.verse_number
        || parseInt(String(verse.verse_key || '').split(':')[1])
        || 0;
      const fixed = correctAyahPage(sid, ayah, firstWord.page_number);
      if (fixed === firstWord.page_number) continue;
      for (const word of verse.words) {
        if (word) word.page_number = fixed;
      }
      verse.page_number = fixed;
      changed = true;
    }
    if (changed) surahData.page_breaks = pageBreaksFromVerses(surahData.verses);
    return surahData;
  }

  return {
    SURAH_END_PAGES,
    surahStartPage,
    surahEndPage,
    surahsOnPage,
    isSharedPage,
    surahStartsOnPage,
    correctAyahPage,
    applyPageFixes
  };
})();
