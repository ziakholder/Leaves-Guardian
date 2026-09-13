import EventEmitter from 'events';
import {
  PromptError,
  PromptTimeoutError,
  PromptCancelledError,
  PromptMaxRetriesError
} from '../errors/LeavesError.js';

export const PROMPT_STATES = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  MAX_RETRIES: 'MAX_RETRIES',
  ERROR: 'ERROR',
  SHUTDOWN: 'SHUTDOWN'
});

const DEFAULT_CANCEL_KEYWORDS = ['batal', 'cancel', 'exit', 'quit'];

/**
 * Prompt class - Multi-step interactive conversation wizard and single-step prompt utility.
 * Built directly on top of LeavesClient and MessageCollector.
 */
export class Prompt extends EventEmitter {
  #client;
  #options;
  #steps = [];
  #state = PROMPT_STATES.IDLE;
  #overallTimer = null;
  #abortReject = null;
  #isTerminal = false;

  /**
   * @param {import('../client/LeavesClient.js').LeavesClient} client
   * @param {Object} [options]
   * @param {number} [options.timeout] - Overall wizard timeout in ms
   * @param {number} [options.stepTimeout=60000] - Default timeout per step in ms
   * @param {number} [options.retries=2] - Default retries per step (additional attempts)
   * @param {string[]|Function} [options.cancelKeywords] - Keywords or predicate to cancel prompt
   * @param {Function} [options.cancelPredicate] - Custom predicate (message, context) => boolean
   * @param {Function} [options.beforeStep] - Hook: async (step, context) => void
   * @param {Function} [options.afterStep] - Hook: async (step, result, context) => void
   * @param {Function} [options.onCancel] - Hook: async (reason, context) => void
   * @param {Function} [options.onError] - Hook: async (error, context) => void
   * @param {Function} [options.onFinish] - Hook: async (answers, context) => void
   */
  constructor(client, options = {}) {
    super();
    if (!client) {
      throw new PromptError('LeavesClient instance is required to create a Prompt');
    }
    this.#client = client;
    this.#options = {
      stepTimeout: 60000,
      retries: 2,
      cancelKeywords: DEFAULT_CANCEL_KEYWORDS,
      ...options
    };
  }

  get state() {
    return this.#state;
  }

  get isRunning() {
    return this.#state === PROMPT_STATES.RUNNING;
  }

  /**
   * Add a step to the prompt wizard.
   * @param {Object} stepConfig
   * @param {string} [stepConfig.id] - Step identifier (key in result object)
   * @param {string|Object|Function} stepConfig.question - Question text, builder, or async ({ context, step, attempt }) => string|builder
   * @param {Function} [stepConfig.validate] - async (value, message, context) => boolean | string | Error
   * @param {Function} [stepConfig.transform] - async (value, message, context) => any
   * @param {number} [stepConfig.retries] - Additional retry attempts after initial attempt
   * @param {number} [stepConfig.timeout] - Step timeout in ms
   * @param {Function} [stepConfig.filter] - Additional message filter predicate (message) => boolean
   * @param {string|string[]} [stepConfig.messageType] - Allowed message type(s)
   * @param {Function} [stepConfig.onInvalid] - async ({ attempt, maxRetries, error, message, context }) => void|string|builder
   * @param {Function} [stepConfig.onTimeout] - async ({ context, step }) => void|string|builder
   * @returns {this}
   */
  addStep(stepConfig) {
    if (this.#state !== PROMPT_STATES.IDLE) {
      throw new PromptError('Cannot add steps while prompt is running or completed');
    }
    if (!stepConfig) {
      throw new PromptError('Step configuration is required');
    }
    const id = stepConfig.id || `step_${this.#steps.length + 1}`;
    this.#steps.push({
      ...stepConfig,
      id
    });
    return this;
  }

  /**
   * Manually cancel the running prompt.
   * @param {string} [reason='manual']
   */
  cancel(reason = 'manual') {
    if (this.#isTerminal) return;
    this._terminate(PROMPT_STATES.CANCELLED, new PromptCancelledError(`Prompt was cancelled: ${reason}`, { reason }));
  }

  /**
   * Run the prompt wizard for a given chat and sender.
   * @param {string} chatId - Target chat JID (e.g. group or DM)
   * @param {string} [senderId] - Target sender JID (defaults to chatId for DMs)
   * @param {Object} [initialContext={}] - Initial seed context data
   * @returns {Promise<Object>} Plain object with answers { [stepId]: value }
   */
  async run(chatId, senderId, initialContext = {}) {
    if (this.#state !== PROMPT_STATES.IDLE) {
      throw new PromptError(`Cannot run prompt in state: ${this.#state}`);
    }
    if (!chatId) {
      throw new PromptError('chatId is required to run a prompt');
    }
    if (this.#steps.length === 0) {
      throw new PromptError('Prompt must have at least one step added before running');
    }

    const effectiveSenderId = senderId || chatId;
    this.#state = PROMPT_STATES.RUNNING;
    this.#isTerminal = false;

    // Register with client for shutdown tracking
    if (typeof this.#client._registerPrompt === 'function') {
      this.#client._registerPrompt(this);
    }

    // Encapsulate internal context (clone initial context)
    const context = { ...initialContext };

    // Promise that can be aborted externally or via overall timeout
    const abortSignalPromise = new Promise((_, reject) => {
      this.#abortReject = reject;
    });

    if (this.#options.timeout && this.#options.timeout > 0) {
      this.#overallTimer = setTimeout(() => {
        this._terminate(
          PROMPT_STATES.TIMEOUT,
          new PromptTimeoutError(`Overall prompt timed out after ${this.#options.timeout}ms`, {
            timeout: this.#options.timeout
          })
        );
      }, this.#options.timeout);
      if (this.#overallTimer.unref) this.#overallTimer.unref();
    }

    const executionPromise = (async () => {
      for (let i = 0; i < this.#steps.length; i++) {
        if (this.#isTerminal) break;
        const step = this.#steps[i];

        if (typeof this.#options.beforeStep === 'function') {
          await this.#options.beforeStep(step, { ...context });
        }

        const answer = await this._executeStep(step, chatId, effectiveSenderId, context);
        context[step.id] = answer;

        if (typeof this.#options.afterStep === 'function') {
          await this.#options.afterStep(step, answer, { ...context });
        }
      }

      this._terminate(PROMPT_STATES.COMPLETED);
      if (typeof this.#options.onFinish === 'function') {
        await this.#options.onFinish({ ...context });
      }
      return { ...context };
    })();

    try {
      const result = await Promise.race([executionPromise, abortSignalPromise]);
      return result;
    } catch (err) {
      if (err instanceof PromptCancelledError && typeof this.#options.onCancel === 'function') {
        try {
          await this.#options.onCancel(err.meta?.reason || 'cancelled', { ...context });
        } catch (_) {}
      } else if (typeof this.#options.onError === 'function') {
        try {
          await this.#options.onError(err, { ...context });
        } catch (_) {}
      }
      throw err;
    } finally {
      this._cleanup();
      if (typeof this.#client._unregisterPrompt === 'function') {
        this.#client._unregisterPrompt(this);
      }
    }
  }

  /**
   * Execute a single step with retry loop and validation pipeline.
   * @private
   */
  async _executeStep(step, chatId, senderId, context) {
    const maxRetries = step.retries !== undefined ? step.retries : this.#options.retries;
    const stepTimeout = step.timeout || this.#options.stepTimeout;
    let attempt = 0;

    while (attempt <= maxRetries) {
      if (this.#isTerminal) {
        throw new PromptCancelledError('Prompt terminated during step execution');
      }

      attempt++;

      // 1. Prepare message listener first so no message is missed during network latency
      const messagePromise = this.#client.awaitMessage({
        chatId,
        senderId,
        timeout: stepTimeout,
        messageType: step.messageType,
        filter: step.filter
      });

      // 2. Render and send question
      try {
        await this._sendQuestion(step, chatId, context, attempt);
      } catch (sendErr) {
        throw sendErr;
      }

      // 3. Await matching response
      let message;
      try {
        message = await messagePromise;
      } catch (err) {
        if (err.code === 'COLLECTOR_TIMEOUT') {
          if (typeof step.onTimeout === 'function') {
            try {
              await step.onTimeout({ context: { ...context }, step });
            } catch (_) {}
          }
          const timeoutErr = new PromptTimeoutError(
            `Step "${step.id}" timed out after ${stepTimeout}ms waiting for response`,
            { stepId: step.id, timeout: stepTimeout }
          );
          this._terminate(PROMPT_STATES.TIMEOUT, timeoutErr);
          throw timeoutErr;
        }
        if (err.code === 'COLLECTOR_SHUTDOWN') {
          const shutdownErr = new PromptCancelledError('Client was shut down while waiting for prompt answer', {
            reason: 'clientShutdown'
          });
          this._terminate(PROMPT_STATES.SHUTDOWN, shutdownErr);
          throw shutdownErr;
        }
        if (err.code === 'COLLECTOR_CANCELED') {
          const cancelErr = new PromptCancelledError('Prompt collector was canceled', { reason: 'collectorCanceled' });
          this._terminate(PROMPT_STATES.CANCELLED, cancelErr);
          throw cancelErr;
        }
        throw err;
      }


      // 3. Check Cancellation PRECEDENCE (before validate)
      if (this._isCancellation(message, context)) {
        const cancelErr = new PromptCancelledError(`Prompt was cancelled by user message: "${message.text}"`, {
          reason: 'userKeyword',
          message
        });
        this._terminate(PROMPT_STATES.CANCELLED, cancelErr);
        throw cancelErr;
      }

      // 4. Extract raw text or payload value
      const rawText = message.text !== undefined ? message.text.trim() : '';
      const rawValue = rawText || message;

      // 5. Validation Pipeline
      let isValid = true;
      let validationError = null;

      if (typeof step.validate === 'function') {
        try {
          const valResult = await step.validate(rawValue, message, { ...context });
          if (valResult === false) {
            isValid = false;
            validationError = 'Input tidak valid';
          } else if (typeof valResult === 'string' && valResult.length > 0) {
            isValid = false;
            validationError = valResult;
          } else if (valResult instanceof Error) {
            isValid = false;
            validationError = valResult.message;
          }
        } catch (vErr) {
          isValid = false;
          validationError = vErr.message || 'Validation error';
        }
      }

      if (isValid) {
        // 6. Transformation Pipeline
        let transformedValue = rawValue;
        if (typeof step.transform === 'function') {
          transformedValue = await step.transform(rawValue, message, { ...context });
        }
        return transformedValue;
      }

      // 7. Handle Invalid Input (Retry or Exhaustion)
      if (attempt <= maxRetries) {
        if (typeof step.onInvalid === 'function') {
          const invalidFeedback = await step.onInvalid({
            attempt,
            maxRetries: maxRetries + 1,
            error: validationError,
            message,
            context: { ...context }
          });
          if (invalidFeedback) {
            await this._sendFeedback(chatId, invalidFeedback);
          }
        } else if (validationError) {
          await this._sendFeedback(chatId, `⚠️ ${validationError}. Silakan coba lagi.`);
        }
      } else {
        const maxRetriesErr = new PromptMaxRetriesError(
          `Step "${step.id}" exceeded maximum attempts (${maxRetries + 1})`,
          {
            stepId: step.id,
            maxAttempts: maxRetries + 1,
            lastError: validationError
          }
        );
        this._terminate(PROMPT_STATES.MAX_RETRIES, maxRetriesErr);
        throw maxRetriesErr;
      }
    }
  }

  /**
   * Check if message matches cancellation keywords or custom predicate.
   * @private
   */
  _isCancellation(message, context) {
    if (typeof this.#options.cancelPredicate === 'function') {
      try {
        if (this.#options.cancelPredicate(message, context)) return true;
      } catch (_) {}
    }

    const keywords = this.#options.cancelKeywords;
    if (Array.isArray(keywords) && keywords.length > 0 && typeof message.text === 'string') {
      const normalized = message.text.trim().toLowerCase();
      return keywords.some((kw) => (typeof kw === 'string' ? normalized === kw.trim().toLowerCase() : false));
    }

    return false;
  }

  /**
   * Render and send question.
   * @private
   */
  async _sendQuestion(step, chatId, context, attempt) {
    let q = step.question;
    if (typeof q === 'function') {
      q = await q({ context: { ...context }, step, attempt });
    }
    if (!q) return;

    await this._sendFeedback(chatId, q);
  }

  /**
   * Send text or builder payload to chat.
   * @private
   */
  async _sendFeedback(chatId, content) {
    if (typeof content === 'string') {
      await this.#client.sendMessage(chatId, { text: content });
    } else if (content && typeof content.send === 'function') {
      await content.send(chatId);
    } else if (content && typeof content === 'object') {
      await this.#client.sendMessage(chatId, content);
    }
  }

  /**
   * Exactly-once terminal transition.
   * @private
   */
  _terminate(state, error = null) {
    if (this.#isTerminal) return;
    this.#isTerminal = true;
    this.#state = state;

    if (error && this.#abortReject) {
      this.#abortReject(error);
    }
  }

  /**
   * Internal cleanup.
   * @private
   */
  _cleanup() {
    if (this.#overallTimer) {
      clearTimeout(this.#overallTimer);
      this.#overallTimer = null;
    }
    this.#abortReject = null;
  }

  // ==========================================
  // STATIC CONVENIENCE SHORTCUTS
  // ==========================================

  /**
   * Ask a single question and return the answered value.
   * @param {import('../client/LeavesClient.js').LeavesClient} client
   * @param {string|{chatId: string, senderId?: string}} target - Target JID or target object
   * @param {string|Object|Function} question - Question text or builder
   * @param {Object} [options] - Step and prompt options
   * @returns {Promise<any>}
   */
  static async ask(client, target, question, options = {}) {
    let chatId;
    let senderId;
    let effectiveQuestion = question;
    let effectiveOptions = options;

    if (typeof target === 'object' && target !== null) {
      chatId = target.chatId;
      senderId = target.senderId || chatId;
    } else if (typeof target === 'string') {
      if (typeof question === 'string' && typeof options === 'string') {
        // Signature: (client, chatId, senderId, question, options)
        chatId = target;
        senderId = arguments[2];
        effectiveQuestion = arguments[3];
        effectiveOptions = arguments[4] || {};
      } else {
        chatId = target;
        senderId = target;
      }
    }

    const prompt = new Prompt(client, effectiveOptions);
    prompt.addStep({
      id: 'answer',
      question: effectiveQuestion,
      validate: effectiveOptions.validate,
      transform: effectiveOptions.transform,
      retries: effectiveOptions.retries,
      timeout: effectiveOptions.timeout || effectiveOptions.stepTimeout,
      onInvalid: effectiveOptions.onInvalid,
      onTimeout: effectiveOptions.onTimeout,
      messageType: effectiveOptions.messageType,
      filter: effectiveOptions.filter
    });

    const result = await prompt.run(chatId, senderId);
    return result.answer;
  }

  /**
   * Prompt user for confirmation (yes/no).
   * Returns boolean true or false.
   * @param {import('../client/LeavesClient.js').LeavesClient} client
   * @param {string|{chatId: string, senderId?: string}} target
   * @param {string|Object|Function} question
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  static async confirm(client, target, question, options = {}) {
    const TRUE_VALUES = new Set(['ya', 'y', 'yes', '1', 'true', 'ok', 'oke', 'siap', 'benar', 'setuju']);
    const FALSE_VALUES = new Set(['tidak', 't', 'n', 'no', '0', 'false', 'bukan', 'ga', 'gak', 'ngga', 'nggak']);

    const validate = (value) => {
      const norm = (typeof value === 'string' ? value : '').trim().toLowerCase();
      if (TRUE_VALUES.has(norm) || FALSE_VALUES.has(norm)) return true;
      return 'Ketik "Ya" atau "Tidak"';
    };

    const transform = (value) => {
      const norm = (typeof value === 'string' ? value : '').trim().toLowerCase();
      return TRUE_VALUES.has(norm);
    };

    return Prompt.ask(client, target, question, {
      ...options,
      validate: options.validate || validate,
      transform: options.transform || transform,
      onInvalid:
        options.onInvalid ||
        (async ({ error }) => {
          return `⚠️ ${error || 'Pilihan tidak valid'}. Ketik "Ya" atau "Tidak".`;
        })
    });
  }

  /**
   * Prompt user to select an item from a list of choices.
   * Choices can be array of strings `['Option A', 'Option B']` or objects `[{ label: 'A', value: 'a' }]`.
   * Returns the selected value.
   * @param {import('../client/LeavesClient.js').LeavesClient} client
   * @param {string|{chatId: string, senderId?: string}} target
   * @param {string|Object|Function} question
   * @param {Array<string|{label: string, value: any}>} choices
   * @param {Object} [options]
   * @returns {Promise<any>}
   */
  static async select(client, target, question, choices = [], options = {}) {
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new PromptError('choices array must contain at least one option');
    }

    const normalizedChoices = choices.map((c, index) => {
      if (typeof c === 'object' && c !== null && 'label' in c) {
        return { index: index + 1, label: String(c.label), value: c.value ?? c.label };
      }
      return { index: index + 1, label: String(c), value: c };
    });

    const formatChoicesQuestion = () => {
      const choiceLines = normalizedChoices.map((c) => `${c.index}. ${c.label}`).join('\n');
      if (typeof question === 'string') {
        return `${question}\n\n${choiceLines}\n\n_Ketik nomor (1-${normalizedChoices.length}) atau nama pilihan._`;
      }
      return choiceLines;
    };

    const validate = (value) => {
      const norm = (typeof value === 'string' ? value : '').trim().toLowerCase();
      const num = parseInt(norm, 10);
      if (!isNaN(num) && num >= 1 && num <= normalizedChoices.length) {
        return true;
      }
      const matched = normalizedChoices.some((c) => c.label.trim().toLowerCase() === norm);
      if (matched) return true;
      return `Pilihan harus antara 1 sampai ${normalizedChoices.length} atau sesuai nama pilihan`;
    };

    const transform = (value) => {
      const norm = (typeof value === 'string' ? value : '').trim().toLowerCase();
      const num = parseInt(norm, 10);
      if (!isNaN(num) && num >= 1 && num <= normalizedChoices.length) {
        return normalizedChoices[num - 1].value;
      }
      const matched = normalizedChoices.find((c) => c.label.trim().toLowerCase() === norm);
      return matched ? matched.value : value;
    };

    const renderedQuestion = typeof question === 'function' ? question : formatChoicesQuestion();

    return Prompt.ask(client, target, renderedQuestion, {
      ...options,
      validate: options.validate || validate,
      transform: options.transform || transform,
      onInvalid:
        options.onInvalid ||
        (async ({ error }) => {
          return `⚠️ ${error || 'Pilihan tidak valid'}. Silakan pilih 1-${normalizedChoices.length}.`;
        })
    });
  }
}
