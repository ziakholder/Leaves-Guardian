import { EventEmitter } from 'events';
import { LeavesValidationError, AutoDeleteError } from '../errors/LeavesError.js';

export const AUTODELETE_STATES = Object.freeze({
  PENDING: 'PENDING',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED'
});

/**
 * Generates a unique task ID.
 */
function generateTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Normalizes any valid message input into a canonical WAMessageKey.
 * @param {*} target 
 * @returns {{ remoteJid: string, id: string, fromMe: boolean, participant?: string }}
 */
export function normalizeMessageKey(target) {
  if (!target || typeof target !== 'object') {
    throw new LeavesValidationError(
      'Target message for auto-delete must be a Message object or a valid key object',
      'AUTODELETE_INVALID_KEY'
    );
  }

  // 1. If target is a normalized Message instance (has .chat and .sender)
  if (target.chat && typeof target.chat === 'object' && target.sender && typeof target.sender === 'object') {
    const remoteJid = target.chat.id;
    const id = target.id;
    const fromMe = typeof target.sender.isMe === 'boolean' ? target.sender.isMe : true;
    const participant = target.chat.isGroup ? target.sender.id : undefined;

    if (!remoteJid || typeof remoteJid !== 'string' || remoteJid.trim() === '') {
      throw new LeavesValidationError(
        'Message key is missing a valid remoteJid / jid string',
        'AUTODELETE_INVALID_KEY',
        { key: target }
      );
    }
    if (!id || typeof id !== 'string' || id.trim() === '') {
      throw new LeavesValidationError(
        'Message key is missing a valid id string',
        'AUTODELETE_INVALID_KEY',
        { key: target }
      );
    }
    const canonical = {
      remoteJid: remoteJid.trim(),
      id: id.trim(),
      fromMe
    };
    if (participant && typeof participant === 'string' && participant.trim() !== '') {
      canonical.participant = participant.trim();
    }
    return canonical;
  }

  // 2. If target has a nested .key property (e.g., Baileys raw proto)
  const rawKey = target.key && typeof target.key === 'object' ? target.key : target;

  const remoteJid = rawKey.remoteJid || rawKey.jid;
  const id = rawKey.id;
  const fromMe = typeof rawKey.fromMe === 'boolean' ? rawKey.fromMe : true; // Default to true
  const participant = rawKey.participant || undefined;

  if (!remoteJid || typeof remoteJid !== 'string' || remoteJid.trim() === '') {
    throw new LeavesValidationError(
      'Message key is missing a valid remoteJid / jid string',
      'AUTODELETE_INVALID_KEY',
      { key: rawKey }
    );
  }

  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new LeavesValidationError(
      'Message key is missing a valid id string',
      'AUTODELETE_INVALID_KEY',
      { key: rawKey }
    );
  }

  const canonical = {
    remoteJid: remoteJid.trim(),
    id: id.trim(),
    fromMe
  };

  if (participant && typeof participant === 'string' && participant.trim() !== '') {
    canonical.participant = participant.trim();
  }

  return canonical;
}

/**
 * Creates a unique string identifier for a canonical key to detect duplicates.
 * @param {object} key 
 * @returns {string}
 */
export function getCanonicalKeyIdentity(key) {
  return `${key.remoteJid}::${key.id}::${key.fromMe}::${key.participant || ''}`;
}

/**
 * Validates the auto-delete delay duration in milliseconds.
 * @param {*} delay 
 * @returns {number}
 */
export function validateDelay(delay) {
  if (
    typeof delay !== 'number' ||
    !Number.isInteger(delay) ||
    !Number.isFinite(delay) ||
    delay < 0
  ) {
    throw new LeavesValidationError(
      `Auto-delete delay must be a non-negative finite integer in milliseconds, received: ${delay}`,
      'AUTODELETE_INVALID_DELAY',
      { delay }
    );
  }
  return delay;
}

/**
 * Represents a single scheduled deletion task.
 */
export class AutoDeleteTask {
  #manager;
  #timer = null;

