/**
 * Quran Bookmarks Module
 *
 * Two separate lists (as agreed):
 *  1. Recent positions (automatic): surah + PAGE, last 5 visited.
 *     Recorded from the reader's current page tracker.
 *  2. User bookmarks (manual): surah + AYAH, up to 10.
 *     Added via the bookmark button in the verse popup.
 *     When full, the oldest entry is replaced (FIFO).
 *
 * Plus `quran_last_position` (surah + page) used for the
 * "continue reading" resume card on the home tab.
 *
 * Storage: localStorage (same pattern as SettingsManager and QuranSearch).
 */
const QuranBookmarks = (() => {
  const LAST_KEY = 'quran_last_position';
  const RECENT_KEY = 'quran_recent_pages';
  const USER_KEY = 'quran_user_bookmarks';

  const RECENT_MAX = 5;
  const USER_MAX = 10;

  let surahNameCache = null;

  function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try {
      const val = JSON.parse(raw);
      return val ?? fallback;
    } catch (e) {
      return fallback;
    }
  }

  function loadRecent() {
    const arr = safeParse(localStorage.getItem(RECENT_KEY), []);
    return Array.isArray(arr) ? arr.filter(isValidPageEntry) : [];
  }

  function loadUser() {
    const arr = safeParse(localStorage.getItem(USER_KEY), []);
    return Array.isArray(arr) ? arr.filter(isValidAyahEntry) : [];
  }

  function loadLast() {
    const val = safeParse(localStorage.getItem(LAST_KEY), null);
    return isValidPageEntry(val) ? val : null;
  }

  function isValidPageEntry(e) {
    return !!e && Number.isInteger(e.surah) && e.surah >= 1 && e.surah <= 114 &&
      Number.isInteger(e.page) && e.page >= 1 && e.page <= 604;
  }

  function isValidAyahEntry(e) {
    if (!e || !Number.isInteger(e.surah) || e.surah < 1 || e.surah > 114) return false;
    if (!Number.isInteger(e.ayah) || e.ayah < 1) return false;
    if (typeof QuranMetaService !== 'undefined') {
      // NOTE: isValidAyah() is internal to QuranMetaService; the public
      // API is validatePosition() (same check). Feature-detect both.
      if (typeof QuranMetaService.validatePosition === 'function') {
        return QuranMetaService.validatePosition(e.surah, e.ayah);
      }
      if (typeof QuranMetaService.isValidAyah === 'function') {
        return QuranMetaService.isValidAyah(e.surah, e.ayah);
      }
      if (typeof QuranMetaService.getSurahAyahCount === 'function') {
        return e.ayah <= QuranMetaService.getSurahAyahCount(e.surah);
      }
    }
    return true;
  }

  /**
   * Record a page visit (called from the reader when the visible
   * mushaf page changes). Updates the resume position and the
   * last-5 list. Consecutive duplicates are ignored.
   */
  function recordPageVisit(surah, page, surahName) {
    surah = parseInt(surah);
    page = parseInt(page);
    if (!Number.isInteger(surah) || surah < 1 || surah > 114) return;
    if (!Number.isInteger(page) || page < 1 || page > 604) return;

    const entry = {
      surah,
      page,
      surahName: surahName || '',
      timestamp: Date.now()
    };

    // Resume position
    localStorage.setItem(LAST_KEY, JSON.stringify(entry));

    // Recent list: drop any existing identical entry, unshift, cap at 5
    const recent = loadRecent().filter(e => !(e.surah === surah && e.page === page));
    recent.unshift(entry);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)));

    render();
  }

  /**
   * Toggle a user ayah bookmark.
   * @returns {boolean|null} true if added, false if removed, null if invalid.
   */
  function toggleAyahBookmark(surah, ayah, surahName) {
    surah = parseInt(surah);
    ayah = parseInt(ayah);
    if (!Number.isInteger(surah) || !Number.isInteger(ayah) || !isValidAyahEntry({ surah, ayah })) {
      return null;
    }
    let list = loadUser();
    const idx = list.findIndex(e => e.surah === surah && e.ayah === ayah);

    if (idx >= 0) {
      list.splice(idx, 1);
      localStorage.setItem(USER_KEY, JSON.stringify(list));
      render();
      return false;
    }

    list.unshift({ surah, ayah, surahName: surahName || '', timestamp: Date.now() });
    // FIFO: exceeding 10 drops the oldest
    list = list.slice(0, USER_MAX);
    localStorage.setItem(USER_KEY, JSON.stringify(list));
    render();
    return true;
  }

  function isAyahBookmarked(surah, ayah) {
    return loadUser().some(e => e.surah === surah && e.ayah === ayah);
  }

  function removeAyahBookmark(surah, ayah) {
    const list = loadUser().filter(e => !(e.surah === surah && e.ayah === ayah));
    localStorage.setItem(USER_KEY, JSON.stringify(list));
    render();
  }

  // ── Navigation ──────────────────────────────────────────────

  function navigateToPage(surah, page) {
    surah = parseInt(surah);
    page = parseInt(page);
    if (!Number.isInteger(surah) || !Number.isInteger(page)) return;
    const targetHash = `#surah/${surah}`;
    if (window.location.hash === targetHash) {
      // Already there: scroll directly, leave no stale pending behind.
      window._pendingPageScroll = null;
      window._pendingAyahScroll = null;
      if (typeof SurahViewer !== 'undefined' && SurahViewer.scrollToPage) {
        SurahViewer.scrollToPage(page);
      }
    } else {
      window._pendingPageScroll = page;
      window._pendingAyahScroll = null;
      window.location.hash = targetHash;
    }
  }

  function navigateToAyah(surah, ayah) {
    surah = parseInt(surah);
    ayah = parseInt(ayah);
    if (!Number.isInteger(surah) || !Number.isInteger(ayah)) return;
    const targetHash = `#surah/${surah}`;
    if (window.location.hash === targetHash) {
      // Already there: scroll directly, leave no stale pending behind.
      window._pendingPageScroll = null;
      window._pendingAyahScroll = null;
      if (typeof SurahViewer !== 'undefined' && SurahViewer.scrollToAyah) {
        SurahViewer.scrollToAyah(ayah);
      }
    } else {
      window._pendingAyahScroll = ayah;
      window._pendingPageScroll = null;
      window.location.hash = targetHash;
    }
  }

  // ── Tabs (home view) ────────────────────────────────────────

  function showSurahsTab() {
    switchTab('surahs');
  }

  function showBookmarksTab() {
    switchTab('bookmarks');
  }

  function switchTab(name) {
    const btnSurahs = document.getElementById('tab-btn-surahs');
    const btnBookmarks = document.getElementById('tab-btn-bookmarks');
    const panelSurahs = document.getElementById('tab-panel-surahs');
    const panelBookmarks = document.getElementById('tab-panel-bookmarks');
    if (!btnSurahs || !panelSurahs) return;

    const showBookmarks = name === 'bookmarks';
    btnSurahs.classList.toggle('active', !showBookmarks);
    btnSurahs.setAttribute('aria-selected', String(!showBookmarks));
    btnBookmarks?.classList.toggle('active', showBookmarks);
    btnBookmarks?.setAttribute('aria-selected', String(showBookmarks));
    panelSurahs.classList.toggle('active', !showBookmarks);
    panelBookmarks?.classList.toggle('active', showBookmarks);
    if (showBookmarks) render();
  }

  function setupTabs() {
    if (window._bookmarksTabsSetup) return;
    window._bookmarksTabsSetup = true;
    document.getElementById('tab-btn-surahs')?.addEventListener('click', () => switchTab('surahs'));
    document.getElementById('tab-btn-bookmarks')?.addEventListener('click', () => switchTab('bookmarks'));
  }

  // ── Surah names (for entries saved without a name) ──────────

  let surahNamesPromise = null;

  async function ensureSurahNames() {
    if (surahNameCache) return surahNameCache;
    // Coalesce concurrent renders into a single fetch.
    if (!surahNamesPromise) {
      surahNamesPromise = (async () => {
        try {
          const chapters = await QuranAPI.getChapters();
          surahNameCache = {};
          chapters.forEach(ch => { surahNameCache[ch.id] = ch.name_arabic || ''; });
        } catch (e) {
          surahNameCache = {};
        }
        return surahNameCache;
      })();
    }
    return surahNamesPromise;
  }

  function surahLabel(entry) {
    if (entry.surahName) return entry.surahName;
    if (surahNameCache && surahNameCache[entry.surah]) return surahNameCache[entry.surah];
    return `رقم ${entry.surah}`;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'الآن';
    if (mins < 60) return `منذ ${mins} دقيقة`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `منذ ${hours} ساعة`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'أمس';
    if (days < 30) return `منذ ${days} يوم`;
    return new Date(ts).toLocaleDateString('ar');
  }

  // ── Rendering ───────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function render() {
    const resumeCard = document.getElementById('resume-card');
    const recentList = document.getElementById('recent-pages-list');
    const userList = document.getElementById('user-bookmarks-list');
    const badge = document.getElementById('bookmarks-count-badge');
    // Not on home view (elements absent) → nothing to do
    if (!resumeCard && !recentList && !userList) return;

    const last = loadLast();
    const recent = loadRecent();
    const user = loadUser();

    if (badge) {
      badge.textContent = user.length > 0 ? ` (${user.length})` : '';
    }

    if (resumeCard) {
      if (last) {
        resumeCard.innerHTML = `
          <div class="resume-info">
            <i class="fa-solid fa-bookmark resume-icon"></i>
            <div class="resume-text">
              <strong>أكمل القراءة</strong>
              <span>سورة ${escapeHtml(surahLabel(last))} — صفحة ${escapeHtml(last.page)}</span>
            </div>
          </div>
          <button class="btn-action resume-btn" data-resume-surah="${last.surah}" data-resume-page="${last.page}">
            <i class="fa-solid fa-arrow-left"></i> انتقل
          </button>`;
        resumeCard.classList.remove('empty');
      } else {
        resumeCard.innerHTML = `
          <div class="resume-info">
            <i class="fa-solid fa-book-open resume-icon"></i>
            <div class="resume-text">
              <strong>أكمل القراءة</strong>
              <span class="empty-hint">لا يوجد موضع محفوظ بعد — تصفح أي سورة وسيُحفظ موضعك هنا</span>
            </div>
          </div>`;
        resumeCard.classList.add('empty');
      }
    }

    if (recentList) {
      recentList.innerHTML = recent.length === 0
        ? `<div class="bookmarks-empty">لا توجد مواضع حديثة بعد</div>`
        : recent.map(e => `
          <button class="bookmark-row" data-nav-type="page" data-surah="${e.surah}" data-page="${e.page}">
            <span class="bookmark-row-main">
              <i class="fa-solid fa-clock-rotate-left bookmark-row-icon"></i>
              <span>سورة ${escapeHtml(surahLabel(e))} — صفحة ${escapeHtml(e.page)}</span>
            </span>
            <span class="bookmark-row-time">${escapeHtml(timeAgo(e.timestamp))}</span>
          </button>`).join('');
    }

    if (userList) {
      const counter = document.getElementById('user-bookmarks-counter');
      if (counter) counter.textContent = `${user.length}/${USER_MAX}`;
      userList.innerHTML = user.length === 0
        ? `<div class="bookmarks-empty">لا توجد مرجعيات محفوظة — اضغط على أي آية ثم زر <i class="fa-solid fa-bookmark"></i> لحفظها هنا</div>`
        : user.map(e => `
          <div class="bookmark-row">
            <button class="bookmark-row-goto" data-nav-type="ayah" data-surah="${e.surah}" data-ayah="${e.ayah}">
              <span class="bookmark-row-main">
                <i class="fa-solid fa-bookmark bookmark-row-icon"></i>
                <span>سورة ${escapeHtml(surahLabel(e))} — الآية ${escapeHtml(e.ayah)}</span>
              </span>
              <span class="bookmark-row-time">${escapeHtml(timeAgo(e.timestamp))}</span>
            </button>
            <button class="bookmark-row-delete" data-del-surah="${e.surah}" data-del-ayah="${e.ayah}" title="حذف المرجع" aria-label="حذف المرجع">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>`).join('');
    }

    // Backfill missing surah names once (async, then re-render)
    if ([...(recent || []), ...(user || []), ...(last ? [last] : [])].some(e => !e.surahName)) {
      ensureSurahNames().then(() => {
        let changed = false;
        const fill = (arr) => arr.forEach(e => {
          if (!e.surahName && surahNameCache[e.surah]) { e.surahName = surahNameCache[e.surah]; changed = true; }
        });
        const r = loadRecent(); fill(r);
        const u = loadUser(); fill(u);
        const l = loadLast(); if (l) fill([l]);
        if (changed) {
          localStorage.setItem(RECENT_KEY, JSON.stringify(r));
          localStorage.setItem(USER_KEY, JSON.stringify(u));
          if (l) localStorage.setItem(LAST_KEY, JSON.stringify(l));
          render();
        }
      });
    }
  }

  /**
   * Delegated clicks for dynamically rendered rows/buttons.
   * Bound once; survives re-renders.
   */
  function setupDelegatedClicks() {
    if (window._bookmarksClicksSetup) return;
    window._bookmarksClicksSetup = true;

    document.addEventListener('click', (e) => {
      const resumeBtn = e.target.closest('[data-resume-surah]');
      if (resumeBtn) {
        navigateToPage(resumeBtn.dataset.resumeSurah, resumeBtn.dataset.resumePage);
        return;
      }

      const delBtn = e.target.closest('[data-del-surah]');
      if (delBtn) {
        e.stopPropagation();
        removeAyahBookmark(parseInt(delBtn.dataset.delSurah), parseInt(delBtn.dataset.delAyah));
        return;
      }

      const navEl = e.target.closest('[data-nav-type]');
      if (navEl) {
        const surah = parseInt(navEl.dataset.surah);
        if (navEl.dataset.navType === 'page') {
          navigateToPage(surah, parseInt(navEl.dataset.page));
        } else {
          navigateToAyah(surah, parseInt(navEl.dataset.ayah));
        }
      }
    });
  }

  function init() {
    setupTabs();
    setupDelegatedClicks();
    // Self-heal: drop corrupt entries persisted by older code, then render
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(loadRecent()));
      localStorage.setItem(USER_KEY, JSON.stringify(loadUser()));
    } catch (e) { /* storage is best-effort */ }
    render();
  }

  return {
    init,
    render,
    recordPageVisit,
    toggleAyahBookmark,
    isAyahBookmarked,
    removeAyahBookmark,
    navigateToPage,
    navigateToAyah,
    showSurahsTab,
    showBookmarksTab,
    RECENT_MAX,
    USER_MAX
  };
})();
