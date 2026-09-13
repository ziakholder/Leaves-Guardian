import { EventEmitter } from 'events';
import { TrafficError } from '../errors/LeavesError.js';

export const TRAFFIC_STATE = Object.freeze({
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED'
});

export const TRAFFIC_PRIORITY = Object.freeze({
  HIGH: 'HIGH',
  NORMAL: 'NORMAL',
  LOW: 'LOW'
});

export const TRAFFIC_TASK_STATE = Object.freeze({
  PENDING: 'PENDING',
  DISPATCHING: 'DISPATCHING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export const TRAFFIC_ERROR_CODES = Object.freeze({
  TRAFFIC_QUEUE_FULL: 'TRAFFIC_QUEUE_FULL',
  TRAFFIC_TASK_CANCELLED: 'TRAFFIC_TASK_CANCELLED',
  TRAFFIC_CONTROLLER_STOPPED: 'TRAFFIC_CONTROLLER_STOPPED',
  TRAFFIC_INVALID_OPTION: 'TRAFFIC_INVALID_OPTION'
});

export const DEFAULT_TRAFFIC_OPTIONS = Object.freeze({
  maxQueueSize: 1000,
  maxConcurrentDispatches: 1,
  minDispatchIntervalMs: 250,
  highWatermarkRatio: 0.8,
  lowWatermarkRatio: 0.2,
  maxConsecutiveHigh: 5,
  historyLimit: 100
});

export function validateTrafficOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TrafficError('Traffic options must be an object', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION);
  }

  const maxQueueSize = options.maxQueueSize ?? DEFAULT_TRAFFIC_OPTIONS.maxQueueSize;
  if (!Number.isInteger(maxQueueSize) || maxQueueSize <= 0) {
    throw new TrafficError('maxQueueSize must be a positive integer', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { maxQueueSize });
  }

  const maxConcurrentDispatches = options.maxConcurrentDispatches ?? DEFAULT_TRAFFIC_OPTIONS.maxConcurrentDispatches;
  if (!Number.isInteger(maxConcurrentDispatches) || maxConcurrentDispatches <= 0) {
    throw new TrafficError('maxConcurrentDispatches must be a positive integer', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { maxConcurrentDispatches });
  }

  const minDispatchIntervalMs = options.minDispatchIntervalMs ?? DEFAULT_TRAFFIC_OPTIONS.minDispatchIntervalMs;
  if (typeof minDispatchIntervalMs !== 'number' || isNaN(minDispatchIntervalMs) || minDispatchIntervalMs < 0) {
    throw new TrafficError('minDispatchIntervalMs must be a non-negative number', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { minDispatchIntervalMs });
  }

  const highWatermarkRatio = options.highWatermarkRatio ?? DEFAULT_TRAFFIC_OPTIONS.highWatermarkRatio;
  if (typeof highWatermarkRatio !== 'number' || isNaN(highWatermarkRatio) || highWatermarkRatio <= 0 || highWatermarkRatio > 1) {
    throw new TrafficError('highWatermarkRatio must be a number between 0 and 1', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { highWatermarkRatio });
  }

  const lowWatermarkRatio = options.lowWatermarkRatio ?? DEFAULT_TRAFFIC_OPTIONS.lowWatermarkRatio;
  if (typeof lowWatermarkRatio !== 'number' || isNaN(lowWatermarkRatio) || lowWatermarkRatio < 0 || lowWatermarkRatio >= 1) {
    throw new TrafficError('lowWatermarkRatio must be a number between 0 and 1', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { lowWatermarkRatio });
  }

  if (lowWatermarkRatio >= highWatermarkRatio) {
    throw new TrafficError('lowWatermarkRatio must be strictly less than highWatermarkRatio', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { lowWatermarkRatio, highWatermarkRatio });
  }

  const maxConsecutiveHigh = options.maxConsecutiveHigh ?? DEFAULT_TRAFFIC_OPTIONS.maxConsecutiveHigh;
  if (!Number.isInteger(maxConsecutiveHigh) || maxConsecutiveHigh <= 0) {
    throw new TrafficError('maxConsecutiveHigh must be a positive integer', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { maxConsecutiveHigh });
  }

  const historyLimit = options.historyLimit ?? DEFAULT_TRAFFIC_OPTIONS.historyLimit;
  if (!Number.isInteger(historyLimit) || historyLimit < 0) {
    throw new TrafficError('historyLimit must be a non-negative integer', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { historyLimit });
  }

  if (options.transportFn !== undefined && typeof options.transportFn !== 'function') {
    throw new TrafficError('transportFn must be a function', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION);
  }

  return {
    maxQueueSize,
    maxConcurrentDispatches,
    minDispatchIntervalMs,
    highWatermarkRatio,
    lowWatermarkRatio,
    maxConsecutiveHigh,
    historyLimit,
    transportFn: options.transportFn
  };
}

