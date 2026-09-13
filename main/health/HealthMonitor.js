import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { HealthError } from '../errors/LeavesError.js';
import { DEFAULT_MEMORY_GUARD_STATUS } from '../memory/MemoryGuard.js';

export const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  CRITICAL: 'CRITICAL'
});

export const PROBE_STATUS = Object.freeze({
  OK: 'OK',
  ERROR: 'ERROR',
  TIMEOUT: 'TIMEOUT'
});

export const MONITOR_STATE = Object.freeze({
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING'
});

export const HEALTH_ERROR_CODES = Object.freeze({
  HEALTH_INVALID_THRESHOLD: 'HEALTH_INVALID_THRESHOLD',
  HEALTH_INVALID_OPTION: 'HEALTH_INVALID_OPTION',
  HEALTH_PROBE_ERROR: 'HEALTH_PROBE_ERROR'
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  eventLoopLagDegradedMs: 250,
  eventLoopLagCriticalMs: 1000,
  memoryHeapPercentDegraded: 80,
  memoryHeapPercentCritical: 95,
  disconnectedDurationDegradedMs: 15000,
  disconnectedDurationCriticalMs: 60000
});

/**
 * Validates that health thresholds are positive numbers and degraded < critical.
 */
export function validateThresholds(thresholds = {}) {
  const merged = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const checkPair = (degradedKey, criticalKey, name) => {
    const deg = merged[degradedKey];
    const crit = merged[criticalKey];

    if (typeof deg !== 'number' || !Number.isFinite(deg) || Number.isNaN(deg) || deg < 0) {
      throw new HealthError(
        `Threshold "${degradedKey}" must be a non-negative finite number (got: ${deg})`,
        HEALTH_ERROR_CODES.HEALTH_INVALID_THRESHOLD
      );
    }
    if (typeof crit !== 'number' || !Number.isFinite(crit) || Number.isNaN(crit) || crit < 0) {
      throw new HealthError(
        `Threshold "${criticalKey}" must be a non-negative finite number (got: ${crit})`,
        HEALTH_ERROR_CODES.HEALTH_INVALID_THRESHOLD
      );
    }
    if (deg >= crit) {
      throw new HealthError(
        `Invalid threshold pair for ${name}: degraded (${deg}) must be strictly less than critical (${crit})`,
        HEALTH_ERROR_CODES.HEALTH_INVALID_THRESHOLD
      );
    }
  };

  checkPair('eventLoopLagDegradedMs', 'eventLoopLagCriticalMs', 'eventLoopLag');
  checkPair('memoryHeapPercentDegraded', 'memoryHeapPercentCritical', 'memoryHeapPercent');
  checkPair('disconnectedDurationDegradedMs', 'disconnectedDurationCriticalMs', 'disconnectedDuration');

  return merged;
}

/**
 * Measures event loop latency asynchronously without blocking.
 */
function measureEventLoopLag() {
  const start = performance.now();
  return new Promise((resolve) => {
    setImmediate(() => {
      const duration = performance.now() - start;
      resolve(Math.max(0, Number(duration.toFixed(2))));
    });
  });
}

/**
 * Safely serializes custom probe results without crashing on circular objects or unsupported types.
 */
function sanitizeProbeResult(data) {
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
    return { error: 'Failed to serialize probe result' };
  }
}

/**
 * HealthMonitor handles runtime observability, event loop lag profiling,
 * threshold evaluation, bounded ring buffer history, unified single-flight execution,
 * and isolated custom probe execution.
 */
export class HealthMonitor extends EventEmitter {
  #history = [];
  #customProbes = new Map();
  #intervalTimer = null;
  #inFlightEvaluation = null;
  #previousStatus = null;
  #lastSummary = null;

  // Rate sampling trackers
  #lastSampleTime = null;
  #lastReceivedCount = 0;

