import EventEmitter from 'events';
import {
  PaginatorError,
  PaginatorStateError,
  PaginatorTimeoutError
} from '../errors/LeavesError.js';
import { COLLECTOR_END_REASONS } from '../collector/MessageCollector.js';

export const PAGINATOR_STATES = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  TIMEOUT: 'TIMEOUT',
  SHUTDOWN: 'SHUTDOWN',
  ERROR: 'ERROR'
});

export const PAGINATOR_ACTIONS = Object.freeze({
  NEXT: 'NEXT',
  PREV: 'PREV',
  FIRST: 'FIRST',
  LAST: 'LAST',
  JUMP: 'JUMP',
  STOP: 'STOP'
});

const DEFAULT_ACTION_DICTIONARY = Object.freeze({
  NEXT: ['pag_next', 'next', 'n', '>', '▶', 'next ▶', '▶ next', 'selanjutnya', 'lanjut', 'berikutnya'],
  PREV: ['pag_prev', 'prev', 'p', '<', '◀', '◀ prev', 'prev ◀', 'sebelumnya', 'kembali'],
  FIRST: ['pag_first', 'first', '<<', '⏮', 'awal', 'pertama'],
  LAST: ['pag_last', 'last', '>>', '⏭', 'akhir', 'terakhir'],
  STOP: ['pag_stop', 'stop', 'close', 'tutup', 'x', '⏹', '⏹ stop', 'stop ⏹', 'batal', 'keluar', 'exit', 'selesai']
});

/**
 * Paginator class - Interactive multi-page navigation system with zero Baileys leaks.
 * Built directly on top of LeavesClient and MessageCollector.
 */
export class Paginator extends EventEmitter {
  #client;
  #options;
  #items = [];
  #itemsPerPage = 5;
  #currentPage = 1;
  #totalPages = 1;
  #state = PAGINATOR_STATES.IDLE;
  #isTerminal = false;

  #collector = null;
  #idleTimer = null;
  #overallTimer = null;
  #actionQueue = Promise.resolve();

  #chatId = null;
  #senderId = null;
  #context = {};
  #lastRenderedMessageId = null;
  #renderedMessageIds = [];
  #endResolver = null;
  #endRejecter = null;

  /**
   * @param {import('../client/LeavesClient.js').LeavesClient} client
   * @param {Object} [options]
   * @param {Array} [options.items=[]] - Array of data items to paginate
   * @param {number} [options.itemsPerPage=5] - Number of items per page
   * @param {number} [options.initialPage=1] - Starting page number (1-based)
   * @param {number} [options.idleTimeout=120000] - Idle timeout in ms (resets on action)
   * @param {number} [options.timeout] - Absolute overall timeout in ms (never resets)
   * @param {boolean} [options.loop=false] - Loop around boundaries (last -> 1, 1 -> last)
   * @param {Function} [options.renderPage] - Renderer function ({ items, page, totalPages, start, end, totalItems, context })
   * @param {Function} [options.onPageChange] - Hook: async (page, totalPages, context) => void
   * @param {Function} [options.onInvalidAction] - Hook: async (rawInput, context) => void
   * @param {Function} [options.onStop] - Hook: async (reason, context) => void
   * @param {Function} [options.onError] - Hook: async (error, context) => void
   * @param {Object} [options.customActions] - Custom string mappings { [canonicalAction]: string[] }
   * @param {Object} [options.context={}] - Initial custom context
   */
  constructor(client, options = {}) {
    super();
    if (!client) {
      throw new PaginatorError('LeavesClient instance is required to create a Paginator');
    }
    this.#client = client;
    this.#options = {
      itemsPerPage: 5,
      initialPage: 1,
      idleTimeout: 120000,
      loop: false,
      ...options
    };

