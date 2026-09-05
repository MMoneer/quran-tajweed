/**
 * MemorizationEngine — V3 schema.
 *
 * Stateless engine. All state lives in the `state` object passed to the
 * constructor; the engine exposes pure operations that mutate it.
 *
 *  - Quran positions  : handled by QuranMetaService (injected)
 *  - Dates            : handled by DateUtils             (injected)
 *  - Persistence      : caller owns it; engine never touches storage.
 *
 * The UI must NOT contain scheduling/business logic — it only calls the
 * methods exposed here.
 */
const MemorizationEngine = ((QuranMetaService, DateUtils) => {
  const SCHEMA_VERSION = 3;

  const STATUS = Object.freeze({
    LEARNING: 'learning',
    REVIEWING: 'reviewing',
    CONSOLIDATING: 'consolidating',
    STABLE: 'stable',
    MASTERED: 'mastered',
  });

  const VALID_STATUSES = new Set([
    STATUS.LEARNING,
    STATUS.REVIEWING,
    STATUS.CONSOLIDATING,
    STATUS.STABLE,
    STATUS.MASTERED,
  ]);

  const VALID_RATINGS = new Set([1, 2, 3, 4]);

  const BADGES = Object.freeze({
    FIRST_PORTION: 'first_portion',
    STREAK_7: 'streak_7',
    STREAK_30: 'streak_30',
    AYAHS_100: 'ayahs_100',
    AYAHS_500: 'ayahs_500',
    AYAHS_1000: 'ayahs_1000',
    FIRST_MASTERED: 'first_mastered',
    JUZ_1: 'juz_1',
    JUZ_5: 'juz_5',
    JUZ_10: 'juz_10',
    JUZ_15: 'juz_15',
    JUZ_20: 'juz_20',
    JUZ_25: 'juz_25',
    JUZ_30: 'juz_30',
  });

  /**
   * Maximum number of review items surfaced per day. The cap is the
   * user-settable `plan.reviewCap` multiplier (default 3) applied to
   * `plan.dailyAmount`. Both factors are configurable: `dailyAmount`
   * controls the forward range size, `reviewCap` controls how many
   * review slots the user wants relative to that range.
   */
  function dailyReviewCap(state) {
    const daily = (state && state.plan && Number.isFinite(state.plan.dailyAmount))
      ? state.plan.dailyAmount
      : 5;
    const multiplier = (state && state.plan && Number.isFinite(state.plan.reviewCap))
      ? Math.max(1, Math.trunc(state.plan.reviewCap))
      : 3;
    return daily * multiplier;
  }

  /**
   * Build a fresh, empty V3 state.
   * @param {string} [today]
   */
  function createInitialState(today = DateUtils.getLocalDateString()) {
    return {
      version: SCHEMA_VERSION,
      plan: {
        isActive: false,
        targetType: 'ayahs',
        dailyAmount: 5,
        reviewCap: 3,
        direction: 'forward',
        currentSurah: 1,
        currentAyah: 1,
        isCompleted: false,
      },
      day: {
        date: today,
        newMemorizationCompleted: false,
        todayRange: null,
        completedReviewIds: [],
        dueReviewIds: [],
      },
      stats: {
        currentStreak: 0,
        longestStreak: 0,
        totalReviews: 0,
        lastCompletedDay: null,
      },
      items: [],
      badges: [],
      _undoSnapshot: null,
    };
  }

  /**
   * Stable, deterministic id for a memorization range. Used to dedupe items
   * so a double-submitted completion does NOT create a second item.
   */
  function buildItemId(fromSurah, fromAyah, toSurah, toAyah) {
    return `${fromSurah}:${fromAyah}-${toSurah}:${toAyah}`;
  }

  /**
   * Determine the canonical status for an item given its review history.
   * Order matters: mastery requires BOTH interval >= 45 AND
   * consecutiveSuccesses >= 5; the simpler interval buckets apply otherwise.
   */
  function computeStatus(item) {
    const s = item.consecutiveSuccesses;
    const i = item.interval;
    if (s < 2) return STATUS.LEARNING;
    if (i >= 45 && s >= 5) return STATUS.MASTERED;
    if (i >= 22) return STATUS.STABLE;
    if (i >= 8) return STATUS.CONSOLIDATING;
    return STATUS.REVIEWING;
  }

  /**
   * Roll the `state.day` forward to `currentLocalDate` if needed. The
   * previous day's `completedReviewIds` / `newMemorizationCompleted` flag
   * AND the frozen `dueReviewIds` cohort must NOT leak into the new day.
   */
  function ensureCurrentDay(state, currentLocalDate = DateUtils.getLocalDateString()) {
    if (!state || typeof state !== 'object') {
      throw new Error('MemorizationEngine: state is required');
    }
    if (!state.day || typeof state.day !== 'object') {
      state.day = {};
    }
    // Backwards compat: old state may lack todayRange and/or dueReviewIds.
    if (!('todayRange' in state.day)) {
      state.day.todayRange = null;
    }
    if (!Array.isArray(state.day.dueReviewIds)) {
      state.day.dueReviewIds = [];
    }
    if (state.day.date !== currentLocalDate) {
      state.day = {
        date: currentLocalDate,
        newMemorizationCompleted: false,
        todayRange: null,
        completedReviewIds: [],
        dueReviewIds: [],
      };
    }
    return state;
  }

  function findItem(state, itemId) {
    return state.items.find(it => it.id === itemId) || null;
  }

  function findItemByRange(state, fromSurah, fromAyah) {
    return state.items.find(it =>
      it.fromSurah === fromSurah && it.fromAyah === fromAyah
    ) || null;
  }

  /**
   * Build the next memorization range according to `plan.targetType`.
   * Returns null if the plan's current pointer has no valid range.
   * Used by both `completeNewMemorization` (which commits the item) and
   * `getDailyTaskSummary` (which only displays the range).
   */
  function computeNextPlanRange(plan) {
    if (!plan || typeof plan !== 'object') return null;
    const isBackward = plan.direction === 'backward';
    if (plan.targetType === 'surah') {
      return isBackward
        ? QuranMetaService.calculatePreviousSurahRange(plan.currentSurah, plan.currentAyah, plan.dailyAmount)
        : QuranMetaService.calculateNextSurahRange(plan.currentSurah, plan.currentAyah, plan.dailyAmount);
    }
    if (plan.targetType === 'page') {
      const page = QuranMetaService.getPageOf(plan.currentSurah, plan.currentAyah);
      if (page == null) return null;
      return isBackward
        ? QuranMetaService.calculatePreviousPageRange(page, plan.currentSurah, plan.currentAyah)
        : QuranMetaService.calculateNextPageRange(page, plan.dailyAmount);
    }
    return isBackward
      ? QuranMetaService.calculatePreviousAyahRange(plan.currentSurah, plan.currentAyah, plan.dailyAmount)
      : QuranMetaService.calculateNextAyahRange(plan.currentSurah, plan.currentAyah, plan.dailyAmount);
  }

  /**
   * Snapshot a deep-ish copy of the mutable parts of state so the most
   * recent review (or new-memorization commit) can be undone.
   *
   * Snapshotting is one level deep on top-level fields plus a per-item
   * copy. That is sufficient because every review/commit replaces whole
   * item records — it never mutates one in place mid-snapshot.
   */
  function takeSnapshot(state) {
    return {
      plan: { ...state.plan },
      day: {
        date: state.day.date,
        newMemorizationCompleted: state.day.newMemorizationCompleted,
        todayRange: state.day.todayRange ? { ...state.day.todayRange } : null,
        completedReviewIds: [...state.day.completedReviewIds],
        dueReviewIds: Array.isArray(state.day.dueReviewIds)
          ? [...state.day.dueReviewIds]
          : [],
      },
      stats: { ...state.stats },
      items: state.items.map(it => ({ ...it })),
      badges: [...state.badges],
    };
  }

  /**
   * One-level undo. Returns true iff there was a snapshot to restore.
   */
  function undoLastReview(state) {
    if (!state._undoSnapshot) return false;
    const snap = state._undoSnapshot;
    state._undoSnapshot = null;
    state.plan = { ...snap.plan };
    state.day = {
      date: snap.day.date,
      newMemorizationCompleted: snap.day.newMemorizationCompleted,
      todayRange: snap.day.todayRange ? { ...snap.day.todayRange } : null,
      completedReviewIds: [...snap.day.completedReviewIds],
      dueReviewIds: Array.isArray(snap.day.dueReviewIds) ? [...snap.day.dueReviewIds] : [],
    };
    state.stats = { ...snap.stats };
    state.items = snap.items.map(it => ({ ...it }));
    state.badges = [...snap.badges];
    return true;
  }

  /**
   * Recompute and grant any newly-earned badges. Idempotent — badges are
   * a Set-equivalent array.
   */
  function awardBadges(state) {
    const earned = new Set(state.badges);

    // "أول جزء" is granted only after the entire Juz 1 is memorized
    // (148 ayahs: Al-Fatiha 1-7 + Al-Baqarah 1-141). Computing it from
    // "≥ 1 ayah" granted the badge the moment the user saved the first
    // range, which read as a bug in the UI.
    if (computeJuz1CoveredAyahs(state) >= 148) earned.add(BADGES.FIRST_PORTION);

    const totalAyahs = computeTotalMemorizedAyahs(state);
    if (totalAyahs >= 100) earned.add(BADGES.AYAHS_100);
    if (totalAyahs >= 500) earned.add(BADGES.AYAHS_500);
    if (totalAyahs >= 1000) earned.add(BADGES.AYAHS_1000);

    if (state.stats.currentStreak >= 7) earned.add(BADGES.STREAK_7);
    if (state.stats.currentStreak >= 30) earned.add(BADGES.STREAK_30);

    const masteredCount = state.items.filter(it => it.status === STATUS.MASTERED).length;
    if (masteredCount >= 1) earned.add(BADGES.FIRST_MASTERED);

    const completedJuz = computeCompletedJuz(state);
    if (completedJuz >= 1) earned.add(BADGES.JUZ_1);
    if (completedJuz >= 5) earned.add(BADGES.JUZ_5);
    if (completedJuz >= 10) earned.add(BADGES.JUZ_10);
    if (completedJuz >= 15) earned.add(BADGES.JUZ_15);
    if (completedJuz >= 20) earned.add(BADGES.JUZ_20);
    if (completedJuz >= 25) earned.add(BADGES.JUZ_25);
    if (completedJuz >= 30) earned.add(BADGES.JUZ_30);

    state.badges = [...earned];
  }

  /**
   * Try to advance the streak. Called only when a day's completion
   * conditions become satisfied. Streak rules:
   *   - If the previous completed day was yesterday → currentStreak++
   *   - Otherwise → currentStreak = 1
   * Always updates longestStreak to the running max.
   *
   * Returns true iff the day was newly completed (i.e. the streak was
   * actually advanced). Repeated calls in the same day are no-ops.
   */
  function tryAdvanceStreak(state) {
    const today = state.day.date;
    if (state.stats.lastCompletedDay === today) {
      return false; // already counted today
    }
    if (state.stats.lastCompletedDay
        && state.stats.lastCompletedDay === DateUtils.addDays(today, -1)) {
      state.stats.currentStreak += 1;
    } else {
      state.stats.currentStreak = 1;
    }
    if (state.stats.currentStreak > state.stats.longestStreak) {
      state.stats.longestStreak = state.stats.currentStreak;
    }
    state.stats.lastCompletedDay = today;
    awardBadges(state);
    return true;
  }

  /**
   * Establish (and freeze) today's review cohort if not yet set.
   *
   * The cohort is the canonical "what the user must review today" — a
   * snapshot of the highest-priority overdue IDs at the moment today's
   * queue is first built, capped at 3 × the active plan's daily target.
   *
   * Once established, the cohort is fixed for the day: reviewing an item
   * MUST NOT promote backlog items into the same day's quota. The cohort
   * is cleared on day rollover (`ensureCurrentDay`).
   *
   * Backwards compatibility: older saved states lack `day.dueReviewIds`.
   * On first access we compute and persist the cohort from the live
   * overdue list so existing users get a sensible first-day cohort.
   */
  function ensureTodayCohort(state, currentLocalDate) {
    if (!state || !state.day) return [];
    // NOTE: an empty array is NOT treated as "already computed" — fresh
    // states (createInitialState) start with [] and expect the cohort to
    // be computed lazily on first access. Caching the empty cohort would
    // permanently freeze it to zero.
    if (Array.isArray(state.day.dueReviewIds) && state.day.dueReviewIds.length > 0) {
      return state.day.dueReviewIds;
    }
    const cap = dailyReviewCap(state);
    const cohort = getOverdueItems(state, currentLocalDate).slice(0, cap).map(it => it.id);
    state.day.dueReviewIds = cohort;
    return cohort;
  }

  /**
   * Has today's review+new-memorization quota been satisfied?
   * Active plan : new memorization AND every ID in the frozen cohort is done.
   * Inactive    : every ID in the frozen cohort is done.
   */
  function isDayCompleted(state, _unused, currentLocalDate) {
    const cohort = ensureTodayCohort(state, currentLocalDate);
    if (state.plan.isActive && !state.day.newMemorizationCompleted) return false;
    const completed = state.day.completedReviewIds;
    for (const id of cohort) {
      if (!completed.includes(id)) return false;
    }
    return true;
  }

  /**
   * Idempotent: completing today's new memorization range commits an
   * item, advances the plan pointer, and may bump the streak if today's
   * reviews are already done.
   *
   * Returns the new item (or the existing one if it was a duplicate).
   */
  function completeNewMemorization(state) {
    ensureCurrentDay(state);

    // Idempotency guard: if today's new memorization has already been
    // committed, do nothing. This prevents accidental double-submission
    // from creating a second item OR advancing the pointer again.
    if (state.day.newMemorizationCompleted) {
      return findItemByRange(state, state.plan.currentSurah, state.plan.currentAyah)
        || state.items[state.items.length - 1]
        || null;
    }

    const plan = state.plan;
    const range = computeNextPlanRange(plan);
    if (!range || range.count === 0) {
      return null;
    }

    // Snapshot for one-level undo BEFORE any mutation (including the
    // todayRange freeze below), honoring the engine's "snapshot before
    // commit" contract for both the normal and the dedup code paths.
    state._undoSnapshot = takeSnapshot(state);

    // Freeze the completed range BEFORE advancing the pointer. This way
    // the stored todayRange always reflects the actual completed range,
    // even when the UI calls us directly without first rendering the
    // summary that populates this field as a side-effect.
    state.day.todayRange = {
      fromSurah: range.fromSurah,
      fromAyah: range.fromAyah,
      toSurah: range.toSurah,
      toAyah: range.toAyah,
      count: range.count,
      isCompleted: !!range.isCompleted,
    };

    const id = buildItemId(range.fromSurah, range.fromAyah, range.toSurah, range.toAyah);
    const existing = findItem(state, id);
    if (existing) {
      // Dedup guard: this range was already recorded (e.g. from a prior
      // session or plan position). The item is NOT re-created, but the
      // pointer MUST still advance — the user explicitly clicked "تم الحفظ".
      // (The undo snapshot was already taken above, before any mutation.)
      const isBackwardDedup = plan.direction === 'backward';
      if (isBackwardDedup && range.fromSurah === 1 && range.fromAyah === 1) {
        plan.currentSurah = 1;
        plan.currentAyah = 1;
        plan.isCompleted = true;
      } else {
        const next = isBackwardDedup
          ? QuranMetaService.getPreviousPosition(range.fromSurah, range.fromAyah)
          : QuranMetaService.getNextPosition(range.toSurah, range.toAyah);
        if (next) {
          plan.currentSurah = next.surah;
          plan.currentAyah = next.ayah;
        } else {
          plan.isCompleted = true;
        }
      }
      state.day.newMemorizationCompleted = true;
      if (isDayCompleted(state)) {
        tryAdvanceStreak(state);
      }
      return existing;
    }

    const today = state.day.date;
    const nextReview = DateUtils.addDays(today, 1);
    const newItem = {
      id,
      fromSurah: range.fromSurah,
      fromAyah: range.fromAyah,
      toSurah: range.toSurah,
      toAyah: range.toAyah,
      repetition: 0,
      consecutiveSuccesses: 0,
      interval: 1,
      easeFactor: 2.5,
      lastReviewed: null,
      nextReview,
      status: STATUS.LEARNING,
    };
    state.items.push(newItem);

    // Advance pointer to the position immediately BEFORE the just-committed range.
    const isBackward = plan.direction === 'backward';
    if (isBackward && range.fromSurah === 1 && range.fromAyah === 1) {
      // Reached the start of the Quran in one step. Pin the pointer to
      // 1:1 so the user sees a stable "done" position instead of the
      // previous pointer (which would point at the start of a range we
      // already committed). Mark the plan as completed.
      plan.currentSurah = 1;
      plan.currentAyah = 1;
      plan.isCompleted = true;
    } else {
      const next = isBackward
        ? QuranMetaService.getPreviousPosition(range.fromSurah, range.fromAyah)
        : QuranMetaService.getNextPosition(range.toSurah, range.toAyah);
      if (next) {
        plan.currentSurah = next.surah;
        plan.currentAyah = next.ayah;
      } else if (range.isCompleted) {
        plan.isCompleted = true;
      }
    }

    state.day.newMemorizationCompleted = true;

    awardBadges(state);
    if (isDayCompleted(state)) {
      tryAdvanceStreak(state);
    }
    return newItem;
  }

  /**
   * Apply a review rating to `itemId`.
   *   rating === 1 → failed
   *   rating ∈ {2,3,4} → successful with hard/good/easy
   *
   * Snapshot is taken BEFORE applying the rating, so `undoLastReview`
   * can restore the previous state exactly.
   *
   * Guards:
   *   - The item MUST be in today's frozen review cohort. Items that
   *     became due only after the cohort was established, or that were
   *     never due, MUST be rejected so the engine never rates backlog
   *     promotions.
   *   - The item MUST be currently due (its `nextReview <= today`).
   *   - The same item MUST NOT be rated twice in the same day.
   */
  function reviewItem(state, itemId, rating, currentLocalDate) {
    ensureCurrentDay(state, currentLocalDate);
    if (!VALID_RATINGS.has(rating)) {
      throw new Error('MemorizationEngine: invalid rating ' + rating);
    }
    const item = findItem(state, itemId);
    if (!item) {
      throw new Error('MemorizationEngine: unknown item ' + itemId);
    }
    const today = state.day.date;

    // Duplicate same-day rating guard: an item rated earlier today is
    // already in `completedReviewIds`. A second submission would corrupt
    // scheduling counters, so refuse it. The UI also locks the buttons
    // while a review save is in flight; this guard is the belt-and-braces
    // engine-side defence against rapid double-clicks.
    if (state.day.completedReviewIds.includes(item.id)) {
      throw new Error('MemorizationEngine: item ' + itemId + ' already reviewed today');
    }

    // The item must be currently due. Backwards-compat: if today's cohort
    // is missing (older saved state), compute it now.
    const cohort = ensureTodayCohort(state, currentLocalDate);
    if (!cohort.includes(item.id)) {
      throw new Error('MemorizationEngine: item ' + itemId + ' is not in today\'s frozen review cohort');
    }
    if (item.nextReview > today) {
      throw new Error('MemorizationEngine: item ' + itemId + ' is not yet due');
    }

    // Snapshot before mutating.
    state._undoSnapshot = takeSnapshot(state);

    if (rating === 1) {
      item.repetition = 0;
      item.consecutiveSuccesses = 0;
      item.interval = 1;
      item.easeFactor = Math.max(1.3, item.easeFactor - 0.2);
      item.lastReviewed = today;
      item.nextReview = DateUtils.addDays(today, item.interval);
    } else {
      // Successful review.
      const prevConsec = item.consecutiveSuccesses;
      if (prevConsec === 0) {
        item.interval = 1;
      } else if (prevConsec === 1) {
        item.interval = 3;
      } else if (prevConsec === 2) {
        item.interval = 7;
      } else {
        item.interval = Math.max(1, Math.round(item.interval * item.easeFactor));
      }
      if (rating === 2) {
        item.easeFactor = Math.max(1.3, item.easeFactor - 0.15);
      } else if (rating === 4) {
        item.easeFactor = Math.min(3.0, item.easeFactor + 0.15);
      }
      // rating === 3 leaves easeFactor untouched.

      item.repetition += 1;
      item.consecutiveSuccesses += 1;
      item.lastReviewed = today;
      item.nextReview = DateUtils.addDays(today, item.interval);
    }

    item.status = computeStatus(item);

    // Record this review as today's work.
    if (!state.day.completedReviewIds.includes(item.id)) {
      state.day.completedReviewIds.push(item.id);
    }
    state.stats.totalReviews += 1;

    awardBadges(state);
    if (isDayCompleted(state, undefined, currentLocalDate)) {
      tryAdvanceStreak(state);
    }
    return item;
  }

  /**
   * Reset a single item back to "learning". Used by the manual Reset
   * Item action. Does not delete the item, does not touch day/stats
   * completion state.
   */
  function resetItem(state, itemId) {
    const item = findItem(state, itemId);
    if (!item) return false;
    state._undoSnapshot = takeSnapshot(state);
    const today = state.day.date;
    item.repetition = 0;
    item.consecutiveSuccesses = 0;
    item.interval = 1;
    item.easeFactor = 2.5;
    item.lastReviewed = null;
    item.nextReview = DateUtils.addDays(today, 1);
    item.status = STATUS.LEARNING;
    return true;
  }

  /**
   * Wipe the entire memorization state and replace it with a fresh initial
   * state. The schema version, surah/ayah bounds, and `state.day.date` are
   * re-anchored to today. The internal `_undoSnapshot` is also cleared so
   * a stale snapshot can never resurrect the wiped state via `undoLastReview`.
   *
   * Returns the freshly created state. The caller is responsible for
   * persisting it (via IndexedDbAdapter.saveState) and for broadcasting the
   * change to other tabs.
   */
  function resetAllState(today = DateUtils.getLocalDateString()) {
    const fresh = createInitialState(today);
    fresh._undoSnapshot = null;
    return fresh;
  }

  /**
   * Items whose `nextReview <= today`. Sorted deterministically by:
   *   1. earliest `nextReview` (most overdue first)
   *   2. smallest `interval` (most urgent first)
   *   3. stable `id` (lexicographic) for total determinism
   *
   * This is the canonical "backlog priority" used by both
   * `getDailyTaskSummary` and `getDueReviewIds`.
   */
  function getOverdueItems(state, currentLocalDate = DateUtils.getLocalDateString()) {
    ensureCurrentDay(state, currentLocalDate);
    const today = currentLocalDate;
    return state.items
      .filter(it => it.nextReview <= today)
      .sort((a, b) => {
        if (a.nextReview !== b.nextReview) return a.nextReview < b.nextReview ? -1 : 1;
        if (a.interval !== b.interval) return a.interval - b.interval;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }

  /**
   * IDs of items that should be reviewed today. Returns the frozen
   * cohort established by `ensureTodayCohort`, NOT a live slice of the
   * overdue list. Items become due later, after the cohort is fixed, are
   * intentionally excluded; they remain in the backlog until tomorrow.
   *
   * `dailyReviewLimit` is preserved in the signature for public-API
   * compatibility but is no longer used: the cap is derived from the
   * active plan's `dailyAmount` (×3) by `dailyReviewCap`.
   */
  function getDueReviewIds(state, _dailyReviewLimit = 10) {
    return ensureTodayCohort(state).slice();
  }

  /**
   * Build the UI-facing summary for today.
   *
   * `dailyReviewLimit` is retained for public-API compatibility; the
   * actual cap is derived from the active plan's `dailyAmount` (×3) via
   * the frozen cohort.
   */
  function getDailyTaskSummary(state, _dailyReviewLimit = 10, currentLocalDate) {
    ensureCurrentDay(state, currentLocalDate);
    const cap = dailyReviewCap(state);
    const overdue = getOverdueItems(state, currentLocalDate);
    const overdueIds = overdue.map(it => it.id);
    const cohort = ensureTodayCohort(state, currentLocalDate);
    const dueIds = cohort.slice();
    const cohortSet = new Set(dueIds);
    const remainingIds = overdueIds.filter(id => !cohortSet.has(id));

    // Compute today's memorization range. If already completed, use the
    // stored range (pointer has since advanced, so recomputing would give
    // tomorrow's range).
    let newMemorization = null;
    const newMemorizationCompleted = state.day.newMemorizationCompleted;
    if (state.plan.isActive && !state.plan.isCompleted) {
      if (newMemorizationCompleted && state.day.todayRange) {
        newMemorization = state.day.todayRange;
      } else {
        newMemorization = computeNextPlanRange(state.plan);
        // Store the range so it stays stable after the pointer advances.
        if (newMemorization) {
          state.day.todayRange = {
            fromSurah: newMemorization.fromSurah,
            fromAyah: newMemorization.fromAyah,
            toSurah: newMemorization.toSurah,
            toAyah: newMemorization.toAyah,
            count: newMemorization.count,
            isCompleted: !!newMemorization.isCompleted,
          };
        }
      }
    }

    const dueReviews = state.items.filter(it => dueIds.includes(it.id));
    const completedReviewIds = state.day.completedReviewIds.slice();
    const completedSet = new Set(completedReviewIds);
    const allReviewsCompleted = dueIds.every(id => completedSet.has(id));
    const dayCompleted = isDayCompleted(state, null, currentLocalDate);
    const streak = state.stats.currentStreak;

    return {
      date: state.day.date,
      newMemorization,
      dueReviews,
      completedReviewIds,
      remainingReviewIds: remainingIds,
      newMemorizationCompleted,
      allReviewsCompleted,
      dayCompleted,
      streak,
      cohortCap: cap,
    };
  }

  // -------- derived statistics (preferring computation over duplication) --------

  function countAyahsInRange(fromSurah, fromAyah, toSurah, toAyah) {
    let curSurah = fromSurah;
    let curAyah = fromAyah;
    let total = 0;
    // Walk forward through the Quran until we reach (toSurah, toAyah).
    // Cap at 6,236 (the entire Quran) to defend against corrupted items.
    const SAFETY_CAP = 6236;
    while (total < SAFETY_CAP) {
      if (curSurah === toSurah && curAyah === toAyah) {
        total += 1;
        return total;
      }
      const next = QuranMetaService.getNextPosition(curSurah, curAyah);
      if (!next) break;
      total += 1;
      curSurah = next.surah;
      curAyah = next.ayah;
    }
    return total;
  }

  /**
   * Count unique ayahs across the items array, deduping overlaps. Walks
   * forward from the very first memorized ayah position, tracking which
   * (surah, ayah) tuples have already been counted. Returns 0 for an
   * empty items array.
   *
   * This is the canonical "how many ayahs have you memorized" figure:
   * overlapping or duplicate ranges contribute their ayahs exactly once.
   * Capped at 6,236 (the total Quran ayah count) so corrupted items can
   * never produce an inflated figure.
   */
  function computeTotalMemorizedAyahs(state) {
    if (!state || !Array.isArray(state.items) || state.items.length === 0) return 0;
    const SAFETY_CAP = 6236;
    const items = state.items;
    // Track the latest (by total ayah offset) memorized ayah seen so far.
    // For each item, count the ayahs that are STRICTLY AFTER that offset.
    // Items are processed in their canonical (fromSurah, fromAyah) order
    // so the "highest offset so far" is a 1-D scan.
    const ordered = items.slice().sort((a, b) => {
      if (a.fromSurah !== b.fromSurah) return a.fromSurah - b.fromSurah;
      return a.fromAyah - b.fromAyah;
    });
    let total = 0;
    let lastEndOffset = -1; // offset of the last ayah already counted
    for (const it of ordered) {
      const startOffset = ayahOffset(it.fromSurah, it.fromAyah);
      const endOffset = ayahOffset(it.toSurah, it.toAyah);
      if (startOffset < 0 || endOffset < startOffset) continue;
      // Count ayahs in (startOffset..endOffset] that are after lastEndOffset.
      const newStart = Math.max(startOffset, lastEndOffset + 1);
      if (newStart > endOffset) continue; // fully covered
      total += (endOffset - newStart + 1);
      if (total > SAFETY_CAP) return SAFETY_CAP;
      lastEndOffset = Math.max(lastEndOffset, endOffset);
    }
    return Math.min(total, SAFETY_CAP);
  }

  // Linear ayah offset (1-indexed): sum of ayahCounts[1..s-1] + a.
  function ayahOffset(surah, ayah) {
    if (surah < 1 || surah > QuranMetaService.TOTAL_SURAHS) return -1;
    let off = 0;
    for (let s = 1; s < surah; s++) off += QuranMetaService.getSurahAyahCount(s);
    return off + ayah;
  }

  /**
   * Number of distinct Juz-1 ayahs covered by the user's memorized items.
   *
   * Juz 1 spans surah 1 ayah 1 through surah 2 ayah 141 — 148 ayahs in
   * total (Al-Fatiha's 7 + the first 141 ayahs of Al-Baqarah). The badge
   * "أول جزء" is granted when this coverage reaches the full 148.
   *
   * Items are walked in canonical (fromSurah, fromAyah) order so the
   * "highest offset so far" is a 1-D scan; overlapping ranges contribute
   * each ayah at most once. This mirrors the dedup logic in
   * `computeTotalMemorizedAyahs`.
   *
   * Returns the count of distinct Juz-1 ayahs covered (capped at 148).
   * Callers compare the result to 148 to decide badge eligibility.
   */
  function computeJuz1CoveredAyahs(state) {
    if (!state || !Array.isArray(state.items) || state.items.length === 0) return 0;
    const JUZ1_START_OFFSET = 1;                          // surah 1, ayah 1
    const JUZ1_END_OFFSET   = ayahOffset(2, 141);         // surah 2, ayah 141
    if (JUZ1_END_OFFSET < JUZ1_START_OFFSET) return 0;
    const ordered = state.items.slice().sort((a, b) => {
      if (a.fromSurah !== b.fromSurah) return a.fromSurah - b.fromSurah;
      return a.fromAyah - b.fromAyah;
    });
    let covered = 0;
    let lastCovered = JUZ1_START_OFFSET - 1;
    for (const it of ordered) {
      const startOffset = ayahOffset(it.fromSurah, it.fromAyah);
      const endOffset = ayahOffset(it.toSurah, it.toAyah);
      if (startOffset < 0 || endOffset < startOffset) continue;
      // Clip the item's range to the Juz 1 window.
      const clipStart = Math.max(startOffset, JUZ1_START_OFFSET);
      const clipEnd = Math.min(endOffset, JUZ1_END_OFFSET);
      if (clipStart > clipEnd) continue;
      const newStart = Math.max(clipStart, lastCovered + 1);
      if (newStart > clipEnd) continue;
      covered += (clipEnd - newStart + 1);
      if (covered >= (JUZ1_END_OFFSET - JUZ1_START_OFFSET + 1)) {
        return JUZ1_END_OFFSET - JUZ1_START_OFFSET + 1;
      }
      lastCovered = Math.max(lastCovered, clipEnd);
    }
    return Math.min(covered, JUZ1_END_OFFSET - JUZ1_START_OFFSET + 1);
  }

  /**
   * Count how many complete juz (parts) the user has memorized.
   * A juz is "complete" when every ayah in its range is covered by at
   * least one memorized item. Uses the global JUZ_DATA array (loaded
   * from data/juz-data.js) for juz boundaries.
   *
   * @returns {number} 0..30
   */
  function computeCompletedJuz(state) {
    if (!state || !Array.isArray(state.items) || state.items.length === 0) return 0;
    if (typeof JUZ_DATA === 'undefined' || !Array.isArray(JUZ_DATA)) return 0;

    const ordered = state.items.slice().sort((a, b) => {
      if (a.fromSurah !== b.fromSurah) return a.fromSurah - b.fromSurah;
      return a.fromAyah - b.fromAyah;
    });

    // Build a sorted list of covered offsets for fast scanning.
    const coveredRanges = ordered.map(it => ({
      start: ayahOffset(it.fromSurah, it.fromAyah),
      end: ayahOffset(it.toSurah, it.toAyah),
    })).filter(r => r.start >= 0 && r.end >= r.start);

    let completed = 0;
    for (let i = 0; i < JUZ_DATA.length; i++) {
      const juzStart = ayahOffset(JUZ_DATA[i].surah, JUZ_DATA[i].ayah);
      const nextEntry = JUZ_DATA[i + 1];
      const juzEnd = nextEntry
        ? ayahOffset(nextEntry.surah, nextEntry.ayah) - 1
        : ayahOffset(114, 6);
      if (juzStart < 0 || juzEnd < juzStart) continue;

      const juzTotal = juzEnd - juzStart + 1;
      let covered = 0;
      let lastCovered = juzStart - 1;
      for (const r of coveredRanges) {
        const clipStart = Math.max(r.start, juzStart);
        const clipEnd = Math.min(r.end, juzEnd);
        if (clipStart > clipEnd) continue;
        const newStart = Math.max(clipStart, lastCovered + 1);
        if (newStart > clipEnd) continue;
        covered += (clipEnd - newStart + 1);
        lastCovered = Math.max(lastCovered, clipEnd);
        if (covered >= juzTotal) break;
      }
      if (covered >= juzTotal) completed++;
    }
    return completed;
  }

  function computeStatusCounts(state) {
    const counts = {
      learning: 0,
      reviewing: 0,
      consolidating: 0,
      stable: 0,
      mastered: 0,
    };
    for (const it of state.items) {
      if (counts[it.status] !== undefined) counts[it.status] += 1;
    }
    return counts;
  }

  function getStatistics(state, _dailyReviewLimit = 10) {
    const overdue = getOverdueItems(state);
    const overdueCount = overdue.length;
    const cap = dailyReviewCap(state);
    const cohort = ensureTodayCohort(state);
    const cohortSize = cohort.length;
    // "Backlog" = overdue items not in today's frozen cohort.
    const backlogCount = Math.max(0, overdueCount - cohortSize);
    return {
      totalMemorizedAyahs: computeTotalMemorizedAyahs(state),
      completedJuz: computeCompletedJuz(state),
      byStatus: computeStatusCounts(state),
      totalReviews: state.stats.totalReviews,
      currentStreak: state.stats.currentStreak,
      longestStreak: state.stats.longestStreak,
      dueReviewCount: cohortSize,
      backlogCount,
      lastCompletedDay: state.stats.lastCompletedDay,
    };
  }

  // -------- activation helpers (not strictly part of the engine core) --------

  function activatePlan(state, opts = {}) {
    const dailyAmount = Math.max(1, Math.trunc(Number(opts.dailyAmount) || 5));
    const reviewCap = (Number.isFinite(opts.reviewCap) && opts.reviewCap >= 1)
      ? Math.max(1, Math.trunc(opts.reviewCap))
      : 3;
    const targetType = (opts.targetType === 'surah' || opts.targetType === 'page')
      ? opts.targetType
      : 'ayahs';
    const direction = (opts.direction === 'backward') ? 'backward' : 'forward';
    const currentSurah = (Number.isInteger(opts.currentSurah) && opts.currentSurah >= 1 && opts.currentSurah <= QuranMetaService.TOTAL_SURAHS)
      ? opts.currentSurah
      : 1;
    const requestedAyah = (Number.isInteger(opts.currentAyah) && opts.currentAyah >= 1) ? opts.currentAyah : 1;
    const surahMax = QuranMetaService.getSurahAyahCount(currentSurah);
    const currentAyah = Math.min(requestedAyah, surahMax);
    state.plan.isActive = true;
    state.plan.targetType = targetType;
    state.plan.dailyAmount = dailyAmount;
    state.plan.reviewCap = reviewCap;
    state.plan.direction = direction;
    state.plan.currentSurah = currentSurah;
    state.plan.currentAyah = currentAyah;
    state.plan.isCompleted = false;
    resetDayCompletionOnPlanEdit(state);
    return state;
  }

  function deactivatePlan(state) {
    state.plan.isActive = false;
    return state;
  }

  /**
   * Reset the per-day "new memorization completed" flag when the user
   * explicitly edits the plan. Returns true iff the flag was reset.
   *
   * Items, badges, stats, and review-schedule state are NEVER touched
   * by plan edits — only the per-day done-flag is, because the user is
   * expressing a new intent for today.
   *
   * The flag is reset whenever `updatePlanPointer` (or `activatePlan`)
   * is called, regardless of whether the resulting range happens to
   * coincide with the previously committed range. A user who edits the
   * plan is asking for a fresh start today; if the new range matches
   * an old one, they can simply click "تم الحفظ" again to recommit.
   */
  function resetDayCompletionOnPlanEdit(state) {
    if (!state || !state.day) return false;
    if (!state.day.newMemorizationCompleted) return false;
    state.day.newMemorizationCompleted = false;
    state.day.todayRange = null;
    return true;
  }

  const VALID_TARGET_TYPES = new Set(['ayahs', 'surah', 'page']);

  /**
   * Mutate only the supplied fields of `state.plan`. Preserves items,
   * badges, stats, and day state. Throws RangeError on invalid input.
   * @returns {object} state
   */
  function updatePlanPointer(state, partial = {}) {
    if (!state || typeof state !== 'object') {
      throw new Error('MemorizationEngine.updatePlanPointer: state is required');
    }
    if (!state.plan || typeof state.plan !== 'object') {
      state.plan = { isActive: false, targetType: 'ayahs', dailyAmount: 5, reviewCap: 3, direction: 'forward', currentSurah: 1, currentAyah: 1, isCompleted: false };
    }
    const plan = state.plan;

    if (partial.targetType !== undefined) {
      if (!VALID_TARGET_TYPES.has(partial.targetType)) {
        throw new RangeError(`MemorizationEngine.updatePlanPointer: invalid targetType "${partial.targetType}"`);
      }
      plan.targetType = partial.targetType;
    }

    if (partial.dailyAmount !== undefined) {
      const n = Math.trunc(Number(partial.dailyAmount));
      if (!Number.isFinite(n) || n < 1) {
        throw new RangeError(`MemorizationEngine.updatePlanPointer: invalid dailyAmount "${partial.dailyAmount}"`);
      }
      plan.dailyAmount = n;
    }

    if (partial.direction !== undefined) {
      plan.direction = (partial.direction === 'backward') ? 'backward' : 'forward';
    }

    if (partial.reviewCap !== undefined) {
      const rc = Math.trunc(Number(partial.reviewCap));
      if (!Number.isFinite(rc) || rc < 1) {
        throw new RangeError(`MemorizationEngine.updatePlanPointer: invalid reviewCap "${partial.reviewCap}"`);
      }
      plan.reviewCap = rc;
    }

    if (partial.currentSurah !== undefined) {
      if (!QuranMetaService.validatePosition(partial.currentSurah, 1)) {
        throw new RangeError(`MemorizationEngine.updatePlanPointer: invalid currentSurah "${partial.currentSurah}"`);
      }
      plan.currentSurah = partial.currentSurah;
    }

    if (partial.currentAyah !== undefined) {
      if (!QuranMetaService.validatePosition(plan.currentSurah, partial.currentAyah)) {
        throw new RangeError(`MemorizationEngine.updatePlanPointer: invalid currentAyah "${partial.currentAyah}" for surah ${plan.currentSurah}`);
      }
      plan.currentAyah = partial.currentAyah;
    }

    // Editing the plan pointer to a valid earlier position re-activates
    // a previously-completed plan so the user can resume from there.
    // The plan is marked complete ONLY when the final range is actually
    // recorded via `completeNewMemorization` — never by the user merely
    // moving the pointer to the last ayah.
    const isForward = plan.direction !== 'backward';
    const isAtBoundary = isForward
      ? (plan.currentSurah === QuranMetaService.TOTAL_SURAHS && plan.currentAyah === QuranMetaService.LAST_AYAHS)
      : (plan.currentSurah === 1 && plan.currentAyah === 1);
    if (!isAtBoundary) {
      plan.isCompleted = false;
    }

    // The user explicitly edited the plan. Reset today's "new memorization
    // completed" flag so the new range is the actionable one for today.
    resetDayCompletionOnPlanEdit(state);

    return state;
  }

  return {
    SCHEMA_VERSION,
    STATUS,
    VALID_STATUSES,
    VALID_RATINGS,
    BADGES,
    createInitialState,
    ensureCurrentDay,
    completeNewMemorization,
    reviewItem,
    resetItem,
    undoLastReview,
    getDailyTaskSummary,
    getDueReviewIds,
    getOverdueItems,
    computeStatus,
    getStatistics,
    computeTotalMemorizedAyahs,
    computeJuz1CoveredAyahs,
    computeCompletedJuz,
    computeStatusCounts,
    activatePlan,
    updatePlanPointer,
    deactivatePlan,
    buildItemId,
    resetAllState,
    dailyReviewCap,
    ensureTodayCohort,
    isDayCompleted,
    awardBadges,
  };
})(
  typeof QuranMetaService !== 'undefined' ? QuranMetaService
    : (typeof require !== 'undefined' ? require('./quranMetaService.js') : null),
  typeof DateUtils !== 'undefined' ? DateUtils
    : (typeof require !== 'undefined' ? require('./dateUtils.js') : null)
);

if (typeof window !== 'undefined') {
  window.MemorizationEngine = MemorizationEngine;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MemorizationEngine;
}