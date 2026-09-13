import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { MemoryError } from '../errors/LeavesError.js';

export const MEMORY_GUARD_STATE = Object.freeze({
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED'
});

export const MEMORY_GUARD_LEVEL = Object.freeze({
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL'
});

export const MEMORY_ERROR_CODES = Object.freeze({
  MEMORY_INVALID_OPTION: 'MEMORY_INVALID_OPTION',
  MEMORY_INVALID_THRESHOLD: 'MEMORY_INVALID_THRESHOLD',
  MEMORY_HOOK_ERROR: 'MEMORY_HOOK_ERROR'
});

export const DEFAULT_MEMORY_GUARD_OPTIONS = Object.freeze({
  enabled: true,
  checkIntervalMs: 30000,
  heapWarningBytes: 150 * 1024 * 1024,   // 150 MB (Configurable heuristic)
  heapCriticalBytes: 300 * 1024 * 1024,  // 300 MB (Configurable heuristic)
  rssWarningBytes: 250 * 1024 * 1024,    // 250 MB (Configurable heuristic)
  rssCriticalBytes: 500 * 1024 * 1024,   // 500 MB (Configurable heuristic)
  growthRateWarningPercent: 20,          // 20%
  minimumGrowthBytes: 20 * 1024 * 1024,  // 20 MB minimum meaningful growth
  sampleWindowSize: 5,                   // 5 samples
  autoMitigateOnCritical: true,
  allowManualGc: false,
  gcCooldownMs: 60000,                   // 60s
  hookTimeoutMs: 5000                    // 5s per hook timeout
});

export const DEFAULT_MEMORY_GUARD_STATUS = Object.freeze({
  state: MEMORY_GUARD_STATE.STOPPED,
  level: MEMORY_GUARD_LEVEL.NORMAL,
  timestamp: null,
  heapUsed: null,
  heapTotal: null,
  heapRatio: null,
  rss: null,
  external: null,
  arrayBuffers: null,
  growthRatePercent: 0,
  consecutiveIncreases: 0,
  sampleCount: 0,
  mitigationInFlight: false,
  lastMitigationAt: null,
  lastMitigationResult: null
});

/**
 * Safely serializes and sanitizes mitigation hook results against circular references,
 * non-clonable types (functions, symbols), BigInts, and unbounded depth.
 */
export function sanitizeMitigationResult(data) {
  if (data === undefined || data === null) return null;
  try {
    const seen = new WeakSet();
    const clean = (val, depth = 0) => {
      if (depth > 5) return '[Truncated: Depth Limit]';
      if (val === null || typeof val !== 'object') {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'function' || typeof val === 'symbol') return undefined;
        return val;
      }
      if (seen.has(val)) return '[Circular Reference]';
      seen.add(val);

      if (Array.isArray(val)) {
        return val.slice(0, 50).map((item) => clean(item, depth + 1));
      }

      const out = {};
      const keys = Object.keys(val).slice(0, 50);
      for (const k of keys) {
        const cleaned = clean(val[k], depth + 1);
        if (cleaned !== undefined) {
          out[k] = cleaned;
        }
      }
      return out;
    };
    return clean(data);
  } catch (_) {
    return { error: 'Failed to serialize mitigation result' };
  }
}

/**
 * Validates MemoryGuard configuration parameters with strict type, bounds, and invariant checks.
 */