  constructor(options = {}) {
    super();
    this.client = options.client || null;
    this.enabled = options.enabled !== false;

    // Strict validation for probeIntervalMs
    if (options.probeIntervalMs !== undefined) {
      if (
        typeof options.probeIntervalMs !== 'number' ||
        !Number.isFinite(options.probeIntervalMs) ||
        Number.isNaN(options.probeIntervalMs) ||
        !Number.isInteger(options.probeIntervalMs) ||
        options.probeIntervalMs < 0
      ) {
        throw new HealthError(
          `Option "probeIntervalMs" must be a non-negative integer (got: ${options.probeIntervalMs})`,
          HEALTH_ERROR_CODES.HEALTH_INVALID_OPTION
        );
      }
      this.probeIntervalMs = options.probeIntervalMs;
    } else {
      this.probeIntervalMs = 30000;
    }

    // Strict validation for probeTimeoutMs
    if (options.probeTimeoutMs !== undefined) {
      if (
        typeof options.probeTimeoutMs !== 'number' ||
        !Number.isFinite(options.probeTimeoutMs) ||
        Number.isNaN(options.probeTimeoutMs) ||
        !Number.isInteger(options.probeTimeoutMs) ||
        options.probeTimeoutMs < 100 ||
        options.probeTimeoutMs > 30000
      ) {
        throw new HealthError(
          `Option "probeTimeoutMs" must be an integer between 100 and 30000 (got: ${options.probeTimeoutMs})`,
          HEALTH_ERROR_CODES.HEALTH_INVALID_OPTION
        );
      }
      this.probeTimeoutMs = options.probeTimeoutMs;
    } else {
      this.probeTimeoutMs = 3000;
    }

    // Strict validation for historyLength
    if (options.historyLength !== undefined) {
      if (
        typeof options.historyLength !== 'number' ||
        !Number.isFinite(options.historyLength) ||
        Number.isNaN(options.historyLength) ||
        !Number.isInteger(options.historyLength) ||
        options.historyLength < 1 ||
        options.historyLength > 1000
      ) {
        throw new HealthError(
          `Option "historyLength" must be an integer between 1 and 1000 (got: ${options.historyLength})`,
          HEALTH_ERROR_CODES.HEALTH_INVALID_OPTION
        );
      }
      this.historyLength = options.historyLength;
    } else {
      this.historyLength = 60;
    }

    this.thresholds = validateThresholds(options.thresholds || {});
    this.state = MONITOR_STATE.STOPPED;

    if (options.customProbes && typeof options.customProbes === 'object') {
      for (const [name, fn] of Object.entries(options.customProbes)) {
        if (typeof fn === 'function') {
          this.registerProbe(name, fn);
        }
      }
    }
  }

  /**
   * Unified Single-Flight Evaluation Gate.
   * Ensures only ONE evaluation executes across manual and periodic triggers.
   */
  async #evaluate(isPeriodic = false) {
    if (this.#inFlightEvaluation) {
      return this.#inFlightEvaluation;
    }

