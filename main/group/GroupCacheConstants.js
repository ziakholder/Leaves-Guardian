import { LeavesValidationError } from '../errors/LeavesError.js';

export const GROUP_CACHE_ERROR_CODES = Object.freeze({
  FETCH_FAILED: 'GROUP_CACHE_FETCH_FAILED',
  INVALID_JID: 'GROUP_CACHE_INVALID_JID',
  SOCKET_UNAVAILABLE: 'GROUP_CACHE_SOCKET_UNAVAILABLE'
});

export const DEFAULT_GROUP_CACHE_OPTIONS = Object.freeze({
  ttlMs: 300000, // 5 minutes default cache TTL
  maxGroups: 250, // Max number of cached groups
  autoSync: true // Automatically sync with socket events
});

export function validateGroupCacheOptions(raw = {}) {
  const options = { ...DEFAULT_GROUP_CACHE_OPTIONS, ...(raw || {}) };

  if (typeof options.ttlMs !== 'number' || options.ttlMs < 0) {
    throw new LeavesValidationError(
      'GroupCache ttlMs must be a non-negative number',
      'GROUP_CACHE_INVALID_TTL',
      { ttlMs: options.ttlMs }
    );
  }

  if (typeof options.maxGroups !== 'number' || options.maxGroups < 1) {
    throw new LeavesValidationError(
      'GroupCache maxGroups must be a positive number',
      'GROUP_CACHE_INVALID_MAX_GROUPS',
      { maxGroups: options.maxGroups }
    );
  }

  if (typeof options.autoSync !== 'boolean') {
    options.autoSync = true;
  }

  return options;
}
