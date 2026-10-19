import fs from 'fs';
import path from 'path';
import { BufferJSON, initAuthCreds as defaultInitAuthCreds } from '@whiskeysockets/baileys';
import { AuthenticationError } from '../errors/LeavesError.js';

class MemoryLRUCache {
  constructor(maxSize = 10000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * useSQLiteAuthState - Penyedia state autentikasi Baileys berbasis database SQLite (single file .db).
 * Mencegah pemborosan inode ribuan file JSON kecil, tahan korupsi file saat crash,
 * dan menggunakan WAL (Write-Ahead Logging) dengan memory cache berkecepatan tinggi.
 *
 * @param {string} [dbPath='./session/auth.db'] Lokasi file database SQLite
 * @param {Object} [options] Opsi konfigurasi tambahan
 * @returns {Promise<{ state: { creds: Object, keys: Object }, saveCreds: Function }>}
 */
export async function useSQLiteAuthState(dbPath = './session/auth.db', options = {}) {
  let Database;
  try {
    const imported = await import('better-sqlite3');
    Database = imported.default || imported;
  } catch (_) {
    throw new AuthenticationError(
      'Modul better-sqlite3 diperlukan untuk menggunakan useSQLiteAuthState. Pasang dengan: npm i better-sqlite3'
    );
  }

  const resolvedDbPath = path.resolve(process.cwd(), dbPath);
  const dir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedDbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.pragma('page_size = 8192');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS baileys_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      last_access INTEGER DEFAULT (unixepoch())
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_key_prefix ON baileys_state(key) WHERE key LIKE '%-%';
  `);

  const stmtGet = db.prepare('SELECT value FROM baileys_state WHERE key = ?');
  const stmtSet = db.prepare('INSERT OR REPLACE INTO baileys_state (key, value, last_access) VALUES (?, ?, unixepoch())');
  const stmtDel = db.prepare('DELETE FROM baileys_state WHERE key = ?');

  const cache = new MemoryLRUCache(options.cacheSize || 10000);
  const initCreds = options.initAuthCreds || defaultInitAuthCreds;

  const readData = (key) => {
    if (cache.get(key) !== undefined) {
      return cache.get(key);
    }
    const row = stmtGet.get(key);
    if (!row || !row.value) return null;
    try {
      const parsed = JSON.parse(row.value, BufferJSON.reviver);
      cache.set(key, parsed);
      return parsed;
    } catch (_) {
      return null;
    }
  };

  const writeData = (key, data) => {
    if (data === null || data === undefined) {
      cache.delete(key);
      stmtDel.run(key);
    } else {
      cache.set(key, data);
      const str = JSON.stringify(data, BufferJSON.replacer);
      stmtSet.run(key, str);
    }
  };

  const txCommit = db.transaction((entries, deletes) => {
    for (const [k, v] of entries) {
      const str = JSON.stringify(v, BufferJSON.replacer);
      stmtSet.run(k, str);
      cache.set(k, v);
    }
    for (const k of deletes) {
      stmtDel.run(k);
      cache.delete(k);
    }
  });

  let creds = readData('creds');
  if (!creds || typeof creds !== 'object') {
    creds = initCreds();
    writeData('creds', creds);
  }

  const saveCreds = async () => {
    writeData('creds', creds);
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const key = `${type}-${id}`;
        const val = readData(key);
        if (val) {
          result[id] = val;
        }
      }
      return result;
    },
    set: async (data) => {
      const entries = [];
      const deletes = [];

      for (const category in data) {
        const items = data[category];
        for (const id in items) {
          const key = `${category}-${id}`;
          const value = items[id];
          if (value === null || value === undefined) {
            deletes.push(key);
          } else {
            entries.push([key, value]);
          }
        }
      }

      txCommit(entries, deletes);
    },
  };

  return {
    state: {
      creds,
      keys,
    },
    saveCreds,
  };
}

export default useSQLiteAuthState;
