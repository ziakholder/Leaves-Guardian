import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { LeavesValidationError, SmartStoreError } from '../errors/LeavesError.js';

export const CURRENT_STORE_VERSION = 1;

/**
 * Validates that a key is a valid non-empty string.
 * @param {*} key 
 * @returns {string}
 */
export function validateKey(key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new LeavesValidationError(
      `SmartStore key must be a non-empty string, received: ${typeof key === 'string' ? '""' : typeof key}`,
      'SMARTSTORE_INVALID_KEY',
      { key }
    );
  }
  return key.trim();
}

/**
 * Validates that a namespace is a valid non-empty string.
 * @param {*} ns 
 * @returns {string}
 */
export function validateNamespace(ns) {
  if (typeof ns !== 'string' || ns.trim() === '') {
    throw new LeavesValidationError(
      `SmartStore namespace must be a non-empty string, received: ${typeof ns === 'string' ? '""' : typeof ns}`,
      'SMARTSTORE_INVALID_NAMESPACE',
      { namespace: ns }
    );
  }
  return ns.trim();
}

/**
 * Recursively validates that a value is strictly JSON-compatible (v1).
 * Rejects: undefined, function, symbol, bigint, NaN, Infinity, -Infinity,
 * Map, Set, Promise/thenable, Date, Buffer, non-plain class instances, circular refs.
 * @param {*} value 
 * @param {Set} [seen]
 * @param {string} [pathStr]
 * @returns {*}
 */
export function validateJSONValue(value, seen = new Set(), pathStr = '$') {
  if (value === undefined) {
    throw new LeavesValidationError(
      `SmartStore value contains undefined at "${pathStr}"`,
      'SMARTSTORE_INVALID_VALUE',
      { path: pathStr, value }
    );
  }

  if (value === null) {
    return null;
  }

  const type = typeof value;

  if (type === 'string' || type === 'boolean') {
    return value;
  }

  if (type === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new LeavesValidationError(
        `SmartStore numbers must be finite, received ${value} at "${pathStr}"`,
        'SMARTSTORE_INVALID_VALUE',
        { path: pathStr, value }
      );
    }
    return value;
  }

  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new LeavesValidationError(
      `SmartStore value contains unsupported type "${type}" at "${pathStr}"`,
      'SMARTSTORE_INVALID_VALUE',
      { path: pathStr, value }
    );
  }

  if (type === 'object') {
    // Check circular references
    if (seen.has(value)) {
      throw new LeavesValidationError(
        `SmartStore value contains circular reference at "${pathStr}"`,
        'SMARTSTORE_INVALID_VALUE',
        { path: pathStr }
      );
    }
    seen.add(value);

    // Reject non-plain objects: Promises, Maps, Sets, Dates, Buffers, TypedArrays, etc.
    if (typeof value.then === 'function') {
      throw new LeavesValidationError(
        `SmartStore value contains Promise/thenable at "${pathStr}"`,
        'SMARTSTORE_INVALID_VALUE',
        { path: pathStr }
      );
    }

    if (
      value instanceof Map ||
      value instanceof Set ||
      value instanceof Date ||
      (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
    ) {
      throw new LeavesValidationError(
        `SmartStore value contains unsupported object instance "${value.constructor?.name}" at "${pathStr}"`,
        'SMARTSTORE_INVALID_VALUE',
        { path: pathStr }
      );
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        validateJSONValue(value[i], seen, `${pathStr}[${i}]`);
      }
      seen.delete(value);
      return value;
    }

    // Verify it is a plain Object (prototype is Object.prototype or null)
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new LeavesValidationError(
        `SmartStore values must be plain objects, received class instance "${value.constructor?.name}" at "${pathStr}"`,
        'SMARTSTORE_INVALID_VALUE',
        { path: pathStr }
      );
    }

    for (const key of Object.keys(value)) {
      validateJSONValue(value[key], seen, `${pathStr}.${key}`);
    }

    seen.delete(value);
    return value;
  }

  throw new LeavesValidationError(
    `SmartStore value contains unrecognized type "${type}" at "${pathStr}"`,
    'SMARTSTORE_INVALID_VALUE',
    { path: pathStr, value }
  );
}

/**
 * Validates the TTL option.
 * @param {*} ttl 
 * @returns {number|null} returns absolute expiration timestamp or null
 */
