/**
 * Dynamic Page View — mushaf page fills ~98% of the dynamic viewport.
 *
 * When enabled (settings `dynamicPage`), every `.page-section` gets a
 * fixed height of `calc(98dvh - top chrome - bottom chrome)` via CSS and
 * this module computes ONE font size (applied as `--dynamic-font-size`)
 * so that even the densest rendered page fits inside that height.
 * Sparse pages simply end early — the font never varies page to page.
 *
 * Refit triggers: surah render, window resize / visualViewport change,
 * media (mobile/tablet/desktop) change, audio-player show/hide, legend
 * show/hide/collapse. All hooks are guarded so the module is a no-op
 * when the mode is off or the reader view is not active.
 *
 * Viewport feasibility gate: the mode activates ONLY when the densest
 * page fits at a readable size (>= MIN_FONT). On viewports too small
 * for that (e.g. phones in portrait) it gracefully stays in normal
 * view instead of shrinking into illegibility or internal scrolling —
 * and re-activates automatically when space allows (rotation/resize).
 */
const DynamicPage = (() => {
  // Readability floor for the auto-fit font. Fresh activation and an
  // already-active session use the SAME gate (no refresh/session
  // asymmetry — that flip-flopped near-boundary viewports like 960px).
  // Deactivation sits slightly below (hysteresis) so resizing across
  // the boundary doesn't flicker.
  const MIN_FONT = 18;
  const ACTIVATE_MIN = 18;
  // Readable floor for the TWO-COLUMN spread. Lower than MIN_FONT because
  // two columns halve the line width (≈ double the lines ≈ ~1.4× the needed
  // font), so an 18px floor would confine the spread to very wide screens.
  // 16px keeps dense Arabic legible on desktop/tablet and lets the spread
  // engage roughly 150–200px earlier.
  const SPREAD_MIN_FONT = 16;
  // Probe measuring font: FIXED so every refit starts from the same
  // point and converges to the same result. (Previously the probe
  // started from lastFont, i.e. the previous fit — since real content
  // height is not purely quadratic in font size, different starts
  // converged to slightly different ends: 24px one time, 25px the
  // next, on the same screen.)
  const PROBE_FONT = 30;
  const MAX_ITERATIONS = 10;
  const CONVERGE_EPS = 0.2;
  const RESIZE_DEBOUNCE_MS = 150;

  /**
   * Ceiling for the fitted font by media: 30px on tablet/desktop,
   * 24px on phones — same breakpoints as SettingsManager
   * (mobile ≤767px). Only the sparse-page tail ever reaches it;
   * the normal 24–29 band is unaffected.
   */
  function fitCap() {
    try {
      if (window.matchMedia('(max-width: 767px)').matches) return 24;
    } catch (e) { /* ignore */ }
    return 30;
  }

  let fitting = false;
  let pendingRefit = false;
  let resizeTimer = null;
  let lastFont = null;
  let initialized = false;
  let controlsSig = '';
  let lastDecision = { state: 'boot' };
  // Per-iteration trace of the last fit ({font, max} per measurement),
  // exposed via debug() — shows whether converge/verify walked down
  // to the truth or plunged to the floor.
  let lastTrace = [];

  function isEnabled() {
    try {
      if (typeof SettingsManager !== 'undefined' && SettingsManager.state) {
        return !!SettingsManager.state.settings.dynamicPage;
      }
    } catch (e) { /* fall through to class check */ }
    return document.body.classList.contains('dynamic-page-mode');
  }

  function readerActive() {
    return !!document.querySelector('#surah-reader-section.active .page-section');
  }

  /**
   * Immersive reading mode (two-page spread): the header, fixed nav,
   * legend and audio player are OVERLAYS owned by ImmersiveReader —
   * none of them reserves layout space, and their show/hide must not
   * re-fit the font.
   */
  function isImmersive() {
    return document.body.classList.contains('immersive-read');
  }

  /**
   * Effective state: the dynamic layout is actually applied right now
   * (setting on AND classes present). The setting alone is not enough —
   * an infeasible viewport keeps classes off (graceful fallback).
   */
  function isActive() {
    return document.body.classList.contains('dynamic-page-mode');
  }

  // ---- Two-page spread integration -------------------------------------
  // The spread is only usable when each opening fits the viewport, so it
  // always runs WITH this fitter. If two columns can't reach the readable
  // floor (MIN_FONT) on the current viewport, the WHOLE reading falls back
  // to a single page (never a half-broken in-page scroll).
  let spreadFailSig = null; // 'WxH' at the viewport where spread proved infeasible
  let spreadFailInfo = null; // diagnostics for the last spread fallback

  function isSpreadOn() {
    if (window.innerWidth < 768) return false;
    try {
      if (typeof SettingsManager !== 'undefined' && SettingsManager.state) {
        return !!SettingsManager.state.settings.spreadView;
      }
    } catch (e) { /* fall through */ }
    return document.body.classList.contains('spread-mode');
  }

  function spreadRowsPresent() {
    const c = document.getElementById('surah-content-container');
    return !!(c && c.querySelector('.spread-row'));
  }

  function viewportSig() {
    return window.innerWidth + 'x' + window.innerHeight;
  }

  // Retry two columns only after the viewport changes (resize/rotate) —
  // this is what prevents a rebuild↔fallback loop at a fixed size.
  function shouldAttemptSpread() {
    if (!isSpreadOn()) return false;
    return spreadFailSig === null || viewportSig() !== spreadFailSig;
  }

  // Build or flatten the spread DOM (and rewire the page observer).
  function applySpreadDom(wantRows) {
    if (typeof SurahViewer === 'undefined') return;
    const hasRows = spreadRowsPresent();
    if (wantRows && !hasRows) {
      if (typeof SurahViewer.buildSpreadLayout === 'function') SurahViewer.buildSpreadLayout();
      if (typeof SurahViewer.setupPageNavigation === 'function') SurahViewer.setupPageNavigation();
    } else if (!wantRows && hasRows) {
      if (typeof SurahViewer.flattenSpreadLayout === 'function') SurahViewer.flattenSpreadLayout();
      if (typeof SurahViewer.setupPageNavigation === 'function') SurahViewer.setupPageNavigation();
    }
  }

  function useSpreadLayout() {
    if (!isSpreadOn()) {
      spreadFailSig = null; // fresh retry next time spread is enabled
      document.body.classList.remove('spread-overflow');
      applySpreadDom(false);
      return false;
    }
    if (shouldAttemptSpread()) {
      document.body.classList.remove('spread-overflow');
      applySpreadDom(true);
      return spreadRowsPresent();
    }
    // Known-infeasible at this viewport → single page for the whole reading.
    // Set the flag BEFORE (re)wiring so surahView behaves as single.
    document.body.classList.add('spread-overflow');
    applySpreadDom(false);
    return false;
  }

  function fallbackFromSpread(info) {
    spreadFailSig = viewportSig();
    spreadFailInfo = info || { reason: 'unknown', last: lastDecision.state };
    document.body.classList.add('spread-overflow');
    applySpreadDom(false);
    scheduleRefit();
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /**
   * Measure the fixed top/bottom chrome and publish as CSS vars:
   * --fit-top (header + visible fixed nav + gap),
   * --fit-bottom (visible audio player + visible legend).
   * Returns the rounded pixel values for height math.
   * While immersive the chrome is an overlay: only the compact
   * app-main/card insets occupy real space, and the bottom is 0.
   */
  function computeOffsets() {
    const root = document.documentElement;

    if (isImmersive()) {
      let top = 0;
      const main = document.querySelector('.app-main');
      if (main) top += parseFloat(getComputedStyle(main).paddingTop) || 0;
      const card = document.querySelector(
        '#surah-reader-section.active .surah-viewer-card'
      );
      if (card) top += parseFloat(getComputedStyle(card).paddingTop) || 0;
      const topPx = Math.round(top);
      root.style.setProperty('--fit-top', `${topPx}px`);
      root.style.setProperty('--fit-bottom', '0px');
      return { top: topPx, bottom: 0 };
    }

    const header = document.querySelector('.app-header');
    const nav = document.querySelector('#fixed-nav.visible');
    const top = (header ? header.offsetHeight : 72)
      + (nav ? nav.offsetHeight : 0) + 8;

    let bottom = 0;
    const player = document.querySelector('.audio-player.visible');
    if (player) bottom += player.offsetHeight;
    const legend = document.querySelector('#tajweed-legend.visible');
    if (legend) bottom += legend.offsetHeight;

    const topPx = Math.round(top);
    const bottomPx = Math.round(bottom);
    root.style.setProperty('--fit-top', `${topPx}px`);
    root.style.setProperty('--fit-bottom', `${bottomPx}px`);
    return { top: topPx, bottom: bottomPx };
  }

  /**
   * Target page-box height. When the mode is already active the box
   * itself is measured (exact). Otherwise it is derived from the same
   * formula the CSS uses (98dvh ≈ 98% of innerHeight minus chrome) —
   * this avoids flashing the fixed layout on viewports where the
   * feasibility probe is about to fail (e.g. phones).
   */
  let lastBoxInfo = {};
  function boxTarget(sections, top, bottom) {
    if (isActive()) {
      const h = sections[0].getBoundingClientRect().height;
      lastBoxInfo = { branch: 'active-measure', h: Math.round(h) };
      if (h && h >= 100) return h;
    }
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const val = vh * 0.98 - top - bottom;
    lastBoxInfo = { branch: 'derived', vh, top, bottom, val: Math.round(val) };
    return val;
  }

  function currentManualFont() {
    try {
      if (typeof SettingsManager !== 'undefined' && SettingsManager.state) {
        return SettingsManager.state.settings.fontSize || 30;
      }
    } catch (e) { /* ignore */ }
    return 30;
  }

  /**
   * Sync the font-size slider + label with the effective state.
   * 'auto'     → fitted, slider bypassed (read-only).
   * 'fallback' → setting on but viewport infeasible: manual slider works,
   *               label shows the exact numbers (required vs gate) and,
   *               when the collapsible legend/player is what decides,
   *               says so — no more mystery "it just doesn't work".
   * 'off'      → setting off: plain manual UI (mirrors settings).
   * Signature dedupe avoids fighting SettingsManager's own UI writes.
   */
  function updateControls(mode, font) {
    const manual = currentManualFont();
    const d = lastDecision || {};
    const sig = mode + ':' + (
      mode === 'auto' ? Math.round(font || 0)
        : mode === 'fallback' ? `${d.state || ''}:${d.required || 0}`
          : manual
    );
    if (sig === controlsSig) return;
    controlsSig = sig;
    const slider = document.getElementById('font-size-slider');
    const sizeText = document.getElementById('font-size-text');
    if (mode === 'auto') {
      if (slider) slider.disabled = true;
      if (sizeText) {
        sizeText.textContent = `تلقائي (${Math.round(font)}px)`;
        sizeText.title = '';
      }
    } else if (mode === 'fallback') {
      if (slider) slider.disabled = false;
      if (sizeText) {
        if (d.state === 'infeasible-chrome') {
          // Only the collapsible bottom chrome stands in the way.
          sizeText.textContent = 'أخفِ الدليل/المشغّل';
          sizeText.title = `معهما: المطلوب ${d.required}px — بدونهما: ${d.altRequired}px (الحد ${d.gate}px)`;
        } else if (typeof d.required === 'number') {
          sizeText.textContent = `غير مناسب (${d.required}/${d.gate}px)`;
          sizeText.title = `state=${d.state} | ارتفاع الشاشة=${d.vh || window.innerHeight}px | `
            + `المطلوب=${d.required}px | الحد=${d.gate}px | `
            + `كروم علوي=${d.top || '?'}px سفلي=${d.bottom || '?'}px`;
        } else {
          sizeText.textContent = 'غير مناسب للشاشة';
          sizeText.title = '';
        }
      }
    } else {
      if (slider) slider.disabled = false;
      if (sizeText) {
        sizeText.textContent = `${manual}px`;
        sizeText.title = '';
      }
    }
  }

  /**
   * Apply/remove the mode classes (= the entire dynamic layout, CSS-driven)
   * and sync the controls. The ONLY place classes are toggled.
   */
  function setEffective(on, font) {
    document.body.classList.toggle('dynamic-page-mode', on);
    document.documentElement.classList.toggle('dynamic-page-mode', on);
    if (!on) {
      lastFont = null;
      // The variable is live outside the mode (measuring needs it) —
      // clear it so normal view always uses the slider font.
      document.documentElement.style.removeProperty('--dynamic-font-size');
    }
    updateControls(on ? 'auto' : (isEnabled() ? 'fallback' : 'off'), font);
  }

  /**
   * Immediate UI refresh from current state (used after settings applies
   * its own UI, so a stale auto-label never lingers).
   */
  function refreshControls() {
    controlsSig = '';
    if (isActive() && lastFont) {
      updateControls('auto', lastFont);
    } else if (isEnabled()) {
      updateControls('fallback');
    } else {
      updateControls('off');
    }
  }

  /**
   * Permanent diagnostic affordance: returns the last fit decision with
   * its numbers. Run `DynamicPage.debug()` in the console — no code
   * changes or log spam needed for future diagnosis.
   */
  function debug() {
    return {
      ...lastDecision,
      vw: window.innerWidth,
      vh: window.innerHeight,
      setting: isEnabled(),
      active: isActive(),
      font: lastFont,
      box: lastBoxInfo,
      spreadFail: spreadFailInfo,
      trace: lastTrace
    };
  }

  /**
   * Record the decision; log ONE console line when the state CHANGES
   * (no spam) so failures are visible without opening settings — the
   * settings label already carries the same numbers as text/tooltip.
   */
  function decide(d) {
    const changed = d.state !== lastDecision.state;
    lastDecision = d;
    if (changed && d.state !== 'fitting') {
      console.info('[DynamicPage] ' + d.state, d);
    }
  }

  // Callbacks registered by whenSettled(); released when no further pass
  // is queued.
  let settleWaiters = [];

  /**
   * Resolve once the fit pass that is currently scheduled (or running) has
   * finished, so callers that need FINAL page geometry — an ayah/page jump
   * coming from search or bookmarks — can target the fitted layout instead
   * of the pre-fit one. Resolves immediately when the mode is off, and
   * gives up after `timeoutMs` so a pending jump is never lost.
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  function whenSettled(timeoutMs = 1500) {
    if (!isEnabled()) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      settleWaiters.push(finish);
      setTimeout(finish, timeoutMs);
    });
  }

  function flushSettled() {
    if (!settleWaiters.length) return;
    const waiters = settleWaiters;
    settleWaiters = [];
    waiters.forEach(fn => fn());
  }

  /**
   * One fit pass, then release whenSettled() waiters — but only once no
   * further pass is queued (a queued pass would move the page boxes again
   * right after they were measured).
   */
  async function doRefit() {
    const requestedAtStart = refitRequests;
    try {
      await runRefit();
    } finally {
      if (!fitting && !pendingRefit && refitRequests === requestedAtStart) {
        flushSettled();
      }
    }
  }

  async function runRefit() {
    if (fitting) {
      // A refit is already in flight — don't drop this request (dropped
      // requests left stale state after a manual viewport drag): mark it
      // and re-run once the current pass finishes.
      pendingRefit = true;
      return;
    }
    if (!isEnabled()) {
      decide({ state: 'setting-off' });
      setEffective(false);
      // Fit off: drop any spread fallback marker and leave the DOM as-is
      // (spread setting is also off whenever the fit is off — see settings).
      document.body.classList.remove('spread-overflow');
      return;
    }
    if (!readerActive()) { decide({ state: 'no-reader' }); setEffective(false); return; }
    fitting = true;
    try {
      try { await document.fonts.ready; } catch (e) { /* ignore */ }
      if (!isEnabled() || !readerActive()) { setEffective(false); return; }

      const sections = Array.from(
        document.querySelectorAll('#surah-reader-section.active .page-section')
      );
      if (!sections.length) { decide({ state: 'no-sections' }); setEffective(false); return; }

      // Spread is a whole-reading decision: show two columns only when the
      // viewport can fit them (best-effort here; the gate below is the
      // authoritative check that triggers the full fallback).
      const usingSpread = useSpreadLayout();

      // ---- Phase 1: feasibility probe WITHOUT touching layout ----
      // (no flash on phones): derived box + dividers minimized for real
      // via .dynamic-dividers-min (the same rules the mode itself uses),
      // so the probe measures content-only heights — identical to what
      // refits measure. (Assuming them instead once underestimated the
      // font by ~2px on fresh activations: a static in-flow divider is
      // ~200px tall.)
      const off = computeOffsets();
      const dividerEl = document.querySelector(
        '#surah-reader-section.active .page-divider'
      );
      let target = boxTarget(sections, off.top, off.bottom);
      if (!target || target < 100) { decide({ state: 'no-target', target }); setEffective(false); return; }
      let textTarget = target - (40 + 21) - 4;
      if (textTarget < 160) { decide({ state: 'tiny', target, textTarget }); setEffective(false); return; }

      const root = document.documentElement;
      const base = clamp(PROBE_FONT, MIN_FONT, fitCap());

      // Measuring pass: natural content heights (CSS height overridden
      // to auto, dividers minimized — see above).
      document.body.classList.add('dynamic-dividers-min');
      root.classList.add('dynamic-measuring');
      let required = 0;
      let maxNatural = 0;
      try {
        // PROBE: what size would the densest rendered page need?
        // (Content height scales ~quadratically with font size.)
        root.style.setProperty('--dynamic-font-size', `${base}px`);
        for (const s of sections) {
          const h = s.scrollHeight;
          if (h > maxNatural) maxNatural = h;
        }
        required = base * Math.sqrt(textTarget / Math.max(1, maxNatural));
      } finally {
        root.classList.remove('dynamic-measuring');
        document.body.classList.remove('dynamic-dividers-min');
      }
      // Same gate for fresh activation and ongoing sessions; only
      // deactivation sits slightly lower so resizing across the boundary
      // doesn't flicker. Two columns use their own (lower) readable floor.
      const floorFont = usingSpread ? SPREAD_MIN_FONT : MIN_FONT;
      const gate = isActive() ? floorFont - 1.5 : floorFont;
      const req100 = Math.round(required * 100) / 100;
      const common = {
        target: Math.round(target), textTarget: Math.round(textTarget),
        base, maxNatural: Math.round(maxNatural),
        top: off.top, bottom: off.bottom,
        vh: window.innerHeight, required: req100, gate
      };
      if (required < gate) {
        // Two columns that can't reach the readable floor → drop the whole
        // reading to a single page (the spread setting stays on; it just
        // doesn't engage at this viewport).
        if (usingSpread) {
          fallbackFromSpread({
            reason: 'gate', required, gate,
            target: Math.round(target), textTarget: Math.round(textTarget),
            maxNatural: Math.round(maxNatural)
          });
          return;
        }
        // Viewport too small for a readable fit — stay in normal view
        // instead of shrinking into illegibility or internal scrolling.
        // Re-evaluated on every refit (rotation/resize/surah change).
        // Distinguish "nowhere near" from "collapsible chrome decides":
        // re-check as if the legend + audio player took no space.
        let altRequired = 0;
        if (off.bottom > 0) {
          altRequired = Math.round(
            base * Math.sqrt((textTarget + off.bottom) / Math.max(1, maxNatural)) * 100
          ) / 100;
        }
        decide({
          ...common,
          state: altRequired >= gate ? 'infeasible-chrome' : 'infeasible',
          altRequired
        });
        setEffective(false);
        return;
      }
      decide({ ...common, state: 'fitting' });

      // ---- Phase 2: feasible — apply layout, then measure for real ----
      document.body.classList.add('dynamic-page-mode');
      document.documentElement.classList.add('dynamic-page-mode');
      target = sections[0].getBoundingClientRect().height;
      if (!target || target < 100) {
        if (usingSpread) { fallbackFromSpread({ reason: 'p2-no-target', target }); return; }
        decide({ state: 'no-target', target }); setEffective(false); return;
      }
      // Now minimized for real: reserve its measured height + 15px bottom
      // offset + 6px breathing gap (keep `bottom` in sync, styles.css).
      // EPS absorbs rounding drift so text never exceeds the real CSS box
      // by a hair (which would add a scrollbar).
      const reserve = (dividerEl ? dividerEl.offsetHeight : 40) + 21;
      textTarget = target - reserve - 4;
      if (textTarget < 160) {
        if (usingSpread) { fallbackFromSpread({ reason: 'p2-tiny', target: Math.round(target), textTarget: Math.round(textTarget) }); return; }
        decide({ state: 'tiny', target: Math.round(target), textTarget: Math.round(textTarget) });
        setEffective(false);
        return;
      }

      // ---- Phase 3: converge + verify at real sizes, then publish ----
      root.classList.add('dynamic-measuring');
      try {
        // Iterate from the probe result to converge.
        // Capped by media (30 tablet/desktop, 24 phone): only the
        // sparse-page tail ever reaches it.
        const cap = fitCap();
        lastTrace = [];
        let font = clamp(required, floorFont, cap);
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          root.style.setProperty('--dynamic-font-size', `${font}px`);
          let max = 0;
          for (const s of sections) {
            const h = s.scrollHeight;
            if (h > max) max = h;
          }
          lastTrace.push({ phase: 'converge', font: +font.toFixed(2), max: Math.round(max) });
          if (max <= textTarget) {
            // Room to grow? (stay slightly under to absorb rounding)
            if (max < textTarget * 0.92 && font < cap) {
              const grown = clamp(font * Math.sqrt(textTarget / Math.max(max, 1)), floorFont, cap);
              if (grown - font < CONVERGE_EPS) break;
              font = grown;
              continue;
            }
            break;
          }
          // Content height scales ~quadratically with font size
          // (line count x line height both grow with it).
          const shrunk = clamp(font * Math.sqrt(textTarget / max), floorFont, cap);
          if (font - shrunk < CONVERGE_EPS) { font = shrunk; break; }
          font = shrunk;
          if (font <= floorFont) break;
        }

        font = Math.round(font * 10) / 10;
        // Snap DOWN to the 0.5px grid: near a rounding boundary the
        // unconverged remainder (24.9 vs 25.1) used to flip the displayed
        // integer between refits. Snapping down can only improve the fit.
        font = Math.max(floorFont, Math.floor(font * 2) / 2);
        root.style.setProperty('--dynamic-font-size', `${font}px`);
        // Final verification at the applied size: line-wrap granularity
        // can defeat the model — SHRINK AND RE-MEASURE instead of
        // abandoning the activation. Browsers (and zoom levels) wrap
        // lines a pixel or two differently; the old all-or-nothing check
        // hard-failed in one browser while another passed, leaving the
        // mode stuck off even on identical hardware/fullscreen.
        const measureMax = () => {
          let m = 0;
          for (const s of sections) {
            const h = s.scrollHeight;
            if (h > m) m = h;
          }
          return m;
        };
        let finalMax = measureMax();
        for (let g = 0; g < 8 && finalMax > textTarget + 2 && font > floorFont; g++) {
          // Sqrt shrink (same model as the converge loop): the old linear
          // shrink overshot on wrap-granularity overflow and ratcheted the
          // font down to the MIN floor (18.000 on 1024x768 for a true ~21
          // fit) with no way back up. Re-measured each step, so it
          // converges instead of plunging.
          let shrunk = Math.floor((font * Math.sqrt(textTarget / Math.max(finalMax, 1))) * 10) / 10;
          if (shrunk >= font) shrunk = Math.floor((font - 0.1) * 10) / 10;
          shrunk = Math.max(floorFont, shrunk);
          if (shrunk >= font) break;
          font = shrunk;
          root.style.setProperty('--dynamic-font-size', `${font}px`);
          finalMax = measureMax();
          lastTrace.push({ phase: 'verify', font: +font.toFixed(2), max: Math.round(finalMax) });
        }
        if (finalMax > textTarget + 2) {
          if (usingSpread) {
            fallbackFromSpread({ reason: 'overflow', finalMax: Math.round(finalMax), textTarget: Math.round(textTarget), font });
            return;
          }
          decide({
            ...common, state: 'overflow', font,
            target: Math.round(target), textTarget: Math.round(textTarget),
            finalMax: Math.round(finalMax)
          });
          setEffective(false);
          return;
        }
        lastFont = font;
        spreadFailSig = null; // a successful spread clears the failure memo
        decide({
          ...common, state: 'active', font,
          target: Math.round(target), textTarget: Math.round(textTarget)
        });
        const wasActive = isActive();
        setEffective(true, font);
        // First activation fitted against the derived target — re-verify
        // once against the real box (now the classes apply) to absorb
        // any dvh/innerHeight drift. Guarded: runs only on transitions.
        if (!wasActive) scheduleRefit();
      } finally {
        root.classList.remove('dynamic-measuring');
      }
    } finally {
      fitting = false;
      document.documentElement.classList.remove('dynamic-measuring');
      if (pendingRefit) {
        pendingRefit = false;
        scheduleRefit();
      }
    }
  }

  // Passes requested with scheduleRefit(). Lets doRefit() tell "this was the
  // last one" from "another pass is queued and would move the boxes again".
  let refitRequests = 0;

  function scheduleRefit() {
    refitRequests++;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { doRefit(); }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * Called after a surah finishes rendering into the reader.
   * Small delay lets the browser complete layout before measuring.
   */
  function onSurahRendered() {
    scheduleRefit();
  }

  function getFontSize() {
    return lastFont;
  }

  function init() {
    if (initialized) return;
    initialized = true;

    window.addEventListener('resize', () => {
      if (isEnabled()) scheduleRefit();
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        if (isEnabled()) scheduleRefit();
      });
    }

    // Bottom/top chrome can appear without a window resize
    // (audio player show/hide, legend show/hide/collapse, fixed nav).
    try {
      const observer = new MutationObserver(() => {
        // Chrome is an overlay while immersive — show/hide must not
        // re-fit (one refit already ran when the mode flipped).
        if (isImmersive()) return;
        if (isEnabled()) scheduleRefit();
      });
      ['audio-player', 'tajweed-legend', 'fixed-nav'].forEach(id => {
        const el = document.getElementById(id);
        if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
    } catch (e) { /* MutationObserver unavailable — resize hook still works */ }
  }

  return {
    init,
    refit: scheduleRefit,
    whenSettled,
    onSurahRendered,
    getFontSize,
    isEnabled,
    isActive,
    refreshControls,
    debug
  };
})();
