/**
 * Immersive reading mode — two-page spread only.
 *
 * While the mushaf opening (spread rows) is on screen, ALL fixed chrome
 * (header + fixed nav on top, tajweed legend + audio player at the
 * bottom) slides away as an overlay so the opening fills the viewport.
 * Revealed chrome does not change layout: DynamicPage publishes compact
 * --fit-top/--fit-bottom while immersive, and the fitter ignores chrome
 * visibility toggles entirely.
 *
 * Reveal affordances:
 *   - Desktop: moving the pointer to the top/bottom viewport edge
 *     (the --immersive-edge CSS token band) opens the chrome
 *     transiently; leaving it for HIDE_DELAY_MS closes it.
 *   - Touch/keyboard: the small edge handle buttons open the chrome
 *     "pinned" — it stays until the user taps/clicks outside the chrome
 *     or presses Escape.
 *
 * Class ownership: body gets `immersive-read` while eligible, plus
 * `immersive-top-open` / `immersive-bottom-open` while chrome shows
 * (CSS drives all hiding/showing from these).
 *
 * Eligibility = two-page spread settings on + spread rows actually
 * rendered (never `spread-overflow`) + the project's wide-screen
 * breakpoint (matched to the CSS media queries, never a magic number)
 * + the surah reader view is the active section. Anything else
 * restores the normal chrome automatically.
 */
