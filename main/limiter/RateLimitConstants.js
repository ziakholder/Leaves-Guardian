import { RateLimitError } from '../errors/LeavesError.js';

/**
 * Frozen Rate Limit Error Codes (Contract Baseline v1)
 */
export const RATE_LIMIT_ERROR_CODES = Object.freeze({
  INVALID_OPTION: 'RATE_LIMIT_INVALID_OPTION',
  INTERNAL_ERROR: 'RATE_LIMIT_ERROR'
});

/**
 * Ingress Rate Limiter Subsystem States
 */
export const LIMITER_STATE = Object.freeze({
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  DESTROYED: 'DESTROYED'
});

/**
 * Default Key Extractor (Defensive string & Message object extraction)
 * @param {string|Object} msgOrKey
 * @returns {string}
 */
export function defaultKeyExtractor(msgOrKey) {
  if (typeof msgOrKey === 'string') {
    const trimmed = msgOrKey.trim();
    if (trimmed.length > 0) return trimmed;
    throw new RateLimitError('Extracted rate limit key cannot be an empty string', RATE_LIMIT_ERROR_CODES.INTERNAL_ERROR);
  }

  if (msgOrKey && typeof msgOrKey === 'object') {
    // 1. Direct sender / senderJid / sender.id
    const sender = msgOrKey.senderJid || (typeof msgOrKey.sender === 'object' ? msgOrKey.sender?.id : msgOrKey.sender);
    if (typeof sender === 'string' && sender.trim().length > 0) {
      return sender.trim();
    }

    // 2. Chat / chatId / chat.id
    const chat = msgOrKey.chatId || (typeof msgOrKey.chat === 'object' ? msgOrKey.chat?.id : msgOrKey.chat);
    if (typeof chat === 'string' && chat.trim().length > 0) {
      return chat.trim();
    }

    // 3. Baileys Message Key remoteJid / participant / jid
    const remoteJid = msgOrKey.key?.participant || msgOrKey.key?.remoteJid || msgOrKey.from || msgOrKey.jid;
    if (typeof remoteJid === 'string' && remoteJid.trim().length > 0) {
      return remoteJid.trim();
    }

    throw new RateLimitError(
      'Unable to extract valid rate limit key from message object (no valid sender or chat identifier found)',
      RATE_LIMIT_ERROR_CODES.INTERNAL_ERROR,
      { input: msgOrKey }
    );
  }

  throw new RateLimitError(
    `Invalid key input for rate limiter: expected non-empty string or Message object, received ${typeof msgOrKey}`,
    RATE_LIMIT_ERROR_CODES.INTERNAL_ERROR,
    { input: msgOrKey }
  );
}

/**
 * Default Ingress Rate Limiter Configuration
 */
export const DEFAULT_RATE_LIMITER_OPTIONS = Object.freeze({
  windowMs: 60000,          // 60 seconds
  maxRequests: 60,          // 60 requests per window
  penaltyDurationMs: 0,     // 0 = Disabled
  maxTrackedKeys: 10000,    // 10,000 tracked keys maximum
  cleanupIntervalMs: 60000, // 60 seconds housekeeping interval
  keyExtractor: defaultKeyExtractor,
  clock: () => Date.now()
});

/**
 * Validates and merges user options with frozen defaults.
 * @param {Object} [options]
 * @returns {Object} Validated options
 */
export function validateRateLimiterOptions(options = {}) {
  const merged = { ...DEFAULT_RATE_LIMITER_OPTIONS, ...options };

  if (typeof merged.windowMs !== 'number' || !Number.isFinite(merged.windowMs) || merged.windowMs <= 0) {
    throw new RateLimitError('windowMs must be a positive finite number', RATE_LIMIT_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.maxRequests !== 'number' || !Number.isInteger(merged.maxRequests) || merged.maxRequests <= 0) {
    throw new RateLimitError('maxRequests must be a positive integer', RATE_LIMIT_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.penaltyDurationMs !== 'number' || !Number.isFinite(merged.penaltyDurationMs) || merged.penaltyDurationMs < 0) {
    throw new RateLimitError('penaltyDurationMs must be a non-negative finite number', RATE_LIMIT_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.maxTrackedKeys !== 'number' || !Number.isInteger(merged.maxTrackedKeys) || merged.maxTrackedKeys <= 0) {
    throw new RateLimitError('maxTrackedKeys must be a positive integer', RATE_LIMIT_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.cleanupIntervalMs !== 'number' || !Number.isFinite(merged.cleanupIntervalMs) || merged.cleanupIntervalMs < 0) {
    throw new RateLimitError('cleanupIntervalMs must be a non-negative finite number', RATE_LIMIT_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.keyExtractor !== 'function') {
    throw new RateLimitError('keyExtractor must be a function', RATE_LIMIT_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.clock !== 'function') {
    throw new RateLimitError('clock must be a function returning a timestamp number', RATE_LIMIT_ERROR_CODES.INVALID_OPTION);
  }

  return merged;
}
