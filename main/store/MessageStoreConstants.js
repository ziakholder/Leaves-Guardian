import { LeavesValidationError } from '../errors/LeavesError.js';

export const MESSAGE_STORE_MODE = Object.freeze({
  HYBRID: 'hybrid',
  DISK: 'disk',
  MEMORY: 'memory',
  NONE: 'none'
});

export const MESSAGE_STORE_ERROR_CODES = Object.freeze({
  INVALID_MODE: 'MESSAGE_STORE_INVALID_MODE',
  INVALID_KEY: 'MESSAGE_STORE_INVALID_KEY',
  CORRUPTED_DISK: 'MESSAGE_STORE_CORRUPTED_DISK',
  WRITE_FAILED: 'MESSAGE_STORE_WRITE_FAILED',
  READ_FAILED: 'MESSAGE_STORE_READ_FAILED'
});

export const DEFAULT_MESSAGE_STORE_OPTIONS = Object.freeze({
  mode: MESSAGE_STORE_MODE.HYBRID,
  directory: './data/messages',
  maxMemoryItems: 100,
  retentionDays: 3,
  autoPruneIntervalMs: 3600000,
  sanitizeBuffers: true
});

export function validateMessageStoreOptions(raw = {}) {
  const options = { ...DEFAULT_MESSAGE_STORE_OPTIONS, ...(raw || {}) };

  const validModes = Object.values(MESSAGE_STORE_MODE);
  if (!validModes.includes(options.mode)) {
    throw new LeavesValidationError(
      `Invalid MessageStore mode: "${options.mode}". Valid modes: ${validModes.join(', ')}`,
      MESSAGE_STORE_ERROR_CODES.INVALID_MODE,
      { mode: options.mode }
    );
  }

  if (typeof options.directory !== 'string' || options.directory.trim() === '') {
    throw new LeavesValidationError(
      'MessageStore directory must be a non-empty string',
      'MESSAGE_STORE_INVALID_DIRECTORY',
      { directory: options.directory }
    );
  }

  if (typeof options.maxMemoryItems !== 'number' || options.maxMemoryItems < 0) {
    throw new LeavesValidationError(
      'MessageStore maxMemoryItems must be a non-negative number',
      'MESSAGE_STORE_INVALID_MAX_ITEMS',
      { maxMemoryItems: options.maxMemoryItems }
    );
  }

  if (typeof options.retentionDays !== 'number' || options.retentionDays < 0) {
    throw new LeavesValidationError(
      'MessageStore retentionDays must be a non-negative number',
      'MESSAGE_STORE_INVALID_RETENTION',
      { retentionDays: options.retentionDays }
    );
  }

  return options;
}