  constructor(manager, { id, key, delay, scheduledAt, executeAt }) {
    this.#manager = manager;
    this.id = id;
    this.key = Object.freeze({ ...key });
    this.jid = this.key.remoteJid;
    this.delay = delay;
    this.scheduledAt = scheduledAt;
    this.executeAt = executeAt;
    this.status = AUTODELETE_STATES.PENDING;
    this.error = null;
  }

  /**
   * Internal setter for timer handle.
   * @param {*} timer 
   */
  _setTimer(timer) {
    this.#timer = timer;
  }

  /**
   * Internal clearer for timer handle.
   */
  _clearTimer() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Helper method to cancel this task.
   * @returns {boolean}
   */
  cancel() {
    return this.#manager.cancel(this.id);
  }
}

/**
 * Active Scheduler for bot-side delayed message deletion.
 */
export class AutoDeleteManager extends EventEmitter {
  #client;
  #activeTasks = new Map(); // id -> AutoDeleteTask
  #keyIdentityMap = new Map(); // canonicalIdentity -> taskId
  #historyTasks = new Map(); // id -> AutoDeleteTask (bounded)
  #historyLimit;
  #isShutdown = false;

  constructor(client, options = {}) {
    super();
    if (!client) {
      throw new AutoDeleteError('AutoDeleteManager requires a valid LeavesClient instance', 'AUTODELETE_NO_CLIENT');
    }
    this.#client = client;
    this.#historyLimit = typeof options.historyLimit === 'number' && options.historyLimit >= 0
      ? options.historyLimit
      : 100;
  }

  /**
   * Schedule a message for deletion after delayMs.
   * @param {object|Message} targetMessageOrKey 
   * @param {number} delayMs 
   * @param {object} options 
   * @returns {AutoDeleteTask}
   */
  schedule(targetMessageOrKey, delayMs, options = {}) {
    if (this.#isShutdown) {
      throw new AutoDeleteError('Cannot schedule auto-delete on a shutdown manager/client', 'AUTODELETE_SHUTDOWN');
    }

    const canonicalKey = normalizeMessageKey(targetMessageOrKey);
    const delay = validateDelay(delayMs);
    const replace = options.replace !== false; // Default: true

    const identity = getCanonicalKeyIdentity(canonicalKey);

    // Duplicate detection / handling
    if (this.#keyIdentityMap.has(identity)) {
      const existingTaskId = this.#keyIdentityMap.get(identity);
      if (replace) {
        // Cancel previous task cleanly
        this.cancel(existingTaskId);
      } else {
        throw new AutoDeleteError(
          `A pending auto-delete task already exists for message key: ${canonicalKey.id}`,
          'AUTODELETE_DUPLICATE_TASK',
          { existingTaskId, key: canonicalKey }
        );
      }
    }

    const now = Date.now();
    const taskId = options.id || generateTaskId();

    const task = new AutoDeleteTask(this, {
      id: taskId,
      key: canonicalKey,
      delay,
      scheduledAt: now,
      executeAt: now + delay
    });

    this.#activeTasks.set(taskId, task);
    this.#keyIdentityMap.set(identity, taskId);

    const timer = setTimeout(() => {
      this.#executeDeletion(task, identity);
    }, delay);

    task._setTimer(timer);

    this.emit('scheduled', task);
    return task;
  }

  /**
   * Internal deletion execution guard.
   * @param {AutoDeleteTask} task 
   * @param {string} identity 
   */
  async #executeDeletion(task, identity) {
    // Atomic state guard: must be PENDING to transition to EXECUTING
    if (task.status !== AUTODELETE_STATES.PENDING) {
      return;
    }

    task.status = AUTODELETE_STATES.EXECUTING;
    task._clearTimer();

