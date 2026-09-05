/**
 * BackupValidator — V3 backup schema validation, migration, and export.
 *
 * Implements progress_plan.md §15 (Backup & Restore) for the memorization
 * state object produced by MemorizationEngine.
 *
 * Three public methods:
 *   - validateBackup(data): check that an incoming JSON (string or object)
 *     is a well-formed V3 state. Returns { valid, error?, sanitizedData? }.
 *     Never throws on invalid input — always returns the result object.
 *   - migrateBackup(rawData): accept legacy V1/V2/unversioned shapes and
 *     produce a clean V3 state. Throws if the input is unrecoverable.
 *   - exportBackup(state): strip private fields, validate, and return a
 *     2-space-indented JSON string ready to write to disk or download.
 *
 * The validator deliberately mirrors the engine's status / badge enums so
 * any drift between the two would surface as a validation failure when
 * importing.
 */
const BackupValidator = ((QuranMetaService, DateUtils) => {
  const SCHEMA_VERSION = 3;

  // Mirror the engine's status enum. If the engine adds a status, add it
  // here — otherwise the validator will reject a perfectly valid state.
  const VALID_STATUSES = new Set([
    'learning', 'reviewing', 'consolidating', 'stable', 'mastered',
  ]);

  // Mirror the engine's plan.targetType enum. Adding a new mode here must
  // also be added in MemorizationEngine.VALID_TARGET_TYPES.
  const VALID_TARGET_TYPES = new Set(['ayahs', 'surah', 'page']);

  // Mirror the engine's badge ids. Any unknown badge string is rejected
  // so users cannot smuggle arbitrary data into a backup file.
  const VALID_BADGES = new Set([
    'first_portion',
    'streak_7',
    'streak_30',
    'ayahs_100',
    'ayahs_500',
    'ayahs_1000',
    'first_mastered',
    'juz_1',
    'juz_5',
    'juz_10',
    'juz_15',
    'juz_20',
    'juz_25',
    'juz_30',
  ]);

  const EASE_MIN = 1.3;
  const EASE_MAX = 3.0;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function isPlainObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  function fail(error) {
    return { valid: false, error };
  }

  function ok(sanitizedData) {
    return { valid: true, sanitizedData };
  }

  function isIsoDateString(s) {
    if (typeof s !== 'string') return false;
    // Local-calendar YYYY-MM-DD only — must round-trip through DateUtils.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    try {
      DateUtils.parseLocalDateString(s);
      return true;
    } catch (e) {
      return false;
    }
  }

  function isNonNegativeInteger(n) {
    return Number.isInteger(n) && n >= 0;
  }

  function isPositiveInteger(n) {
    return Number.isInteger(n) && n >= 1;
  }

  function isBoundedEase(e) {
    return typeof e === 'number' && Number.isFinite(e)
      && e >= EASE_MIN && e <= EASE_MAX;
  }

  function validateQuranPosition(s, a) {
    return QuranMetaService.validatePosition(s, a);
  }

  function buildItemId(fromSurah, fromAyah, toSurah, toAyah) {
    return `${fromSurah}:${fromAyah}-${toSurah}:${toAyah}`;
  }

  // ---------------------------------------------------------------------
  // validateBackup
  // ---------------------------------------------------------------------

  /**
   * Validate a backup. Accepts either a JSON string or an already-parsed
   * object. Returns a result object — never throws.
   * @param {string|object} data
   * @returns {{valid:boolean, error?:string, sanitizedData?:object}}
   */
  function validateBackup(data) {
    if (data === null || data === undefined) {
      return fail('BackupValidator: data is required');
    }

    let parsed = data;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        return fail('BackupValidator: malformed JSON — ' + e.message);
      }
    }

    if (!isPlainObject(parsed)) {
      return fail('BackupValidator: top-level value must be an object');
    }

    if (parsed.version !== SCHEMA_VERSION) {
      return fail(`BackupValidator: unsupported version ${parsed.version} (expected ${SCHEMA_VERSION})`);
    }

    // plan
    if (!isPlainObject(parsed.plan)) return fail('BackupValidator: plan must be an object');
    const plan = parsed.plan;
    if (typeof plan.isActive !== 'boolean') return fail('BackupValidator: plan.isActive must be boolean');
    if (!VALID_TARGET_TYPES.has(plan.targetType)) {
      return fail(`BackupValidator: plan.targetType must be one of ${[...VALID_TARGET_TYPES].join(', ')}`);
    }
    if (!isPositiveInteger(plan.dailyAmount)) return fail('BackupValidator: plan.dailyAmount must be integer >= 1');
    if (typeof plan.isCompleted !== 'boolean') return fail('BackupValidator: plan.isCompleted must be boolean');
    if (!validateQuranPosition(plan.currentSurah, plan.currentAyah)) {
      return fail(`BackupValidator: invalid plan position ${plan.currentSurah}:${plan.currentAyah}`);
    }
    // plan.direction is optional (older V3 exports predate it) and is
    // normalized to 'forward' below. When present it must be a valid
    // value — reject garbage rather than silently flipping the user's
    // memorization direction.
    if (plan.direction !== undefined && plan.direction !== 'forward' && plan.direction !== 'backward') {
      return fail(`BackupValidator: plan.direction must be 'forward' or 'backward', got "${plan.direction}"`);
    }
    // plan.reviewCap is optional (older V3 exports predate it) and is
    // normalized to 3 below. When present it must be a positive integer.
    if (plan.reviewCap !== undefined && plan.reviewCap !== null) {
      if (!isPositiveInteger(plan.reviewCap)) {
        return fail('BackupValidator: plan.reviewCap must be null or integer >= 1');
      }
    }

    // day
    if (!isPlainObject(parsed.day)) return fail('BackupValidator: day must be an object');
    const day = parsed.day;
    if (!isIsoDateString(day.date)) return fail('BackupValidator: day.date must be YYYY-MM-DD');
    if (typeof day.newMemorizationCompleted !== 'boolean') {
      return fail('BackupValidator: day.newMemorizationCompleted must be boolean');
    }
    if (!Array.isArray(day.completedReviewIds)) {
      return fail('BackupValidator: day.completedReviewIds must be an array');
    }
    for (const id of day.completedReviewIds) {
      if (typeof id !== 'string') return fail('BackupValidator: day.completedReviewIds entries must be strings');
    }
    if (day.todayRange !== undefined && day.todayRange !== null && !isPlainObject(day.todayRange)) {
      return fail('BackupValidator: day.todayRange must be an object or null');
    }
    // dueReviewIds (frozen daily review cohort) is optional for backwards
    // compatibility with V3 backups written before this field existed.
    // When present it MUST be an array of strings.
    if (day.dueReviewIds !== undefined) {
      if (!Array.isArray(day.dueReviewIds)) {
        return fail('BackupValidator: day.dueReviewIds must be an array when present');
      }
      for (const id of day.dueReviewIds) {
        if (typeof id !== 'string') {
          return fail('BackupValidator: day.dueReviewIds entries must be strings');
        }
      }
    }

    // stats
    if (!isPlainObject(parsed.stats)) return fail('BackupValidator: stats must be an object');
    const stats = parsed.stats;
    if (!isNonNegativeInteger(stats.currentStreak)) return fail('BackupValidator: stats.currentStreak must be a non-negative integer');
    if (!isNonNegativeInteger(stats.longestStreak)) return fail('BackupValidator: stats.longestStreak must be a non-negative integer');
    if (!isNonNegativeInteger(stats.totalReviews)) return fail('BackupValidator: stats.totalReviews must be a non-negative integer');

    // items
    if (!Array.isArray(parsed.items)) return fail('BackupValidator: items must be an array');
    const sanitizedItems = [];
    for (let i = 0; i < parsed.items.length; i++) {
      const it = parsed.items[i];
      if (!isPlainObject(it)) return fail(`BackupValidator: items[${i}] must be an object`);
      const expectedId = buildItemId(it.fromSurah, it.fromAyah, it.toSurah, it.toAyah);
      if (typeof it.id !== 'string' || it.id !== expectedId) {
        return fail(`BackupValidator: items[${i}].id must equal "${expectedId}", got "${it.id}"`);
      }
      if (!validateQuranPosition(it.fromSurah, it.fromAyah)) {
        return fail(`BackupValidator: items[${i}] has invalid fromSurah:fromAyah ${it.fromSurah}:${it.fromAyah}`);
      }
      if (!validateQuranPosition(it.toSurah, it.toAyah)) {
        return fail(`BackupValidator: items[${i}] has invalid toSurah:toAyah ${it.toSurah}:${it.toAyah}`);
      }
      if (!isNonNegativeInteger(it.repetition)) return fail(`BackupValidator: items[${i}].repetition must be a non-negative integer`);
      if (!isNonNegativeInteger(it.consecutiveSuccesses)) return fail(`BackupValidator: items[${i}].consecutiveSuccesses must be a non-negative integer`);
      if (!isPositiveInteger(it.interval)) return fail(`BackupValidator: items[${i}].interval must be integer >= 1`);
      if (!isBoundedEase(it.easeFactor)) return fail(`BackupValidator: items[${i}].easeFactor must be in [${EASE_MIN}, ${EASE_MAX}]`);
      if (!VALID_STATUSES.has(it.status)) return fail(`BackupValidator: items[${i}].status must be one of ${[...VALID_STATUSES].join(', ')}`);
      if (!isIsoDateString(it.nextReview)) return fail(`BackupValidator: items[${i}].nextReview must be YYYY-MM-DD`);
      if (it.lastReviewed !== null && !isIsoDateString(it.lastReviewed)) {
        return fail(`BackupValidator: items[${i}].lastReviewed must be null or YYYY-MM-DD`);
      }
      sanitizedItems.push({
        id: it.id,
        fromSurah: it.fromSurah,
        fromAyah: it.fromAyah,
        toSurah: it.toSurah,
        toAyah: it.toAyah,
        repetition: it.repetition,
        consecutiveSuccesses: it.consecutiveSuccesses,
        interval: it.interval,
        easeFactor: it.easeFactor,
        lastReviewed: it.lastReviewed,
        nextReview: it.nextReview,
        status: it.status,
      });
    }

    // badges
    if (!Array.isArray(parsed.badges)) return fail('BackupValidator: badges must be an array');
    const sanitizedBadges = [];
    for (let i = 0; i < parsed.badges.length; i++) {
      const b = parsed.badges[i];
      if (typeof b !== 'string') return fail(`BackupValidator: badges[${i}] must be a string`);
      if (!VALID_BADGES.has(b)) return fail(`BackupValidator: badges[${i}] "${b}" is not a known badge id`);
      sanitizedBadges.push(b);
    }

    // Build the sanitized copy. Use DateUtils.getLocalDateString() for `today`
    // when the migrated state needs a fresh day, but we don't have to — the
    // caller already provided day.date. We keep it.
    const sanitized = {
      version: SCHEMA_VERSION,
      plan: {
        isActive: plan.isActive,
        targetType: plan.targetType,
        dailyAmount: plan.dailyAmount,
        reviewCap: (Number.isFinite(plan.reviewCap) && plan.reviewCap >= 1)
          ? Math.trunc(plan.reviewCap) : 3,
        direction: plan.direction === 'backward' ? 'backward' : 'forward',
        currentSurah: plan.currentSurah,
        currentAyah: plan.currentAyah,
        isCompleted: plan.isCompleted,
      },
      day: {
        date: day.date,
        newMemorizationCompleted: day.newMemorizationCompleted,
        todayRange: (isPlainObject(day.todayRange) && typeof day.todayRange.fromSurah === 'number')
          ? {
              fromSurah: day.todayRange.fromSurah,
              fromAyah: day.todayRange.fromAyah,
              toSurah: day.todayRange.toSurah,
              toAyah: day.todayRange.toAyah,
              count: day.todayRange.count,
              isCompleted: !!day.todayRange.isCompleted,
            }
          : null,
        completedReviewIds: day.completedReviewIds.slice(),
        // Default the frozen cohort to []. The engine re-establishes it
        // lazily on first access, so importing an older backup is safe.
        dueReviewIds: Array.isArray(day.dueReviewIds)
          ? day.dueReviewIds.filter(id => typeof id === 'string')
          : [],
      },
      stats: {
        currentStreak: stats.currentStreak,
        longestStreak: stats.longestStreak,
        totalReviews: stats.totalReviews,
        lastCompletedDay: typeof stats.lastCompletedDay === 'string'
          && isIsoDateString(stats.lastCompletedDay)
            ? stats.lastCompletedDay
            : null,
      },
      items: sanitizedItems,
      badges: sanitizedBadges,
    };

    return ok(sanitized);
  }

  // ---------------------------------------------------------------------
  // migrateBackup
  // ---------------------------------------------------------------------

  /**
   * Migrate legacy / unversioned state to V3. Throws if the data is so
   * corrupted it cannot be repaired (null/primitive input, items with
   * invalid Quran positions, completely missing structure).
   * @param {object} rawData
   * @returns {object} a V3 state ready to be passed to validateBackup
   */
  function migrateBackup(rawData) {
    if (!isPlainObject(rawData)) {
      throw new Error('BackupValidator.migrateBackup: input must be an object');
    }

    const src = rawData;

    // plan: preserve valid sub-fields, default the rest.
    const srcPlan = isPlainObject(src.plan) ? src.plan : {};
    const plan = {
      isActive: typeof srcPlan.isActive === 'boolean' ? srcPlan.isActive : false,
      targetType: VALID_TARGET_TYPES.has(srcPlan.targetType) ? srcPlan.targetType : 'ayahs',
      dailyAmount: isPositiveInteger(srcPlan.dailyAmount) ? srcPlan.dailyAmount : 5,
      reviewCap: isPositiveInteger(srcPlan.reviewCap) ? srcPlan.reviewCap : 3,
      direction: (srcPlan.direction === 'backward') ? 'backward' : 'forward',
      currentSurah: Number.isInteger(srcPlan.currentSurah) ? srcPlan.currentSurah : 1,
      currentAyah: Number.isInteger(srcPlan.currentAyah) ? srcPlan.currentAyah : 1,
      isCompleted: typeof srcPlan.isCompleted === 'boolean' ? srcPlan.isCompleted : false,
    };
    // If the caller stored an out-of-range position, repair it back to (1,1).
    if (!validateQuranPosition(plan.currentSurah, plan.currentAyah)) {
      plan.currentSurah = 1;
      plan.currentAyah = 1;
    }

    // day: ensure a valid YYYY-MM-DD date.
    const srcDay = isPlainObject(src.day) ? src.day : {};
    const dayDate = isIsoDateString(srcDay.date)
      ? srcDay.date
      : DateUtils.getLocalDateString();
    const day = {
      date: dayDate,
      newMemorizationCompleted: typeof srcDay.newMemorizationCompleted === 'boolean'
        ? srcDay.newMemorizationCompleted
        : false,
      todayRange: (isPlainObject(srcDay.todayRange) && typeof srcDay.todayRange.fromSurah === 'number')
        ? {
            fromSurah: srcDay.todayRange.fromSurah,
            fromAyah: srcDay.todayRange.fromAyah,
            toSurah: srcDay.todayRange.toSurah,
            toAyah: srcDay.todayRange.toAyah,
            count: srcDay.todayRange.count,
            isCompleted: !!srcDay.todayRange.isCompleted,
          }
        : null,
      completedReviewIds: Array.isArray(srcDay.completedReviewIds)
        ? srcDay.completedReviewIds.filter(id => typeof id === 'string')
        : [],
      // Older V3 backups may not carry the frozen review cohort. Default
      // to []. The engine populates this field lazily on first access,
      // so migration is safe for legacy backups.
      dueReviewIds: Array.isArray(srcDay.dueReviewIds)
        ? srcDay.dueReviewIds.filter(id => typeof id === 'string')
        : [],
    };

    // stats: repair negatives into zeros; default missing keys to 0.
    const srcStats = isPlainObject(src.stats) ? src.stats : {};
    const stats = {
      currentStreak: isNonNegativeInteger(srcStats.currentStreak) ? srcStats.currentStreak : 0,
      longestStreak: isNonNegativeInteger(srcStats.longestStreak) ? srcStats.longestStreak : 0,
      totalReviews: isNonNegativeInteger(srcStats.totalReviews) ? srcStats.totalReviews : 0,
      lastCompletedDay: isIsoDateString(srcStats.lastCompletedDay) ? srcStats.lastCompletedDay : null,
    };

    // items: walk and repair, drop unrecoverable entries (throw the whole
    // migration only if ZERO items survive AND items was provided non-empty
    // — i.e. caller handed us a non-empty items array of all garbage).
    const srcItems = Array.isArray(src.items) ? src.items : [];
    const migratedItems = [];
    for (let i = 0; i < srcItems.length; i++) {
      const raw = srcItems[i];
      if (!isPlainObject(raw)) continue;
      const fromSurah = Number.isInteger(raw.fromSurah) ? raw.fromSurah : null;
      const fromAyah = Number.isInteger(raw.fromAyah) ? raw.fromAyah : null;
      const toSurah = Number.isInteger(raw.toSurah) ? raw.toSurah : null;
      const toAyah = Number.isInteger(raw.toAyah) ? raw.toAyah : null;
      if (!validateQuranPosition(fromSurah, fromAyah)) continue;
      if (!validateQuranPosition(toSurah, toAyah)) continue;

      const easeRaw = typeof raw.easeFactor === 'number' && Number.isFinite(raw.easeFactor)
        ? raw.easeFactor
        : 2.5;
      const easeFactor = Math.min(EASE_MAX, Math.max(EASE_MIN, easeRaw));

      const intervalRaw = Number.isInteger(raw.interval) ? raw.interval : 1;
      const interval = Math.max(1, intervalRaw);

      const repetition = isNonNegativeInteger(raw.repetition) ? raw.repetition : 0;
      const consecutiveSuccesses = isNonNegativeInteger(raw.consecutiveSuccesses)
        ? raw.consecutiveSuccesses
        : 0;

      const nextReview = isIsoDateString(raw.nextReview) ? raw.nextReview : dayDate;
      const lastReviewed = raw.lastReviewed === null || isIsoDateString(raw.lastReviewed)
        ? raw.lastReviewed
        : null;

      const status = VALID_STATUSES.has(raw.status) ? raw.status : 'learning';

      migratedItems.push({
        id: buildItemId(fromSurah, fromAyah, toSurah, toAyah),
        fromSurah, fromAyah, toSurah, toAyah,
        repetition,
        consecutiveSuccesses,
        interval,
        easeFactor,
        lastReviewed,
        nextReview,
        status,
      });
    }

    // If the source claimed to have items but NONE survived repair, the
    // data is unrecoverable — refuse rather than silently return empty.
    if (srcItems.length > 0 && migratedItems.length === 0) {
      throw new Error('BackupValidator.migrateBackup: all items failed validation; cannot repair');
    }

    // badges: keep only known ids.
    const srcBadges = Array.isArray(src.badges) ? src.badges : [];
    const badges = srcBadges.filter(b => typeof b === 'string' && VALID_BADGES.has(b));

    return {
      version: SCHEMA_VERSION,
      plan,
      day,
      stats,
      items: migratedItems,
      badges,
    };
  }

  // ---------------------------------------------------------------------
  // exportBackup
  // ---------------------------------------------------------------------

  /**
   * Produce a portable JSON string of the given state.
   *
   * Strips private fields such as `_undoSnapshot` so the export is safe to
   * share. Validates before exporting — if the state is somehow invalid,
   * the validation error message is returned via the thrown Error.
   * @param {object} state
   * @returns {string}
   */
  function exportBackup(state) {
    if (!isPlainObject(state)) {
      throw new Error('BackupValidator.exportBackup: state must be an object');
    }
    const stripped = JSON.parse(JSON.stringify(state));
    delete stripped._undoSnapshot;
    const res = validateBackup(stripped);
    if (!res.valid) {
      throw new Error('BackupValidator.exportBackup: cannot export invalid state — ' + res.error);
    }
    return JSON.stringify(res.sanitizedData, null, 2);
  }

  return {
    SCHEMA_VERSION,
    VALID_STATUSES,
    VALID_BADGES,
    EASE_MIN,
    EASE_MAX,
    validateBackup,
    migrateBackup,
    exportBackup,
  };
})(
  typeof QuranMetaService !== 'undefined' ? QuranMetaService
    : (typeof require !== 'undefined' ? require('./quranMetaService.js') : null),
  typeof DateUtils !== 'undefined' ? DateUtils
    : (typeof require !== 'undefined' ? require('./dateUtils.js') : null)
);

if (typeof window !== 'undefined') {
  window.BackupValidator = BackupValidator;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BackupValidator;
}