export function validateAndCalculateExpiry(ttl) {
  if (ttl === undefined || ttl === null) {
    return null; // Persistent indefinitely
  }

  if (
    typeof ttl !== 'number' ||
    !Number.isInteger(ttl) ||
    !Number.isFinite(ttl) ||
    ttl <= 0
  ) {
    throw new LeavesValidationError(
      `SmartStore TTL must be a positive integer in milliseconds, received: ${ttl}`,
      'SMARTSTORE_INVALID_TTL',
      { ttl }
    );
  }

  return Date.now() + ttl;
}

/**
 * Namespace proxy view for SmartStore.
 */
export class SmartStoreNamespace {
  #store;
  #namespace;

  constructor(store, namespace) {
    this.#store = store;
    this.#namespace = namespace;
  }

  get name() {
    return this.#namespace;
  }

  async set(key, value, options = {}) {
    return this.#store.setInNamespace(this.#namespace, key, value, options);
  }

  async get(key) {
    return this.#store.getInNamespace(this.#namespace, key);
  }

  async has(key) {
    return this.#store.hasInNamespace(this.#namespace, key);
  }

  async delete(key) {
    return this.#store.deleteInNamespace(this.#namespace, key);
  }

  async clear() {
    return this.#store.clearInNamespace(this.#namespace);
  }

  async entries() {
    return this.#store.entriesInNamespace(this.#namespace);
  }

  async keys() {
    return this.#store.keysInNamespace(this.#namespace);
  }

  async values() {
    return this.#store.valuesInNamespace(this.#namespace);
  }

  async size() {
    return this.#store.sizeInNamespace(this.#namespace);
  }
}

/**
 * Lightweight State & KV Store with serialized atomic persistence and TTL.
 */
export class SmartStore extends EventEmitter {
  #filePath;
  #data = new Map(); // namespace -> Map(key -> { value, expiresAt })
  #writeQueue = Promise.resolve();
  #sweepIntervalTimer = null;
  #sweepIntervalMs;
  #autoPersist;
  #isShutdown = false;

  constructor(options = {}) {
    super();
    this.#filePath = options.filePath || './data/smart-store.json';
    this.#autoPersist = options.autoPersist !== false; // Default: true
    this.#sweepIntervalMs = typeof options.sweepIntervalMs === 'number' && options.sweepIntervalMs > 0
      ? options.sweepIntervalMs
      : 60000; // 1 minute default sweep

    // Load existing persistence synchronously or initialize fresh
    this.#initializeStore();

    if (this.#sweepIntervalMs > 0 && options.autoSweep !== false) {
      this.#startPeriodicSweep();
    }
  }

