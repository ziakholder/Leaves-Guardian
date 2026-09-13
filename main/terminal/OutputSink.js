import { TERMINAL_LEVEL } from './TerminalConstants.js';

/**
 * DefaultDualSink routes INFO/DEBUG to stdout and WARN/ERROR to stderr (Contract Baseline v1.3).
 */
export class DefaultDualSink {
  constructor(stdout = process.stdout, stderr = process.stderr) {
    this.name = 'DefaultDualSink';
    this.stdout = stdout;
    this.stderr = stderr;
  }

  /**
   * Writes rendered text line to appropriate stream synchronously.
   * @param {string} text
   * @param {string} level
   */
  write(text, level) {
    const line = text.endsWith('\n') ? text : `${text}\n`;
    if (level === TERMINAL_LEVEL.WARN || level === TERMINAL_LEVEL.ERROR) {
      if (this.stderr && typeof this.stderr.write === 'function') {
        this.stderr.write(line);
      }
    } else {
      if (this.stdout && typeof this.stdout.write === 'function') {
        this.stdout.write(line);
      }
    }
  }

  destroy() {
    this.stdout = null;
    this.stderr = null;
  }
}

/**
 * MemorySink records rendered lines in-memory for testing, inspection, and verification.
 */
export class MemorySink {
  constructor() {
    this.name = 'MemorySink';
    this.records = [];
    this._destroyed = false;
  }

  /**
   * @param {string} text
   * @param {string} level
   */
  write(text, level) {
    if (this._destroyed) return;
    this.records.push({
      text,
      output: text,
      level,
      timestamp: Date.now()
    });
  }

  /**
   * Returns array of recorded line texts.
   * @returns {string[]}
   */
  getLines() {
    return this.records.map((r) => r.text);
  }

  /**
   * Returns array of recorded entry objects.
   * @returns {Object[]}
   */
  getEntries() {
    return [...this.records];
  }

  /**
   * Clears all recorded entries.
   */
  clear() {
    this.records = [];
  }

  destroy() {
    this._destroyed = true;
  }
}