    try {
      // Delegate to client deletion adapter (zero direct sock.ev)
      const result = await this.#client.deleteMessage(task.key);

      // Transition to COMPLETED
      task.status = AUTODELETE_STATES.COMPLETED;
      this.#finalizeTask(task, identity);
      this.emit('deleted', task, result);
    } catch (err) {
      // Deletion failed - Transition to FAILED without crashing process
      task.status = AUTODELETE_STATES.FAILED;
      task.error = err;
      this.#finalizeTask(task, identity);
      this.emit('failed', err, task);
    }
  }

  /**
   * Finalizes an active task and moves it to history.
   * @param {AutoDeleteTask} task 
   * @param {string} identity 
   */
  #finalizeTask(task, identity) {
    this.#activeTasks.delete(task.id);
    if (this.#keyIdentityMap.get(identity) === task.id) {
      this.#keyIdentityMap.delete(identity);
    }

    if (this.#historyLimit > 0) {
      // Manage bounded history
      if (this.#historyTasks.size >= this.#historyLimit) {
        const oldestKey = this.#historyTasks.keys().next().value;
        if (oldestKey !== undefined) {
          this.#historyTasks.delete(oldestKey);
        }
      }
      this.#historyTasks.set(task.id, task);
    }
  }

  /**
   * Cancel an active task by its Task ID.
   * @param {string} taskId 
   * @returns {boolean}
   */
  cancel(taskId) {
    if (!taskId || typeof taskId !== 'string') {
      return false;
    }

    const task = this.#activeTasks.get(taskId);
    if (!task) {
      return false;
    }

    // Atomic check: only PENDING tasks can be cancelled
    if (task.status !== AUTODELETE_STATES.PENDING) {
      return false;
    }

    task.status = AUTODELETE_STATES.CANCELLED;
    task._clearTimer();

    const identity = getCanonicalKeyIdentity(task.key);
    this.#finalizeTask(task, identity);

    this.emit('cancelled', task, 'USER_CANCELLED');
    return true;
  }

  /**
   * Cancel all active tasks matching a specific message ID.
   * @param {string} messageId 
   * @returns {number} Count of cancelled tasks.
   */
  cancelByMessageId(messageId) {
    if (!messageId || typeof messageId !== 'string') {
      return 0;
    }

    const targetId = messageId.trim();
    let cancelledCount = 0;

    for (const task of Array.from(this.#activeTasks.values())) {
      if (task.key.id === targetId && task.status === AUTODELETE_STATES.PENDING) {
        if (this.cancel(task.id)) {
          cancelledCount++;
        }
      }
    }

    return cancelledCount;
  }

  /**
   * Cancel all active auto-delete tasks.
   * @returns {number} Count of cancelled tasks.
   */
  cancelAll() {
    let cancelledCount = 0;
    for (const task of Array.from(this.#activeTasks.values())) {
      if (task.status === AUTODELETE_STATES.PENDING) {
        if (this.cancel(task.id)) {
          cancelledCount++;
        }
      }
    }
    return cancelledCount;
  }

  /**
   * Get a task by ID from active or history storage.
   * @param {string} taskId 
   * @returns {AutoDeleteTask|undefined}
   */
  getTask(taskId) {
    return this.#activeTasks.get(taskId) || this.#historyTasks.get(taskId);
  }

  /**
   * Checks if a task exists in active or history storage.
   * @param {string} taskId 
   * @returns {boolean}
   */
  has(taskId) {
    return this.#activeTasks.has(taskId) || this.#historyTasks.has(taskId);
  }

  /**
   * Returns count of currently active (pending/executing) tasks.
   */
  get activeTasksCount() {
    return this.#activeTasks.size;
  }

  /**
   * Returns count of stored terminal history tasks.
   */
  get historyCount() {
    return this.#historyTasks.size;
  }

  /**
   * Gracefully stop the manager, clearing all timers and marking active tasks as CANCELLED.
   */
  stop() {
    this.#isShutdown = true;
    for (const task of Array.from(this.#activeTasks.values())) {
      if (task.status === AUTODELETE_STATES.PENDING) {
        task.status = AUTODELETE_STATES.CANCELLED;
        task._clearTimer();
        const identity = getCanonicalKeyIdentity(task.key);
        this.#finalizeTask(task, identity);
        this.emit('cancelled', task, 'SHUTDOWN');
      }
    }
    this.#activeTasks.clear();
    this.#keyIdentityMap.clear();
  }
}
