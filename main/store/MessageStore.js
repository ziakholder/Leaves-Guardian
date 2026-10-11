import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import {
  MESSAGE_STORE_MODE,
  MESSAGE_STORE_ERROR_CODES,
  validateMessageStoreOptions
} from './MessageStoreConstants.js';
import { MessageStoreError, LeavesValidationError } from '../errors/LeavesError.js';

/**
 * Sanitizes arbitrary JID and ID strings for safe filesystem paths.
 */
function sanitizePathSegment(segment) {
  if (typeof segment !== 'string') return 'unknown';
  return segment.replace(/[:\/\\?*<>"|]/g, '_');
}

/**
 * Extracts canonical key string and parts from string or Baileys key object.
 */
function extractKeyParts(keyInput) {
  if (!keyInput) return null;
  if (typeof keyInput === 'string') {
    const parts = keyInput.split(':');
    if (parts.length >= 2) {
      return {
        keyStr: keyInput,
        remoteJid: parts[0],
        id: parts.slice(1).join(':')
      };
    }
    return { keyStr: keyInput, remoteJid: keyInput, id: keyInput };
  }

  if (typeof keyInput === 'object' && keyInput.remoteJid && keyInput.id) {
    return {
      keyStr: `${keyInput.remoteJid}:${keyInput.id}`,
      remoteJid: keyInput.remoteJid,
      id: keyInput.id
    };
  }

  return null;
}

/**
 * Strips huge raw binary buffers from message payloads before disk serialization,
 * preserving all Protobuf schema fields required for E2EE retries and quoting.
 */
function sanitizeForPersistence(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return obj;

  if (Buffer.isBuffer(obj)) {
    if (obj.length > 65536) {
      return undefined;
    }
    return obj.toString('base64');
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForPersistence(item, depth + 1));
  }

  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    clean[k] = sanitizeForPersistence(v, depth + 1);
  }
  return clean;
}

/**
 * Tiered MessageStore for Leaves Guardian.
 * Implements L1 (bounded RAM LRU cache) and L2 (partitioned disk storage)
 * to eliminate memory leaks during long-running WhatsApp bot operations.
 */
export class MessageStore extends EventEmitter {
  #options;
  #memoryCache = new Map();
  #autoPruneTimer = null;
  #isShutdown = false;

  constructor(options = {}) {
    super();
    this.#options = validateMessageStoreOptions(options);

    if (this.#options.mode === MESSAGE_STORE_MODE.HYBRID || this.#options.mode === MESSAGE_STORE_MODE.DISK) {
      this.#ensureDirectory(this.#options.directory);
    }

    if (this.#options.autoPruneIntervalMs > 0 && this.#options.retentionDays > 0) {
      this.#startAutoPrune();
    }
  }

  get mode() {
    return this.#options.mode;
  }

  get directory() {
    return this.#options.directory;
  }

  get memorySize() {
    return this.#memoryCache.size;
  }

  get maxMemoryItems() {
    return this.#options.maxMemoryItems;
  }

