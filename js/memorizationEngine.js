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
  });

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
        currentSurah: 1,
        currentAyah: 1,
        isCompleted: false,
      },
      day: {
        date: today,
        newMemorizationCompleted: false,
        todayRange: null,
        completedReviewIds: [],
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
   * must NOT leak into the new day.
   */
  function ensureCurrentDay(state, currentLocalDate = DateUtils.getLocalDateString()) {
    if (!state || typeof state !== 'object') {
      throw new Error('MemorizationEngine: state is required');
    }
    if (!state.day || typeof state.day !== 'object') {
      state.day = {};
    }
    // Backwards compat: old state may lack todayRange.
    if (!('todayRange' in state.day)) {
      state.day.todayRange = null;
    }
    if (state.day.date !== currentLocalDate) {
      state.day = {
        date: currentLocalDate,
        newMemorizationCompleted: false,
        todayRange: null,
        completedReviewIds: [],
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
    if (plan.targetType === 'surah') {
      return QuranMetaService.calculateNextSurahRange(plan.currentSurah, plan.currentAyah);
    }
    if (plan.targetType === 'page') {
      const page = QuranMetaService.getPageOf(plan.currentSurah, plan.currentAyah);
      if (page == null) return null;
      return QuranMetaService.calculateNextPageRange(page);
    }
    return QuranMetaService.calculateNextAyahRange(
      plan.currentSurah, plan.currentAyah, plan.dailyAmount
    );
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

    const totalAyahs = computeTotalMemorizedAyahs(state);
    if (totalAyahs >= 1) earned.add(BADGES.FIRST_PORTION);
    if (totalAyahs >= 100) earned.add(BADGES.AYAHS_100);
    if (totalAyahs >= 500) earned.add(BADGES.AYAHS_500);
    if (totalAyahs >= 1000) earned.add(BADGES.AYAHS_1000);

    if (state.stats.currentStreak >= 7) earned.add(BADGES.STREAK_7);
    if (state.stats.currentStreak >= 30) earned.add(BADGES.STREAK_30);

    const masteredCount = state.items.filter(it => it.status === STATUS.MASTERED).length;
    if (masteredCount >= 1) earned.add(BADGES.FIRST_MASTERED);

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
   * Has today's review+new-memorization quota been satisfied?
   * Active plan : new memorization AND all currently due reviews done.
   * Inactive    : all currently due reviews done.
   */
  function isDayCompleted(state, dailyReviewLimit = 10) {
    const due = getDueReviewIds(state, dailyReviewLimit);
    if (state.plan.isActive && !state.day.newMemorizationCompleted) return false;
    for (const id of due) {
      if (!state.day.completedReviewIds.includes(id)) return false;
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

    const id = buildItemId(range.fromSurah, range.fromAyah, range.toSurah, range.toAyah);
    const existing = findItem(state, id);
    if (existing) {
      // Dedup guard: this range was already recorded (e.g. from a prior
      // session or plan position). The item is NOT re-created, but the
      // pointer MUST still advance — the user explicitly clicked "تم الحفظ".
      const next = QuranMetaService.getNextPosition(range.toSurah, range.toAyah);
      if (next) {
        plan.currentSurah = next.surah;
        plan.currentAyah = next.ayah;
      } else {
        plan.isCompleted = true;
      }
      state.day.newMemorizationCompleted = true;
      if (isDayCompleted(state)) {
        tryAdvanceStreak(state);
      }
      return existing;
    }

    // Snapshot for one-level undo.
    state._undoSnapshot = takeSnapshot(state);

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

    // Advance pointer to the position immediately AFTER the just-committed range.
    const next = QuranMetaService.getNextPosition(range.toSurah, range.toAyah);
    if (next) {
      plan.currentSurah = next.surah;
      plan.currentAyah = next.ayah;
    } else {
      plan.isCompleted = true;
    }
    if (range.isCompleted) {
      plan.isCompleted = true;
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
   */
  function reviewItem(state, itemId, rating) {
    ensureCurrentDay(state);
    if (!VALID_RATINGS.has(rating)) {
      throw new Error('MemorizationEngine: invalid rating ' + rating);
    }
    const item = findItem(state, itemId);
    if (!item) {
      throw new Error('MemorizationEngine: unknown item ' + itemId);
    }
    const today = state.day.date;

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
    if (isDayCompleted(state)) {
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
   * IDs of items that should be reviewed today. Honors `dailyReviewLimit`
   * by surfacing the highest-priority slice of the overdue list. Items
   * NOT in the slice are NOT marked done — they remain due.
   */
  function getDueReviewIds(state, dailyReviewLimit = 10) {
    const overdue = getOverdueItems(state);
    return overdue.slice(0, Math.max(0, dailyReviewLimit)).map(it => it.id);
  }

  /**
   * Build the UI-facing summary for today.
   */
  function getDailyTaskSummary(state, dailyReviewLimit = 10) {
    ensureCurrentDay(state);
    const overdue = getOverdueItems(state);
    const dueIds = overdue.slice(0, Math.max(0, dailyReviewLimit)).map(it => it.id);
    const remainingIds = overdue.slice(dailyReviewLimit).map(it => it.id);

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
          state.day.todayRange = { ...newMemorization };
        }
      }
    }

    const dueReviews = state.items.filter(it => dueIds.includes(it.id));
    const completedReviewIds = state.day.completedReviewIds.slice();
    const remainingReviewIds = remainingIds;
    const allReviewsCompleted = dueIds.every(id => completedReviewIds.includes(id));
    const dayCompleted = isDayCompleted(state, dailyReviewLimit);
    const streak = state.stats.currentStreak;

    return {
      date: state.day.date,
      newMemorization,
      dueReviews,
      completedReviewIds,
      remainingReviewIds,
      newMemorizationCompleted,
      allReviewsCompleted,
      dayCompleted,
      streak,
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

  function computeTotalMemorizedAyahs(state) {
    let total = 0;
    for (const it of state.items) {
      total += countAyahsInRange(it.fromSurah, it.fromAyah, it.toSurah, it.toAyah);
    }
    return total;
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

  function getStatistics(state, dailyReviewLimit = 10) {
    return {
      totalMemorizedAyahs: computeTotalMemorizedAyahs(state),
      byStatus: computeStatusCounts(state),
      totalReviews: state.stats.totalReviews,
      currentStreak: state.stats.currentStreak,
      longestStreak: state.stats.longestStreak,
      dueReviewCount: getOverdueItems(state).length,
      backlogCount: Math.max(0, getOverdueItems(state).length - dailyReviewLimit),
      lastCompletedDay: state.stats.lastCompletedDay,
    };
  }

  // -------- activation helpers (not strictly part of the engine core) --------

  function activatePlan(state, opts = {}) {
    const dailyAmount = Math.max(1, Math.trunc(Number(opts.dailyAmount) || 5));
    const targetType = (opts.targetType === 'surah' || opts.targetType === 'page')
      ? opts.targetType
      : 'ayahs';
    const currentSurah = (Number.isInteger(opts.currentSurah) && opts.currentSurah >= 1 && opts.currentSurah <= QuranMetaService.TOTAL_SURAHS)
      ? opts.currentSurah
      : 1;
    const requestedAyah = (Number.isInteger(opts.currentAyah) && opts.currentAyah >= 1) ? opts.currentAyah : 1;
    const surahMax = QuranMetaService.getSurahAyahCount(currentSurah);
    const currentAyah = Math.min(requestedAyah, surahMax);
    state.plan.isActive = true;
    state.plan.targetType = targetType;
    state.plan.dailyAmount = dailyAmount;
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
      state.plan = { isActive: false, targetType: 'ayahs', dailyAmount: 5, currentSurah: 1, currentAyah: 1, isCompleted: false };
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

    if (plan.currentSurah === QuranMetaService.TOTAL_SURAHS
        && plan.currentAyah === QuranMetaService.LAST_AYAHS) {
      plan.isCompleted = true;
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
    computeStatusCounts,
    activatePlan,
    updatePlanPointer,
    deactivatePlan,
    buildItemId,
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