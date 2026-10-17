/**
 * Mushaf page map — which surahs occupy a given page (1..604).
 *
 * SURAH_START_PAGES lives in data/juz-data.js; SURAH_END_PAGES below is the
 * page of each surah's LAST verse (generated once from the Quran.com chapters
 * API, index 0 = surah 1). Both are monotonic, so a page's surahs are a
 * contiguous run. Unlike data/, this file is source and may be edited.
 */
const SURAH_END_PAGES = [
  1, 49, 76, 106, 127, 150, 176, 186, 207, 221,
  235, 248, 255, 261, 267, 281, 293, 304, 312, 321,
  331, 341, 349, 359, 366, 376, 385, 396, 404, 410,
  414, 417, 427, 434, 440, 445, 452, 458, 467, 476,
  482, 489, 495, 498, 502, 506, 510, 515, 517, 520,
  523, 525, 528, 531, 534, 537, 541, 545, 548, 551,
  552, 554, 555, 557, 559, 561, 564, 566, 568, 570,
  571, 573, 575, 577, 578, 580, 581, 583, 584, 585,
  586, 587, 589, 589, 590, 591, 592, 592, 594, 594,
  595, 596, 596, 596, 597, 597, 598, 599, 599, 600,
  600, 600, 601, 601, 601, 602, 602, 602, 603, 603,
  603, 604, 604, 604
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

  return { SURAH_END_PAGES, surahStartPage, surahEndPage, surahsOnPage, isSharedPage, surahStartsOnPage };
})();
