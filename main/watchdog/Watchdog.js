import { EventEmitter } from 'events';
import { WatchdogError } from '../errors/LeavesError.js';

export const WATCHDOG_STATE = Object.freeze({
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  TERMINATING: 'TERMINATING'
});

export const WATCHDOG_ERROR_CODES = Object.freeze({
  WATCHDOG_INVALID_OPTION: 'WATCHDOG_INVALID_OPTION',
  WATCHDOG_SOCKET_ERROR: 'WATCHDOG_SOCKET_ERROR'
});

export const DEFAULT_WATCHDOG_OPTIONS = Object.freeze({
  enabled: true,
  checkIntervalMs: 15000,
  maxSilenceMs: 60000,
  pingTimeoutMs: 10000,
  maxMissedPings: 2
});

/**
 * Validates Watchdog configuration parameters with strict type and integer bounds checking.
 */
export function validateWatchdogOptions(options = {}) {
  const merged = { ...DEFAULT_WATCHDOG_OPTIONS, ...options };

  const validateInteger = (key, min, max) => {
    const val = merged[key];
    if (
      typeof val !== 'number' ||
      !Number.isFinite(val) ||
      Number.isNaN(val) ||
      !Number.isInteger(val) ||
      val < min ||
      val > max
    ) {
      throw new WatchdogError(
        `Watchdog option "${key}" must be an integer between ${min} and ${max} (got: ${val})`,
        WATCHDOG_ERROR_CODES.WATCHDOG_INVALID_OPTION
      );
    }
  };

  validateInteger('checkIntervalMs', 1000, 300000);
  validateInteger('maxSilenceMs', 5000, 600000);
  validateInteger('pingTimeoutMs', 1000, 60000);
  validateInteger('maxMissedPings', 1, 10);

  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') {
    throw new WatchdogError(
      `Watchdog option "enabled" must be a boolean (got: ${typeof merged.enabled})`,
      WATCHDOG_ERROR_CODES.WATCHDOG_INVALID_OPTION
    );
  }

  return merged;
}

/**
 * Watchdog monitors socket silence and ping/pong liveness to detect zombie sockets.
 * When a zombie socket is confirmed, it terminates the socket via ConnectionManager
 * and delegates auto-reconnection entirely to ReconnectManager.
 */
export class Watchdog extends EventEmitter {
  #intervalTimer = null;
  #pingTimeoutTimer = null;
  #pingInFlight = false;
  #pingSentAt = null;
  #lastPingAckAt = null;
  #lastActivityAt = null;
  #missedPings = 0;
  #zombiesDetectedTotal = 0;
  #terminationInProgress = false;
  #terminationGeneration = 0;

  constructor(options = {}) {
    super();
    this.client = options.client || null;
    this.connectionManager = options.connectionManager || this.client?.connectionManager || null;

    const validated = validateWatchdogOptions(options);
    this.enabled = validated.enabled;
    this.checkIntervalMs = validated.checkIntervalMs;
    this.maxSilenceMs = validated.maxSilenceMs;
    this.pingTimeoutMs = validated.pingTimeoutMs;
    this.maxMissedPings = validated.maxMissedPings;

    this.state = WATCHDOG_STATE.STOPPED;
  }