  /**
   * Strictly validates loaded schema from disk.
   */
  #validatePersistedSchema(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SmartStoreError(
        'Invalid SmartStore file: Root must be an object',
        'SMARTSTORE_CORRUPTED_FILE',
        { filePath: this.#filePath }
      );
    }

    if (parsed.version !== CURRENT_STORE_VERSION) {
      if (typeof parsed.version === 'number') {
        throw new SmartStoreError(
          `Unsupported SmartStore version: ${parsed.version} (expected: ${CURRENT_STORE_VERSION})`,
          'SMARTSTORE_UNSUPPORTED_VERSION',
          { version: parsed.version, filePath: this.#filePath }
        );
      }
      throw new SmartStoreError(
        'Invalid SmartStore file: Missing or invalid version field',
        'SMARTSTORE_CORRUPTED_FILE',
        { filePath: this.#filePath }
      );
    }

    if (!parsed.namespaces || typeof parsed.namespaces !== 'object' || Array.isArray(parsed.namespaces)) {
      throw new SmartStoreError(
        'Invalid SmartStore file: "namespaces" must be an object',
        'SMARTSTORE_CORRUPTED_FILE',
        { filePath: this.#filePath }
      );
    }

    for (const [ns, items] of Object.entries(parsed.namespaces)) {
      if (!ns || typeof ns !== 'string' || ns.trim() === '') {
        throw new SmartStoreError(
          `Invalid SmartStore file: namespace name must be a non-empty string, got "${ns}"`,
          'SMARTSTORE_CORRUPTED_FILE',
          { filePath: this.#filePath, namespace: ns }
        );
      }
      if (!items || typeof items !== 'object' || Array.isArray(items)) {
        throw new SmartStoreError(
          `Invalid SmartStore file: namespace "${ns}" content must be an object`,
          'SMARTSTORE_CORRUPTED_FILE',
          { filePath: this.#filePath, namespace: ns }
        );
      }
      for (const [key, entry] of Object.entries(items)) {
        if (!key || typeof key !== 'string' || key.trim() === '') {
          throw new SmartStoreError(
            `Invalid SmartStore file: key in namespace "${ns}" must be non-empty string`,
            'SMARTSTORE_CORRUPTED_FILE',
            { filePath: this.#filePath, namespace: ns }
          );
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('value' in entry)) {
          throw new SmartStoreError(
            `Invalid SmartStore file: entry "${key}" in namespace "${ns}" must be an object with "value"`,
            'SMARTSTORE_CORRUPTED_FILE',
            { filePath: this.#filePath, namespace: ns, key }
          );
        }
        if (entry.expiresAt !== null && (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || !Number.isInteger(entry.expiresAt) || entry.expiresAt <= 0)) {
          throw new SmartStoreError(
            `Invalid SmartStore file: expiresAt for "${key}" in namespace "${ns}" must be null or positive integer timestamp`,
            'SMARTSTORE_CORRUPTED_FILE',
            { filePath: this.#filePath, namespace: ns, key, expiresAt: entry.expiresAt }
          );
        }
        try {
          validateJSONValue(entry.value);
        } catch (valErr) {
          throw new SmartStoreError(
            `Invalid SmartStore file: value for "${key}" in namespace "${ns}" is not valid JSON (${valErr.message})`,
            'SMARTSTORE_CORRUPTED_FILE',
            { cause: valErr, filePath: this.#filePath, namespace: ns, key }
          );
        }
      }
    }
  }

  /**
   * Initializes or loads store from disk.
   */
  #initializeStore() {
    if (!this.#filePath) return;

    const dir = path.dirname(this.#filePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }

    if (fs.existsSync(this.#filePath)) {
      let raw;
      try {
        raw = fs.readFileSync(this.#filePath, 'utf8');
      } catch (readErr) {
        throw new SmartStoreError(
          `Failed to read SmartStore file: ${readErr.message}`,
          'SMARTSTORE_READ_FAILED',
          { cause: readErr, filePath: this.#filePath }
        );
      }

      if (raw.trim() === '') {
        this.#data.clear();
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (jsonErr) {
        throw new SmartStoreError(
          `Failed to parse SmartStore file: ${jsonErr.message}`,
          'SMARTSTORE_CORRUPTED_FILE',
          { cause: jsonErr, filePath: this.#filePath }
        );
      }

      // Strictly validate schema without silent repairs
      this.#validatePersistedSchema(parsed);

      const now = Date.now();
      this.#data.clear();

      for (const [ns, items] of Object.entries(parsed.namespaces)) {
        const nsMap = new Map();
        for (const [key, entry] of Object.entries(items)) {
          // If not expired, load into memory
          if (entry.expiresAt === null || entry.expiresAt > now) {
            nsMap.set(key, {
              value: entry.value,
              expiresAt: entry.expiresAt
            });
          }
        }
        if (nsMap.size > 0 || ns === 'default') {
          this.#data.set(ns, nsMap);
        }
      }
    }
  }

  /**
   * Starts periodic sweep timer.
   */
  #startPeriodicSweep() {
    this.#sweepIntervalTimer = setInterval(() => {
      this.sweep();
    }, this.#sweepIntervalMs);

    if (this.#sweepIntervalTimer.unref) {
      this.#sweepIntervalTimer.unref();
    }
  }

  /**
   * Returns a namespace proxy view.
   * @param {string} name 
   * @returns {SmartStoreNamespace}
   */
  namespace(name) {
    const validNs = validateNamespace(name);
    return new SmartStoreNamespace(this, validNs);
  }

  /**
   * Internal getter for namespace map.
   * @param {string} ns 
   * @param {boolean} createIfMissing 
   * @returns {Map|undefined}
   */
  #getNamespaceMap(ns, createIfMissing = false) {
    let map = this.#data.get(ns);
    if (!map && createIfMissing) {
      map = new Map();
      this.#data.set(ns, map);
    }
    return map;
  }

  /**
   * Helper to perform lazy eviction on get/has/entries/size.
   * Contract: Lazy eviction removes from in-memory cache immediately;
   * disk persistence occurs on subsequent sweep or mutation.
   */
  #isEntryExpired(entry, ns, key) {
    if (!entry) return true;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      const nsMap = this.#data.get(ns);
      if (nsMap) {
        nsMap.delete(key);
        if (nsMap.size === 0 && ns !== 'default') {
          this.#data.delete(ns);
        }
      }
      return true;
    }
    return false;
  }

  // --- Namespace-scoped Operations ---

  async setInNamespace(ns, key, value, options = {}) {
    if (this.#isShutdown) {
      throw new SmartStoreError('Cannot perform set on a shutdown SmartStore', 'SMARTSTORE_SHUTDOWN');
    }

    const validNs = validateNamespace(ns);
    const validKey = validateKey(key);
    const validValue = validateJSONValue(value);
    const expiresAt = validateAndCalculateExpiry(options.ttl);

    const nsMap = this.#getNamespaceMap(validNs, true);
    nsMap.set(validKey, {
      value: validValue,
      expiresAt
    });

    if (this.#autoPersist) {
      await this.#enqueuePersistence();
    }

    this.emit('set', { namespace: validNs, key: validKey, value: validValue, expiresAt });
  }

  async getInNamespace(ns, key) {
    const validNs = validateNamespace(ns);
    const validKey = validateKey(key);

    const nsMap = this.#getNamespaceMap(validNs, false);
    if (!nsMap) return undefined;

    const entry = nsMap.get(validKey);
    if (!entry) return undefined;

    if (this.#isEntryExpired(entry, validNs, validKey)) {
      this.emit('expired', { namespace: validNs, key: validKey });
      return undefined;
    }

    return entry.value;
  }

  async hasInNamespace(ns, key) {
    const validNs = validateNamespace(ns);
    const validKey = validateKey(key);

    const nsMap = this.#getNamespaceMap(validNs, false);
    if (!nsMap) return false;

    const entry = nsMap.get(validKey);
    if (!entry) return false;

    if (this.#isEntryExpired(entry, validNs, validKey)) {
      return false;
    }

    return true;
  }

  async deleteInNamespace(ns, key) {
    if (this.#isShutdown) {
      throw new SmartStoreError('Cannot perform delete on a shutdown SmartStore', 'SMARTSTORE_SHUTDOWN');
    }

    const validNs = validateNamespace(ns);
    const validKey = validateKey(key);

    const nsMap = this.#getNamespaceMap(validNs, false);
    if (!nsMap) return false;

    const existed = nsMap.delete(validKey);
    if (existed) {
      if (nsMap.size === 0 && validNs !== 'default') {
        this.#data.delete(validNs);
      }
      if (this.#autoPersist) {
        await this.#enqueuePersistence();
      }
      this.emit('delete', { namespace: validNs, key: validKey });
    }

    return existed;
  }

  async clearInNamespace(ns) {
    if (this.#isShutdown) {
      throw new SmartStoreError('Cannot perform clear on a shutdown SmartStore', 'SMARTSTORE_SHUTDOWN');
    }

    const validNs = validateNamespace(ns);
    const nsMap = this.#getNamespaceMap(validNs, false);

    if (nsMap && nsMap.size > 0) {
      nsMap.clear();
      if (validNs !== 'default') {
        this.#data.delete(validNs);
      }
      if (this.#autoPersist) {
        await this.#enqueuePersistence();
      }
      this.emit('clear', { namespace: validNs });
    }
  }

  async entriesInNamespace(ns) {
    const validNs = validateNamespace(ns);
    const nsMap = this.#getNamespaceMap(validNs, false);
    if (!nsMap) return [];

    const result = [];
    for (const [key, entry] of nsMap.entries()) {
      if (!this.#isEntryExpired(entry, validNs, key)) {
        result.push([key, entry.value]);
      }
    }
    return result;
  }

  async keysInNamespace(ns) {
    const entries = await this.entriesInNamespace(ns);
    return entries.map(([k]) => k);
  }

  async valuesInNamespace(ns) {
    const entries = await this.entriesInNamespace(ns);
    return entries.map(([, v]) => v);
  }

  async sizeInNamespace(ns) {
    const entries = await this.entriesInNamespace(ns);
    return entries.length;
  }

  // --- Shorthand Default Namespace Operations ---

  async set(key, value, options = {}) {
    return this.setInNamespace('default', key, value, options);
  }

  async get(key) {
    return this.getInNamespace('default', key);
  }

  async has(key) {
    return this.hasInNamespace('default', key);
  }

  async delete(key) {
    return this.deleteInNamespace('default', key);
  }

  async clear() {
    return this.clearInNamespace('default');
  }

  async entries() {
    return this.entriesInNamespace('default');
  }

  async keys() {
    return this.keysInNamespace('default');
  }

  async values() {
    return this.valuesInNamespace('default');
  }

  async size() {
    return this.sizeInNamespace('default');
  }

  /**
   * Sweeps and evicts all expired entries across all namespaces.
   * @returns {number} count of evicted items
   */
  sweep() {
    let evictedCount = 0;
    const now = Date.now();

    for (const [ns, nsMap] of this.#data.entries()) {
      for (const [key, entry] of nsMap.entries()) {
        if (entry.expiresAt !== null && now > entry.expiresAt) {
          nsMap.delete(key);
          evictedCount++;
          this.emit('expired', { namespace: ns, key });
        }
      }
      if (nsMap.size === 0 && ns !== 'default') {
        this.#data.delete(ns);
      }
    }

    if (evictedCount > 0 && this.#autoPersist) {
      this.#enqueuePersistence().catch(() => {});
    }

    return evictedCount;
  }

  /**
   * Flushes current in-memory store to disk via serialized queue.
   */
  async flush() {
    return this.#enqueuePersistence();
  }

  /**
   * Serialized Atomic Persistence Mutex Queue with Recovery Guarantee.
   * Contract:
   * 1. Current failed write rejects its own operation.
   * 2. Failure does NOT permanently poison the write queue chain.
   * 3. Next write executes normally on recovered chain.
   */
  #enqueuePersistence() {
    if (!this.#filePath) {
      return Promise.resolve();
    }

    const operation = this.#writeQueue
      .catch(() => {}) // Absorb previous failure so this operation can run
      .then(() => this.#performAtomicWrite())
      .catch((err) => {
        // Emit safe non-fatal event (NOT unhandled 'error')
        this.emit('writeError', err);
        throw err;
      });

    // Update queue pointer, absorbing rejections so subsequent operations are unblocked
    this.#writeQueue = operation.catch(() => {});

    return operation;
  }

  /**
   * Durable Atomic file write:
   * 1. Snapshot memory state & serialize.
   * 2. Open temporary file.
   * 3. Write data & sync/flush (fsync).
   * 4. Close file handle.
   * 5. Rename temporary file to target atomically.
   */
  async #performAtomicWrite() {
    const dir = path.dirname(this.#filePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const payload = {
      version: CURRENT_STORE_VERSION,
      updatedAt: Date.now(),
      namespaces: {}
    };

    const now = Date.now();

    for (const [ns, nsMap] of this.#data.entries()) {
      const nsObj = {};
      let hasItems = false;
      for (const [key, entry] of nsMap.entries()) {
        if (entry.expiresAt === null || entry.expiresAt > now) {
          nsObj[key] = {
            value: entry.value,
            expiresAt: entry.expiresAt
          };
          hasItems = true;
        }
      }
      if (hasItems) {
        payload.namespaces[ns] = nsObj;
      }
    }

    const content = JSON.stringify(payload, null, 2);
    const tmpPath = `${this.#filePath}.tmp_${process.pid}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    let fileHandle;
    try {
      // 1. Open temp file
      fileHandle = await fs.promises.open(tmpPath, 'w');
      // 2. Write content
      await fileHandle.writeFile(content, 'utf8');
      // 3. Durable flush to disk (fsync)
      await fileHandle.sync();
      // 4. Close handle
      await fileHandle.close();
      fileHandle = null;

      // 5. Atomic rename temp -> target
      await fs.promises.rename(tmpPath, this.#filePath);
    } catch (err) {
      if (fileHandle) {
        try { await fileHandle.close(); } catch (_) {}
      }
      if (fs.existsSync(tmpPath)) {
        try { await fs.promises.unlink(tmpPath); } catch (_) {}
      }
      throw new SmartStoreError(
        `Failed durable atomic persistence for SmartStore: ${err.message}`,
        'SMARTSTORE_WRITE_FAILED',
        { cause: err, filePath: this.#filePath }
      );
    }
  }

  /**
   * Stop the SmartStore, clearing sweep timers and flushing pending writes.
   * Idempotent and exposes flush error via diagnostic event without silent swallowing.
   */
  async stop() {
    if (this.#isShutdown) return;
    this.#isShutdown = true;

    if (this.#sweepIntervalTimer) {
      clearInterval(this.#sweepIntervalTimer);
      this.#sweepIntervalTimer = null;
    }

    if (this.#autoPersist) {
      try {
        await this.flush();
      } catch (flushErr) {
        this.emit('shutdownError', flushErr);
      }
    }
  }
}
