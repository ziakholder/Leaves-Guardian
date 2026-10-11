import { EventEmitter } from 'events';
import {
  GROUP_CACHE_ERROR_CODES,
  validateGroupCacheOptions
} from './GroupCacheConstants.js';
import { GroupCacheError, LeavesValidationError } from '../errors/LeavesError.js';

/**
 * Normalizes JID to base user/group representation without device suffix.
 */
function normalizeJid(jid) {
  if (typeof jid !== 'string') return '';
  const clean = jid.trim();
  if (/:\d+@/gi.test(clean)) {
    return `${clean.split('@')[0].split(':')[0]}@${clean.split('@')[1]}`;
  }
  return clean;
}

/**
 * Extracts phone number or user identifier digits.
 */
function extractUserIdentifier(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * High-Performance Group Metadata Cache for Leaves Guardian.
 * Automatically synchronizes with Baileys socket events to eliminate redundant
 * network requests, rate limits (IQ 429), and boilerplate bot code.
 */
export class GroupCache extends EventEmitter {
  #options;
  #cache = new Map(); // groupJid -> { data, expiresAt }
  #inFlightRequests = new Map(); // groupJid -> Promise<GroupMetadata>
  #getSocketFn;

  constructor(options = {}, getSocketFn = null) {
    super();
    this.#options = validateGroupCacheOptions(options);
    this.#getSocketFn = typeof getSocketFn === 'function' ? getSocketFn : () => null;
  }

  get ttlMs() {
    return this.#options.ttlMs;
  }

  get maxGroups() {
    return this.#options.maxGroups;
  }

  get size() {
    return this.#cache.size;
  }

  /**
   * Sets the socket accessor function.
   * @param {Function} fn 
   */
  setSocketAccessor(fn) {
    if (typeof fn === 'function') {
      this.#getSocketFn = fn;
    }
  }

  /**
   * Retrieves group metadata with transparent caching and singleflight coalescing.
   * @param {string} groupJid 
   * @param {boolean} [forceRefresh=false] 
   * @returns {Promise<object>} GroupMetadata
   */
  async getMetadata(groupJid, forceRefresh = false) {
    const cleanJid = normalizeJid(groupJid);
    if (!cleanJid || !cleanJid.endsWith('@g.us')) {
      throw new LeavesValidationError(
        `Invalid group JID: "${groupJid}". Must end with @g.us`,
        GROUP_CACHE_ERROR_CODES.INVALID_JID,
        { groupJid }
      );
    }

    const now = Date.now();
    const existing = this.#cache.get(cleanJid);

    if (!forceRefresh && existing && existing.expiresAt > now) {
      return existing.data;
    }

    if (this.#inFlightRequests.has(cleanJid)) {
      return this.#inFlightRequests.get(cleanJid);
    }

    const sock = this.#getSocketFn();
    if (!sock || typeof sock.groupMetadata !== 'function') {
      if (existing) {
        return existing.data;
      }
      throw new GroupCacheError(
        'Cannot fetch group metadata: Baileys socket is unavailable',
        GROUP_CACHE_ERROR_CODES.SOCKET_UNAVAILABLE,
        { groupJid: cleanJid }
      );
    }

    const fetchPromise = (async () => {
      try {
        const metadata = await sock.groupMetadata(cleanJid);
        this.setMetadata(cleanJid, metadata);
        this.emit('metadata_fetched', { groupJid: cleanJid, metadata });
        return metadata;
      } catch (err) {
        if (existing) {
          return existing.data;
        }
        throw new GroupCacheError(
          `Failed to fetch group metadata for "${cleanJid}": ${err.message}`,
          GROUP_CACHE_ERROR_CODES.FETCH_FAILED,
          { groupJid: cleanJid, cause: err }
        );
      } finally {
        this.#inFlightRequests.delete(cleanJid);
      }
    })();

    this.#inFlightRequests.set(cleanJid, fetchPromise);
    return fetchPromise;
  }

  /**
   * Stores group metadata directly into cache.
   * @param {string} groupJid 
   * @param {object} metadata 
   */
  setMetadata(groupJid, metadata) {
    const cleanJid = normalizeJid(groupJid);
    if (!cleanJid || !metadata) return;

    if (this.#cache.size >= this.#options.maxGroups && !this.#cache.has(cleanJid)) {
      const oldestKey = this.#cache.keys().next().value;
      this.#cache.delete(oldestKey);
    }

    this.#cache.set(cleanJid, {
      data: metadata,
      expiresAt: Date.now() + this.#options.ttlMs
    });

    this.emit('metadata_cached', { groupJid: cleanJid, metadata });
  }

  /**
   * Checks if group metadata is present and valid in cache.
   * @param {string} groupJid 
   * @returns {boolean}
   */
  hasMetadata(groupJid) {
    const cleanJid = normalizeJid(groupJid);
    const existing = this.#cache.get(cleanJid);
    return Boolean(existing && existing.expiresAt > Date.now());
  }

  /**
   * Removes a group from cache.
   * @param {string} groupJid 
   */
  deleteMetadata(groupJid) {
    const cleanJid = normalizeJid(groupJid);
    return this.#cache.delete(cleanJid);
  }

  /**
   * Clears entire group metadata cache.
   */
  clear() {
    this.#cache.clear();
    this.#inFlightRequests.clear();
  }

  /**
   * Returns a dictionary of all cached group metadata.
   * @returns {Record<string, object>}
   */
  getAllCachedMetadata() {
    const result = {};
    const now = Date.now();
    for (const [jid, entry] of this.#cache.entries()) {
      if (entry.expiresAt > now) {
        result[jid] = entry.data;
      }
    }
    return result;
  }

  /**
   * Returns list of participants for a group.
   * @param {string} groupJid 
   * @returns {Promise<string[]>}
   */
  async getGroupParticipants(groupJid) {
    const metadata = await this.getMetadata(groupJid);
    if (!Array.isArray(metadata?.participants)) return [];
    return metadata.participants.map(p => normalizeJid(p.id || p.jid)).filter(Boolean);
  }

  /**
   * Returns list of admin JIDs for a group.
   * @param {string} groupJid 
   * @returns {Promise<string[]>}
   */
  async getGroupAdmins(groupJid) {
    const metadata = await this.getMetadata(groupJid);
    if (!Array.isArray(metadata?.participants)) return [];
    return metadata.participants
      .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
      .map(p => normalizeJid(p.id || p.jid))
      .filter(Boolean);
  }

  /**
   * Checks if a user is an admin or superadmin in a group.
   * @param {string} groupJid 
   * @param {string} userJid 
   * @returns {Promise<boolean>}
   */
  async isGroupAdmin(groupJid, userJid) {
    const cleanUser = normalizeJid(userJid);
    const userNum = extractUserIdentifier(cleanUser);
    const metadata = await this.getMetadata(groupJid);
    if (!Array.isArray(metadata?.participants)) return false;

    return metadata.participants.some(p => {
      const pJid = normalizeJid(p.id || p.jid);
      const pLid = normalizeJid(p.lid);
      const pNum = extractUserIdentifier(pJid);

      const isMatch = (pJid && pJid === cleanUser) ||
                      (pLid && pLid === cleanUser) ||
                      (userNum && pNum && userNum === pNum);

      return isMatch && (p.admin === 'admin' || p.admin === 'superadmin');
    });
  }

  /**
   * Checks if the bot itself is an admin in a group.
   * @param {string} groupJid 
   * @param {string} botJid 
   * @returns {Promise<boolean>}
   */
  async isBotAdmin(groupJid, botJid) {
    return this.isGroupAdmin(groupJid, botJid);
  }

  /**
   * Handles real-time groups.update events from Baileys.
   * @param {Array<object>} updates 
   */
  handleGroupsUpdate(updates) {
    if (!Array.isArray(updates)) return;

    for (const update of updates) {
      if (!update || !update.id) continue;
      const cleanJid = normalizeJid(update.id);
      const entry = this.#cache.get(cleanJid);

      if (entry && entry.data) {
        Object.assign(entry.data, update);
        entry.expiresAt = Date.now() + this.#options.ttlMs;
      }

      this.emit('group_updated', { groupJid: cleanJid, update });
    }
  }

  /**
   * Handles real-time group-participants.update events from Baileys.
   * @param {object} update 
   */
  handleParticipantsUpdate(update) {
    if (!update || !update.id) return;
    const cleanJid = normalizeJid(update.id);
    const { participants = [], action } = update;
    const entry = this.#cache.get(cleanJid);

    if (entry && entry.data && Array.isArray(entry.data.participants)) {
      const list = entry.data.participants;
      const normalizedTargets = participants.map(p => normalizeJid(p));

      switch (action) {
        case 'add': {
          for (const targetJid of normalizedTargets) {
            const exists = list.some(p => normalizeJid(p.id || p.jid) === targetJid);
            if (!exists) {
              list.push({ id: targetJid, admin: null });
            }
          }
          break;
        }
        case 'remove': {
          entry.data.participants = list.filter(p => !normalizedTargets.includes(normalizeJid(p.id || p.jid)));
          break;
        }
        case 'promote': {
          for (const p of list) {
            if (normalizedTargets.includes(normalizeJid(p.id || p.jid))) {
              p.admin = 'admin';
            }
          }
          break;
        }
        case 'demote': {
          for (const p of list) {
            if (normalizedTargets.includes(normalizeJid(p.id || p.jid))) {
              p.admin = null;
            }
          }
          break;
        }
      }

      entry.data.size = entry.data.participants.length;
      entry.expiresAt = Date.now() + this.#options.ttlMs;
    }

    this.emit('participants_updated', {
      groupJid: cleanJid,
      participants,
      action
    });
  }

  /**
   * Hooks into Baileys socket and EventManager for automatic cache synchronization.
   * @param {object} sock 
   * @param {object} eventManager 
   */
  bindEvents(sock, eventManager) {
    if (sock && sock.ev) {
      sock.ev.on('groups.update', updates => this.handleGroupsUpdate(updates));
      sock.ev.on('group-participants.update', update => this.handleParticipantsUpdate(update));
    }

    if (eventManager && typeof eventManager.on === 'function') {
      eventManager.on('groups.update', updates => this.handleGroupsUpdate(updates));
      eventManager.on('group-participants.update', update => this.handleParticipantsUpdate(update));
    }
  }

  /**
   * Shuts down cache and cancels in-flight operations.
   */
  shutdown() {
    this.clear();
  }
}

export default GroupCache;