  #ensureDirectory(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    } catch (err) {
      throw new MessageStoreError(
        `Failed to initialize MessageStore directory: ${err.message}`,
        MESSAGE_STORE_ERROR_CODES.WRITE_FAILED,
        { cause: err, directory: dirPath }
      );
    }
  }

  #getDiskFilePath(remoteJid, id) {
    const safeChat = sanitizePathSegment(remoteJid);
    const safeId = sanitizePathSegment(id);
    return path.join(this.#options.directory, safeChat, `${safeId}.json`);
  }

  /**
   * Saves a message to the store according to configured mode.
   * @param {string|object} keyInput - Canonical string or Baileys key object
   * @param {object} messageObj - Raw message object
   */
  async saveMessage(keyInput, messageObj) {
    if (this.#isShutdown || this.#options.mode === MESSAGE_STORE_MODE.NONE) return;
    if (!keyInput || !messageObj) return;

    const keyParts = extractKeyParts(keyInput);
    if (!keyParts) return;

    const { keyStr, remoteJid, id } = keyParts;

    if (this.#options.mode === MESSAGE_STORE_MODE.HYBRID || this.#options.mode === MESSAGE_STORE_MODE.MEMORY) {
      this.#memoryCache.set(keyStr, messageObj);
      if (this.#memoryCache.size > this.#options.maxMemoryItems) {
        const oldestKey = this.#memoryCache.keys().next().value;
        this.#memoryCache.delete(oldestKey);
      }
    }

    if (this.#options.mode === MESSAGE_STORE_MODE.HYBRID || this.#options.mode === MESSAGE_STORE_MODE.DISK) {
      const targetFile = this.#getDiskFilePath(remoteJid, id);
      const targetDir = path.dirname(targetFile);

      try {
        if (!fs.existsSync(targetDir)) {
          await fs.promises.mkdir(targetDir, { recursive: true });
        }

        const serialized = this.#options.sanitizeBuffers
          ? sanitizeForPersistence(messageObj)
          : messageObj;

        await fs.promises.writeFile(targetFile, JSON.stringify(serialized), 'utf8');
      } catch (err) {
        this.emit('error', new MessageStoreError(
          `Failed to persist message to disk: ${err.message}`,
          MESSAGE_STORE_ERROR_CODES.WRITE_FAILED,
          { cause: err, keyStr, targetFile }
        ));
      }
    }

    this.emit('message_saved', { keyStr, remoteJid, id });
  }

  /**
   * Retrieves a message by key. Checks L1 memory first, falls back to L2 disk.
   * Compatible with Baileys getMessage(key) callback contract.
   * @param {string|object} keyInput
   * @returns {Promise<object|undefined>}
   */
  async getMessage(keyInput) {
    if (this.#isShutdown || this.#options.mode === MESSAGE_STORE_MODE.NONE) return undefined;
    if (!keyInput) return undefined;

    const keyParts = extractKeyParts(keyInput);
    if (!keyParts) return undefined;

    const { keyStr, remoteJid, id } = keyParts;

    if (this.#options.mode === MESSAGE_STORE_MODE.HYBRID || this.#options.mode === MESSAGE_STORE_MODE.MEMORY) {
      const cached = this.#memoryCache.get(keyStr);
      if (cached) {
        return cached.message || cached;
      }
    }

    if (this.#options.mode === MESSAGE_STORE_MODE.HYBRID || this.#options.mode === MESSAGE_STORE_MODE.DISK) {
      const targetFile = this.#getDiskFilePath(remoteJid, id);
      try {
        if (fs.existsSync(targetFile)) {
          const content = await fs.promises.readFile(targetFile, 'utf8');
          const parsed = JSON.parse(content);

          if (this.#options.mode === MESSAGE_STORE_MODE.HYBRID) {
            this.#memoryCache.set(keyStr, parsed);
            if (this.#memoryCache.size > this.#options.maxMemoryItems) {
              const oldestKey = this.#memoryCache.keys().next().value;
              this.#memoryCache.delete(oldestKey);
            }
          }

          return parsed.message || parsed;
        }
      } catch (err) {
        this.emit('error', new MessageStoreError(
          `Failed to read message from disk: ${err.message}`,
          MESSAGE_STORE_ERROR_CODES.READ_FAILED,
          { cause: err, keyStr, targetFile }
        ));
      }
    }

    return undefined;
  }

  /**
   * Deletes a message from both memory and disk.
   */
  async deleteMessage(keyInput) {
    if (this.#isShutdown || this.#options.mode === MESSAGE_STORE_MODE.NONE) return;
    const keyParts = extractKeyParts(keyInput);
    if (!keyParts) return;

    const { keyStr, remoteJid, id } = keyParts;
    this.#memoryCache.delete(keyStr);

    if (this.#options.mode === MESSAGE_STORE_MODE.HYBRID || this.#options.mode === MESSAGE_STORE_MODE.DISK) {
      const targetFile = this.#getDiskFilePath(remoteJid, id);
      try {
        if (fs.existsSync(targetFile)) {
          await fs.promises.unlink(targetFile);
        }
      } catch (err) {
        this.emit('error', new MessageStoreError(
          `Failed to delete message file from disk: ${err.message}`,
          MESSAGE_STORE_ERROR_CODES.WRITE_FAILED,
          { cause: err, keyStr, targetFile }
        ));
      }
    }
  }

  /**
   * Flushes and clears L1 memory cache without deleting persistent disk files.
   * Useful when MemoryGuard triggers emergency mitigation.
   */
  evictMemory() {
    const count = this.#memoryCache.size;
    this.#memoryCache.clear();
    this.emit('memory_evicted', { count });
    return count;
  }

  /**
   * Prunes disk files older than specified retention duration.
   * @param {number} [retentionMs] - Optional custom retention in ms
   */
  async prune(retentionMs) {
    if (this.#isShutdown) return 0;
    if (this.#options.mode !== MESSAGE_STORE_MODE.HYBRID && this.#options.mode !== MESSAGE_STORE_MODE.DISK) {
      return 0;
    }

    const maxAge = typeof retentionMs === 'number' && retentionMs > 0
      ? retentionMs
      : this.#options.retentionDays * 86400000;

    if (maxAge <= 0) return 0;

    const threshold = Date.now() - maxAge;
    let deletedCount = 0;

    try {
      if (!fs.existsSync(this.#options.directory)) return 0;
      const chatDirs = await fs.promises.readdir(this.#options.directory, { withFileTypes: true });

      for (const chatDir of chatDirs) {
        if (!chatDir.isDirectory()) continue;
        const chatDirPath = path.join(this.#options.directory, chatDir.name);
        const msgFiles = await fs.promises.readdir(chatDirPath, { withFileTypes: true });

        let remainingInChat = 0;
        for (const file of msgFiles) {
          if (!file.isFile() || !file.name.endsWith('.json')) continue;
          const filePath = path.join(chatDirPath, file.name);

          try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mtimeMs < threshold) {
              await fs.promises.unlink(filePath);
              deletedCount++;
            } else {
              remainingInChat++;
            }
          } catch (_) {}
        }

        if (remainingInChat === 0) {
          try {
            await fs.promises.rmdir(chatDirPath);
          } catch (_) {}
        }
      }
    } catch (err) {
      this.emit('error', new MessageStoreError(
        `Failed during store pruning: ${err.message}`,
        MESSAGE_STORE_ERROR_CODES.WRITE_FAILED,
        { cause: err }
      ));
    }

    if (deletedCount > 0) {
      this.emit('pruned', { deletedCount });
    }
    return deletedCount;
  }

  #startAutoPrune() {
    this.#autoPruneTimer = setInterval(() => {
      this.prune().catch(() => {});
    }, this.#options.autoPruneIntervalMs);

    if (this.#autoPruneTimer.unref) {
      this.#autoPruneTimer.unref();
    }
  }

  /**
   * Shuts down store and stops pruning timers.
   */
  async shutdown() {
    this.#isShutdown = true;
    if (this.#autoPruneTimer) {
      clearInterval(this.#autoPruneTimer);
      this.#autoPruneTimer = null;
    }
    this.#memoryCache.clear();
  }
}

export default MessageStore;
