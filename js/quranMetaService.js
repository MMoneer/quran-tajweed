/**
 * QuranMetaService — static Quran structure metadata.
 *
 * Holds the canonical ayah count for each of the 114 surahs and offers
 * pure helpers for:
 *   - position validation
 *   - computing the next ayah position
 *   - building memorization ranges that cross surah boundaries safely
 *
 * This service deliberately contains NO memorization state and NO UI
 * concerns. It is a pure, easily-testable value module.
 */
const QuranMetaService = (() => {
  // 1-indexed surah → ayah count.
  // Slot 0 is unused (kept so `ayahCounts[s]` reads naturally as "surah s").
  // Total = 6,236 ayahs.
  const ayahCounts = [
    0,
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
    123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
    112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
    34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
    54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
    60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
    14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
    28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
    29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
    15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
    11, 8, 3, 9, 5, 4, 7, 3, 6, 3,
    5, 4, 5, 6
  ];

  const TOTAL_SURAHS = 114;
  const LAST_AYAHS = 6; // Last surah (An-Nas) has 6 ayahs.
  const TOTAL_PAGES = 604; // Standard mushaf page count.

  function isValidSurah(surah) {
    return Number.isInteger(surah) && surah >= 1 && surah <= TOTAL_SURAHS;
  }

  function isValidAyah(surah, ayah) {
    return isValidSurah(surah) && Number.isInteger(ayah) && ayah >= 1 && ayah <= ayahCounts[surah];
  }

  /**
   * Number of ayahs in `surah`. Returns 0 for unknown surahs.
   * @param {number} surah 1..114
   * @returns {number}
   */
  function getSurahAyahCount(surah) {
    return isValidSurah(surah) ? ayahCounts[surah] : 0;
  }

  /**
   * Return the 1-based mushaf page (1..604) containing the given ayah.
   * Uses PageIndex (built from imported surah verses' word-level
   * page_number) when available — that gives the canonical mushaf
   * mapping. Returns null if PageIndex is unavailable or the surah is
   * not yet indexed.
   * @returns {number|null}
   */
  function getPageOf(surah, ayah) {
    if (!isValidAyah(surah, ayah)) return null;
    const cached = (typeof PageIndex !== 'undefined') ? PageIndex.getCached() : null;
    if (cached && cached.ayahToPage[surah] && cached.ayahToPage[surah][ayah - 1] !== undefined) {
      return cached.ayahToPage[surah][ayah - 1];
    }
    return null;
  }

  /**
   * Validate that `(surah, ayah)` is a real Quran position.
   * @returns {boolean}
   */
  function validatePosition(surah, ayah) {
    return isValidAyah(surah, ayah);
  }

  /**
   * Return the position of the next ayah after `(surah, ayah)`.
   * Returns `null` once 114:6 (the very last ayah) has been passed.
   * @param {number} surah
   * @param {number} ayah
   * @returns {{surah:number, ayah:number}|null}
   */
  function getNextPosition(surah, ayah) {
    if (!isValidAyah(surah, ayah)) return null;
    if (surah === TOTAL_SURAHS && ayah === LAST_AYAHS) return null;
    if (ayah < ayahCounts[surah]) {
      return { surah, ayah: ayah + 1 };
    }
    return { surah: surah + 1, ayah: 1 };
  }

  /**
   * Build a memorization range starting at `(startSurah, startAyah)` and
   * spanning exactly `amount` ayahs. Handles:
   *   - normal in-surah ranges
   *   - ranges that cross a surah boundary (e.g. 2:284 + 3 → 2:284..2:286)
   *   - ranges that span multiple short surahs at the end of the Quran
   *   - end-of-Quran detection: when the range reaches 114:6, the
   *     result carries `isCompleted: true`.
   *
   * Returns `null` if `startSurah:startAyah` is invalid (never an invalid
   * position is generated). If `amount <= 0`, returns an empty range
   * anchored at the start with `count: 0` and `isCompleted: false`.
   *
   * @param {number} startSurah
   * @param {number} startAyah
   * @param {number} amount
   * @returns {{
   *   fromSurah:number, fromAyah:number,
   *   toSurah:number, toAyah:number,
   *   count:number, isCompleted:boolean
   * }|null}
   */
  function calculateNextAyahRange(startSurah, startAyah, amount) {
    if (!isValidAyah(startSurah, startAyah)) return null;

    const fromSurah = startSurah;
    const fromAyah = startAyah;
    let remaining = Math.max(0, Math.trunc(amount));

    let curSurah = startSurah;
    let curAyah = startAyah;
    let toSurah = startSurah;
    let toAyah = startAyah;
    let taken = 0;
    let reachedEnd = false;

    while (remaining > 0) {
      if (curSurah > TOTAL_SURAHS) {
        // Walked past the end of the Quran — stop cleanly.
        reachedEnd = true;
        // Step back so toSurah/toAyah represent the last valid ayah.
        curSurah = TOTAL_SURAHS;
        curAyah = LAST_AYAHS;
        toSurah = curSurah;
        toAyah = curAyah;
        break;
      }
      const surahMax = ayahCounts[curSurah];
      const room = surahMax - curAyah + 1;
      if (remaining <= room) {
        toAyah = curAyah + remaining - 1;
        toSurah = curSurah;
        taken += remaining;
        remaining = 0;
        if (toSurah === TOTAL_SURAHS && toAyah === LAST_AYAHS) {
          reachedEnd = true;
        }
        break;
      }
      // Consume the rest of this surah and roll into the next.
      taken += room;
      remaining -= room;
      curSurah += 1;
      curAyah = 1;
      // If we just consumed the last ayah of the Quran, we are done even
      // if the caller asked for more.
      if (curSurah - 1 === TOTAL_SURAHS && curAyah === 1
          && toSurah === TOTAL_SURAHS && toAyah === LAST_AYAHS) {
        reachedEnd = true;
        break;
      }
      toSurah = curSurah;
      toAyah = 1;
    }

    return {
      fromSurah,
      fromAyah,
      toSurah,
      toAyah,
      count: taken,
      isCompleted: reachedEnd,
    };
  }

  /**
   * Build a memorization range covering the remainder of the current
   * surah, starting at (startSurah, startAyah). Sets isCompleted iff the
   * range reaches 114:6.
   * @returns {{fromSurah:number, fromAyah:number, toSurah:number, toAyah:number, count:number, isCompleted:boolean}|null}
   */
  function calculateNextSurahRange(startSurah, startAyah) {
    if (!isValidAyah(startSurah, startAyah)) return null;
    const total = ayahCounts[startSurah];
    const fromSurah = startSurah;
    const fromAyah = startAyah;
    const toSurah = startSurah;
    const toAyah = total;
    const count = total - startAyah + 1;
    const isCompleted = (startSurah === TOTAL_SURAHS && startAyah === total);
    return {
      fromSurah,
      fromAyah,
      toSurah,
      toAyah,
      count,
      isCompleted,
    };
  }

  /**
   * Build a memorization range covering exactly one mushaf page starting
   * at `startPage` (1..604). Looks up the page's ayah range in PageIndex.
   * Returns null if PageIndex is unavailable.
   *
   * v1 (deprecated): used a `/15 ayahs per page` approximation that was
   * inaccurate for surahs with variable page density.
   *
   * @returns {{fromSurah:number, fromAyah:number, toSurah:number, toAyah:number, count:number, isCompleted:boolean}|null}
   */
  function calculateNextPageRange(startPage) {
    if (!Number.isInteger(startPage) || startPage < 1 || startPage > TOTAL_PAGES) {
      return null;
    }
    const cached = (typeof PageIndex !== 'undefined') ? PageIndex.getCached() : null;
    if (!cached || !cached.pageRanges.has(startPage)) return null;
    const r = cached.pageRanges.get(startPage);
    const isCompleted = (r.toSurah === TOTAL_SURAHS && r.toAyah === LAST_AYAHS);
    return {
      fromSurah: r.fromSurah,
      fromAyah: r.fromAyah,
      toSurah: r.toSurah,
      toAyah: r.toAyah,
      count: countAyahs(r.fromSurah, r.fromAyah, r.toSurah, r.toAyah),
      isCompleted,
    };
  }

  // Local helper: count ayahs from (a,b) to (c,d) by walking forward.
  function countAyahs(fromSurah, fromAyah, toSurah, toAyah) {
    if (fromSurah === toSurah) return toAyah - fromAyah + 1;
    let n = ayahCounts[fromSurah] - fromAyah + 1;
    for (let s = fromSurah + 1; s < toSurah; s++) {
      n += ayahCounts[s];
    }
    n += toAyah;
    return n;
  }

  return {
    TOTAL_SURAHS,
    LAST_AYAHS,
    TOTAL_PAGES,
    getSurahAyahCount,
    validatePosition,
    getNextPosition,
    calculateNextAyahRange,
    calculateNextSurahRange,
    calculateNextPageRange,
    getPageOf,
  };
})();

if (typeof window !== 'undefined') {
  window.QuranMetaService = QuranMetaService;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QuranMetaService;
}