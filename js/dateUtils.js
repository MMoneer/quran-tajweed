/**
 * DateUtils — local-calendar date helpers.
 *
 * All user-facing dates in the memorization system MUST use the user's local
 * calendar date. Never derive "today" via `new Date().toISOString().split('T')[0]`,
 * because that converts to UTC and can silently shift the calendar date near
 * midnight for users in non-UTC timezones.
 *
 * Every public function expects (and returns) dates in the canonical
 * `"YYYY-MM-DD"` form, built from the local components of a `Date` instance.
 */
const DateUtils = (() => {
  /**
   * Pad a number to a zero-padded 2-digit string.
   * @param {number} n
   * @returns {string}
   */
  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /**
   * Format a `Date` (or `date-like`) as `"YYYY-MM-DD"` using local components.
   * @param {Date} [date] Defaults to `new Date()`.
   * @returns {string}
   */
  function getLocalDateString(date = new Date()) {
    return date.getFullYear()
      + '-' + pad2(date.getMonth() + 1)
      + '-' + pad2(date.getDate());
  }

  /**
   * Parse a `"YYYY-MM-DD"` string into a `Date` at local midnight.
   * Throws for malformed input so callers fail loudly rather than silently
   * producing wrong calendar dates.
   * @param {string} dateString `"YYYY-MM-DD"`
   * @returns {Date}
   */
  function parseLocalDateString(dateString) {
    if (typeof dateString !== 'string') {
      throw new Error('DateUtils: dateString must be a string, got ' + typeof dateString);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!m) {
      throw new Error('DateUtils: invalid dateString "' + dateString + '" (expected YYYY-MM-DD)');
    }
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return new Date(y, mo - 1, d);
  }

  /**
   * Add `days` (may be negative or fractional) to a `"YYYY-MM-DD"` string.
   * Fractional `days` are floored to whole-day offsets to keep the canonical
   * day-string contract intact.
   * @param {string} dateString `"YYYY-MM-DD"`
   * @param {number} days
   * @returns {string}
   */
  function addDays(dateString, days) {
    const base = parseLocalDateString(dateString);
    const offset = Math.trunc(days);
    base.setDate(base.getDate() + offset);
    return getLocalDateString(base);
  }

  /**
   * Integer day distance from `date1` to `date2`, computed in local calendar
   * days (not 24h epochs). Positive when `date2` is after `date1`.
   * @param {string} date1 `"YYYY-MM-DD"`
   * @param {string} date2 `"YYYY-MM-DD"`
   * @returns {number}
   */
  function daysBetween(date1, date2) {
    const a = parseLocalDateString(date1);
    const b = parseLocalDateString(date2);
    const ms = b.getTime() - a.getTime();
    return Math.round(ms / 86400000);
  }

  /**
   * True iff the given `"YYYY-MM-DD"` is today (local calendar).
   * @param {string} dateString
   * @returns {boolean}
   */
  function isToday(dateString) {
    return dateString === getLocalDateString(new Date());
  }

  /**
   * True iff the given `"YYYY-MM-DD"` is yesterday (local calendar).
   * @param {string} dateString
   * @returns {boolean}
   */
  function isYesterday(dateString) {
    return dateString === addDays(getLocalDateString(new Date()), -1);
  }

  return {
    getLocalDateString,
    addDays,
    daysBetween,
    isToday,
    isYesterday,
    parseLocalDateString,
  };
})();

if (typeof window !== 'undefined') {
  window.DateUtils = DateUtils;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DateUtils;
}