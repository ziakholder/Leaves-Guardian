import { TERMINAL_LEVEL, TERMINAL_DOMAIN } from './TerminalConstants.js';

/**
 * Immutable TerminalEvent value object snapshot (Contract Baseline v1.3).
 */
export class TerminalEvent {
  /**
   * @param {Object} params
   * @param {string} params.id - Monotonic sequence ID (e.g. 'evt_1')
   * @param {number} params.timestamp - Authoritative epoch timestamp (ms)
   * @param {string} params.level - Severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
   * @param {string} params.domain - Semantic domain: 'CLIENT' | 'MESSAGE' | ...
   * @param {string} params.type - Semantic event type (e.g. 'CONNECTION_READY')
   * @param {string} params.message - Human-readable semantic summary (unformatted)
   * @param {Object} [params.data] - Owned, canonicalized, deep-frozen data snapshot
   */
  constructor(params = {}) {
    this.id = String(params.id || '');
    this.timestamp = Number(params.timestamp) || Date.now();
    this.level = params.level || TERMINAL_LEVEL.INFO;
    this.domain = params.domain || TERMINAL_DOMAIN.APPLICATION;
    this.type = String(params.type || 'GENERAL');
    this.message = String(params.message || '');
    this.data = params.data && typeof params.data === 'object' ? params.data : undefined;

    Object.freeze(this);
  }

  /**
   * Safe JSON serialization representation.
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      level: this.level,
      domain: this.domain,
      type: this.type,
      message: this.message,
      data: this.data
    };
  }
}
