import { EventEmitter } from 'events';
import { RateLimitError } from '../errors/LeavesError.js';
import {
  LIMITER_STATE,
  RATE_LIMIT_ERROR_CODES,
  validateRateLimiterOptions
} from './RateLimitConstants.js';
import { SlidingWindowTracker } from './SlidingWindowTracker.js';
import { RateLimitDecision } from './RateLimitDecision.js';

/**
 * IngressRateLimiter provides deterministic, synchronous, in-memory ingress rate observation & limiting.
 */
export class IngressRateLimiter extends EventEmitter {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    super();
    this.options = validateRateLimiterOptions(options);
    this._tracker = new SlidingWindowTracker(this.options.maxTrackedKeys);

    this.state = LIMITER_STATE.RUNNING;
    this._cleanupTimer = null;

    this._totalAllowed = 0;
    this._totalRejected = 0;

    this._startCleanupTimer();
  }

  /**
   * Evaluates ingress rate consumption for a key or Message object (Synchronous).
   * @param {string|Object} keyOrMessage
   * @returns {RateLimitDecision}
   */
  consume(keyOrMessage) {
    this._assertNotDestroyed('consume');

    const key = this._resolveKey(keyOrMessage);
    const now = this._getTimestamp();

    const evaluation = this._tracker.evaluate(key, now, this.options);
    const decision = new RateLimitDecision(evaluation);

    if (decision.allowed) {
      this._totalAllowed++;
    } else {
      this._totalRejected++;

      if (evaluation.penaltyApplied) {
        this.emit('penalty_applied', {
          key,
          penaltyDurationMs: this.options.penaltyDurationMs,
          penaltyUntil: now + this.options.penaltyDurationMs,
          timestamp: now
        });
      }

      this.emit('rate_limit_exceeded', {
        decision,
        key,
        timestamp: now
      });
    }

    return decision;
  }

  /**
   * Inspects current state for a given key or Message object (Synchronous).
   * Returns a defensive copy of state.
   * @param {string|Object} keyOrMessage
   * @returns {{ count: number, penaltyUntil: number, timestamps: number[] } | null}
   */
  getState(keyOrMessage) {
    this._assertNotDestroyed('getState');
    const key = this._resolveKey(keyOrMessage);
    const now = this._getTimestamp();
    return this._tracker.getState(key, now, this.options.windowMs);
  }

  /**
   * Checks if key exists in active tracking table.
   * @param {string|Object} keyOrMessage
   * @returns {boolean}
   */
  has(keyOrMessage) {
    this._assertNotDestroyed('has');
    const key = this._resolveKey(keyOrMessage);
    return this._tracker.has(key);
  }

  /**
   * Resets rate tracking for a specific key.
   * @param {string|Object} keyOrMessage
   * @returns {boolean}
   */
  reset(keyOrMessage) {
    this._assertNotDestroyed('reset');
    const key = this._resolveKey(keyOrMessage);
    const deleted = this._tracker.reset(key);
    if (deleted) {
      this.emit('rate_limit_reset', {
        key,
        timestamp: this._getTimestamp()
      });
    }
    return deleted;
  }

  /**
   * Clears all tracking memory.
   */
  resetAll() {
    this._assertNotDestroyed('resetAll');
    this._tracker.resetAll();
    this.emit('rate_limit_reset', {
      timestamp: this._getTimestamp()
    });
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
      throw new RateLimitError(
        `keyExtractor must return a string, received ${typeof rawKey}`,
        RATE_LIMIT_ERROR_CODES.INTERNAL_ERROR,
        { returnedKey: rawKey }
      );
    }
    const trimmed = rawKey.trim();
    if (trimmed.length === 0) {
      throw new RateLimitError(
        'keyExtractor returned an empty or whitespace-only string',
        RATE_LIMIT_ERROR_CODES.INTERNAL_ERROR
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
      throw new RateLimitError(
        `clock function must return a finite numeric timestamp, received ${typeof now} (${now})`,
        RATE_LIMIT_ERROR_CODES.INTERNAL_ERROR,
        { returnedTimestamp: now }
      );
    }
    return now;
  }

  /**
   * Returns live diagnostic metrics and health stats.
   * @returns {{ trackedKeys: number, totalAllowed: number, totalRejected: number, state: string, isRunning: boolean }}
   */
  getStats() {
    return {
      trackedKeys: this._tracker.size,
      totalAllowed: this._totalAllowed,
      totalRejected: this._totalRejected,
      state: this.state,
      isRunning: this.state === LIMITER_STATE.RUNNING
    };
  }

  /**
   * Starts or resumes the background housekeeping cleanup timer.
   */
  start() {
    this._assertNotDestroyed('start');
    if (this.state === LIMITER_STATE.RUNNING) return;

    this.state = LIMITER_STATE.RUNNING;
    this._startCleanupTimer();
  }

  /**
   * Pauses the background housekeeping cleanup timer.
   * Note: consume() remains fully operational.
   */
  stop() {
    this._assertNotDestroyed('stop');
    if (this.state === LIMITER_STATE.STOPPED) return;

    this.state = LIMITER_STATE.STOPPED;
    this._stopCleanupTimer();
  }

  /**
   * Destroys rate limiter, stops timer, clears state, and marks instance terminal.
   */
  destroy() {
    if (this.state === LIMITER_STATE.DESTROYED) return;

    this.state = LIMITER_STATE.DESTROYED;
    this._stopCleanupTimer();
    this._tracker.resetAll();
    this.removeAllListeners();
  }

  /**
   * Background housekeeping sweep timer callback.
   * @private
   */
  _housekeeping() {
    if (this.state !== LIMITER_STATE.RUNNING) return;
    try {
      const now = this._getTimestamp();
      this._tracker.pruneAll(now, this.options.windowMs);
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
    if (this.state === LIMITER_STATE.DESTROYED) {
      throw new RateLimitError(
        `Cannot call ${methodName}() on a destroyed IngressRateLimiter`,
        RATE_LIMIT_ERROR_CODES.INTERNAL_ERROR
      );
    }
  }
}
