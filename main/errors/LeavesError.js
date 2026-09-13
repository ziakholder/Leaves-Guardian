/**
 * Structured error classes for Leaves Guardian Library.
 * Provides hierarchical error codes for all subsystem exceptions.
 */

export class LeavesError extends Error {
  constructor(message, code = 'LEAVES_ERROR', meta = {}) {
    super(message);
    this.name = 'LeavesError';
    this.code = code;
    this.meta = meta;
    if (meta && meta.cause) {
      this.cause = meta.cause;
    }
    Object.assign(this, meta);
  }
}

export class ConnectionError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'CONNECTION_ERROR', meta);
    this.name = 'ConnectionError';
  }
}

export class AuthenticationError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'AUTHENTICATION_ERROR', meta);
    this.name = 'AuthenticationError';
  }
}

export class SessionError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'SESSION_ERROR', meta);
    this.name = 'SessionError';
  }
}

export class PairingError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'PAIRING_ERROR', meta);
    this.name = 'PairingError';
  }
}

export class MessageNormalizationError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'MESSAGE_NORMALIZATION_ERROR', meta);
    this.name = 'MessageNormalizationError';
  }
}

export class ShutdownError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'SHUTDOWN_ERROR', meta);
    this.name = 'ShutdownError';
  }
}

export class StateError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'STATE_ERROR', meta);
    this.name = 'StateError';
  }
}

// Backward compatibility for existing Message Builders
export class ItemNotFoundError extends LeavesError {
  constructor(id, availableIds = []) {
    super(
      `Item id "${id}" tidak ditemukan${
        availableIds.length ? ` (tersedia: ${availableIds.join(', ')})` : ' (belum ada item dengan id)'
      }`,
      'ITEM_NOT_FOUND',
      { id, availableIds }
    );
    this.name = 'ItemNotFoundError';
  }
}

export class DuplicateIdError extends LeavesError {
  constructor(id) {
    super(`Item id "${id}" sudah dipakai`, 'DUPLICATE_ID', { id });
    this.name = 'DuplicateIdError';
  }
}

export class InvalidTargetError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'INVALID_TARGET', meta);
    this.name = 'InvalidTargetError';
  }
}

export class ContentValidationError extends LeavesError {
  constructor(message, meta = {}) {
    super(message, 'CONTENT_VALIDATION', meta);
    this.name = 'ContentValidationError';
  }
}

export class CollectorError extends LeavesError {
  constructor(message, code = 'COLLECTOR_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'CollectorError';
  }
}

export class CollectorTimeoutError extends CollectorError {
  constructor(message = 'Message collector timed out before receiving a matching message', meta = {}) {
    super(message, 'COLLECTOR_TIMEOUT', meta);
    this.name = 'CollectorTimeoutError';
  }
}

export class PromptError extends LeavesError {
  constructor(message, code = 'PROMPT_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'PromptError';
  }
}

export class PromptTimeoutError extends PromptError {
  constructor(message = 'Prompt timed out', meta = {}) {
    const code = meta.stepId ? 'PROMPT_STEP_TIMEOUT' : 'PROMPT_TIMEOUT';
    super(message, meta.code || code, meta);
    this.name = 'PromptTimeoutError';
  }
}

export class PromptCancelledError extends PromptError {
  constructor(message = 'Prompt was cancelled', meta = {}) {
    super(message, 'PROMPT_CANCELLED', meta);
    this.name = 'PromptCancelledError';
  }
}

export class PromptMaxRetriesError extends PromptError {
  constructor(message = 'Prompt exceeded maximum validation retries', meta = {}) {
    super(message, 'PROMPT_MAX_RETRIES', meta);
    this.name = 'PromptMaxRetriesError';
  }
}

export class PaginatorError extends LeavesError {
  constructor(message, code = 'PAGINATOR_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'PaginatorError';
  }
}

export class PaginatorStateError extends PaginatorError {
  constructor(message = 'Invalid paginator state transition', meta = {}) {
    super(message, 'PAGINATOR_STATE_ERROR', meta);
    this.name = 'PaginatorStateError';
  }
}

export class PaginatorTimeoutError extends PaginatorError {
  constructor(message = 'Paginator timed out', meta = {}) {
    const code = meta.isIdle ? 'PAGINATOR_IDLE_TIMEOUT' : 'PAGINATOR_TIMEOUT';
    super(message, meta.code || code, meta);
    this.name = 'PaginatorTimeoutError';
  }
}

export class LeavesValidationError extends LeavesError {
  constructor(message, code = 'VALIDATION_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'LeavesValidationError';
  }
}

export class EphemeralError extends LeavesError {
  constructor(message, code = 'EPHEMERAL_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'EphemeralError';
  }
}

export class AutoDeleteError extends LeavesError {
  constructor(message, code = 'AUTODELETE_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'AutoDeleteError';
  }
}

export class SmartStoreError extends LeavesError {
  constructor(message, code = 'SMARTSTORE_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'SmartStoreError';
  }
}

export class SessionRecoveryError extends SessionError {
  constructor(message, code = 'SESSION_RECOVERY_ERROR', meta = {}) {
    super(message, meta);
    this.name = 'SessionRecoveryError';
    this.code = code;
  }
}

export class HealthError extends LeavesError {
  constructor(message, code = 'HEALTH_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'HealthError';
  }
}

export class WatchdogError extends LeavesError {
  constructor(message, code = 'WATCHDOG_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'WatchdogError';
  }
}

export class MemoryError extends LeavesError {
  constructor(message, code = 'MEMORY_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'MemoryError';
  }
}

export class TrafficError extends LeavesError {
  constructor(message, code = 'TRAFFIC_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'TrafficError';
  }
}

export class MediaError extends LeavesError {
  constructor(message, code = 'MEDIA_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'MediaError';
  }
}

export class RateLimitError extends LeavesError {
  constructor(message, code = 'RATE_LIMIT_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'RateLimitError';
  }
}

export class DeduplicationError extends LeavesError {
  constructor(message, code = 'DEDUP_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'DeduplicationError';
  }
}

export class TerminalError extends LeavesError {
  constructor(message, code = 'TERMINAL_ERROR', meta = {}) {
    super(message, code, meta);
    this.name = 'TerminalError';
  }
}





