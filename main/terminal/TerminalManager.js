import { TerminalError } from '../errors/LeavesError.js';
import {
  TERMINAL_LEVEL,
  LEVEL_WEIGHTS,
  TERMINAL_DOMAIN,
  TERMINAL_STATE,
  RENDERER_STATUS,
  TERMINAL_ERROR_CODES,
  validateTerminalOptions,
  extractRendererSafeOptions
} from './TerminalConstants.js';
import { PresentationSanitizer } from './PresentationSanitizer.js';
import { TerminalEvent } from './TerminalEvent.js';
import { getTerminalCapabilities } from './TerminalCapabilities.js';
import { DefaultTextRenderer } from './TerminalRenderer.js';
import { DefaultDualSink } from './OutputSink.js';

/**
 * TerminalManager is the public facade and synchronous execution engine
 * for Terminal Presentation (Contract Baseline v1.3).
 */
export class TerminalManager {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    this.options = validateTerminalOptions(options);
    this.state = TERMINAL_STATE.RUNNING;
    this.rendererStatus = RENDERER_STATUS.HEALTHY;

    this.renderer = options.renderer || new DefaultTextRenderer();
    this.sink = options.sink || new DefaultDualSink();

    this._sequenceCounter = 0;
    this._dispatchDepth = 0;

    this._initRenderer(this.renderer);
  }

  /**
   * Initializes renderer with safe, isolated context (Invariant 6).
   * @param {Object} renderer
   * @private
   */
  _initRenderer(renderer) {
    if (renderer && typeof renderer.init === 'function') {
      try {
        const safeOptions = extractRendererSafeOptions(this.options);
        const capabilities = this.getCapabilities();
        renderer.init(Object.freeze({
          capabilities,
          options: safeOptions
        }));
      } catch (_) {}
    }
  }

  /**
   * Dispatches a semantic event synchronously through the presentation pipeline.
   * @param {Object} eventInput
   * @returns {boolean} True if event was accepted and processed; false if suppressed
   */
  dispatch(eventInput) {
    if (this.state === TERMINAL_STATE.DESTROYED) {
      return false;
    }

    if (!this.options.enabled) {
      return false;
    }

    if (eventInput === null || typeof eventInput !== 'object' || Array.isArray(eventInput)) {
      throw new TerminalError(
        'Terminal dispatch requires a valid event input object',
        TERMINAL_ERROR_CODES.INVALID_EVENT,
        { input: eventInput }
      );
    }

    const level = eventInput.level || TERMINAL_LEVEL.INFO;
    if (!LEVEL_WEIGHTS[level]) {
      throw new TerminalError(
        `Invalid terminal event level: ${level}`,
        TERMINAL_ERROR_CODES.INVALID_EVENT,
        { level }
      );
    }

    // Level threshold filtering
    if (LEVEL_WEIGHTS[level] < LEVEL_WEIGHTS[this.options.minLevel]) {
      return false;
    }

    // Bounded recursive-chain guard (Invariant 8)
    if (this._dispatchDepth >= this.options.maxDispatchDepth) {
      return false;
    }

    this._dispatchDepth++;

    try {
      const id = `evt_${++this._sequenceCounter}`;
      const timestamp = this.options.clock();
      const domain = eventInput.domain || TERMINAL_DOMAIN.APPLICATION;
      const type = eventInput.type || 'GENERAL';
      const message = String(eventInput.message || '');

      const sanitizedData = eventInput.data !== undefined
        ? PresentationSanitizer.sanitizeData(eventInput.data, {
            privacyMasking: this.options.privacyMasking
          })
        : undefined;

      const event = new TerminalEvent({
        id,
        timestamp,
        level,
        domain,
        type,
        message,
        data: sanitizedData
      });

      // Model A execution: renderer returns string or null
      let output = null;
      try {
        output = this.renderer.render(event);
      } catch (renderErr) {
        this.rendererStatus = RENDERER_STATUS.DEGRADED;
        try {
          const fallbackMsg = `[TERR_FALLBACK] [${event.level}] (${event.domain}:${event.type}) Formatter error: ${renderErr.message || String(renderErr)} | ${event.message}\n`;
          process.stderr.write(fallbackMsg);
        } catch (_) {}
        return true;
      }

      if (typeof output === 'string' && output.length > 0) {
        try {
          this.sink.write(output, event.level);
        } catch (_) {}
      }

      return true;
    } finally {
      this._dispatchDepth--;
    }
  }

  /**
   * Updates runtime configuration options.
   * @param {Object} options
   */
  configure(options = {}) {
    this.options = validateTerminalOptions({ ...this.options, ...options });
    this._initRenderer(this.renderer);
  }

  /**
   * Replaces the active renderer and restores HEALTHY status.
   * @param {Object} newRenderer
   */
  setRenderer(newRenderer) {
    if (!newRenderer || typeof newRenderer.render !== 'function') {
      throw new TerminalError(
        'newRenderer must be an object implementing render(event)',
        TERMINAL_ERROR_CODES.INVALID_OPTION
      );
    }
    if (this.renderer && typeof this.renderer.destroy === 'function') {
      try {
        this.renderer.destroy();
      } catch (_) {}
    }
    this.renderer = newRenderer;
    this.rendererStatus = RENDERER_STATUS.HEALTHY;
    this._initRenderer(this.renderer);
  }

  /**
   * Returns current terminal physical stream capabilities.
   * @returns {Readonly<{ isTTY: boolean, supportsColor: boolean, supportsCursorMovement: boolean, columns: number, rows: number }>}
   */
  getCapabilities() {
    return getTerminalCapabilities(process.stdout);
  }

  /**
   * Cleans up and destroys terminal manager instance.
   */
  destroy() {
    if (this.state === TERMINAL_STATE.DESTROYED) return;

    this.state = TERMINAL_STATE.DESTROYED;
    if (this.renderer && typeof this.renderer.destroy === 'function') {
      try {
        this.renderer.destroy();
      } catch (_) {}
    }
    if (this.sink && typeof this.sink.destroy === 'function') {
      try {
        this.sink.destroy();
      } catch (_) {}
    }
  }
}