export class TrafficController extends EventEmitter {
  #state = TRAFFIC_STATE.STOPPED;
  #maxQueueSize;
  #maxConcurrentDispatches;
  #minDispatchIntervalMs;
  #highWatermarkRatio;
  #lowWatermarkRatio;
  #highWatermarkCount;
  #lowWatermarkCount;
  #maxConsecutiveHigh;
  #historyLimit;
  #transportFn;

  #highQueue = [];
  #normalQueue = [];
  #lowQueue = [];

  #inFlightCount = 0;
  #activeTasks = new Map();
  #terminalHistory = [];
  #terminalMap = new Map();

  #pacingTimer = null;
  #lastDispatchStartedAt = 0;
  #consecutiveHighCount = 0;
  #backpressureActive = false;
  #taskIdCounter = 0;

  #metrics = {
    dispatchedTotal: 0,
    failedTotal: 0,
    cancelledTotal: 0,
    rejectedAdmissionTotal: 0
  };
  #totalWaitTimeMs = 0;

  constructor(options = {}) {
    super();
    const validated = validateTrafficOptions(options);

    this.#maxQueueSize = validated.maxQueueSize;
    this.#maxConcurrentDispatches = validated.maxConcurrentDispatches;
    this.#minDispatchIntervalMs = validated.minDispatchIntervalMs;
    this.#highWatermarkRatio = validated.highWatermarkRatio;
    this.#lowWatermarkRatio = validated.lowWatermarkRatio;
    this.#highWatermarkCount = Math.ceil(this.#maxQueueSize * this.#highWatermarkRatio);
    this.#lowWatermarkCount = Math.floor(this.#maxQueueSize * this.#lowWatermarkRatio);
    this.#maxConsecutiveHigh = validated.maxConsecutiveHigh;
    this.#historyLimit = validated.historyLimit;
    this.#transportFn = validated.transportFn || null;
  }

  get state() {
    return this.#state;
  }

  get queueSize() {
    return this.#highQueue.length + this.#normalQueue.length + this.#lowQueue.length;
  }

  get inFlightCount() {
    return this.#inFlightCount;
  }

  get backpressureActive() {
    return this.#backpressureActive;
  }

  setTransport(fn) {
    if (typeof fn !== 'function') {
      throw new TrafficError('transportFn must be a function', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION);
    }
    this.#transportFn = fn;
  }

  start() {
    if (this.#state === TRAFFIC_STATE.RUNNING) {
      return;
    }
    const prevState = this.#state;
    this.#state = TRAFFIC_STATE.RUNNING;
    this.emit('state_change', { from: prevState, to: this.#state });
    this.#pump();
  }

  pause() {
    if (this.#state === TRAFFIC_STATE.PAUSED || this.#state === TRAFFIC_STATE.STOPPED) {
      return;
    }
    const prevState = this.#state;
    this.#state = TRAFFIC_STATE.PAUSED;
    if (this.#pacingTimer) {
      clearTimeout(this.#pacingTimer);
      this.#pacingTimer = null;
    }
    this.emit('state_change', { from: prevState, to: this.#state });
  }

  resume() {
    if (this.#state === TRAFFIC_STATE.STOPPED) {
      return false;
    }
    if (this.#state === TRAFFIC_STATE.RUNNING) {
      return true;
    }
    const prevState = this.#state;
    this.#state = TRAFFIC_STATE.RUNNING;
    this.emit('state_change', { from: prevState, to: this.#state });
    this.#pump();
    return true;
  }

  stop() {
    if (this.#state === TRAFFIC_STATE.STOPPED) {
      return;
    }
    const prevState = this.#state;
    this.#state = TRAFFIC_STATE.STOPPED;

    if (this.#pacingTimer) {
      clearTimeout(this.#pacingTimer);
      this.#pacingTimer = null;
    }

    const pendingTasks = [
      ...this.#highQueue,
      ...this.#normalQueue,
      ...this.#lowQueue
    ];

    this.#highQueue = [];
    this.#normalQueue = [];
    this.#lowQueue = [];

    const now = Date.now();
    for (const task of pendingTasks) {
      this.#activeTasks.delete(task.id);
      task.status = TRAFFIC_TASK_STATE.FAILED;
      task.settledAt = now;
      const error = new TrafficError('TrafficController is STOPPED', TRAFFIC_ERROR_CODES.TRAFFIC_CONTROLLER_STOPPED);
      task.error = error;
      this.#metrics.failedTotal++;
      this.#recordTerminalTask(task);
      task.reject(error);
    }

    if (this.#backpressureActive) {
      this.#backpressureActive = false;
      this.emit('backpressure_resolved', { queueSize: 0, lowWatermark: this.#lowWatermarkCount });
    }

    this.emit('state_change', { from: prevState, to: this.#state });
  }

  enqueue(jid, content, options = {}) {
    if (this.#state === TRAFFIC_STATE.STOPPED) {
      this.#metrics.rejectedAdmissionTotal++;
      return Promise.reject(new TrafficError('TrafficController is STOPPED', TRAFFIC_ERROR_CODES.TRAFFIC_CONTROLLER_STOPPED));
    }

    let priority = TRAFFIC_PRIORITY.NORMAL;
    if (options && options.priority !== undefined) {
      const pUpper = String(options.priority).toUpperCase();
      if (!TRAFFIC_PRIORITY[pUpper]) {
        this.#metrics.rejectedAdmissionTotal++;
        return Promise.reject(new TrafficError(`Invalid priority option: ${options.priority}`, TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION, { priority: options.priority }));
      }
      priority = pUpper;
    }

    if (this.queueSize >= this.#maxQueueSize) {
      this.#metrics.rejectedAdmissionTotal++;
      return Promise.reject(new TrafficError(`Traffic queue is full (maxQueueSize: ${this.#maxQueueSize})`, TRAFFIC_ERROR_CODES.TRAFFIC_QUEUE_FULL, {
        maxQueueSize: this.#maxQueueSize,
        currentQueueSize: this.queueSize
      }));
    }

    const taskId = `task_${Date.now()}_${++this.#taskIdCounter}`;
    let resolveFn, rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const task = {
      id: taskId,
      jid,
      content,
      options,
      priority,
      status: TRAFFIC_TASK_STATE.PENDING,
      queuedAt: Date.now(),
      dispatchStartedAt: null,
      settledAt: null,
      result: null,
      error: null,
      resolve: resolveFn,
      reject: rejectFn,
      promise
    };

    if (priority === TRAFFIC_PRIORITY.HIGH) {
      this.#highQueue.push(task);
    } else if (priority === TRAFFIC_PRIORITY.LOW) {
      this.#lowQueue.push(task);
    } else {
      this.#normalQueue.push(task);
    }

    this.#activeTasks.set(taskId, task);

    // Check backpressure high watermark (rising edge)
    if (!this.#backpressureActive && this.queueSize >= this.#highWatermarkCount) {
      this.#backpressureActive = true;
      this.emit('backpressure_active', {
        queueSize: this.queueSize,
        highWatermark: this.#highWatermarkCount
      });
    }

    if (this.#state === TRAFFIC_STATE.RUNNING) {
      this.#pump();
    }

    return task.promise;
  }

  send(jid, content, options) {
    return this.enqueue(jid, content, options);
  }

  cancel(taskId) {
    if (!taskId) return false;

    let targetTask = null;
    let targetQueue = null;
    let targetIndex = -1;

    for (const queue of [this.#highQueue, this.#normalQueue, this.#lowQueue]) {
      const idx = queue.findIndex(t => t.id === taskId);
      if (idx !== -1) {
        targetTask = queue[idx];
        targetQueue = queue;
        targetIndex = idx;
        break;
      }
    }

    if (!targetTask) {
      return false;
    }

    targetQueue.splice(targetIndex, 1);
    this.#activeTasks.delete(taskId);

    targetTask.status = TRAFFIC_TASK_STATE.CANCELLED;
    targetTask.settledAt = Date.now();
    const error = new TrafficError('Task cancelled', TRAFFIC_ERROR_CODES.TRAFFIC_TASK_CANCELLED, { taskId });
    targetTask.error = error;
    this.#metrics.cancelledTotal++;
    this.#recordTerminalTask(targetTask);

    this.#checkBackpressureResolved();

    targetTask.reject(error);
    return true;
  }

  cancelByJid(jid) {
    if (!jid) return 0;

    let cancelledCount = 0;
    const now = Date.now();

    const cancelFromQueue = (queue) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].jid === jid) {
          const [task] = queue.splice(i, 1);
          this.#activeTasks.delete(task.id);
          task.status = TRAFFIC_TASK_STATE.CANCELLED;
          task.settledAt = now;
          const error = new TrafficError('Task cancelled by recipient JID', TRAFFIC_ERROR_CODES.TRAFFIC_TASK_CANCELLED, { taskId: task.id, jid });
          task.error = error;
          this.#metrics.cancelledTotal++;
          this.#recordTerminalTask(task);
          cancelledCount++;
          task.reject(error);
        }
      }
    };

    cancelFromQueue(this.#highQueue);
    cancelFromQueue(this.#normalQueue);
    cancelFromQueue(this.#lowQueue);

    if (cancelledCount > 0) {
      this.#checkBackpressureResolved();
    }

    return cancelledCount;
  }

  getTask(taskId) {
    if (!taskId) return null;
    const active = this.#activeTasks.get(taskId);
    if (active) {
      return this.#createTaskSnapshot(active);
    }
    const terminal = this.#terminalMap.get(taskId);
    if (terminal) {
      return this.#createTaskSnapshot(terminal);
    }
    return null;
  }

  getStatus() {
    const dispatched = this.#metrics.dispatchedTotal;
    const avgWait = dispatched > 0 ? (this.#totalWaitTimeMs / dispatched) : 0;

    return {
      state: this.#state,
      queueSize: this.queueSize,
      queueByPriority: {
        HIGH: this.#highQueue.length,
        NORMAL: this.#normalQueue.length,
        LOW: this.#lowQueue.length
      },
      inFlightCount: this.#inFlightCount,
      maxQueueSize: this.#maxQueueSize,
      maxConcurrentDispatches: this.#maxConcurrentDispatches,
      minDispatchIntervalMs: this.#minDispatchIntervalMs,
      backpressureActive: this.#backpressureActive,
      metrics: {
        dispatchedTotal: this.#metrics.dispatchedTotal,
        failedTotal: this.#metrics.failedTotal,
        cancelledTotal: this.#metrics.cancelledTotal,
        rejectedAdmissionTotal: this.#metrics.rejectedAdmissionTotal,
        averageWaitTimeMs: avgWait
      }
    };
  }

  #checkBackpressureResolved() {
    if (this.#backpressureActive && this.queueSize <= this.#lowWatermarkCount) {
      this.#backpressureActive = false;
      this.emit('backpressure_resolved', {
        queueSize: this.queueSize,
        lowWatermark: this.#lowWatermarkCount
      });
    }
  }

  #recordTerminalTask(task) {
    if (this.#historyLimit <= 0) return;

    this.#terminalHistory.push(task);
    this.#terminalMap.set(task.id, task);

    while (this.#terminalHistory.length > this.#historyLimit) {
      const removed = this.#terminalHistory.shift();
      if (removed) {
        this.#terminalMap.delete(removed.id);
      }
    }
  }

  #createTaskSnapshot(task) {
    return {
      id: task.id,
      jid: task.jid,
      priority: task.priority,
      status: task.status,
      queuedAt: task.queuedAt,
      dispatchStartedAt: task.dispatchStartedAt,
      settledAt: task.settledAt,
      error: task.error,
      result: task.result
    };
  }

  #selectNextTask() {
    const hasHigh = this.#highQueue.length > 0;
    const hasNormal = this.#normalQueue.length > 0;
    const hasLow = this.#lowQueue.length > 0;
    const hasNormalOrLow = hasNormal || hasLow;

    if (!hasHigh && !hasNormalOrLow) {
      return null;
    }

    if (hasHigh && (!hasNormalOrLow || this.#consecutiveHighCount < this.#maxConsecutiveHigh)) {
      this.#consecutiveHighCount++;
      return this.#highQueue.shift();
    }

    if (hasNormalOrLow) {
      this.#consecutiveHighCount = 0;
      if (hasNormal) {
        return this.#normalQueue.shift();
      }
      return this.#lowQueue.shift();
    }

    if (hasHigh) {
      this.#consecutiveHighCount = 1;
      return this.#highQueue.shift();
    }

    return null;
  }

  #pump() {
    if (this.#state !== TRAFFIC_STATE.RUNNING) {
      return;
    }

    if (this.#pacingTimer) {
      return;
    }

    while (this.#inFlightCount < this.#maxConcurrentDispatches) {
      if (this.queueSize === 0) {
        break;
      }

      const now = Date.now();
      const elapsed = now - this.#lastDispatchStartedAt;
      const delay = Math.max(0, this.#minDispatchIntervalMs - elapsed);

      if (delay > 0) {
        this.#pacingTimer = setTimeout(() => {
          this.#pacingTimer = null;
          this.#pump();
        }, delay);
        break;
      }

      const task = this.#selectNextTask();
      if (!task) {
        break;
      }

      this.#checkBackpressureResolved();

      // Dispatch execution
      task.status = TRAFFIC_TASK_STATE.DISPATCHING;
      task.dispatchStartedAt = Date.now();
      this.#lastDispatchStartedAt = task.dispatchStartedAt;
      this.#inFlightCount++;

      const waitTime = Math.max(0, task.dispatchStartedAt - task.queuedAt);
      this.#totalWaitTimeMs += waitTime;

      this.#executeDispatch(task);
    }
  }

  async #executeDispatch(task) {
    const transport = this.#transportFn;
    try {
      if (typeof transport !== 'function') {
        throw new TrafficError('No transport function configured on TrafficController', TRAFFIC_ERROR_CODES.TRAFFIC_INVALID_OPTION);
      }

      const res = await transport(task.jid, task.content, task.options);

      task.status = TRAFFIC_TASK_STATE.COMPLETED;
      task.settledAt = Date.now();
      task.result = res;
      this.#metrics.dispatchedTotal++;
      this.#activeTasks.delete(task.id);
      this.#recordTerminalTask(task);
      task.resolve(res);
    } catch (err) {
      task.status = TRAFFIC_TASK_STATE.FAILED;
      task.settledAt = Date.now();
      task.error = err;
      this.#metrics.failedTotal++;
      this.#activeTasks.delete(task.id);
      this.#recordTerminalTask(task);
      // Unmasked error propagation (A8, A19)
      task.reject(err);
    } finally {
      this.#inFlightCount--;
      if (this.#state === TRAFFIC_STATE.RUNNING) {
        this.#pump();
      }
    }
  }
}