export function validateMemoryGuardOptions(options = {}) {
  const merged = { ...DEFAULT_MEMORY_GUARD_OPTIONS, ...options };

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
      throw new MemoryError(
        `MemoryGuard option "${key}" must be an integer between ${min} and ${max} (got: ${val})`,
        MEMORY_ERROR_CODES.MEMORY_INVALID_OPTION
      );
    }
  };

  validateInteger('checkIntervalMs', 1000, 300000);
  validateInteger('heapWarningBytes', 1024 * 1024, 100 * 1024 * 1024 * 1024);
  validateInteger('heapCriticalBytes', 1024 * 1024, 100 * 1024 * 1024 * 1024);
  validateInteger('rssWarningBytes', 1024 * 1024, 100 * 1024 * 1024 * 1024);
  validateInteger('rssCriticalBytes', 1024 * 1024, 100 * 1024 * 1024 * 1024);
  validateInteger('growthRateWarningPercent', 5, 100);
  validateInteger('minimumGrowthBytes', 1024 * 1024, 10 * 1024 * 1024 * 1024);
  validateInteger('sampleWindowSize', 3, 50);
  validateInteger('gcCooldownMs', 10000, 600000);
  validateInteger('hookTimeoutMs', 500, 30000);

  // Invariant validation: warning < critical
  if (merged.heapWarningBytes >= merged.heapCriticalBytes) {
    throw new MemoryError(
      `Invalid threshold pair for heap: heapWarningBytes (${merged.heapWarningBytes}) must be strictly less than heapCriticalBytes (${merged.heapCriticalBytes})`,
      MEMORY_ERROR_CODES.MEMORY_INVALID_THRESHOLD
    );
  }

  if (merged.rssWarningBytes >= merged.rssCriticalBytes) {
    throw new MemoryError(
      `Invalid threshold pair for rss: rssWarningBytes (${merged.rssWarningBytes}) must be strictly less than rssCriticalBytes (${merged.rssCriticalBytes})`,
      MEMORY_ERROR_CODES.MEMORY_INVALID_THRESHOLD
    );
  }

  const validateBoolean = (key) => {
    if (merged[key] !== undefined && typeof merged[key] !== 'boolean') {
      throw new MemoryError(
        `MemoryGuard option "${key}" must be a boolean (got: ${typeof merged[key]})`,
        MEMORY_ERROR_CODES.MEMORY_INVALID_OPTION
      );
    }
  };

  validateBoolean('enabled');
  validateBoolean('autoMitigateOnCritical');
  validateBoolean('allowManualGc');

  return merged;
}

/**
 * MemoryGuard monitors host Node.js process memory metrics, evaluates heuristic sustained growth,
 * emits structured lifecycle pressure events, and executes official bounded subsystem mitigation hooks.
 * 
 * Invariants:
 * - Observes process-level memory via process.memoryUsage(), not claiming exclusive package memory.
 * - Zero ReconnectManager, socket termination, or process.exit authority.
 * - Single-flight promise coalescing for all mitigation executions.
 */
export class MemoryGuard extends EventEmitter {
  #history = [];
  #mitigationHooks = new Map();
  #inFlightMitigation = null;
  #intervalTimer = null;
  #lastGcAt = null;
  #lastMitigationAt = null;
  #lastMitigationResult = null;
  #previousLevel = null;

  constructor(options = {}) {
    super();
    this.client = options.client || null;

    const validated = validateMemoryGuardOptions(options);
    this.enabled = validated.enabled;
    this.checkIntervalMs = validated.checkIntervalMs;
    this.heapWarningBytes = validated.heapWarningBytes;
    this.heapCriticalBytes = validated.heapCriticalBytes;
    this.rssWarningBytes = validated.rssWarningBytes;
    this.rssCriticalBytes = validated.rssCriticalBytes;
    this.growthRateWarningPercent = validated.growthRateWarningPercent;
    this.minimumGrowthBytes = validated.minimumGrowthBytes;
    this.sampleWindowSize = validated.sampleWindowSize;
    this.autoMitigateOnCritical = validated.autoMitigateOnCritical;
    this.allowManualGc = validated.allowManualGc;
    this.gcCooldownMs = validated.gcCooldownMs;
    this.hookTimeoutMs = validated.hookTimeoutMs;

    this.state = MEMORY_GUARD_STATE.STOPPED;
    this.level = MEMORY_GUARD_LEVEL.NORMAL;
  }

