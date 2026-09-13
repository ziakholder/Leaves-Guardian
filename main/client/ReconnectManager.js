import { EventEmitter } from 'events';

export const RECONNECT_REASONS = Object.freeze({
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
  CONNECTION_CLOSED: 'CONNECTION_CLOSED',
  CONFLICT: 'CONFLICT',
  UNKNOWN_TRANSIENT: 'UNKNOWN_TRANSIENT'
});

export const NON_RECOVERABLE_REASONS = Object.freeze({
  LOGGED_OUT: 'LOGGED_OUT',
  SHUTDOWN: 'SHUTDOWN',
  AUTH_FAILURE: 'AUTH_FAILURE'
});

/**
 * ReconnectManager handles connection auto-recovery using Exponential Backoff with Jitter.
 * Formula: Math.min(Math.round(initialDelay * (2 ^ attempt) + jitter), maxDelay)
 */
export class ReconnectManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.maxAttempts = options.maxAttempts ?? Infinity;
    this.initialDelay = options.initialDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.jitter = options.jitter ?? 1000;
    this.attempts = 0;
    this._timer = null;
    this._isShuttingDown = false;
  }

  isRecoverable(reason) {
    if (this._isShuttingDown) return false;
    if (!this.enabled) return false;
    if (this.attempts >= this.maxAttempts) return false;
    if (Object.values(NON_RECOVERABLE_REASONS).includes(reason)) return false;
    return true;
  }

  hasPendingReconnect() {
    return this._timer !== null;
  }

  calculateDelay(attempt = this.attempts + 1) {
    const exponent = Math.max(0, attempt - 1);
    const baseDelay = Math.min(this.initialDelay * Math.pow(2, exponent), this.maxDelay);
    const jitterVal = this.jitter ? (Math.random() * this.jitter) : 0;
    return Math.min(Math.round(baseDelay + jitterVal), this.maxDelay);
  }

  schedule(reason, onReconnect) {
    this.cancel();

    if (!this.isRecoverable(reason)) {
      this.emit('reconnect_rejected', { reason, attempts: this.attempts });
      return null;
    }

    this.attempts++;
    const delay = this.calculateDelay(this.attempts);

    this.emit('reconnect_scheduled', {
      reason,
      attempt: this.attempts,
      delay
    });

    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._isShuttingDown) return;
      this.emit('reconnect_executing', { reason, attempt: this.attempts });
      if (typeof onReconnect === 'function') {
        onReconnect({ reason, attempt: this.attempts });
      }
    }, delay);

    return delay;
  }

  reset() {
    this.attempts = 0;
    this.cancel();
  }

  cancel() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  setShutdown() {
    this._isShuttingDown = true;
    this.cancel();
  }
}