const ImmersiveReader = (() => {
  /** The project's shared wide-screen breakpoint (same as CSS MQs). */
  const wideScreen = window.matchMedia('(min-width: 768px)');
  /** Fallback if the --immersive-edge token was renamed in CSS. */
  const EDGE_PX_FALLBACK = 12;
  /** Mouse-out delay before transient chrome closes. */
  const HIDE_DELAY_MS = 500;
  /** Debounce for resize-driven re-evaluation. */
  const RESIZE_DEBOUNCE_MS = 150;

  let initialized = false;
  let active = false; // body.immersive-read is on
  let topOpen = false;
  let bottomOpen = false;
  let topPinned = false;
  let bottomPinned = false;
  let hideTimer = null;
  let resizeTimer = null;
  let syncQueued = false;

  /** Edge-reveal band width, taken from the CSS token --immersive-edge
   *  (styles.css) so CSS stays the single source of this metric. */
  function edgePx() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--immersive-edge');
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) ? n : EDGE_PX_FALLBACK;
  }

  const TOP_SELECTOR = '.app-header, #fixed-nav';
  const BOTTOM_SELECTOR = '#tajweed-legend, .audio-player';
  const HANDLE_SELECTOR = '.immersive-handle';
  // Everything that counts as "inside the chrome": while the pointer or
  // focus is on any of these, the chrome must not auto-close.
  const ANY_CHROME_SELECTOR =
    TOP_SELECTOR + ', ' + BOTTOM_SELECTOR + ', ' + HANDLE_SELECTOR;

  /**
   * The immersive mode may be on: two-page spread actually rendering
   * (rows exist, no overflow fallback), reader view active, wide screen.
   */
  function eligible() {
    const body = document.body;
    if (!body.classList.contains('spread-mode')) return false;
    if (body.classList.contains('spread-overflow')) return false;
    if (!wideScreen.matches) return false;

    const reader = document.getElementById('surah-reader-section');
    if (!reader || !reader.classList.contains('active')) return false;
    const container = document.getElementById('surah-content-container');
    return !!(container && container.querySelector('.spread-row'));
  }

  function setTop(open) {
    topOpen = open;
    if (!open) topPinned = false;
    document.body.classList.toggle('immersive-top-open', open);
    const handle = document.getElementById('immersive-handle-top');
    if (handle) handle.setAttribute('aria-expanded', String(open));
  }

  function setBottom(open) {
    bottomOpen = open;
    if (!open) bottomPinned = false;
    document.body.classList.toggle('immersive-bottom-open', open);
    const handle = document.getElementById('immersive-handle-bottom');
    if (handle) handle.setAttribute('aria-expanded', String(open));
  }

  /** Enter/exit immersive mode. Calls DynamicPage.refit() ONLY when the
   *  mode itself flips — chrome open/close must never re-fit the font. */
  function sync() {
    syncQueued = false;
    const now = eligible();
    if (now === active) return;
    active = now;
    document.body.classList.toggle('immersive-read', now);
    // Chrome always starts hidden on (re)activation; restored by CSS
    // defaults the moment .immersive-read is removed.
    setTop(false);
    setBottom(false);
    clearHideTimer();
    if (typeof DynamicPage !== 'undefined' &&
        typeof DynamicPage.refit === 'function') {
      DynamicPage.refit();
    }
  }

  /** Mutations / resizes are frequent — coalesce via rAF. */
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(sync);
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  /** Close whatever is open but NOT pinned (hover-opened chrome). */
  function scheduleHide() {
    if (hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (topOpen && !topPinned) setTop(false);
      if (bottomOpen && !bottomPinned) setBottom(false);
    }, HIDE_DELAY_MS);
  }

  function pointerInsideChrome(e) {
    return !!(e.target && e.target.closest &&
      e.target.closest(ANY_CHROME_SELECTOR));
  }

  function onPointerMove(e) {
    if (!active) return;
    clearHideTimer();
    if (e.pointerType !== 'mouse') return;
    const edge = edgePx();
    if (e.clientY <= edge) {
      setTop(true);
      return;
    }
    if (e.clientY >= window.innerHeight - edge) {
      setBottom(true);
      return;
    }
    if (pointerInsideChrome(e)) return; // hovering chrome keeps it open
    scheduleHide();
  }

  /** Handles open pinned chrome (touch + keyboard). */
  function onHandleClick(kind) {
    if (!active) return;
    clearHideTimer();
    if (kind === 'top') {
      topPinned = true;
      setTop(true);
    } else {
      bottomPinned = true;
      setBottom(true);
    }
  }

  /** Click/tap outside an open pinned panel closes it (touch dismiss). */
  function onDocumentClick(e) {
    if (!active) return;
    if (!topOpen && !bottomOpen) return;
    if (e.target && e.target.closest &&
        e.target.closest(ANY_CHROME_SELECTOR)) return;
    if (topOpen) setTop(false);
    if (bottomOpen) setBottom(false);
  }

  /** Keyboard users: reaching chrome reveals it; leaving re-hides if it
   *  was not pinned. Handles are exempt (they toggle deliberately). */
  function onFocusIn(e) {
    if (!active) return;
    const inside = e.target && e.target.closest &&
      e.target.closest(ANY_CHROME_SELECTOR);
    if (!inside) return;
    clearHideTimer();
    if (e.target.closest(TOP_SELECTOR)) setTop(true);
    else if (e.target.closest(BOTTOM_SELECTOR)) setBottom(true);
  }

  function onFocusOut() {
    if (!active) return;
    setTimeout(() => {
      if (!active) return;
      const el = document.activeElement;
      const inside = !!(el && el.closest && el.closest(ANY_CHROME_SELECTOR));
      if (inside) return;
      scheduleHide();
    }, 0);
  }

  function onEscape(e) {
    if (e.key !== 'Escape' || !active) return;
    if (!topOpen && !bottomOpen) return;
    clearHideTimer();
    setTop(false);
    setBottom(false);
  }

  function init() {
    if (initialized) return;
    initialized = true;

    try {
      const observer = new MutationObserver(scheduleSync);
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
      const reader = document.getElementById('surah-reader-section');
      if (reader) {
        observer.observe(reader, {
          attributes: true,
          attributeFilter: ['class']
        });
      }
      const container = document.getElementById('surah-content-container');
      if (container) observer.observe(container, { childList: true });
    } catch (e) {
      /* MutationObserver unavailable — resize hook still applies */
    }

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sync, RESIZE_DEBOUNCE_MS);
    });

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onEscape);

    document.getElementById('immersive-handle-top')
      ?.addEventListener('click', () => onHandleClick('top'));
    document.getElementById('immersive-handle-bottom')
      ?.addEventListener('click', () => onHandleClick('bottom'));

    sync();
  }

  /** Public: re-evaluate after view/mode changes that bypass the
   *  observed classes (defensive entry point for other modules). */
  function refresh() {
    scheduleSync();
  }

  return {
    init,
    refresh,
    get isActive() { return active; },
    get isBottomOpen() { return bottomOpen; }
  };
})();