  /**
   * Safe event emission wrapper protecting from listener exceptions.
   */
  #safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (_) {}
  }

  /**
   * Records inbound socket or message activity.
   * Inbound non-pong activity updates lastActivityAt and resets missed pings.
   * Pong ACK updates lastPingAckAt, clears timeout, and resolves in-flight ping WITHOUT modifying lastActivityAt.
   * 
   * Official Contract Definition:
   * - `lastActivityAt`: Timestamp of the most recent meaningful inbound socket/application traffic (excluding pong control frames).
   * - `lastPingAckAt`: Timestamp of the most recent pong control frame ACK received from the peer WebSocket.
   * 
   * @param {'socket'|'message'|'pong'|string} source
   */
  recordActivity(source = 'unknown') {
    const now = Date.now();

    if (source === 'pong') {
      this.#lastPingAckAt = now;
      if (this.#pingInFlight) {
        const rttMs = this.#pingSentAt ? Math.max(0, now - this.#pingSentAt) : 0;
        this.#clearPingTimeout();
        this.#pingInFlight = false;
        this.#missedPings = 0;
        this.#safeEmit('ping_ack', { timestamp: now, rttMs });
      } else {
        this.#missedPings = 0;
      }
      return;
    }

    // Inbound traffic/message updates lastActivityAt and resets missed pings
    this.#lastActivityAt = now;
    this.#missedPings = 0;
  }

  #clearPingTimeout() {
    if (this.#pingTimeoutTimer) {
      clearTimeout(this.#pingTimeoutTimer);
      this.#pingTimeoutTimer = null;
    }
  }

  /**
   * Dispatches active WebSocket ping probe.
   */
  #dispatchPing(now, silenceDurationMs) {
    let pingSent = false;
    let dispatchError = null;

    try {
      if (this.connectionManager && typeof this.connectionManager.sendPing === 'function') {
        pingSent = this.connectionManager.sendPing() === true;
      } else if (this.client?.connectionManager && typeof this.client.connectionManager.sendPing === 'function') {
        pingSent = this.client.connectionManager.sendPing() === true;
      }
    } catch (err) {
      pingSent = false;
      dispatchError = err?.message || String(err);
    }

    if (!pingSent) {
      // Ping dispatch failed: do NOT start timeout timer, do NOT mark ping in-flight, do NOT increment missed pings
      this.#pingInFlight = false;
      this.#pingSentAt = null;
      this.#safeEmit('ping_sent', {
        timestamp: now,
        silenceDurationMs,
        success: false,
        error: dispatchError || 'PING_DISPATCH_REJECTED'
      });
      return;
    }

    // Ping successfully dispatched across the wire
    this.#pingInFlight = true;
    this.#pingSentAt = now;

    this.#safeEmit('ping_sent', { timestamp: now, silenceDurationMs, success: true });

    this.#clearPingTimeout();
    this.#pingTimeoutTimer = setTimeout(() => {
      this.#handlePingTimeout();
    }, this.pingTimeoutMs);

    if (this.#pingTimeoutTimer && typeof this.#pingTimeoutTimer.unref === 'function') {
      this.#pingTimeoutTimer.unref();
    }
  }

  /**
   * Handles ping timeout and evaluates zombie threshold.
   */
  #handlePingTimeout() {
    this.#pingTimeoutTimer = null;
    this.#pingInFlight = false;

    if (this.state !== WATCHDOG_STATE.RUNNING) {
      return;
    }

    this.#missedPings++;
    const now = Date.now();

    this.#safeEmit('ping_timeout', {
      timestamp: now,
      missedPings: this.#missedPings,
      maxMissedPings: this.maxMissedPings
    });

    if (this.#missedPings >= this.maxMissedPings) {
      this.#handleZombieDetected(now);
    }
  }

  /**
   * Handles zombie detection with strict generation token & single-execution guard.
   * Stale asynchronous termination completions are discarded without mutating current lifecycle state.
   */
  async #handleZombieDetected(now) {
    if (this.#terminationInProgress || this.state === WATCHDOG_STATE.TERMINATING) {
      return;
    }

    const generation = ++this.#terminationGeneration;
    this.#terminationInProgress = true;
    this.state = WATCHDOG_STATE.TERMINATING;
    this.#zombiesDetectedTotal++;

    const silenceDurationMs = this.#lastActivityAt ? Math.max(0, now - this.#lastActivityAt) : 0;
    const reason = 'CONSECUTIVE_PINGS_TIMED_OUT';

    this.#safeEmit('zombie_detected', {
      timestamp: now,
      silenceDurationMs,
      missedPings: this.#missedPings,
      reason
    });

    // Terminate socket cleanly via ConnectionManager
    let terminated = false;
    let terminationError = null;

    try {
      const connMgr = this.connectionManager || this.client?.connectionManager;
      if (connMgr && typeof connMgr.terminateSocket === 'function') {
        const res = connMgr.terminateSocket('ZOMBIE_SOCKET_DETECTED');
        if (res instanceof Promise) {
          terminated = (await res) !== false;
        } else {
          terminated = res !== false;
        }
      } else {
        terminationError = 'NO_CONNECTION_MANAGER_TERMINATE_METHOD';
      }
    } catch (err) {
      terminated = false;
      terminationError = err?.message || String(err);
    }

    // Invalidation Guard: if lifecycle state changed while awaiting async termination, abort safely
    if (generation !== this.#terminationGeneration) {
      return;
    }

    if (terminated) {
      // Contract: zombie_terminated indicates ConnectionManager accepted and dispatched socket termination (sock.end).
      // Watchdog remains in TERMINATING state with #terminationInProgress = true until connection_close pauses it.
      this.#safeEmit('zombie_terminated', {
        timestamp: Date.now(),
        reason: 'ZOMBIE_SOCKET_DETECTED'
      });
    } else {
      // Deterministic failure recovery path: recover to RUNNING only if still active generation
      this.#terminationInProgress = false;
      this.state = WATCHDOG_STATE.RUNNING;
      this.#safeEmit('zombie_termination_failed', {
        timestamp: Date.now(),
        error: terminationError || 'TERMINATE_SOCKET_FAILED'
      });
    }
  }

  /**
   * Periodic evaluation tick.
   */
  #performTick() {
    if (this.state !== WATCHDOG_STATE.RUNNING || this.#terminationInProgress) {
      return;
    }

    // Single-flight ping protection: do not dispatch if ping is already in-flight
    if (this.#pingInFlight) {
      return;
    }

    // Only active on connected clients
    const isConnected = Boolean(
      this.connectionManager?.isConnected ?? this.client?.connectionManager?.isConnected
    );
    const clientState = this.client?.state;
    if (clientState && clientState !== 'READY' && clientState !== 'OPEN') {
      return;
    }
    if (!isConnected) {
      return;
    }

    const now = Date.now();
    const silenceDurationMs = this.#lastActivityAt ? Math.max(0, now - this.#lastActivityAt) : 0;

    this.#safeEmit('watchdog_tick', {
      timestamp: now,
      silenceDurationMs,
      missedPings: this.#missedPings,
      state: this.state
    });

    if (silenceDurationMs >= this.maxSilenceMs) {
      this.#dispatchPing(now, silenceDurationMs);
    }
  }

  /**
   * Internal tick evaluation trigger for test harness orchestration.
   */
  _performTick() {
    return this.#performTick();
  }

  /**
   * Internal ping dispatch trigger for test harness orchestration.
   */
  _dispatchPing(now = Date.now(), silenceDurationMs = this.maxSilenceMs) {
    return this.#dispatchPing(now, silenceDurationMs);
  }

  /**
   * Internal zombie detection trigger for test harness orchestration.
   */
  async _handleZombieDetected(now = Date.now()) {
    return this.#handleZombieDetected(now);
  }

  /**
   * Starts watchdog monitoring loop (Idempotent).
   */
  start() {
    this.#terminationGeneration++;
    if (this.state === WATCHDOG_STATE.RUNNING) return;
    this.state = WATCHDOG_STATE.RUNNING;
    this.#lastActivityAt = Date.now();
    this.#terminationInProgress = false;

    if (this.enabled && this.checkIntervalMs > 0) {
      if (!this.#intervalTimer) {
        this.#intervalTimer = setInterval(() => {
          this.#performTick();
        }, this.checkIntervalMs);

        if (this.#intervalTimer && typeof this.#intervalTimer.unref === 'function') {
          this.#intervalTimer.unref();
        }
      }
    }
  }

  /**
   * Stops watchdog monitoring loop (Idempotent).
   * Invalidates any in-flight async termination.
   */
  stop() {
    this.#terminationGeneration++;
    if (this.state === WATCHDOG_STATE.STOPPED) return;
    this.state = WATCHDOG_STATE.STOPPED;

    if (this.#intervalTimer) {
      clearInterval(this.#intervalTimer);
      this.#intervalTimer = null;
    }

    this.#clearPingTimeout();
    this.#pingInFlight = false;
    this.#terminationInProgress = false;
  }

  /**
   * Pauses watchdog monitoring (e.g. during client disconnect or reconnecting).
   * Invalidates any in-flight async termination.
   */
  pause() {
    this.#terminationGeneration++;
    if (this.state === WATCHDOG_STATE.PAUSED || this.state === WATCHDOG_STATE.STOPPED) return;
    this.state = WATCHDOG_STATE.PAUSED;

    this.#clearPingTimeout();
    this.#pingInFlight = false;
    this.#missedPings = 0;
    this.#terminationInProgress = false;
  }

  /**
   * Resumes watchdog monitoring (e.g. when client reaches READY state).
   * Invalidates any in-flight async termination.
   */
  resume() {
    this.#terminationGeneration++;
    if (this.state === WATCHDOG_STATE.STOPPED) {
      this.start();
      return;
    }
    this.state = WATCHDOG_STATE.RUNNING;
    this.#lastActivityAt = Date.now();
    this.#missedPings = 0;
    this.#pingInFlight = false;
    this.#terminationInProgress = false;
  }

  /**
   * Resets diagnostic counters.
   */
  reset() {
    this.#terminationGeneration++;
    this.#missedPings = 0;
    this.#zombiesDetectedTotal = 0;
    this.#pingSentAt = null;
    this.#lastPingAckAt = null;
    this.#lastActivityAt = Date.now();
    this.#pingInFlight = false;
    this.#terminationInProgress = false;
    this.#clearPingTimeout();
  }

  /**
   * Returns a deep-cloned diagnostic status snapshot.
   */
  getStatus() {
    const now = Date.now();
    const silenceDurationMs = this.#lastActivityAt ? Math.max(0, now - this.#lastActivityAt) : 0;
    return {
      state: this.state,
      silenceDurationMs,
      missedPings: this.#missedPings,
      zombiesDetectedTotal: this.#zombiesDetectedTotal,
      lastActivityAt: this.#lastActivityAt,
      lastPingSentAt: this.#pingSentAt,
      lastPingAckAt: this.#lastPingAckAt,
      pingInFlight: this.#pingInFlight,
      terminationInProgress: this.#terminationInProgress
    };
  }
}
