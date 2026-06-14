/**
 * db.js — IndexedDB wrapper for the Google Calendar PWA.
 *
 * DB name: gcal-pwa  |  version: 1
 * Object stores:
 *   events     – keyPath: id
 *   calendars  – keyPath: id
 *   meta       – keyPath: key
 */

const DB = (() => {
  const DB_NAME = 'gcal-pwa';
  const DB_VERSION = 1;

  let _db = null;

  // ── Open / Cache DB Instance ──────────────────────────────────────────────

  function openDB() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('events')) {
          db.createObjectStore('events', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('calendars')) {
          db.createObjectStore('calendars', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        _db = e.target.result;

        // Re-open if the connection is invalidated (e.g., version bump from another tab).
        _db.onversionchange = () => {
          _db.close();
          _db = null;
        };

        resolve(_db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ── Transaction Helper ────────────────────────────────────────────────────

  /**
   * Run a callback against a transaction on one or more stores.
   * @param {string|string[]} storeNames
   * @param {'readonly'|'readwrite'} mode
   * @param {(tx: IDBTransaction) => IDBRequest|void} callback — return the
   *   IDBRequest whose result you want, or nothing for fire-and-forget.
   * @returns {Promise<any>}
   */
  function withTx(storeNames, mode, callback) {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        tx.onerror = () => reject(tx.error);

        const req = callback(tx);

        if (req && typeof req.onsuccess !== 'undefined') {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          // For operations where we don't need a result value, resolve on commit.
          tx.oncomplete = () => resolve(undefined);
        }
      });
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────

  function putEvent(event) {
    return withTx('events', 'readwrite', (tx) =>
      tx.objectStore('events').put(event)
    );
  }

  function deleteEvent(id) {
    return withTx('events', 'readwrite', (tx) =>
      tx.objectStore('events').delete(id)
    );
  }

  function getAllEvents() {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('events', 'readonly');
        const req = tx.objectStore('events').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  function clearEvents() {
    return withTx('events', 'readwrite', (tx) =>
      tx.objectStore('events').clear()
    );
  }

  // ── Calendars ─────────────────────────────────────────────────────────────

  function putCalendar(cal) {
    return withTx('calendars', 'readwrite', (tx) =>
      tx.objectStore('calendars').put(cal)
    );
  }

  function getAllCalendars() {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('calendars', 'readonly');
        const req = tx.objectStore('calendars').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  function getMeta(key) {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readonly');
        const req = tx.objectStore('meta').get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
        req.onerror = () => reject(req.error);
      });
    });
  }

  function setMeta(key, value) {
    return withTx('meta', 'readwrite', (tx) =>
      tx.objectStore('meta').put({ key, value })
    );
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    putEvent,
    deleteEvent,
    getAllEvents,
    clearEvents,
    putCalendar,
    getAllCalendars,
    getMeta,
    setMeta,
  };
})();
