import { EventEmitter } from 'events';
import { CollectorError } from '../errors/LeavesError.js';

export const COLLECTOR_END_REASONS = Object.freeze({
  LIMIT: 'limit',
  TIME: 'time',
  IDLE: 'idle',
  USER: 'user',
  CANCELED: 'canceled',
  PROCESSED_LIMIT: 'processedLimit',
  SHUTDOWN: 'clientShutdown',
});

/**
 * MessageCollector — Mengumpulkan pesan WhatsApp masuk berbasis filter, timeout, dan limits.
 * Beroperasi murni di atas normalized Message dari LeavesClient ('message' event).
 */
export class MessageCollector extends EventEmitter {
  #client;
  #options;
  #collected = new Map();
  #ended = false;
  #endReason = null;
  #timeoutTimer = null;
  #idleTimer = null;
  #processedCount = 0;
  #handleMessage;

  constructor(client, options = {}) {
    super();

    if (!client || typeof client.on !== 'function') {
      throw new CollectorError('MessageCollector membutuhkan instance client / EventEmitter yang valid');
    }

    this.#client = client;
    this.#options = {
      chatId: options.chatId,
      senderId: options.senderId,
      messageType: options.messageType,
      filter: typeof options.filter === 'function' ? options.filter : () => true,
      timeout: options.timeout ?? options.time ?? null,
      idle: options.idle ?? options.idleTime ?? null,
      max: options.max ?? options.maxMessages ?? null,
      maxProcessed: options.maxProcessed ?? null,
      dispose: Boolean(options.dispose),
    };

    // Private listener reference for clean teardown without touching external handlers
    this.#handleMessage = (message) => {
      this.#onMessage(message);
    };

    this.#setup();
  }

  #setup() {
    this.#client.on('message', this.#handleMessage);

    // Initial timeout timer
    if (typeof this.#options.timeout === 'number' && this.#options.timeout > 0) {
      this.#timeoutTimer = setTimeout(() => {
        this.stop(COLLECTOR_END_REASONS.TIME);
      }, this.#options.timeout);
    }

    // Initial idle timer
    if (typeof this.#options.idle === 'number' && this.#options.idle > 0) {
      this.#idleTimer = setTimeout(() => {
        this.stop(COLLECTOR_END_REASONS.IDLE);
      }, this.#options.idle);
    }
  }

  #onMessage(message) {
    if (this.#ended || !message) return;

    this.#processedCount++;

    // 1. Check filter criteria
    if (!this.#passesFilter(message)) {
      this.#checkProcessedLimit();
      return;
    }

    // 2. Add to collected map
    const key = message.id || ('msg_' + Date.now() + '_' + Math.random());
    this.#collected.set(key, message);

    // 3. Reset idle timer on successful collect
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(() => {
        this.stop(COLLECTOR_END_REASONS.IDLE);
      }, this.#options.idle);
    }

    // 4. Emit collect event
    try {
      this.emit('collect', message);
    } catch (err) {
      this.emit('error', err);
    }

    // 5. Check limits
    if (typeof this.#options.max === 'number' && this.#collected.size >= this.#options.max) {
      this.stop(COLLECTOR_END_REASONS.LIMIT);
      return;
    }

    this.#checkProcessedLimit();
  }

  #matchesJid(expected, actual) {
    if (!expected || !actual) return false;
    const expectedList = Array.isArray(expected) ? expected : [expected];
    for (const exp of expectedList) {
      if (exp === actual) return true;
      const expClean = String(exp).replace(/@.*$/, '');
      const actClean = String(actual).replace(/@.*$/, '');
      if (expClean && actClean && expClean === actClean) return true;
    }
    return false;
  }

  #passesFilter(message) {
    const { chatId, senderId, messageType, filter } = this.#options;

    // Chat ID match
    if (chatId) {
      if (!this.#matchesJid(chatId, message.chat?.id)) {
        return false;
      }
    }

    // Sender ID match
    if (senderId) {
      if (!this.#matchesJid(senderId, message.sender?.id)) {
        return false;
      }
    }

    // Message Type match
    if (messageType) {
      const typeList = Array.isArray(messageType) ? messageType : [messageType];
      if (!message.type || !typeList.includes(message.type)) {
        return false;
      }
    }

    // Custom predicate
    try {
      return Boolean(filter(message));
    } catch {
      return false;
    }
  }

  #checkProcessedLimit() {
    if (
      typeof this.#options.maxProcessed === 'number' &&
      this.#processedCount >= this.#options.maxProcessed &&
      !this.#ended
    ) {
      this.stop(COLLECTOR_END_REASONS.PROCESSED_LIMIT);
    }
  }

  /**
   * Mengembalikan snapshot immutable dari seluruh pesan yang terkumpul.
   */
  get collected() {
    return new Map(this.#collected);
  }

  /**
   * Mengembalikan seluruh pesan terkumpul dalam bentuk Array.
   */
  get collectedArray() {
    return Array.from(this.#collected.values());
  }

  get size() {
    return this.#collected.size;
  }

  get processedCount() {
    return this.#processedCount;
  }

  get ended() {
    return this.#ended;
  }

  get endReason() {
    return this.#endReason;
  }

  /**
   * Mereset timer batas waktu (timeout).
   */
  resetTimer({ timeout, time } = {}) {
    if (this.#ended) return this;

    if (this.#timeoutTimer) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = null;
    }

    const duration = timeout ?? time ?? this.#options.timeout;
    if (typeof duration === 'number' && duration > 0) {
      this.#timeoutTimer = setTimeout(() => {
        this.stop(COLLECTOR_END_REASONS.TIME);
      }, duration);
    }
    return this;
  }

  /**
   * Menghentikan collector dengan alasan tertentu (menjamin 'end' hanya dipancarkan 1 kali).
   */
  stop(reason = COLLECTOR_END_REASONS.USER) {
    if (this.#ended) return;
    this.#ended = true;
    this.#endReason = reason;

    // Clean up own timers
    if (this.#timeoutTimer) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = null;
    }
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }

    // Detach ONLY own listener from client (never touching other handlers)
    if (this.#client && typeof this.#client.off === 'function') {
      this.#client.off('message', this.#handleMessage);
    } else if (this.#client && typeof this.#client.removeListener === 'function') {
      this.#client.removeListener('message', this.#handleMessage);
    }

    // Emit 'end' exactly once with immutable snapshot
    const snapshot = new Map(this.#collected);
    try {
      this.emit('end', snapshot, reason);
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Membatalkan collector secara eksplisit.
   */
  cancel() {
    this.stop(COLLECTOR_END_REASONS.CANCELED);
  }
}

export default MessageCollector;
