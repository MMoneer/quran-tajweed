/**
 * Verse Clipboard Utilities
 * Copy Quran verse text to clipboard + transient toast notifications.
 * Global module: VerseClipboard
 */
const VerseClipboard = (() => {
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  function toArabicDigits(n) {
    return String(n).replace(/\d/g, d => AR_DIGITS[d]);
  }

  /**
   * Arabic-aware ayah counter:
   * 1 → «آية واحدة», 2 → «آيتان», 3–10 → «n آيات», 11+ → «n آية»
   */
  function formatAyahCount(n) {
    if (n === 1) return 'آية واحدة';
    if (n === 2) return 'آيتان';
    if (n >= 3 && n <= 10) return `${toArabicDigits(n)} آيات`;
    return `${toArabicDigits(n)} آية`;
  }

  /**
   * Plain Uthmani text of a verse from word-level data
   * (NOT the tajweed-annotated render text).
   */
  function extractVerseText(verse) {
    if (!verse || !Array.isArray(verse.words)) return '';
    return verse.words
      .filter(w => w.char_type_name === 'word' && w.text_qpc_hafs)
      .map(w => w.text_qpc_hafs)
      .join(' ');
  }

  /**
   * Build final copyable text.
   * Contiguous ayah ids merge into one ﴿…﴾ block with a range reference;
   * disjoint runs go on separate lines.
   * @param {number[]} ayahIds global verse ids (any order)
   * @param {Array} verses surah verses array (ordered by id)
   * @param {string} surahName arabic surah name
   * @returns {string}
   */
  function buildCopyText(ayahIds, verses, surahName) {
    const byId = new Map();
    (verses || []).forEach((v, i) => {
      const num = v.verse_number != null ? v.verse_number : i + 1;
      byId.set(v.id, { text: extractVerseText(v), num });
    });

    const sorted = [...(ayahIds || [])].filter(id => byId.has(id)).sort((a, b) => a - b);

    // Group contiguous runs
    const runs = [];
    for (const id of sorted) {
      const last = runs[runs.length - 1];
      if (last && id === last[last.length - 1] + 1) last.push(id);
      else runs.push([id]);
    }

    return runs.map(run => {
      const text = run.map(id => byId.get(id).text).join(' ');
      const first = toArabicDigits(byId.get(run[0]).num);
      const nums = run.length === 1
        ? first
        : `${first}-${toArabicDigits(byId.get(run[run.length - 1]).num)}`;
      return `﴿${text}﴾ [${surahName}: ${nums}]`;
    }).join('\n');
  }

  /**
   * Copy text to clipboard, with legacy fallback for non-secure
   * contexts (file:// has no navigator.clipboard).
   * @returns {Promise<boolean>} success
   */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  let toastTimer = null;

  /**
   * Show a transient toast at bottom center.
   * Positions itself above the selection bar or audio player when visible.
   * @param {string} message
   * @param {'success'|'error'} type
   */
  function showToast(message, type = 'success') {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;

    // Stack above selection bar or audio player if present
    let bottom = 24;
    const bar = document.getElementById('selection-bar');
    if (bar && bar.parentNode) {
      bottom = (parseInt(bar.style.bottom, 10) || 24) + bar.offsetHeight + 12;
    } else {
      const ap = document.querySelector('.audio-player.visible');
      if (ap) bottom = ap.offsetHeight + 16;
    }
    toast.style.bottom = `${bottom}px`;

    toast.className = `app-toast visible ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  return { toArabicDigits, formatAyahCount, extractVerseText, buildCopyText, copyToClipboard, showToast };
})();
