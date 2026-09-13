import { TerminalError } from '../errors/LeavesError.js';

/**
 * Frozen Terminal Log Severity Levels (Contract Baseline v1.3)
 * Note: SUCCESS is NOT a severity level; it is rendered via semantic event types.
 */
export const TERMINAL_LEVEL = Object.freeze({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR'
});

/**
 * Frozen Severity Priority Weights for filtering.
 */
export const LEVEL_WEIGHTS = Object.freeze({
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
});

/**
 * Frozen Semantic Terminal Domains
 */
export const TERMINAL_DOMAIN = Object.freeze({
  CLIENT: 'CLIENT',
  MESSAGE: 'MESSAGE',
  RELIABILITY: 'RELIABILITY',
  TRAFFIC: 'TRAFFIC',
  MEDIA: 'MEDIA',
  APPLICATION: 'APPLICATION'
});

/**
 * Frozen Terminal Presentation Subsystem Lifecycle States
 */
export const TERMINAL_STATE = Object.freeze({
  RUNNING: 'RUNNING',
  DESTROYED: 'DESTROYED'
});

/**
 * Frozen Renderer Health States
 */
export const RENDERER_STATUS = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED'
});

/**
 * Frozen Terminal Error Codes
 */
export const TERMINAL_ERROR_CODES = Object.freeze({
  INVALID_OPTION: 'TERMINAL_INVALID_OPTION',
  INVALID_EVENT: 'TERMINAL_INVALID_EVENT',
  RENDERER_ERROR: 'TERMINAL_RENDERER_ERROR',
  INTERNAL_ERROR: 'TERMINAL_ERROR'
});

/**
 * Default Terminal Presentation Options
 */
export const DEFAULT_TERMINAL_OPTIONS = Object.freeze({
  enabled: true,
  minLevel: TERMINAL_LEVEL.INFO,
  privacyMasking: true,
  maxDispatchDepth: 3,
  clock: () => Date.now()
});

/**
 * Validates and merges user options with frozen defaults.
 * @param {Object} [options]
 * @returns {Object} Validated options
 */
export function validateTerminalOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TerminalError('options must be a plain object', TERMINAL_ERROR_CODES.INVALID_OPTION);
  }

  const cleanOptions = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) cleanOptions[k] = v;
  }

  const merged = { ...DEFAULT_TERMINAL_OPTIONS, ...cleanOptions };

  if (typeof merged.enabled !== 'boolean') {
    throw new TerminalError('enabled must be a boolean', TERMINAL_ERROR_CODES.INVALID_OPTION);
  }

  if (typeof merged.minLevel !== 'string' || !LEVEL_WEIGHTS[merged.minLevel]) {
    throw new TerminalError(
      `minLevel must be one of: ${Object.keys(TERMINAL_LEVEL).join(', ')}`,
      TERMINAL_ERROR_CODES.INVALID_OPTION
    );
  }

  if (typeof merged.privacyMasking !== 'boolean') {
    throw new TerminalError('privacyMasking must be a boolean', TERMINAL_ERROR_CODES.INVALID_OPTION);
  }

  if (
    typeof merged.maxDispatchDepth !== 'number' ||
    !Number.isInteger(merged.maxDispatchDepth) ||
    merged.maxDispatchDepth <= 0
  ) {
    throw new TerminalError('maxDispatchDepth must be a positive integer', TERMINAL_ERROR_CODES.INVALID_OPTION);
  }

  if (typeof merged.clock !== 'function') {
    throw new TerminalError('clock must be a function returning a numeric timestamp', TERMINAL_ERROR_CODES.INVALID_OPTION);
  }

  return merged;
}

/**
 * Extracts pure, safe primitive options for RendererContext isolation (Invariant 6).
 * Strips sink, renderer, clock, and internal references.
 * @param {Object} options
 * @returns {Readonly<{ enabled: boolean, minLevel: string, privacyMasking: boolean }>}
 */
export function extractRendererSafeOptions(options = {}) {
  return Object.freeze({
    enabled: options.enabled !== false,
    minLevel: options.minLevel || TERMINAL_LEVEL.INFO,
    privacyMasking: options.privacyMasking !== false
  });
}
