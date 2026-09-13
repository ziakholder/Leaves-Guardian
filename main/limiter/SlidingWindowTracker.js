/**
 * SlidingWindowTracker manages exact sliding window timestamp deques, LRU eviction, and per-key penalty states.
 */
export class SlidingWindowTracker {
  /**
   * @param {number} maxTrackedKeys
   */
  constructor(maxTrackedKeys = 10000) {
    this.maxTrackedKeys = maxTrackedKeys;
    this._entries = new Map(); // key -> { timestamps: number[], penaltyUntil: number, lastAccessedAt: number }
  }

  /**
   * Returns active tracked keys count.
   * @returns {number}
   */
  get size() {
    return this._entries.size;
  }

  /**
   * Evaluates rate limit consumption for a given key.
   * @param {string} key
   * @param {number} now
   * @param {Object} options
   * @param {number} options.windowMs
   * @param {number} options.maxRequests
   * @param {number} options.penaltyDurationMs
   * @returns {{ allowed: boolean, key: string, currentCount: number, limit: number, remaining: number, resetMs: number, retryAfterMs: number, isPenalty: boolean, penaltyApplied?: boolean }}
   */
  evaluate(key, now, options) {
    const { windowMs, maxRequests, penaltyDurationMs } = options;

    let entry = this._entries.get(key);

    if (!entry) {
      // Enforce maxTrackedKeys LRU eviction before adding new entry
      if (this._entries.size >= this.maxTrackedKeys) {
        this._evictLru(now);
      }
      entry = {
        timestamps: [],
        penaltyUntil: 0,
        lastAccessedAt: now
      };
      this._entries.set(key, entry);
    }

    entry.lastAccessedAt = now;

    // 1. Check Active Penalty
    if (entry.penaltyUntil > now) {
      const penaltyRemainingMs = Math.max(0, entry.penaltyUntil - now);
      const currentCount = this._pruneTimestamps(entry.timestamps, now, windowMs);
      const newest = entry.timestamps.length > 0 ? entry.timestamps[entry.timestamps.length - 1] : now;
      const resetMs = entry.timestamps.length > 0 ? Math.max(0, newest + windowMs - now) : 0;

      return {
        allowed: false,
        key,
        currentCount,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - currentCount),
        resetMs,
        retryAfterMs: penaltyRemainingMs,
        isPenalty: true
      };
    }

    // 2. Prune Expired Timestamps
    const currentCount = this._pruneTimestamps(entry.timestamps, now, windowMs);

    // 3. Evaluate Quota
    if (currentCount < maxRequests) {
      // ALLOWED: Append current timestamp
      entry.timestamps.push(now);
      const newCount = currentCount + 1;
      const remaining = Math.max(0, maxRequests - newCount);
      const newest = now;
      const resetMs = Math.max(0, newest + windowMs - now);

      return {
        allowed: true,
        key,
        currentCount: newCount,
        limit: maxRequests,
        remaining,
        resetMs,
        retryAfterMs: 0,
        isPenalty: false
      };
    }

    // REJECTED: Limit reached or exceeded
    let penaltyApplied = false;
    let retryAfterMs = 0;

    if (penaltyDurationMs > 0) {
      entry.penaltyUntil = now + penaltyDurationMs;
      penaltyApplied = true;
      retryAfterMs = penaltyDurationMs;
    } else {
      const oldest = entry.timestamps[0];
      retryAfterMs = Math.max(0, oldest + windowMs - now);
    }

    const newest = entry.timestamps[entry.timestamps.length - 1];
    const resetMs = entry.timestamps.length > 0 ? Math.max(0, newest + windowMs - now) : 0;

    return {
      allowed: false,
      key,
      currentCount,
      limit: maxRequests,
      remaining: 0,
      resetMs,
      retryAfterMs,
      isPenalty: Boolean(entry.penaltyUntil > now),
      penaltyApplied
    };
  }

  /**
   * Prunes expired timestamps older than now - windowMs in O(k) where k is number of expired items.
   * @param {number[]} timestamps
   * @param {number} now
   * @param {number} windowMs
   * @returns {number} Remaining active count
   * @private
   */
  _pruneTimestamps(timestamps, now, windowMs) {
    const cutoff = now - windowMs;
    let shiftCount = 0;

    while (shiftCount < timestamps.length && timestamps[shiftCount] <= cutoff) {
      shiftCount++;
    }

    if (shiftCount > 0) {
      timestamps.splice(0, shiftCount);
    }

    return timestamps.length;
  }

  /**
   * Evicts the least recently used unpenalized entry.
   * If all tracked entries are under active penalty (entry.penaltyUntil > now),
   * no active penalty entry is evicted, preserving full penalty lockout integrity.
   * @param {number} now
   * @returns {boolean} True if an entry was evicted, false if all entries are protected by active penalty
   * @private
   */
  _evictLru(now) {
    let oldestUnpenalizedKey = null;
    let oldestAccess = Infinity;

    for (const [k, entry] of this._entries) {
      if (entry.penaltyUntil <= now) {
        if (entry.lastAccessedAt < oldestAccess) {
          oldestAccess = entry.lastAccessedAt;
          oldestUnpenalizedKey = k;
        }
      }
    }

    if (oldestUnpenalizedKey !== null) {
      this._entries.delete(oldestUnpenalizedKey);
      return true;
    }

    return false;
  }

  /**
   * Gets state for a key, returning a defensive copy.
   * @param {string} key
   * @param {number} now
   * @param {number} windowMs
   * @returns {{ count: number, penaltyUntil: number, timestamps: number[] } | null}
   */
  getState(key, now, windowMs) {
    const entry = this._entries.get(key);
    if (!entry) return null;

    this._pruneTimestamps(entry.timestamps, now, windowMs);
    const isPenaltyActive = entry.penaltyUntil > now;

    // Clean up if completely empty and no penalty
    if (entry.timestamps.length === 0 && !isPenaltyActive) {
      this._entries.delete(key);
      return null;
    }

    return {
      count: entry.timestamps.length,
      penaltyUntil: entry.penaltyUntil,
      timestamps: [...entry.timestamps] // Defensive clone
    };
  }

  /**
   * Checks if tracker has an entry for key.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._entries.has(key);
  }

  /**
   * Resets rate tracking for a specific key.
   * @param {string} key
   * @returns {boolean}
   */
  reset(key) {
    return this._entries.delete(key);
  }

  /**
   * Clears all tracking data.
   */
  resetAll() {
    this._entries.clear();
  }

  /**
   * Performs housekeeping sweep to clean inactive entries.
   * @param {number} now
   * @param {number} windowMs
   * @returns {number} Count of pruned entries
   */
  pruneAll(now, windowMs) {
    let prunedCount = 0;
    for (const [k, entry] of this._entries) {
      this._pruneTimestamps(entry.timestamps, now, windowMs);
      if (entry.timestamps.length === 0 && entry.penaltyUntil <= now) {
        this._entries.delete(k);
        prunedCount++;
      }
    }
    return prunedCount;
  }
}
