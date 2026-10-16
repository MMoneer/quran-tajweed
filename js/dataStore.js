/**
 * IndexedDB Storage Layer for Quran Data
 * Stores surah data and chapters list for offline use.
 */
const DataStore = (() => {
  const DB_NAME = 'quran_tajweed_db';
  const DB_VERSION = 4;
  let db = null;

  /**
   * Open/upgrade the database and return it
   * @returns {Promise<IDBDatabase>}
   */
  function initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        const oldVersion = event.oldVersion;

        // Destructive helper — see migration policy at the bottom of this handler.
        const recreateStore = (name, keyPath) => {
          if (database.objectStoreNames.contains(name)) {
            database.deleteObjectStore(name);
          }
          database.createObjectStore(name, { keyPath });
        };

        if (!database.objectStoreNames.contains('chapters')) {
          database.createObjectStore('chapters', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('surahs')) {
          database.createObjectStore('surahs', { keyPath: 'surah_id' });
        }
        if (!database.objectStoreNames.contains('search_index')) {
          database.createObjectStore('search_index', { keyPath: 'surah_id' });
        }

        // v3: invalidate search index (entries now carry normalizedAlt)
        if (oldVersion < 3) {
          recreateStore('search_index', 'surah_id');
        }

        // v4: search now uses text_imlaei_simple + new normalization.
        // v3-era cached surahs lack text_imlaei_simple, so the verse records
        // themselves are invalid, not just the index — hence both are wiped.
        if (oldVersion < 4) {
          recreateStore('search_index', 'surah_id');
          recreateStore('surahs', 'surah_id');
        }

        // ── Migration policy for future DB_VERSION bumps (5+) ──────────────
        // Deleting `surahs` forces every user to re-download ~96 MB of Quran
        // data — unrecoverable while offline, painful on metered connections.
        // Default for any new bump: invalidate ONLY search_index, which is
        // rebuildable lazily from whatever surahs are stored locally
        // (recreateStore('search_index', 'surah_id')).
        // Never delete `surahs` unless the stored verse record schema itself
        // changed; if it must, say so in the release notes first so users
        // know a full re-download is coming.
      };

      request.onsuccess = (event) => {
        db = event.target.result;
        resolve(db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Generic transaction helper
   * @param {string} storeName
   * @param {string} mode - 'readonly' or 'readwrite'
   * @returns {IDBObjectStore}
   */
  function getStore(storeName, mode = 'readonly') {
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  /**
   * Save the full chapters list as a single record
   * @param {Array} chapters - Array of chapter objects
   * @returns {Promise<void>}
   */
  function saveChapters(chapters) {
    return new Promise((resolve, reject) => {
      const store = getStore('chapters', 'readwrite');
      const request = store.put({ id: 'list', data: chapters });
      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        console.error('Error saving chapters:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Retrieve the chapters list
   * @returns {Promise<Array|null>}
   */
  function getChapters() {
    return new Promise((resolve, reject) => {
      const store = getStore('chapters');
      const request = store.get('list');
      request.onsuccess = (event) => {
        const result = event.target.result;
        resolve(result ? result.data : null);
      };
      request.onerror = (event) => {
        console.error('Error getting chapters:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Save one surah's data
   * @param {Object} surahData - Must include surah_id property
   * @returns {Promise<void>}
   */
  function saveSurah(surahData) {
    return new Promise((resolve, reject) => {
      const store = getStore('surahs', 'readwrite');
      const request = store.put(surahData);
      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        console.error('Error saving surah:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Retrieve one surah's data
   * @param {number} surahId
   * @returns {Promise<Object|null>}
   */
  function getSurah(surahId) {
    return new Promise((resolve, reject) => {
      const store = getStore('surahs');
      const request = store.get(surahId);
      request.onsuccess = (event) => {
        resolve(event.target.result || null);
      };
      request.onerror = (event) => {
        console.error('Error getting surah:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Check if data exists (chapters list + at least one surah)
   * @returns {Promise<boolean>}
   */
  function hasData() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['chapters', 'surahs'], 'readonly');
      const chaptersStore = tx.objectStore('chapters');
      const surahsStore = tx.objectStore('surahs');

      let chaptersExist = false;
      let surahExists = false;

      const chaptersReq = chaptersStore.count();
      chaptersReq.onsuccess = () => {
        chaptersExist = chaptersReq.result > 0;
      };

      const surahsReq = surahsStore.count();
      surahsReq.onsuccess = () => {
        surahExists = surahsReq.result > 0;
      };

      tx.oncomplete = () => resolve(chaptersExist && surahExists);
      tx.onerror = (event) => {
        console.error('Error checking hasData:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Get list of surah IDs already imported
   * @returns {Promise<number[]>}
   */
  function getImportedSurahIds() {
    return new Promise((resolve, reject) => {
      const store = getStore('surahs');
      const request = store.getAllKeys();
      request.onsuccess = (event) => {
        resolve(event.target.result);
      };
      request.onerror = (event) => {
        console.error('Error getting imported surah IDs:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Save one surah's search index record
   * @param {number} surahId
   * @param {Array} entries - Array of { ayah, verse_id, normalized }
   * @returns {Promise<void>}
   */
  function saveSearchIndex(surahId, entries) {
    return new Promise((resolve, reject) => {
      const store = getStore('search_index', 'readwrite');
      const request = store.put({ surah_id: surahId, entries });
      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        console.error('Error saving search index:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Retrieve all search index records
   * @returns {Promise<Array>} Array of { surah_id, entries }
   */
  function getSearchIndex() {
    return new Promise((resolve, reject) => {
      const store = getStore('search_index');
      const request = store.getAll();
      request.onsuccess = (event) => resolve(event.target.result || []);
      request.onerror = (event) => {
        console.error('Error getting search index:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Get surah IDs that already have a search index record
   * @returns {Promise<number[]>}
   */
  function getIndexedSurahIds() {
    return new Promise((resolve, reject) => {
      const store = getStore('search_index');
      const request = store.getAllKeys();
      request.onsuccess = (event) => resolve(event.target.result || []);
      request.onerror = (event) => {
        console.error('Error getting indexed surah IDs:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Wipe the search index store
   * @returns {Promise<void>}
   */
  function clearSearchIndex() {
    return new Promise((resolve, reject) => {
      const store = getStore('search_index', 'readwrite');
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        console.error('Error clearing search index:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Wipe all data from every store
   * @returns {Promise<void>}
   */
  function clearAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['chapters', 'surahs', 'search_index'], 'readwrite');
      tx.objectStore('chapters').clear();
      tx.objectStore('surahs').clear();
      tx.objectStore('search_index').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => {
        console.error('Error clearing data:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  return {
    initDB,
    saveChapters,
    getChapters,
    saveSurah,
    getSurah,
    hasData,
    getImportedSurahIds,
    saveSearchIndex,
    getSearchIndex,
    getIndexedSurahIds,
    clearSearchIndex,
    clearAll
  };
})();
