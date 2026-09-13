import { DeduplicationError } from '../errors/LeavesError.js';

/**
 * Frozen Deduplication Error Codes (Contract Baseline v1)
 */
export const DEDUP_ERROR_CODES = Object.freeze({
  INVALID_OPTION: 'DEDUP_INVALID_OPTION',
  INVALID_KEY: 'DEDUP_INVALID_KEY',
  INTERNAL_ERROR: 'DEDUP_ERROR'
});

/**
 * Ingress Deduplicator Subsystem States
 */
export const DEDUP_STATE = Object.freeze({
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  DESTROYED: 'DESTROYED'
});

/**
 * Default Identity Extractor (Dual-Compatibility: Canonical Message & Baileys Key)
 * @param {string|Object} msgOrKey
 * @returns {string} Canonical identity string
 */
export function defaultIdentityExtractor(msgOrKey) {
  if (typeof msgOrKey === 'string') {
    const trimmed = msgOrKey.trim();
    if (trimmed.length > 0) return trimmed;
    throw new DeduplicationError(
      'Extracted deduplication key cannot be an empty string',
      DEDUP_ERROR_CODES.INVALID_KEY
    );
  }

  if (msgOrKey && typeof msgOrKey === 'object') {
    // 1. Resolve chatId
    let chatId = msgOrKey.chat?.id || msgOrKey.chatId || msgOrKey.jid;
    if (!chatId && msgOrKey.key?.remoteJid) {
      chatId = msgOrKey.key.remoteJid;
    }

    // 2. Resolve messageId
    let messageId = msgOrKey.id || msgOrKey.messageId;
    if (!messageId && msgOrKey.key?.id) {
      messageId = msgOrKey.key.id;
    }

    // 3. Resolve isMe
    let isMe = false;
    if (typeof msgOrKey.sender?.isMe === 'boolean') {
      isMe = msgOrKey.sender.isMe;
    } else if (typeof msgOrKey.fromMe === 'boolean') {
      isMe = msgOrKey.fromMe;
    } else if (typeof msgOrKey.key?.fromMe === 'boolean') {
      isMe = msgOrKey.key.fromMe;
    }

    // 4. Resolve senderId
    let senderId = msgOrKey.sender?.id || msgOrKey.senderJid || msgOrKey.participant;
    if (!senderId && msgOrKey.key?.participant) {
      senderId = msgOrKey.key.participant;
    }

    // 5. Resolve isGroup
    const isGroup = Boolean(
      msgOrKey.chat?.isGroup ||
      msgOrKey.isGroup ||
      (typeof chatId === 'string' && chatId.endsWith('@g.us'))
    );

    // Validate essential components
    if (typeof chatId !== 'string' || chatId.trim().length === 0) {
      throw new DeduplicationError(
        'Unable to extract valid chatId from message object',
        DEDUP_ERROR_CODES.INVALID_KEY,
        { input: msgOrKey }
      );
    }

    if (typeof messageId !== 'string' || messageId.trim().length === 0) {
      throw new DeduplicationError(
        'Unable to extract valid messageId from message object',
        DEDUP_ERROR_CODES.INVALID_KEY,
        { input: msgOrKey }
      );
    }

    const cleanChatId = chatId.trim();
    const cleanMessageId = messageId.trim();
    const fromMeFlag = isMe ? '1' : '0';

    if (isGroup) {
      if (typeof senderId !== 'string' || senderId.trim().length === 0) {
        throw new DeduplicationError(
          'Group message requires a valid non-empty senderId for deduplication identity',
          DEDUP_ERROR_CODES.INVALID_KEY,
          { input: msgOrKey }
        );
      }
      return `${cleanChatId}:${cleanMessageId}:${fromMeFlag}:${senderId.trim()}`;
    }

    return `${cleanChatId}:${cleanMessageId}:${fromMeFlag}`;
  }

  throw new DeduplicationError(
    `Invalid key input for deduplicator: expected non-empty string or Message object, received ${typeof msgOrKey}`,
    DEDUP_ERROR_CODES.INVALID_KEY,
    { input: msgOrKey }
  );
}

/**
 * Default Ingress Deduplicator Configuration
 */
export const DEFAULT_DEDUPLICATOR_OPTIONS = Object.freeze({
  ttlMs: 300000,              // 5 minutes fixed TTL
  maxTrackedMessages: 10000,  // 10,000 tracked messages maximum
  cleanupIntervalMs: 60000,   // 60 seconds housekeeping interval (0 = disable)
  keyExtractor: defaultIdentityExtractor,
  clock: () => Date.now()
});

/**
 * Validates and merges user options with frozen defaults.
 * @param {Object} [options]
 * @returns {Object} Validated options
 */
export function validateDeduplicatorOptions(options = {}) {
  const merged = { ...DEFAULT_DEDUPLICATOR_OPTIONS, ...options };

  if (typeof merged.ttlMs !== 'number' || !Number.isFinite(merged.ttlMs) || merged.ttlMs <= 0) {
    throw new DeduplicationError('ttlMs must be a positive finite number', DEDUP_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.maxTrackedMessages !== 'number' || !Number.isInteger(merged.maxTrackedMessages) || merged.maxTrackedMessages <= 0) {
    throw new DeduplicationError('maxTrackedMessages must be a positive integer', DEDUP_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.cleanupIntervalMs !== 'number' || !Number.isFinite(merged.cleanupIntervalMs) || merged.cleanupIntervalMs < 0) {
    throw new DeduplicationError('cleanupIntervalMs must be a non-negative finite number', DEDUP_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.keyExtractor !== 'function') {
    throw new DeduplicationError('keyExtractor must be a function', DEDUP_ERROR_CODES.INVALID_OPTION);
  }
  if (typeof merged.clock !== 'function') {
    throw new DeduplicationError('clock must be a function returning a timestamp number', DEDUP_ERROR_CODES.INVALID_OPTION);
  }

  return merged;
}
