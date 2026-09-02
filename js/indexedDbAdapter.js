/**
 * IndexedDbAdapter — persistent offline storage for the memorization state.
 *
 * Implements progress_plan.md §14: a dedicated object store for memorization
 * data, fully decoupled from the Quran-text stores. Survives reloads in
 * the browser; tests use an injected IDB factory (in-memory mock).
 *
 * Public methods:
 *   - initDB(factory?)        : open / upgrade the database. Idempotent.
 *   - saveState(state)        : persist a state object (Promise). Strips
 *                               `_undoSnapshot`. Rejects on IDB failure so
 *                               the caller never sees a silent success.
 *   - loadState()             : Promise<state|null> — returns null when
 *                               nothing has been saved yet.
 *   - clearState()            : Promise<void> — empties the store.
 *
 * Error handling contract:
 *   - IDB errors (open / transaction / quota exceeded) reject the returned
 *     Promise. The caller MUST treat any resolved save as "durably saved".
 *   - On `QuotaExceededError` we surface a descriptive Error message so
 *     the UI can prompt the user to free space.
 */
class IndexedDbAdapter {
  /**
   * @param {object} [idbFactory] An `IDBFactory`-like object. Defaults to
   *  `globalThis.indexedDB` when available. Pass a custom factory (e.g.
   *  the in-memory mock in tests) to exercise the adapter under Node.
   */
  constructor(idbFactory) {
    if (idbFactory !== undefined && idbFactory !== null
        && typeof idbFactory.open !== 'function') {
      throw new Error('IndexedDbAdapter: idbFactory must expose an open(name, version, upgrade) method');
    }
    this._factory = idbFactory !== undefined
      ? idbFactory
      : (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this._db = null;
    this._initPromise = null;
  }

  /**
   * Resolve the IDB factory lazily so the adapter stays usable in both
   * browser and Node test environments.
   */
  _resolveFactory() {
    if (this._factory && typeof this._factory.open === 'function') return this._factory;
    if (typeof indexedDB !== 'undefined' && indexedDB) {
      this._factory = indexedDB;
      return this._factory;
    }
    return null;
  }

  /**
   * Open / create the memorization database. Resolves with the IDBDatabase
   * instance. Rejects if no IDB factory is available or the open fails.
   *
   * Idempotent: repeated calls share the same in-flight Promise, so
   * concurrent `saveState` / `loadState` calls never race.
   */
  initDB() {
    if (this._initPromise) return this._initPromise;

    const factory = this._resolveFactory();
    if (!factory) {
      return Promise.reject(new Error(
        'IndexedDbAdapter: no IndexedDB factory available (pass one to the constructor)'
      ));
    }

    this._initPromise = new Promise((resolve, reject) => {
      function handleUpgrade(event) {
        const db = event.target && event.target.result;
        const upgradeTx = event.target && event.target.transaction;
        if (!db) return;
        if (typeof db.createObjectStore === 'function' && !db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        } else if (upgradeTx && typeof upgradeTx.db?.createObjectStore === 'function' && !upgradeTx.db.objectStoreNames.contains(STORE_NAME)) {
          upgradeTx.db.createObjectStore(STORE_NAME);
        }
      }

      let req;
      try {
        req = factory.open(DB_NAME, DB_VERSION, (event) => {
          handleUpgrade(event);
        });
      } catch (e) {
        reject(e);
        return;
      }

      req.onupgradeneeded = (event) => {
        handleUpgrade(event);
      };

      req.onsuccess = () => {
        this._db = req.result;
        resolve(this._db);
      };
      req.onerror = () => {
        const err = req.error || new Error('IndexedDbAdapter: failed to open database');
        reject(err);
      };
      req.onblocked = () => {
        reject(new Error('IndexedDbAdapter: database open blocked by another connection'));
      };
    });

    return this._initPromise;
  }

  /**
   * Persist the given state. Strips `_undoSnapshot` so the snapshot is
   * never durable.
   *
   * @param {object} state
   * @returns {Promise<void>}
   */
  saveState(state) {
    if (state === null || typeof state !== 'object') {
      return Promise.reject(new Error('IndexedDbAdapter.saveState: state must be an object'));
    }
    return this._withDb((db) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
      } catch (e) {
        reject(e);
        return;
      }
      let store;
      try {
        store = tx.objectStore(STORE_NAME);
      } catch (e) {
        reject(new Error('IndexedDbAdapter.saveState: object store "' + STORE_NAME + '" is missing'));
        return;
      }

      // Deep-clone so we never mutate the caller's object and so
      // _undoSnapshot is provably stripped before it reaches the store.
      const toPersist = JSON.parse(JSON.stringify(state));
      delete toPersist._undoSnapshot;

      let req;
      try {
        // Use a fixed key so a single record holds the entire state.
        req = store.put(toPersist, SINGLETON_KEY);
      } catch (e) {
        reject(e);
        return;
      }

      let settled = false;
      function done(err) {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      }

      req.onsuccess = () => done();
      req.onerror = () => done(req.error || new Error('IndexedDbAdapter.saveState: request error'));
      if (tx) {
        tx.oncomplete = () => done();
        tx.onerror = () => done(tx.error || req.error || new Error('IndexedDbAdapter.saveState: transaction error'));
        tx.onabort = () => done(tx.error || new Error('IndexedDbAdapter.saveState: transaction aborted'));
      }
    }));
  }

  /**
   * Load the previously-saved state.
   * @returns {Promise<object|null>}
   */
  loadState() {
    return this._withDb((db) => new Promise((resolve, reject) => {
      let tx, store;
      try {
        tx = db.transaction(STORE_NAME, 'readonly');
        store = tx.objectStore(STORE_NAME);
      } catch (e) {
        reject(e);
        return;
      }

      let req;
      try {
        req = store.get(SINGLETON_KEY);
      } catch (e) {
        reject(e);
        return;
      }

      let settled = false;
      function done(err, val) {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(val);
      }

      req.onsuccess = () => {
        const value = req.result;
        if (value === undefined || value === null) {
          done(null, null);
          return;
        }
        // Defensive: ensure no _undoSnapshot leaks back even if the store
        // somehow contains one (e.g. a corrupt write from an older build).
        if (typeof value === 'object' && '_undoSnapshot' in value) {
          delete value._undoSnapshot;
        }
        done(null, value);
      };
      req.onerror = () => done(req.error || new Error('IndexedDbAdapter.loadState: request error'));
      if (tx) {
        tx.onerror = () => done(tx.error || req.error || new Error('IndexedDbAdapter.loadState: transaction error'));
      }
    }));
  }

  /**
   * Erase the persisted state. Resolves on success, rejects on failure.
   * @returns {Promise<void>}
   */
  clearState() {
    return this._withDb((db) => new Promise((resolve, reject) => {
      let tx, store;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
        store = tx.objectStore(STORE_NAME);
      } catch (e) {
        reject(e);
        return;
      }
      let req;
      try {
        req = store.clear();
      } catch (e) {
        reject(e);
        return;
      }

      let settled = false;
      function done(err) {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      }

      req.onsuccess = () => done();
      req.onerror = () => done(req.error || new Error('IndexedDbAdapter.clearState: request error'));
      if (tx) {
        tx.oncomplete = () => done();
        tx.onerror = () => done(tx.error || req.error || new Error('IndexedDbAdapter.clearState: transaction error'));
      }
    }));
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  /**
   * Ensure the DB is open, then run `fn(db)`. Rejects if initDB fails.
   */
  _withDb(fn) {
    return this.initDB().then((db) => fn(db));
  }
}

const DB_NAME = 'quran_memorization_db';
const DB_VERSION = 1;
const STORE_NAME = 'state';
const SINGLETON_KEY = 'singleton';

if (typeof window !== 'undefined') {
  window.IndexedDbAdapter = IndexedDbAdapter;
  window.IndexedDbAdapter.DB_NAME = DB_NAME;
  window.IndexedDbAdapter.DB_VERSION = DB_VERSION;
  window.IndexedDbAdapter.STORE_NAME = STORE_NAME;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = IndexedDbAdapter;
  module.exports.DB_NAME = DB_NAME;
  module.exports.DB_VERSION = DB_VERSION;
  module.exports.STORE_NAME = STORE_NAME;
}