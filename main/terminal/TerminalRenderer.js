import chalk from 'chalk';
import { TERMINAL_LEVEL } from './TerminalConstants.js';

/**
 * Base / Default Text Renderer for Terminal Presentation (Model A - Contract v1.3).
 * Synchronously transforms a TerminalEvent into visual text without accessing OutputSink.
 */
export class DefaultTextRenderer {
  /**
   * @param {Object} [options]
   * @param {Object} [options.theme]
   */
  constructor(options = {}) {
    this.name = 'DefaultTextRenderer';
    this.theme = options.theme || {};
    this.context = null;
  }

  /**
   * Initializes renderer with safe context (Invariant 6).
   * @param {Object} context
   */
  init(context) {
    this.context = context;
  }

  /**
   * Formats authoritative epoch timestamp.
   * @param {number} timestamp
   * @returns {string}
   * @private
   */
  _formatTimestamp(timestamp) {
    if (typeof this.theme.formatTimestamp === 'function') {
      return this.theme.formatTimestamp(timestamp);
    }
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return this._hasColor() ? chalk.gray(`[${timeStr}]`) : `[${timeStr}]`;
  }

  /**
   * Checks if terminal supports color styling.
   * @returns {boolean}
   * @private
   */
  _hasColor() {
    return this.context?.capabilities?.supportsColor !== false;
  }

  /**
   * Pure synchronous transformation of TerminalEvent to string output.
   * @param {Object} event - Immutable TerminalEvent
   * @returns {string | null}
   */
  render(event) {
    if (!event) return null;

    const ts = this._formatTimestamp(event.timestamp);
    const tag = String(event.type || event.domain || 'INFO').padEnd(8);
    const color = this._hasColor();
    const isSuccess = Boolean(event.data?._legacySuccess);

    // Custom theme formatter hook override
    if (typeof this.theme.formatEvent === 'function') {
      return this.theme.formatEvent(event, { timestamp: ts, color });
    }

    switch (event.level) {
      case TERMINAL_LEVEL.DEBUG: {
        const glyph = color ? chalk.magenta('🔍') : '[DEBUG]';
        const formattedTag = color ? chalk.bold.magenta(tag) : tag;
        const msg = color ? chalk.gray(event.message) : event.message;
        return `${ts} ${glyph} ${formattedTag} ${msg}`;
      }

      case TERMINAL_LEVEL.WARN: {
        const glyph = color ? chalk.yellow('⚠') : '[WARN]';
        const formattedTag = color ? chalk.bold.yellow(tag) : tag;
        const msg = color ? chalk.yellow(event.message) : event.message;
        return `${ts} ${glyph} ${formattedTag} ${msg}`;
      }

      case TERMINAL_LEVEL.ERROR: {
        const glyph = color ? chalk.red('✖') : '[ERROR]';
        const formattedTag = color ? chalk.bold.red(tag) : tag;
        const msg = color ? chalk.red(event.message) : event.message;
        return `${ts} ${glyph} ${formattedTag} ${msg}`;
      }

      case TERMINAL_LEVEL.INFO:
      default: {
        if (event.type === 'MESSAGE' && event.data?.sender) {
          const glyph = color ? chalk.blue('💬') : '[MSG]';
          const formattedTag = color ? chalk.bold.blue(tag) : tag;
          const isGroup = Boolean(event.data.chat?.isGroup);
          const chatId = event.data.chat?.id || 'Chat';
          const chatPrefix = isGroup
            ? (color ? chalk.magenta(`[Group: ${chatId}] `) : `[Group: ${chatId}] `)
            : '';
          const sender = color ? chalk.yellow(event.data.sender) : event.data.sender;
          const text = color ? chalk.white(event.message) : event.message;
          return `${ts} ${glyph} ${formattedTag} ${chatPrefix}${sender}: ${text}`;
        }
        if (isSuccess) {
          const glyph = color ? chalk.green('✓') : '[OK]';
          const formattedTag = color ? chalk.bold.green(tag) : tag;
          return `${ts} ${glyph} ${formattedTag} ${event.message}`;
        }
        const glyph = color ? chalk.cyan('ℹ') : '[INFO]';
        const formattedTag = color ? chalk.bold.cyan(tag) : tag;
        return `${ts} ${glyph} ${formattedTag} ${event.message}`;
      }
    }
  }

  destroy() {
    this.context = null;
  }
}
