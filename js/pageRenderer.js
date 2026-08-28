/**
 * Page Renderer - Handles rendering Surah content with page divisions
 */
const PageRenderer = (() => {
  
  /**
   * Build HTML for a single verse from per-word QPC Hafs data
   */
  function buildVerseHTML(verse) {
    const wordTexts = [];
    for (const word of verse.words) {
      const html = buildWordHTML(word);
      if (html) wordTexts.push(html);
    }
    return wordTexts.join('\u200C ');
  }

  /**
   * Build HTML for a single word (tajweed-merged) or empty string
   * @param {Object} word - Word object from verse data
   * @returns {string}
   */
  function buildWordHTML(word) {
    if (word.char_type_name === 'word' && word.text_qpc_hafs) {
      return mergeTajweedToQPC(
        word.text_qpc_hafs,
        word.text_uthmani_tajweed || ''
      );
    } else if (word.char_type_name === 'end') {
      const num = word.text_qpc_hafs || word.text_uthmani_tajweed || word.text || '';
      return `<span class="end">${num}</span>`;
    }
    return '';
  }
  
  /**
   * Merge tajweed rule annotations from text_uthmani_tajweed onto text_qpc_hafs
   * Optimized: uses pure string parsing instead of DOM manipulation
   */
  function mergeTajweedToQPC(qpcText, tajweedHtml) {
    if (!tajweedHtml) return qpcText;

    // Extract char+rule pairs from tajweed HTML using regex
    // API format: <rule class=ham_wasl>text</rule> (NO quotes on attribute)
    const charRules = [];
    const ruleRegex = /<rule\s+class=([^\s>]+)>([\s\S]*?)<\/rule>|<tajweed\s+class=([^\s>]+)>([\s\S]*?)<\/tajweed>|([^<]+)/g;
    let match;

    while ((match = ruleRegex.exec(tajweedHtml)) !== null) {
      if (match[1] !== undefined) {
        // <rule class=...> tag
        const rule = match[1];
        for (const ch of match[2]) {
          charRules.push({ char: ch, rule });
        }
      } else if (match[3] !== undefined) {
        // <tajweed class=...> tag
        const rule = match[3];
        for (const ch of match[4]) {
          charRules.push({ char: ch, rule });
        }
      } else if (match[5] !== undefined) {
        // Plain text
        for (const ch of match[5]) {
          charRules.push({ char: ch, rule: null });
        }
      }
    }

    // Character classification helpers (inlined for performance)
    const DIACRITIC_RANGES = [
      [0x064B, 0x0658], [0x06D6, 0x06ED]
    ];
    const DIACRITIC_SINGLE = new Set([0x0670, 0x06E1]);
    const ALEF_VARIANTS = new Set(['ٱ', 'أ', 'إ', 'ٲ', 'ٳ', 'آ']);
    const HARAKAT_RANGE = [0x064B, 0x0652];

    function isDiacritic(ch) {
      const code = ch.charCodeAt(0);
      if (DIACRITIC_SINGLE.has(code)) return true;
      for (const [lo, hi] of DIACRITIC_RANGES) {
        if (code >= lo && code <= hi) return true;
      }
      return false;
    }

    function baseChar(ch) {
      if (isDiacritic(ch)) return '';
      if (ALEF_VARIANTS.has(ch)) return 'ا';
      if (ch === 'ـ') return '';
      return ch;
    }

    function isHarakah(ch) {
      const code = ch.charCodeAt(0);
      return code >= HARAKAT_RANGE[0] && code <= HARAKAT_RANGE[1];
    }

    // Match QPC chars to tajweed rules
    const qpcChars = qpcText;
    const qpcLen = qpcChars.length;
    const rules = new Array(qpcLen).fill(null);
    let ri = 0;

    for (let qi = 0; qi < qpcLen && ri < charRules.length; qi++) {
      const qc = qpcChars[qi];
      const rc = charRules[ri].char;
      const qBase = baseChar(qc);
      const rBase = baseChar(rc);

      if (isDiacritic(qc) && isDiacritic(rc)) {
        if (qc === rc) {
          rules[qi] = charRules[ri].rule;
          ri++;
        }
        continue;
      }

      if (qBase === '' && rBase !== '') continue;
      if (rBase === '' && qBase !== '') { ri++; qi--; continue; }
      if (qBase === rBase) {
        rules[qi] = charRules[ri].rule;
        ri++;
      } else {
        qi--;
        ri++;
      }
    }

    // Transfer rules from diacritics to their base character
    for (let i = 1; i < qpcLen; i++) {
      if (isDiacritic(qpcChars[i]) && rules[i]) {
        const rule = rules[i];
        const isMaddSpecial = rule.startsWith('madda_') || rule === 'custom-alef-maksora';
        if (isMaddSpecial && isHarakah(qpcChars[i])) {
          rules[i] = null;
          continue;
        }
        for (let j = i - 1; j >= 0; j--) {
          if (!isDiacritic(qpcChars[j])) {
            if (!rules[j]) {
              rules[j] = rules[i];
            }
            break;
          }
        }
        rules[i] = null;
      }
    }

    // Build HTML output using string concatenation (fastest method)
    let html = '';
    let i = 0;

    while (i < qpcLen) {
      if (rules[i]) {
        const rule = rules[i];
        html += '<tajweed class="' + rule + '">';
        while (i < qpcLen && (rules[i] === rule || (isDiacritic(qpcChars[i]) && !rules[i]))) {
          html += qpcChars[i];
          i++;
        }
        html += '</tajweed>';
      } else {
        html += qpcChars[i];
        i++;
        while (i < qpcLen && isDiacritic(qpcChars[i]) && !rules[i]) {
          html += qpcChars[i];
          i++;
        }
      }
    }

    return html;
  }
  
  /**
   * Create page divider HTML string
   */
  function createPageDividerHTML(pageNumber) {
    return `<div class="page-divider">
      <div class="divider-line"></div>
      <button type="button" class="copy-page-btn" data-page-number="${pageNumber}" title="نسخ هذه الصفحة" aria-label="نسخ صفحة ${pageNumber}">
        <i class="fa-regular fa-copy"></i>
      </button>
      <span class="page-number">${pageNumber}</span>
      <div class="divider-line"></div>
    </div>`;
  }

  /**
   * Create juz divider HTML string
   */
  function createJuzDividerHTML(juzNumber) {
    return `<div class="juz-divider" data-juz="${juzNumber}">
      <div class="juz-divider-line"></div>
      <span class="juz-divider-label"><i class="fa-solid fa-book-quran"></i> الجزء ${juzNumber}</span>
      <div class="juz-divider-line"></div>
    </div>`;
  }
  
  /**
   * Render Surah content with page divisions
   * Optimized: builds HTML string first, then inserts in one batch
   */
  function renderSurahWithPages(surahData) {
    const container = document.getElementById('surah-content-container');

    const { verses, page_breaks, name_arabic, bismillah_pre, revelation_place } = surahData;
    const currentSurahId = surahData.surah_id;

    // Find all juz that start in this surah
    const juzStartsInSurah = JUZ_DATA.filter(j => j.surah === currentSurahId);

    // Build complete HTML as string for maximum performance
    let html = '';

    // 1. Surah Header Banner
    const revelationPlaceAr = revelation_place === 'makkah' ? 'مكية' : 'مدنية';
    html += `<div class="surah-header-banner">
      <div class="surah-ornament-title">سُورَةُ ${name_arabic}</div>
      <div class="surah-meta-details">
        <span><i class="fa-solid fa-location-dot"></i> مكان النزول: ${revelationPlaceAr}</span>
        <span><i class="fa-solid fa-arrow-down-1-9"></i> آياتها: ${verses.length}</span>
        <span><i class="fa-solid fa-book-quran"></i> ترتيبها: ${currentSurahId}</span>
        <button type="button" class="copy-surah-btn" title="نسخ السورة كاملة" aria-label="نسخ السورة كاملة">
          <i class="fa-regular fa-copy"></i>
          <span>نسخ السورة</span>
        </button>
      </div>`;

    if (bismillah_pre) {
      html += `<div class="bismillah-text">بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ</div>`;
    }
    html += `</div>`;

    // Add juz marker for ayah 1
    const juzAtSurahStart = juzStartsInSurah.find(j => j.ayah === 1);
    if (juzAtSurahStart) {
      html += createJuzDividerHTML(juzAtSurahStart.juz);
    }

    // 2. Render verses with page divisions
    for (let pageIdx = 0; pageIdx < page_breaks.length; pageIdx++) {
      const pageStart = page_breaks[pageIdx] - 1;
      const pageEnd = pageIdx + 1 < page_breaks.length
        ? page_breaks[pageIdx + 1] - 1
        : verses.length;

      const firstVerseOfPage = verses[page_breaks[pageIdx] - 1];
      const firstWordOfPage = firstVerseOfPage?.words?.find(w => w.char_type_name === 'word');
      const currentPageNumber = firstWordOfPage?.page_number || pageIdx + 1;

      html += `<div class="page-section" data-page-number="${currentPageNumber}">`;

      const pageVerses = verses.slice(pageStart, pageEnd);
      for (let i = 0; i < pageVerses.length; i++) {
        const verse = pageVerses[i];
        const localAyahNum = pageStart + i + 1;

        // Insert juz divider if needed
        if (localAyahNum !== 1) {
          const juzHere = juzStartsInSurah.find(j => j.ayah === localAyahNum);
          if (juzHere) {
            html += createJuzDividerHTML(juzHere.juz);
          }
        }

        const verseHtml = wrapNormalMadd(buildVerseHTML(verse));
        html += `<span class="verse" data-ayah="${verse.id}">${verseHtml}</span>`;
        if (i < pageVerses.length - 1) {
          html += ' ';
        }
      }

      html += `</div>`;
      html += createPageDividerHTML(currentPageNumber);
    }

    // Insert all HTML in one DOM operation
    container.innerHTML = html;
  }
  
  /**
   * Wrap normal madd letters in tajweed tags
   * Optimized: uses pure string regex instead of DOM manipulation
   */
  function wrapNormalMadd(html) {
    // Replace alef maksora variant first
    let cleaned = html.replace(/ٲ/g, 'ٰ');

    // Process text nodes only (skip existing tajweed tags)
    // Split by tajweed tags, process only the text parts
    const MADD_PATTERN = /(َ)ا(ٓ?)(?![ًٌٍَُِّْ])/g;
    const MADD_WAW_PATTERN = /(ُ)و(ٓ?)(?![ًٌٍَُِّْ])/g;
    const MADD_YA_PATTERN = /(ِ)ي(ٓ?)(?![ًٌٍَُِّْ])/g;

    // Split HTML into segments: text outside tajweed tags vs tajweed tags themselves
    const segments = cleaned.split(/(<tajweed[^>]*>[\s\S]*?<\/tajweed>)/);

    for (let i = 0; i < segments.length; i++) {
      // Only process segments that are NOT tajweed tags (odd indices are tags)
      if (!segments[i].startsWith('<tajweed')) {
        segments[i] = segments[i]
          .replace(MADD_PATTERN, '$1<tajweed class="madda_normal">ا$2</tajweed>')
          .replace(MADD_WAW_PATTERN, '$1<tajweed class="madda_normal">و$2</tajweed>')
          .replace(MADD_YA_PATTERN, '$1<tajweed class="madda_normal">ي$2</tajweed>');
      }
    }

    let result = segments.join('');

    // Keep combining marks attached to their base letter. The tajweed span above
    // wraps a base (e.g. madd alef) but can leave a trailing combining mark (tanween,
    // sukun, small-high sign, maddah, ...) OUTSIDE the element. That boundary breaks
    // HarfBuzz mark-to-base positioning, dropping the mark to the baseline / overlapping
    // the alef. Pull any trailing combining mark back inside the preceding </tajweed>.
    result = result.replace(
      /<\/tajweed>([\u064B-\u065F\u0670\u06D6-\u06ED]+)/g,
      '$1</tajweed>'
    );

    return result;
  }
  
  return {
    renderSurahWithPages,
    buildWordHTML,
    wrapNormalMadd
  };
})();
