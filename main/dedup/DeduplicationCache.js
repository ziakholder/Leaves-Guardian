/**
 * DeduplicationCache manages in-memory FIFO message entries, exhaustive expired pruning, and hard-bounded capacity.
 * Pure state engine with zero lifecycle, event, or error construction authority.
 */
export class DeduplicationCache {
  /**
   * @param {number} [maxTrackedMessages=10000]
   */
  constructor(maxTrackedMessages = 10000) {
    this.maxTrackedMessages = maxTrackedMessages;
    this._entries = new Map(); // key -> { firstSeenAt, lastSeenAt, seenCount, expiresAt }
  }

  /**
   * Returns current active tracked messages count.
   * @returns {number}
   */
  get size() {
    return this._entries.size;
  }

  /**
   * Evaluates and mutates deduplication state for a canonical key.
   * @param {string} key
   * @param {number} now
   * @param {number} ttlMs
   * @returns {{ isDuplicate: boolean, key: string, firstSeenAt: number, lastSeenAt: number, seenCount: number, expiresAt: number, ttlRemainingMs: number, isNew: boolean }}
   */
  checkAndMark(key, now, ttlMs) {
    const existing = this._entries.get(key);

    if (existing) {
      if (now < existing.expiresAt) {
        // Active Duplicate
        existing.lastSeenAt = now;
        existing.seenCount++;

        return {
          isDuplicate: true,
          key,
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: existing.lastSeenAt,
          seenCount: existing.seenCount,
          expiresAt: existing.expiresAt,
          ttlRemainingMs: Math.max(0, existing.expiresAt - now),
          isNew: false
        };
      }

      // Existing entry is expired -> remove it before fresh insert
      this._entries.delete(key);
    }

    // Insert New Entry (Tier 1 Prune -> Tier 2 FIFO Eviction)
    if (this._entries.size >= this.maxTrackedMessages) {
      this._pruneAllExpired(now);
      if (this._entries.size >= this.maxTrackedMessages) {
        this._evictFifo();
      }
    }

    const expiresAt = now + ttlMs;
    const entry = {
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
      expiresAt
    };

    this._entries.set(key, entry);

    return {
      isDuplicate: false,
      key,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
      expiresAt,
      ttlRemainingMs: ttlMs,
      isNew: true
    };
  }

  /**
   * Inspects state for a key without mutating lastSeenAt or seenCount.
   * @param {string} key
   * @param {number} now
   * @returns {{ isDuplicate: boolean, key: string, firstSeenAt: number, lastSeenAt: number, seenCount: number, expiresAt: number, ttlRemainingMs: number } | null}
   */
  peek(key, now) {
    const entry = this._entries.get(key);
    if (!entry) return null;

    if (now >= entry.expiresAt) {
      return null;
    }

    return {
      isDuplicate: true,
      key,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      seenCount: entry.seenCount,
      expiresAt: entry.expiresAt,
      ttlRemainingMs: Math.max(0, entry.expiresAt - now)
    };
  }

  /**
   * Checks if active key exists.
   * Pure read-only without state mutation.
   * @param {string} key
   * @param {number} now
   * @returns {boolean}
   */
  has(key, now) {
    const entry = this._entries.get(key);
    if (!entry) return false;

    if (now >= entry.expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Resets tracking for a specific key.
   * @param {string} key
   * @returns {boolean}
   */
  reset(key) {
    return this._entries.delete(key);
  }

  /**
   * Clears all entries.
   * @returns {number} Count of cleared entries
   */
  resetAll() {
    const count = this._entries.size;
    this._entries.clear();
    return count;
  }

  /**
   * Prunes all expired entries.
   * @param {number} now
   * @returns {number} Count of pruned entries
   */
  pruneAll(now) {
    return this._pruneAllExpired(now);
  }

  /**
   * Exhaustively prunes all expired entries.
   * @param {number} now
   * @returns {number}
   * @private
   */
  _pruneAllExpired(now) {
    let prunedCount = 0;
    for (const [k, entry] of this._entries) {
      if (now >= entry.expiresAt) {
        this._entries.delete(k);
        prunedCount++;
      }
    }
    return prunedCount;
  }

  /**
   * Evicts the oldest entry based on Map insertion order (FIFO).
   * @private
   */
  _evictFifo() {
    const oldestKey = this._entries.keys().next().value;
    if (oldestKey !== undefined) {
      this._entries.delete(oldestKey);
    }
  }
}