  /**
   * Safe event emission protecting internal loops from observer exceptions.
   */
  #safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (_) {}
  }

  /**
   * Samples process-level memory metrics from process.memoryUsage().
   * @returns {object} Canonical processMemory snapshot.
   */
  #sampleProcessMemory() {
    const timestamp = Date.now();
    const mem = process.memoryUsage();
    const heapUsed = mem.heapUsed;
    const heapTotal = mem.heapTotal;
    const heapRatio = heapTotal > 0 ? Number((heapUsed / heapTotal).toFixed(4)) : 0;
    const rss = mem.rss;
    const external = mem.external;
    const arrayBuffers = mem.arrayBuffers || 0;

    return {
      timestamp,
      heapUsed,
      heapTotal,
      heapRatio,
      rss,
      external,
      arrayBuffers
    };
  }

  /**
   * Evaluates heuristic sustained growth across the sliding window history.
   * Requires:
   * 1. Full window size reached.
   * 2. Strictly non-decreasing heapUsed across all consecutive samples.
   * 3. Relative growth percent >= growthRateWarningPercent.
   * 4. Absolute growth bytes >= minimumGrowthBytes.
   */
  #evaluateGrowthTrend() {
    if (this.#history.length < this.sampleWindowSize) {
      return {
        isSustained: false,
        growthRatePercent: 0,
        consecutiveIncreases: 0,
        deltaBytes: 0
      };
    }

    let consecutiveIncreases = 0;
    for (let i = 1; i < this.#history.length; i++) {
      if (this.#history[i].heapUsed > this.#history[i - 1].heapUsed) {
        consecutiveIncreases++;
      } else {
        // Monotonic growth broken
        return {
          isSustained: false,
          growthRatePercent: 0,
          consecutiveIncreases,
          deltaBytes: 0
        };
      }
    }

    const first = this.#history[0].heapUsed;
    const last = this.#history[this.#history.length - 1].heapUsed;
    const deltaBytes = Math.max(0, last - first);
    const growthRatePercent = first > 0 ? Number(((deltaBytes / first) * 100).toFixed(2)) : 0;

    const isSustained =
      consecutiveIncreases === this.#history.length - 1 &&
      growthRatePercent >= this.growthRateWarningPercent &&
      deltaBytes >= this.minimumGrowthBytes;

    return {
      isSustained,
      growthRatePercent,
      consecutiveIncreases,
      deltaBytes
    };
  }

  /**
   * Periodic evaluation tick.
   */
  #performTick() {
    if (this.state !== MEMORY_GUARD_STATE.RUNNING) {
      return;
    }

    const mem = this.#sampleProcessMemory();

    // Update bounded sliding window
    this.#history.push(mem);
    if (this.#history.length > this.sampleWindowSize) {
      this.#history.shift();
    }

    // Evaluate heuristic sustained growth
    const growth = this.#evaluateGrowthTrend();

    // Evaluate pressure level (CRITICAL > WARNING > NORMAL)
    const criticalReasons = [];
    const warningReasons = [];

    if (mem.heapUsed >= this.heapCriticalBytes) {
      criticalReasons.push(`heapUsed (${mem.heapUsed} bytes) >= heapCriticalBytes (${this.heapCriticalBytes} bytes)`);
    }
    if (mem.rss >= this.rssCriticalBytes) {
      criticalReasons.push(`rss (${mem.rss} bytes) >= rssCriticalBytes (${this.rssCriticalBytes} bytes)`);
    }

    if (mem.heapUsed >= this.heapWarningBytes && mem.heapUsed < this.heapCriticalBytes) {
      warningReasons.push(`heapUsed (${mem.heapUsed} bytes) >= heapWarningBytes (${this.heapWarningBytes} bytes)`);
    }
    if (mem.rss >= this.rssWarningBytes && mem.rss < this.rssCriticalBytes) {
      warningReasons.push(`rss (${mem.rss} bytes) >= rssWarningBytes (${this.rssWarningBytes} bytes)`);
    }

    let level = MEMORY_GUARD_LEVEL.NORMAL;
    if (criticalReasons.length > 0) {
      level = MEMORY_GUARD_LEVEL.CRITICAL;
    } else if (warningReasons.length > 0) {
      level = MEMORY_GUARD_LEVEL.WARNING;
    }

    this.level = level;

    // Emit periodic sample event
    this.#safeEmit('memory_sample', {
      timestamp: mem.timestamp,
      state: this.state,
      level,
      processMemory: mem,
      growth: {
        ratePercent: growth.growthRatePercent,
        consecutiveIncreases: growth.consecutiveIncreases,
        deltaBytes: growth.deltaBytes
      }
    });

    // Emit heuristic sustained growth warning if triggered
    if (growth.isSustained) {
      const growthPayload = {
        timestamp: mem.timestamp,
        isHeuristic: true,
        growthRatePercent: growth.growthRatePercent,
        consecutiveIncreases: growth.consecutiveIncreases,
        deltaBytes: growth.deltaBytes,
        sampleCount: this.#history.length,
        currentHeapUsed: mem.heapUsed,
        reason: 'SUSTAINED_GROWTH_HEURISTIC_TRIGGERED'
      };

      // Canonical event
      this.#safeEmit('memory_growth_warning', growthPayload);
      // Backwards-compatible alias
      this.#safeEmit('memory_leak_warning', growthPayload);
    }

    // Complete state transition events
    const prev = this.#previousLevel;
    if (level === MEMORY_GUARD_LEVEL.CRITICAL && prev !== MEMORY_GUARD_LEVEL.CRITICAL) {
      this.#safeEmit('memory_critical', {
        timestamp: mem.timestamp,
        level: MEMORY_GUARD_LEVEL.CRITICAL,
        processMemory: mem,
        reasons: criticalReasons
      });

      if (this.autoMitigateOnCritical) {
        this.mitigate().catch(() => {});
      }
    } else if (level === MEMORY_GUARD_LEVEL.WARNING && prev !== MEMORY_GUARD_LEVEL.WARNING) {
      this.#safeEmit('memory_pressure', {
        timestamp: mem.timestamp,
        level: MEMORY_GUARD_LEVEL.WARNING,
        processMemory: mem,
        reasons: warningReasons
      });
    } else if (level === MEMORY_GUARD_LEVEL.NORMAL && (prev === MEMORY_GUARD_LEVEL.WARNING || prev === MEMORY_GUARD_LEVEL.CRITICAL)) {
      this.#safeEmit('memory_recovered', {
        timestamp: mem.timestamp,
        fromLevel: prev,
        processMemory: mem
      });
    }

    this.#previousLevel = level;
  }

  /**
   * Internal tick evaluation trigger for test harness orchestration.
   */
  _performTick() {
    return this.#performTick();
  }

  /**
   * Internal growth trend evaluation trigger for test harness orchestration.
   */
  _evaluateGrowthTrend() {
    return this.#evaluateGrowthTrend();
  }

  /**
   * Internal history injection trigger for test harness orchestration.
   */
  _injectHistory(entries) {
    this.#history = entries.slice(-this.sampleWindowSize);
  }

  /**
   * Executes registered official mitigation hooks and throttled manual GC with single-flight coalescing.
   * Multiple concurrent calls return the same in-flight Promise.
   * @returns {Promise<object>} Forensic mitigation report.
   */
  mitigate() {
    if (this.#inFlightMitigation) {
      return this.#inFlightMitigation;
    }

    this.#inFlightMitigation = this.#performMitigation().finally(() => {
      this.#inFlightMitigation = null;
    });

    return this.#inFlightMitigation;
  }

  async #performMitigation() {
    const startTime = performance.now();
    const timestamp = Date.now();
    const actions = [];
    let hasErrors = false;

    // 1. Execute registered official mitigation hooks with per-hook bounded timeout
    if (this.#mitigationHooks.size > 0) {
      for (const hookDef of this.#mitigationHooks.values()) {
        const hookStart = performance.now();
        const hookPromise = Promise.resolve().then(() => hookDef.fn());
        // Attach noop catch to prevent unhandled late rejection if hook rejects after timeout
        hookPromise.catch(() => {});

        let timeoutTimer = null;
        const timeoutPromise = new Promise((resolve) => {
          timeoutTimer = setTimeout(() => {
            resolve({
              status: 'TIMEOUT',
              error: `Hook timed out after ${hookDef.timeoutMs}ms (MemoryGuard abandoned waiting)`
            });
          }, hookDef.timeoutMs);
          if (timeoutTimer && typeof timeoutTimer.unref === 'function') {
            timeoutTimer.unref();
          }
        });

        let outcome = null;
        try {
          outcome = await Promise.race([
            hookPromise.then((res) => ({ status: 'COMPLETED', result: res })),
            timeoutPromise
          ]);
        } catch (err) {
          outcome = { status: 'ERROR', error: err?.message || String(err) };
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer);
        }

        if (outcome.status === 'ERROR' || outcome.status === 'TIMEOUT') {
          hasErrors = true;
        }

        const durationMs = Number((performance.now() - hookStart).toFixed(2));
        actions.push({
          name: hookDef.name,
          status: outcome.status,
          durationMs,
          result: sanitizeMitigationResult(outcome.result),
          error: outcome.error ?? null
        });
      }
    }

    // 2. Execute throttled manual GC if enabled and available
    if (this.allowManualGc) {
      const gcStart = performance.now();
      if (typeof global.gc === 'function') {
        const now = Date.now();
        if (!this.#lastGcAt || now - this.#lastGcAt >= this.gcCooldownMs) {
          try {
            global.gc();
            this.#lastGcAt = now;
            actions.push({
              name: 'manualGc',
              status: 'COMPLETED',
              durationMs: Number((performance.now() - gcStart).toFixed(2)),
              result: { executed: true, cooldownMs: this.gcCooldownMs },
              error: null
            });
          } catch (gcErr) {
            hasErrors = true;
            actions.push({
              name: 'manualGc',
              status: 'ERROR',
              durationMs: Number((performance.now() - gcStart).toFixed(2)),
              result: null,
              error: gcErr?.message || String(gcErr)
            });
          }
        } else {
          actions.push({
            name: 'manualGc',
            status: 'SKIPPED_COOLDOWN',
            durationMs: 0,
            result: {
              executed: false,
              remainingCooldownMs: Math.max(0, this.gcCooldownMs - (now - this.#lastGcAt))
            },
            error: null
          });
        }
      } else {
        actions.push({
          name: 'manualGc',
          status: 'UNAVAILABLE',
          durationMs: 0,
          result: { executed: false, reason: 'global.gc is not a function (run with --expose-gc)' },
          error: null
        });
      }
    }

    const totalDurationMs = Number((performance.now() - startTime).toFixed(2));
    const report = {
      attempted: true,
      succeeded: !hasErrors,
      timestamp,
      durationMs: totalDurationMs,
      actions
    };

    this.#lastMitigationAt = timestamp;
    this.#lastMitigationResult = report;

    this.#safeEmit('mitigation_completed', report);
    return report;
  }

  /**
   * Registers an official subsystem mitigation hook with strict validation.
   */
  registerMitigationHook(name, hookFn, options = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new MemoryError('Mitigation hook name must be a non-empty string', MEMORY_ERROR_CODES.MEMORY_INVALID_OPTION);
    }
    if (typeof hookFn !== 'function') {
      throw new MemoryError('Mitigation hook handler must be a function', MEMORY_ERROR_CODES.MEMORY_INVALID_OPTION);
    }

    let timeoutMs = this.hookTimeoutMs;
    if (options.timeoutMs !== undefined) {
      if (
        typeof options.timeoutMs !== 'number' ||
        !Number.isFinite(options.timeoutMs) ||
        Number.isNaN(options.timeoutMs) ||
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 500 ||
        options.timeoutMs > 30000
      ) {
        throw new MemoryError(
          `Mitigation hook "timeoutMs" must be an integer between 500 and 30000 (got: ${options.timeoutMs})`,
          MEMORY_ERROR_CODES.MEMORY_INVALID_OPTION
        );
      }
      timeoutMs = options.timeoutMs;
    }

    this.#mitigationHooks.set(name.trim(), {
      name: name.trim(),
      fn: hookFn,
      timeoutMs
    });
  }

  /**
   * Unregisters an official mitigation hook.
   */
  unregisterMitigationHook(name) {
    if (typeof name !== 'string') return false;
    return this.#mitigationHooks.delete(name.trim());
  }

  /**
   * Returns an array of registered hook names.
   */
  getRegisteredHooks() {
    return Array.from(this.#mitigationHooks.keys());
  }

  /**
   * On-demand observation snapshot. Does NOT mutate sliding window history or emit events.
   */
  checkNow() {
    const mem = this.#sampleProcessMemory();
    let level = MEMORY_GUARD_LEVEL.NORMAL;
    if (mem.heapUsed >= this.heapCriticalBytes || mem.rss >= this.rssCriticalBytes) {
      level = MEMORY_GUARD_LEVEL.CRITICAL;
    } else if (mem.heapUsed >= this.heapWarningBytes || mem.rss >= this.rssWarningBytes) {
      level = MEMORY_GUARD_LEVEL.WARNING;
    }

    return {
      timestamp: mem.timestamp,
      level,
      isHealthy: level === MEMORY_GUARD_LEVEL.NORMAL,
      processMemory: mem
    };
  }

  /**
   * Starts periodic memory monitoring loop (Idempotent).
   */
  start() {
    if (this.state === MEMORY_GUARD_STATE.RUNNING) return;
    this.state = MEMORY_GUARD_STATE.RUNNING;

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
   * Stops periodic memory monitoring loop (Idempotent).
   * Does NOT forcibly null #inFlightMitigation (active mitigation finishes naturally).
   */
  stop() {
    if (this.state === MEMORY_GUARD_STATE.STOPPED) return;
    this.state = MEMORY_GUARD_STATE.STOPPED;

    if (this.#intervalTimer) {
      clearInterval(this.#intervalTimer);
      this.#intervalTimer = null;
    }
  }

  /**
   * Pauses periodic memory monitoring (e.g. during client disconnect).
   * Strictly clears periodic interval timer.
   */
  pause() {
    if (this.state === MEMORY_GUARD_STATE.PAUSED || this.state === MEMORY_GUARD_STATE.STOPPED) return;
    this.state = MEMORY_GUARD_STATE.PAUSED;

    if (this.#intervalTimer) {
      clearInterval(this.#intervalTimer);
      this.#intervalTimer = null;
    }
  }

  /**
   * Resumes periodic memory monitoring (e.g. when client reaches READY state).
   * Recreates periodic interval timer if enabled and checkIntervalMs > 0.
   */
  resume() {
    if (this.state === MEMORY_GUARD_STATE.STOPPED) {
      this.start();
      return;
    }
    if (this.state === MEMORY_GUARD_STATE.RUNNING) return;
    this.state = MEMORY_GUARD_STATE.RUNNING;

    if (this.enabled && this.checkIntervalMs > 0 && !this.#intervalTimer) {
      this.#intervalTimer = setInterval(() => {
        this.#performTick();
      }, this.checkIntervalMs);

      if (this.#intervalTimer && typeof this.#intervalTimer.unref === 'function') {
        this.#intervalTimer.unref();
      }
    }
  }

  /**
   * Resets diagnostic counters and sliding window history.
   */
  reset() {
    this.#history = [];
    this.#lastMitigationAt = null;
    this.#lastMitigationResult = null;
    this.#previousLevel = null;
    this.level = MEMORY_GUARD_LEVEL.NORMAL;
  }

  /**
   * Returns a deep-cloned diagnostic status snapshot adhering to the 15-field canonical schema.
   */
  getStatus() {
    const mem = this.#history.length > 0
      ? this.#history[this.#history.length - 1]
      : this.#sampleProcessMemory();

    const growth = this.#evaluateGrowthTrend();

    return {
      state: this.state,
      level: this.level,
      timestamp: mem.timestamp,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapRatio: mem.heapRatio,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      growthRatePercent: growth.growthRatePercent,
      consecutiveIncreases: growth.consecutiveIncreases,
      sampleCount: this.#history.length,
      mitigationInFlight: this.#inFlightMitigation !== null,
      lastMitigationAt: this.#lastMitigationAt,
      lastMitigationResult: this.#lastMitigationResult ? structuredClone(this.#lastMitigationResult) : null
    };
  }
}