    this.#setItems(options.items || []);
    this.#itemsPerPage = Math.max(1, parseInt(options.itemsPerPage, 10) || 5);
    this.#calculateTotalPages();
    this.#context = { ...(options.context || {}) };
  }

  get state() {
    return this.#state;
  }

  get isRunning() {
    return this.#state === PAGINATOR_STATES.RUNNING;
  }

  get currentPage() {
    return this.#currentPage;
  }

  get totalPages() {
    return this.#totalPages;
  }

  get totalItems() {
    return this.#items.length;
  }

  get itemsPerPage() {
    return this.#itemsPerPage;
  }

  get lastRenderedMessageId() {
    return this.#lastRenderedMessageId;
  }

  get renderedMessageIds() {
    return [...this.#renderedMessageIds];
  }

  /**
   * Set or update items array.
   * @private
   */
  #setItems(items) {
    if (!Array.isArray(items)) {
      throw new PaginatorError('Items must be an array', 'PAGINATOR_INVALID_ITEMS');
    }
    this.#items = Object.freeze([...items]);
  }

  /**
   * Calculate total pages from items and itemsPerPage.
   * @private
   */
  #calculateTotalPages() {
    if (this.#items.length === 0) {
      this.#totalPages = 1;
    } else {
      this.#totalPages = Math.max(1, Math.ceil(this.#items.length / this.#itemsPerPage));
    }
  }

  /**
   * Start the interactive paginator.
   * @param {string|{chatId: string, senderId?: string, initialPage?: number, context?: Object}} target
   * @param {string} [senderId]
   * @returns {Promise<Object>} Resolves with final state { finalPage, totalPages, reason }
   */
  async start(target, senderId) {
    if (this.#state !== PAGINATOR_STATES.IDLE) {
      throw new PaginatorStateError(`Cannot start paginator in state: ${this.#state}`);
    }

    let chatId;
    let effectiveSenderId;
    let initialPage = this.#options.initialPage || 1;

    if (typeof target === 'object' && target !== null) {
      chatId = target.chatId;
      effectiveSenderId = target.senderId || chatId;
      if (target.initialPage !== undefined) initialPage = target.initialPage;
      if (target.context) Object.assign(this.#context, target.context);
    } else if (typeof target === 'string') {
      chatId = target;
      effectiveSenderId = senderId || chatId;
    }

    if (!chatId) {
      throw new PaginatorError('chatId is required to start paginator');
    }

    this.#chatId = chatId;
    this.#senderId = effectiveSenderId;
    this.#currentPage = Math.max(1, Math.min(this.#totalPages, parseInt(initialPage, 10) || 1));
    this.#state = PAGINATOR_STATES.RUNNING;
    this.#isTerminal = false;

    // Register with client for shutdown tracking
    if (typeof this.#client._registerPaginator === 'function') {
      this.#client._registerPaginator(this);
    }

    const completionPromise = new Promise((resolve, reject) => {
      this.#endResolver = resolve;
      this.#endRejecter = reject;
    });

    try {
      // 1. Setup Overall Timeout (if configured)
      if (this.#options.timeout && this.#options.timeout > 0) {
        this.#overallTimer = setTimeout(() => {
          this._terminate(
            PAGINATOR_STATES.TIMEOUT,
            new PaginatorTimeoutError(`Overall paginator timeout reached (${this.#options.timeout}ms)`, {
              timeout: this.#options.timeout,
              isIdle: false
            })
          );
        }, this.#options.timeout);
      }

      // 2. Setup Idle Timeout
      this._resetIdleTimer();

      // 3. Create isolated MessageCollector (Layer 4.1 primitive)
      this._setupCollector();

      // 4. Initial Render
      await this._renderCurrentPage();

      return await completionPromise;
    } catch (err) {
      if (typeof this.#options.onError === 'function') {
        try {
          await this.#options.onError(err, { ...this.#context, page: this.#currentPage, totalPages: this.#totalPages });
        } catch (_) {}
      }
      throw err;
    } finally {
      this._cleanup();
      if (typeof this.#client._unregisterPaginator === 'function') {
        this.#client._unregisterPaginator(this);
      }
    }
  }

  /**
   * Stop the paginator manually.
   * @param {string} [reason='manual']
   */
  stop(reason = 'manual') {
    if (this.#isTerminal) return;
    this._terminate(PAGINATOR_STATES.STOPPED, null, { reason });
  }

  /**
   * Set up internal MessageCollector.
   * @private
   */
  _setupCollector() {
    this.#collector = this.#client.createMessageCollector({
      chatId: this.#chatId,
      senderId: this.#senderId,
      filter: (msg) => this._isPaginatorMessage(msg)
    });

    this.#collector.on('collect', (message) => {
      // Enqueue action serialized to prevent concurrency race
      this.#actionQueue = this.#actionQueue
        .then(() => this._processInboundMessage(message))
        .catch((err) => {
          this._terminate(PAGINATOR_STATES.ERROR, err);
        });
    });

    this.#collector.once('end', (_, reason) => {
      if (!this.#isTerminal) {
        if (reason === COLLECTOR_END_REASONS.SHUTDOWN) {
          this._terminate(
            PAGINATOR_STATES.SHUTDOWN,
            new PaginatorError('Client shutdown while paginator active', 'PAGINATOR_SHUTDOWN')
          );
        } else if (reason === COLLECTOR_END_REASONS.CANCELED) {
          this._terminate(PAGINATOR_STATES.STOPPED, null, { reason: 'collectorCanceled' });
        }
      }
    });
  }

  /**
   * Filter predicate to determine if an incoming message belongs to this paginator.
   * @private
   */
  _isPaginatorMessage(message) {
    if (this.#isTerminal) return false;
    const parsed = this._parseMessageAction(message);
    return parsed !== null;
  }

  /**
   * Process a collected inbound message through the serialized queue.
   * @private
   */
  async _processInboundMessage(message) {
    if (this.#isTerminal) return;

    const parsedAction = this._parseMessageAction(message);
    if (!parsedAction) {
      if (typeof this.#options.onInvalidAction === 'function') {
        await this.#options.onInvalidAction(message.text, { ...this.#context });
      }
      return;
    }

    // Reset idle timer upon valid action
    this._resetIdleTimer();

    // Execute state transition
    const pageChanged = this._applyAction(parsedAction);

    if (parsedAction.action === PAGINATOR_ACTIONS.STOP) {
      this.stop('userAction');
      return;
    }

    if (pageChanged) {
      await this._renderCurrentPage();
      if (typeof this.#options.onPageChange === 'function') {
        await this.#options.onPageChange(this.#currentPage, this.#totalPages, { ...this.#context });
      }
      this.emit('pageChange', {
        page: this.#currentPage,
        totalPages: this.#totalPages,
        action: parsedAction.action
      });
    }
  }

  /**
   * Parse inbound message into a canonical action object.
   * @private
   */
  _parseMessageAction(message) {
    const rawText = (message.text !== undefined ? String(message.text) : '').trim().toLowerCase();
    if (!rawText) return null;

    const dict = {
      ...DEFAULT_ACTION_DICTIONARY,
      ...(this.#options.customActions || {})
    };

    const cleanedText = rawText.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();

    // 1. Direct canonical action matches
    for (const [actionName, keywords] of Object.entries(dict)) {
      if (
        keywords.some((kw) => {
          const kwLower = kw.trim().toLowerCase();
          return rawText === kwLower || (cleanedText && cleanedText === kwLower);
        })
      ) {
        return { action: actionName, raw: rawText };
      }
    }

    // 2. Numeric Page Jump (e.g. "3", "page 3", "hal 3", "/page 3")
    const jumpMatch = rawText.match(/^(?:(?:page|hal|halaman|\/page|\/hal)\s*)?(\d+)$/i);
    if (jumpMatch) {
      const targetPage = parseInt(jumpMatch[1], 10);
      if (!isNaN(targetPage) && targetPage >= 1 && targetPage <= this.#totalPages) {
        return { action: PAGINATOR_ACTIONS.JUMP, page: targetPage, raw: rawText };
      }
    }

    return null;
  }

  /**
   * Apply canonical action to update current page.
   * @private
   * @returns {boolean} Whether page number changed
   */
  _applyAction({ action, page: targetPage }) {
    const prevPage = this.#currentPage;

    switch (action) {
      case PAGINATOR_ACTIONS.NEXT:
        if (this.#currentPage < this.#totalPages) {
          this.#currentPage++;
        } else if (this.#options.loop) {
          this.#currentPage = 1;
        }
        break;

      case PAGINATOR_ACTIONS.PREV:
        if (this.#currentPage > 1) {
          this.#currentPage--;
        } else if (this.#options.loop) {
          this.#currentPage = this.#totalPages;
        }
        break;

      case PAGINATOR_ACTIONS.FIRST:
        this.#currentPage = 1;
        break;

      case PAGINATOR_ACTIONS.LAST:
        this.#currentPage = this.#totalPages;
        break;

      case PAGINATOR_ACTIONS.JUMP:
        if (targetPage >= 1 && targetPage <= this.#totalPages) {
          this.#currentPage = targetPage;
        }
        break;

      case PAGINATOR_ACTIONS.STOP:
        return false;
    }

    return this.#currentPage !== prevPage;
  }

  /**
   * Render the current page and send to chat.
   * @private
   */
  async _renderCurrentPage() {
    const startIndex = (this.#currentPage - 1) * this.#itemsPerPage;
    const endIndex = Math.min(startIndex + this.#itemsPerPage, this.#items.length);
    const pageItems = this.#items.slice(startIndex, endIndex);

    const renderPayload = {
      items: pageItems,
      page: this.#currentPage,
      totalPages: this.#totalPages,
      start: startIndex + 1,
      end: endIndex,
      totalItems: this.#items.length,
      context: { ...this.#context }
    };

    let content;
    try {
      if (typeof this.#options.renderPage === 'function') {
        content = await this.#options.renderPage(renderPayload);
      } else {
        content = this._defaultRender(renderPayload);
      }
    } catch (renderErr) {
      const err = new PaginatorError(`renderPage threw an error: ${renderErr.message}`, 'PAGINATOR_RENDER_ERROR', {
        cause: renderErr
      });
      this._terminate(PAGINATOR_STATES.ERROR, err);
      throw err;
    }

    if (!content) return;

    try {
      let sentResult;
      if (typeof content === 'string') {
        sentResult = await this.#client.sendMessage(this.#chatId, { text: content });
      } else if (content && typeof content.send === 'function') {
        sentResult = await content.send(this.#chatId);
      } else if (content && typeof content === 'object') {
        sentResult = await this.#client.sendMessage(this.#chatId, content);
      }

      if (sentResult?.key?.id) {
        this.#lastRenderedMessageId = sentResult.key.id;
        this.#renderedMessageIds.push(sentResult.key.id);
      }
    } catch (sendErr) {
      const err = new PaginatorError(`Failed to send paginated message: ${sendErr.message}`, 'PAGINATOR_SEND_ERROR', {
        cause: sendErr
      });
      this._terminate(PAGINATOR_STATES.ERROR, err);
      throw err;
    }
  }

  /**
   * Default text renderer when no custom renderPage is provided.
   * @private
   */
  _defaultRender({ items, page, totalPages, start, end, totalItems }) {
    const header = `📄 *Halaman ${page} dari ${totalPages}* (Total: ${totalItems} item)\n` + '─'.repeat(30) + '\n';
    const body = items.map((item, idx) => `${start + idx}. ${typeof item === 'object' ? JSON.stringify(item) : item}`).join('\n');
    const footer = '\n' + '─'.repeat(30) + '\n_Ketik *next* / *prev* / *stop* atau nomor halaman._';
    return header + body + footer;
  }

  /**
   * Reset the idle timer on action.
   * @private
   */
  _resetIdleTimer() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#options.idleTimeout && this.#options.idleTimeout > 0) {
      this.#idleTimer = setTimeout(() => {
        this._terminate(
          PAGINATOR_STATES.TIMEOUT,
          new PaginatorTimeoutError(`Paginator idle timeout reached (${this.#options.idleTimeout}ms)`, {
            idleTimeout: this.#options.idleTimeout,
            isIdle: true
          })
        );
      }, this.#options.idleTimeout);
    }
  }

  /**
   * Exactly-once terminal transition.
   * @private
   */
  _terminate(state, error = null, meta = {}) {
    if (this.#isTerminal) return;
    this.#isTerminal = true;
    this.#state = state;

    if (this.#collector) {
      try {
        this.#collector.stop(state);
      } catch (_) {}
    }

    if (error && this.#endRejecter) {
      this.#endRejecter(error);
    } else if (this.#endResolver) {
      this.#endResolver({
        finalPage: this.#currentPage,
        totalPages: this.#totalPages,
        reason: meta.reason || state.toLowerCase(),
        context: { ...this.#context }
      });
    }

    if (state === PAGINATOR_STATES.STOPPED && typeof this.#options.onStop === 'function') {
      try {
        this.#options.onStop(meta.reason || 'stopped', { ...this.#context });
      } catch (_) {}
    }
  }

  /**
   * Clean up timers and references.
   * @private
   */
  _cleanup() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#overallTimer) {
      clearTimeout(this.#overallTimer);
      this.#overallTimer = null;
    }
    this.#collector = null;
    this.#endResolver = null;
    this.#endRejecter = null;
  }

  // ==========================================
  // STATIC SHORTCUT HELPER
  // ==========================================

  /**
   * Static convenience helper to paginate a list of items quickly.
   * @param {import('../client/LeavesClient.js').LeavesClient} client
   * @param {string|{chatId: string, senderId?: string}} target
   * @param {Array} items
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  static async paginate(client, target, items = [], options = {}) {
    const paginator = new Paginator(client, {
      items,
      ...options
    });
    return paginator.start(target);
  }
}