    this.#inFlightEvaluation = this.#performEvaluation({ isPeriodic }).finally(() => {
      this.#inFlightEvaluation = null;
    });

    return this.#inFlightEvaluation;
  }

  /**
   * Starts periodic health probing scheduler (Idempotent).
   */
  start() {
    if (this.state === MONITOR_STATE.RUNNING) return;
    this.state = MONITOR_STATE.RUNNING;

    if (this.enabled && this.probeIntervalMs > 0) {
      this.#intervalTimer = setInterval(() => {
        // Unified single-flight gate: skips tick if an evaluation is already running
        if (this.#inFlightEvaluation) return;
        this.#evaluate(true).catch(() => {});
      }, this.probeIntervalMs);
    }
  }

  /**
   * Stops periodic health probing scheduler (Idempotent).
   */
  stop() {
    if (this.state === MONITOR_STATE.STOPPED) return;
    this.state = MONITOR_STATE.STOPPED;

    if (this.#intervalTimer) {
      clearInterval(this.#intervalTimer);
      this.#intervalTimer = null;
    }
  }

  /**
   * Registers a custom health probe with strict validation.
   */
  registerProbe(name, probeFn, options = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new HealthError('Probe name must be a non-empty string', HEALTH_ERROR_CODES.HEALTH_INVALID_OPTION);
    }
    if (typeof probeFn !== 'function') {
      throw new HealthError('Probe handler must be a function', HEALTH_ERROR_CODES.HEALTH_INVALID_OPTION);
    }

    let timeoutMs = this.probeTimeoutMs;
    if (options.timeoutMs !== undefined) {
      if (
        typeof options.timeoutMs !== 'number' ||
        !Number.isFinite(options.timeoutMs) ||
        Number.isNaN(options.timeoutMs) ||
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 100 ||
        options.timeoutMs > 30000
      ) {
        throw new HealthError(
          `Probe "timeoutMs" must be an integer between 100 and 30000 (got: ${options.timeoutMs})`,
          HEALTH_ERROR_CODES.HEALTH_INVALID_OPTION
        );
      }
      timeoutMs = options.timeoutMs;
    }

    if (options.critical !== undefined && typeof options.critical !== 'boolean') {
      throw new HealthError(
        `Probe "critical" option must be a boolean (got: ${typeof options.critical})`,
        HEALTH_ERROR_CODES.HEALTH_INVALID_OPTION
      );
    }

    this.#customProbes.set(name.trim(), {
      name: name.trim(),
      fn: probeFn,
      timeoutMs,
      critical: options.critical === true
    });
  }

  /**
   * Unregisters a custom health probe.
   */
  unregisterProbe(name) {
    if (typeof name !== 'string') return false;
    return this.#customProbes.delete(name.trim());
  }

  /**
   * Returns an array of registered custom probe names.
   */
  getRegisteredProbes() {
    return Array.from(this.#customProbes.keys());
  }

  /**
   * Safe event emission that protects the monitor from throwing observer callbacks.
   */
  #safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (_) {}
  }

  /**
   * Internal evaluation engine.
   */
  async #performEvaluation({ isPeriodic = false } = {}) {
    const timestamp = Date.now();
    const timestampISO = new Date(timestamp).toISOString();

    // 1. Measure Event Loop Lag asynchronously
    const eventLoopLagMs = await measureEventLoopLag();

    // 2. Measure Memory Usage
    const memUsage = process.memoryUsage();
    const heapUsedBytes = memUsage.heapUsed;
    const heapTotalBytes = memUsage.heapTotal;
    const heapPercent = Number(((heapUsedBytes / heapTotalBytes) * 100).toFixed(2));
    const rssBytes = memUsage.rss;
    const externalBytes = memUsage.external;

    // 3. Measure CPU Usage
    const cpuUsage = process.cpuUsage();
    const cpu = {
      userMicros: cpuUsage.user,
      systemMicros: cpuUsage.system
    };

    // 4. Sample Client & Connection State (Read-only)
    const clientState = this.client?.state || 'UNINITIALIZED';
    const isConnected = Boolean(this.client?.connectionManager?.isConnected);
    const connectedAt = this.client?.connectedAt || null;
    const readyAt = this.client?.readyAt || null;
    const disconnectedAt = this.client?.disconnectedAt || null;

    let disconnectedDurationMs = 0;
    if (!isConnected && disconnectedAt) {
      disconnectedDurationMs = Math.max(0, timestamp - disconnectedAt);
    }

    const uptimeSeconds = readyAt && isConnected
      ? Math.floor((timestamp - readyAt) / 1000)
      : (connectedAt && isConnected ? Math.floor((timestamp - connectedAt) / 1000) : 0);

    const userJid = this.client?.connectionManager?.sock?.user?.id || null;

    // 5. Sample Subsystems Statistics (Read-only)
    const watchdogStatus = this.client?.watchdog && typeof this.client.watchdog.getStatus === 'function'
      ? this.client.watchdog.getStatus()
      : {
          state: 'STOPPED',
          silenceDurationMs: 0,
          missedPings: 0,
          zombiesDetectedTotal: 0,
          lastActivityAt: null,
          lastPingSentAt: null,
          lastPingAckAt: null,
          pingInFlight: false,
          terminationInProgress: false
        };

    const memoryGuardStatus = this.client?.memoryGuard && typeof this.client.memoryGuard.getStatus === 'function'
      ? this.client.memoryGuard.getStatus()
      : structuredClone(DEFAULT_MEMORY_GUARD_STATUS);

    const subsystems = {
      collectors: { active: this.client?.activeCollectorsCount ?? 0 },
      prompts: { active: this.client?.activePromptsCount ?? 0 },
      paginators: { active: this.client?.activePaginatorsCount ?? 0 },
      autoDelete: {
        activeTasks: this.client?.autoDelete?.activeTasksCount ?? 0,
        historyTasks: this.client?.autoDelete?.historyCount ?? 0
      },
      smartStore: {
        namespaces: this.client?.store?.namespacesCount ?? 0,
        totalKeys: this.client?.store?.totalKeysCount ?? 0
      },
      sessionRecovery: {
        isTerminalLoggedOut: Boolean(this.client?.recovery?._isTerminalLoggedOut)
      },
      watchdog: watchdogStatus,
      memoryGuard: memoryGuardStatus
    };

    // 6. Execute Custom Probes in Parallel
    const customProbeResults = {};
    if (this.#customProbes.size > 0) {
      const probePromises = Array.from(this.#customProbes.values()).map(async (probe) => {
        const probeStart = performance.now();
        let timeoutHandle;
        let cancelTimeout;

        const timeoutPromise = new Promise((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve({
              status: PROBE_STATUS.TIMEOUT,
              error: `Probe timed out after ${probe.timeoutMs}ms`
            });
          }, probe.timeoutMs);
          if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
            timeoutHandle.unref();
          }
          cancelTimeout = () => {
            clearTimeout(timeoutHandle);
            resolve(null);
          };
        });

        const executionPromise = (async () => {
          try {
            // Call probe with no mutable internal references
            const res = await probe.fn();
            return {
              status: PROBE_STATUS.OK,
              result: sanitizeProbeResult(res)
            };
          } catch (err) {
            return {
              status: PROBE_STATUS.ERROR,
              error: err?.message || 'Custom probe failed'
            };
          }
        })();

        const outcome = await Promise.race([executionPromise, timeoutPromise]);
        if (cancelTimeout) cancelTimeout();
        const durationMs = Number((performance.now() - probeStart).toFixed(2));

        return {
          name: probe.name,
          critical: probe.critical,
          status: outcome.status,
          durationMs,
          result: outcome.result ?? null,
          error: outcome.error ?? null
        };
      });

      const settled = await Promise.allSettled(probePromises);
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          const val = item.value;
          customProbeResults[val.name] = {
            status: val.status,
            durationMs: val.durationMs,
            result: val.result,
            error: val.error
          };
        }
      }
    }

    // 7. Calculate Throughput & Rates
    const messagesReceivedTotal = this.client?.throughput?.messagesReceivedTotal ?? 0;
    const messagesSentTotal = this.client?.throughput?.messagesSentTotal ?? 0;
    const errorsTotal = this.client?.throughput?.errorsTotal ?? 0;

    let messagesPerMinute = null;
    if (this.#lastSampleTime !== null) {
      const timeDeltaMinutes = (timestamp - this.#lastSampleTime) / 60000;
      if (timeDeltaMinutes > 0) {
        const countDelta = Math.max(0, messagesReceivedTotal - this.#lastReceivedCount);
        messagesPerMinute = Number((countDelta / timeDeltaMinutes).toFixed(2));
      }
    }

    const processUptimeMinutes = process.uptime() / 60;
    const averageMessagesPerMinute =
      processUptimeMinutes > 0 ? Number((messagesReceivedTotal / processUptimeMinutes).toFixed(2)) : 0;

    if (isPeriodic) {
      this.#lastSampleTime = timestamp;
      this.#lastReceivedCount = messagesReceivedTotal;
    }

    // 8. Deterministic Classification Precedence Engine (CRITICAL > DEGRADED > HEALTHY)
    const criticalReasons = [];
    const degradedReasons = [];

    // Check Event Loop Lag
    if (eventLoopLagMs >= this.thresholds.eventLoopLagCriticalMs) {
      criticalReasons.push(
        `Event loop lag critical: ${eventLoopLagMs}ms >= ${this.thresholds.eventLoopLagCriticalMs}ms`
      );
    } else if (eventLoopLagMs >= this.thresholds.eventLoopLagDegradedMs) {
      degradedReasons.push(
        `Event loop lag degraded: ${eventLoopLagMs}ms >= ${this.thresholds.eventLoopLagDegradedMs}ms`
      );
    }

    // Check Memory Heap Percent
    if (heapPercent >= this.thresholds.memoryHeapPercentCritical) {
      criticalReasons.push(
        `Heap memory critical: ${heapPercent}% >= ${this.thresholds.memoryHeapPercentCritical}%`
      );
    } else if (heapPercent >= this.thresholds.memoryHeapPercentDegraded) {
      degradedReasons.push(
        `Heap memory degraded: ${heapPercent}% >= ${this.thresholds.memoryHeapPercentDegraded}%`
      );
    }

    // Check Disconnected Duration for active client
    if (clientState === 'READY' && !isConnected) {
      if (disconnectedDurationMs >= this.thresholds.disconnectedDurationCriticalMs) {
        criticalReasons.push(
          `Disconnected duration critical: ${disconnectedDurationMs}ms >= ${this.thresholds.disconnectedDurationCriticalMs}ms`
        );
      } else if (disconnectedDurationMs >= this.thresholds.disconnectedDurationDegradedMs) {
        degradedReasons.push(
          `Disconnected duration degraded: ${disconnectedDurationMs}ms >= ${this.thresholds.disconnectedDurationDegradedMs}ms`
        );
      }
    }

    // Check Custom Probes status
    for (const [name, pRes] of Object.entries(customProbeResults)) {
      const probeDef = this.#customProbes.get(name);
      if (pRes.status === PROBE_STATUS.ERROR || pRes.status === PROBE_STATUS.TIMEOUT) {
        if (probeDef?.critical) {
          criticalReasons.push(`Critical probe "${name}" failed with ${pRes.status}: ${pRes.error}`);
        } else {
          degradedReasons.push(`Probe "${name}" reported ${pRes.status}: ${pRes.error}`);
        }
      }
    }

    // Determine Final Status based on Precedence
    let status = HEALTH_STATUS.HEALTHY;
    if (criticalReasons.length > 0) {
      status = HEALTH_STATUS.CRITICAL;
    } else if (degradedReasons.length > 0) {
      status = HEALTH_STATUS.DEGRADED;
    }

    const summary = {
      isHealthy: status === HEALTH_STATUS.HEALTHY,
      status,
      degradedReasons,
      criticalReasons,
      evaluatedAt: timestamp
    };

    // 9. Build Complete Health Report
    const report = {
      schemaVersion: 1,
      timestamp,
      timestampISO,
      status,
      summary,
      client: {
        state: clientState,
        isConnected,
        uptimeSeconds,
        connectedAt,
        readyAt,
        userJid,
        disconnectedDurationMs
      },
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        eventLoopLagMs,
        memory: {
          heapUsedBytes,
          heapTotalBytes,
          heapPercent,
          rssBytes,
          externalBytes
        },
        cpu
      },
      subsystems,
      throughput: {
        messagesReceivedTotal,
        messagesSentTotal,
        messagesPerMinute,
        averageMessagesPerMinute,
        errorsTotal
      },
      customProbes: customProbeResults
    };

    // 10. Update History & Dispatch Events ONLY on periodic evaluation
    if (isPeriodic) {
      this.#lastSummary = summary;
      this.#history.push(report);
      if (this.#history.length > this.historyLength) {
        this.#history.shift();
      }

      this.#safeEmit('health_check', report);

      // Complete Transition Matrix
      const prev = this.#previousStatus;
      if (status === HEALTH_STATUS.CRITICAL && prev !== HEALTH_STATUS.CRITICAL) {
        this.#safeEmit('health_critical', { report, reasons: criticalReasons });
      } else if (status === HEALTH_STATUS.DEGRADED && prev !== HEALTH_STATUS.DEGRADED) {
        this.#safeEmit('health_degraded', { report, reasons: degradedReasons });
      } else if (status === HEALTH_STATUS.HEALTHY && (prev === HEALTH_STATUS.DEGRADED || prev === HEALTH_STATUS.CRITICAL)) {
        this.#safeEmit('health_recovered', { report, fromStatus: prev });
      }

      this.#previousStatus = status;
    }

    return report;
  }

  /**
   * Evaluates and returns health report on-demand with single-flight protection.
   * Manual calls do NOT mutate history and do NOT emit lifecycle events.
   */
  async getHealth() {
    return this.#evaluate(false);
  }

  /**
   * Returns deep, structurally independent cloned snapshots of the health history ring buffer.
   */
  getHistory() {
    return this.#history.map((entry) => structuredClone(entry));
  }

  /**
   * Returns the latest evaluated health summary snapshot or null before the first evaluation.
   * Does NOT perform an implicit probe.
   */
  getSummary() {
    if (!this.#lastSummary) return null;
    return structuredClone(this.#lastSummary);
  }

  /**
   * Resets throughput rate trackers.
   */
  resetMetrics() {
    this.#lastSampleTime = null;
    this.#lastReceivedCount = 0;
    if (this.client?.throughput) {
      this.client.throughput.messagesReceivedTotal = 0;
      this.client.throughput.messagesSentTotal = 0;
      this.client.throughput.errorsTotal = 0;
    }
  }
}
