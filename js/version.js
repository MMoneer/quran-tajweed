/**
 * APP_VERSION — the user-facing release version (semantic versioning).
 *
 * Bump ONLY on releases, not on every change:
 *   - major (2.0.0): breaking change / data migration users must know about
 *   - minor (x.Y.0): new feature (e.g. bookmarks)
 *   - patch (x.y.Z): bug fixes only
 *
 * This is SEPARATE from the Service Worker CACHE_VERSION in sw.js, which is
 * an internal counter bumped on EVERY asset change (even a one-line CSS fix)
 * so offline clients reliably fetch fresh files. Users never see it.
 */
const APP_VERSION = '1.4.0';
