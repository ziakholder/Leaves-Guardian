import { EventEmitter } from 'events';
import { DeduplicationError } from '../errors/LeavesError.js';
import {
  DEDUP_STATE,
  DEDUP_ERROR_CODES,
  validateDeduplicatorOptions
} from './DeduplicatorConstants.js';
import { DeduplicationCache } from './DeduplicationCache.js';
import { DeduplicationResult } from './DeduplicationResult.js';

/**
 * IngressDeduplicator provides deterministic, synchronous, in-memory ingress message deduplication.
 */
export class IngressDeduplicator extends EventEmitter {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    super();
    this.options = validateDeduplicatorOptions(options);
    this._cache = new DeduplicationCache(this.options.maxTrackedMessages);

    this.state = DEDUP_STATE.RUNNING;
    this._cleanupTimer = null;

    this._totalFirstSeen = 0;
    this._totalDuplicates = 0;

    this._startCleanupTimer();
  }

  /**
   * Evaluates and marks ingress message identity atomically (Synchronous Test-and-Set).
   * @param {string|Object} keyOrMessage
   * @returns {DeduplicationResult}
   */
  checkAndMark(keyOrMessage) {
    this._assertNotDestroyed('checkAndMark');

    const key = this._resolveKey(keyOrMessage);
    const now = this._getTimestamp();

    const evaluation = this._cache.checkAndMark(key, now, this.options.ttlMs);
    const result = new DeduplicationResult(evaluation);

    if (evaluation.isNew) {
      this._totalFirstSeen++;
    } else {
      this._totalDuplicates++;
      this.#safeEmit('duplicate_detected', {
        key,
        result,
        timestamp: now
      });
    }

    return result;
  }

  /**
   * Inspects current deduplication state for a key without mutating it.
   * @param {string|Object} keyOrMessage
   * @returns {DeduplicationResult | null}
   */
  peek(keyOrMessage) {
    this._assertNotDestroyed('peek');
    const key = this._resolveKey(keyOrMessage);
    const now = this._getTimestamp();
    const evaluation = this._cache.peek(key, now);
    return evaluation ? new DeduplicationResult(evaluation) : null;
  }

  /**
   * Exact alias to peek() for cross-subsystem consistency.
   * @param {string|Object} keyOrMessage
   * @returns {DeduplicationResult | null}
   */
  getState(keyOrMessage) {
    return this.peek(keyOrMessage);
  }

  /**
   * Checks if an active (non-expired) entry exists for key.
   * @param {string|Object} keyOrMessage
   * @returns {boolean}
   */
  has(keyOrMessage) {
    this._assertNotDestroyed('has');
    const key = this._resolveKey(keyOrMessage);
    const now = this._getTimestamp();
    return this._cache.has(key, now);
  }

  /**
   * Resets tracking for a specific key.
   * @param {string|Object} keyOrMessage
   * @returns {boolean} True if entry existed and was removed
   */
  reset(keyOrMessage) {
    this._assertNotDestroyed('reset');
    const key = this._resolveKey(keyOrMessage);
    const now = this._getTimestamp();
    const deleted = this._cache.reset(key);

    if (deleted) {
      this.#safeEmit('dedup_reset', {
        key,
        timestamp: now
      });
    }

    return deleted;
  }

  /**
   * Clears all tracking memory.
   */
  resetAll() {
    this._assertNotDestroyed('resetAll');
    const now = this._getTimestamp();
    const clearedCount = this._cache.resetAll();

    this.#safeEmit('dedup_reset', {
      timestamp: now,
      clearedCount
    });
  }

  /**
   * Returns live diagnostic metrics and health stats.
   * Available even after destroy() without throwing.
   * @returns {{ trackedMessages: number, totalFirstSeen: number, totalDuplicates: number, state: string, isRunning: boolean }}
   */
  getStats() {
    if (this.state === DEDUP_STATE.DESTROYED) {
      return {
        trackedMessages: 0,
        totalFirstSeen: this._totalFirstSeen,
        totalDuplicates: this._totalDuplicates,
        state: this.state,
        isRunning: false
      };
    }

    return {
      trackedMessages: this._cache.size,
      totalFirstSeen: this._totalFirstSeen,
      totalDuplicates: this._totalDuplicates,
      state: this.state,
      isRunning: this.state === DEDUP_STATE.RUNNING
    };
  }

  /**
   * Starts or resumes the background housekeeping cleanup timer.
   */
  start() {
    if (this.state === DEDUP_STATE.DESTROYED) {
      throw new DeduplicationError(
        'Cannot call start() on a destroyed IngressDeduplicator',
        DEDUP_ERROR_CODES.INTERNAL_ERROR
      );
    }
    if (this.state === DEDUP_STATE.RUNNING) return;

    this.state = DEDUP_STATE.RUNNING;
    this._startCleanupTimer();
  }

  /**
   * Pauses the background housekeeping cleanup timer.
   * Functional checkAndMark() remains fully operational.
   */
  stop() {
    if (this.state === DEDUP_STATE.DESTROYED || this.state === DEDUP_STATE.STOPPED) return;

    this.state = DEDUP_STATE.STOPPED;
    this._stopCleanupTimer();
  }

  /**
   * Destroys deduplicator, stops timer, clears state, and marks instance terminal.
   */
  destroy() {
    if (this.state === DEDUP_STATE.DESTROYED) return;

    this.state = DEDUP_STATE.DESTROYED;
    this._stopCleanupTimer();
    this._cache.resetAll();
    this.removeAllListeners();
  }

  /**
   * Resolves and strictly validates canonical string key from input using keyExtractor.
   * @param {string|Object} keyOrMessage
   * @returns {string} Canonical trimmed string key
   * @private
   */
  _resolveKey(keyOrMessage) {
    const rawKey = this.options.keyExtractor(keyOrMessage);
    if (typeof rawKey !== 'string') {
      throw new DeduplicationError(
        `keyExtractor must return a string, received ${typeof rawKey}`,
        DEDUP_ERROR_CODES.INVALID_KEY,
        { returnedKey: rawKey }
      );
    }
    const trimmed = rawKey.trim();
    if (trimmed.length === 0) {
      throw new DeduplicationError(
        'keyExtractor returned an empty or whitespace-only string',
        DEDUP_ERROR_CODES.INVALID_KEY
      );
    }
    return trimmed;
  }

  /**
   * Retrieves and strictly validates finite timestamp from clock function.
   * @returns {number}
   * @private
   */
  _getTimestamp() {
    const now = this.options.clock();
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new DeduplicationError(
        `clock function must return a finite numeric timestamp, received ${typeof now} (${now})`,
        DEDUP_ERROR_CODES.INTERNAL_ERROR,
        { returnedTimestamp: now }
      );
    }
    return now;
  }

  /**
   * Emits event safely with listener failure isolation and frozen payload snapshot.
   * @param {string} eventName
   * @param {Object} payload
   * @private
   */
  #safeEmit(eventName, payload) {
    try {
      this.emit(eventName, Object.freeze({ ...payload }));
    } catch (_) {}
  }

  /**
   * Background housekeeping sweep timer callback.
   * @private
   */
  _housekeeping() {
    if (this.state !== DEDUP_STATE.RUNNING) return;
    try {
      const now = this._getTimestamp();
      this._cache.pruneAll(now);
    } catch (_) {}
  }

  /**
   * Starts periodic cleanup timer unref'd.
   * @private
   */
  _startCleanupTimer() {
    this._stopCleanupTimer();
    if (this.options.cleanupIntervalMs > 0) {
      this._cleanupTimer = setInterval(() => {
        this._housekeeping();
      }, this.options.cleanupIntervalMs);

      if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
        this._cleanupTimer.unref();
      }
    }
  }

  /**
   * Clears cleanup timer.
   * @private
   */
  _stopCleanupTimer() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /**
   * Asserts that instance has not been destroyed.
   * @param {string} methodName
   * @private
   */
  _assertNotDestroyed(methodName) {
    if (this.state === DEDUP_STATE.DESTROYED) {
      throw new DeduplicationError(
        `Cannot call ${methodName}() on a destroyed IngressDeduplicator`,
        DEDUP_ERROR_CODES.INTERNAL_ERROR
      );
    }
  }
}
