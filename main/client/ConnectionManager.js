import { EventEmitter } from 'events';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { ConnectionError, AuthenticationError } from '../errors/LeavesError.js';
import { RECONNECT_REASONS, NON_RECOVERABLE_REASONS } from './ReconnectManager.js';
import { normalizePhoneNumber } from './SessionManager.js';

class MemoryRetryCache {
  constructor(limit = 2000) {
    this._data = new Map();
    this._limit = limit;
  }
  get(key) {
    return this._data.get(key);
  }
  set(key, val) {
    this._data.set(key, val);
    if (this._data.size > this._limit) {
      const first = this._data.keys().next().value;
      this._data.delete(first);
    }
    return true;
  }
  del(key) {
    return this._data.delete(key);
  }
  flushAll() {
    this._data.clear();
  }
}

export class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionManager = options.sessionManager;
    this.reconnectManager = options.reconnectManager;
    this.terminal = options.terminal;
    this.loggerAdapter = options.loggerAdapter;
    this.eventManager = options.eventManager;
    this.socketFactory = options.socketFactory || makeWASocket;
    this.browser = options.browser || Browsers.macOS('Safari');
    this.markOnlineOnConnect = options.markOnlineOnConnect !== false;
    
    this.sock = null;
    this.isConnected = false;
    this._isShuttingDown = false;
    this._pairingRequested = false;
    this._pairingTimeout = null;

    // Retry & Message History Cache (Crucial for E2EE Signal Handshake & Multi-Device Delivery)
    this.msgRetryCounterCache = new MemoryRetryCache(3000);
    this.rawMessageHistory = new Map();
  }

  storeMessage(keyStr, messageObj) {
    if (!keyStr || !messageObj) return;
    this.rawMessageHistory.set(keyStr, messageObj);
    if (this.rawMessageHistory.size > 2000) {
      const first = this.rawMessageHistory.keys().next().value;
      this.rawMessageHistory.delete(first);
    }
  }

  async createSocket() {
    if (this._isShuttingDown) return null;

    const auth = await this.sessionManager.initAuth();
    let version = this._cachedVersion;
    if (!version) {
      try {
        const v = await fetchLatestBaileysVersion();
        if (v && v.version) {
          version = v.version;
          this._cachedVersion = version;
        }
      } catch (_) {}
    }
    if (!version) {
      version = [2, 3000, 1043857760];
    }

    const logger = this.loggerAdapter ? this.loggerAdapter.createPinoLogger() : undefined;
    const usePairing = !this.sessionManager.isRegistered() && this.sessionManager.authMethod === 'pairing';

    this.sock = this.socketFactory({
      version,
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: this.browser,
      markOnlineOnConnect: this.markOnlineOnConnect,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      msgRetryCounterCache: this.msgRetryCounterCache,
      getMessage: async (key) => {
        if (!key) return undefined;
        const msgKey = `${key.remoteJid}:${key.id}`;
        const stored = this.rawMessageHistory.get(msgKey);
        if (stored?.message) return stored.message;
        if (stored) return stored;
        return undefined;
      },
      patchMessageBeforeSending: (message) => {
        const requiresPatch = Boolean(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage
        );
        if (requiresPatch) {
          message = {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadataVersion: 2,
                  deviceListMetadata: {},
                },
                ...message,
              },
            },
          };
        }
        return message;
      }
    });

    this.eventManager.bindSocketEvents(this.sock, {
      onConnectionUpdate: (update) => this._handleConnectionUpdate(update),
      onCredsUpdate: auth.saveCreds,
      onMessagesUpsert: (m) => {
        this.emit('socket_activity', { source: 'message' });
        if (m && Array.isArray(m.messages)) {
          for (const msg of m.messages) {
            if (msg.key && msg.message) {
              const k = `${msg.key.remoteJid}:${msg.key.id}`;
              this.storeMessage(k, msg);
            }
          }
        }
        this.emit('raw_messages_upsert', m);
      }
    });

    if (this.sock?.ws && typeof this.sock.ws.on === 'function') {
      this.sock.ws.on('pong', () => {
        this.emit('pong');
        this.emit('socket_activity', { source: 'pong' });
      });
      this.sock.ws.on('message', () => {
        this.emit('socket_activity', { source: 'socket' });
      });
    }

    // Proactive single pairing trigger (Standard Baileys Flow)
    if (usePairing && this.sessionManager.phoneNumber) {
      if (this._pairingTimeout) {
        clearTimeout(this._pairingTimeout);
      }
      this._pairingTimeout = setTimeout(async () => {
        if (
          !this.sessionManager.isRegistered() &&
          !this.isConnected &&
          !this._isShuttingDown &&
          !this._pairingRequested
        ) {
          try {
            await this.requestPairingCode(this.sessionManager.phoneNumber);
          } catch (err) {
            // Handled inside requestPairingCode
          }
        }
      }, 3000);
    }

    return this.sock;
  }

  async requestPairingCode(phoneNumber, customCode) {
    if (!this.sock) {
      throw new ConnectionError('Cannot request pairing code before socket is created');
    }
    if (this.sessionManager.isRegistered()) {
      return null;
    }

    const cleanNumber = normalizePhoneNumber(phoneNumber || this.sessionManager.phoneNumber);
    if (!cleanNumber) {
      throw new ConnectionError('Phone number is required for pairing code authentication');
    }

    if (this._pairingRequested) {
      return null;
    }
    this._pairingRequested = true;

    const targetCustomCode = customCode || this.sessionManager.customCode || undefined;
    const validCustomCode = (typeof targetCustomCode === 'string' && targetCustomCode.trim().length === 8)
      ? targetCustomCode.trim().toUpperCase()
      : undefined;

    try {
      const code = await this.sock.requestPairingCode(cleanNumber, validCustomCode);
      this.emit('pairing_code', { phoneNumber: cleanNumber, code, custom: Boolean(validCustomCode) });
      return code;
    } catch (err) {
      this._pairingRequested = false;
      this.terminal.error('PAIRING', `Failed to request pairing code: ${err.message}`);
      throw new ConnectionError(`Pairing code request failed: ${err.message}`, 'PAIRING_FAILED', { cause: err });
    }
  }

  _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.emit('qr', qr);
    }

    if (connection === 'connecting') {
      this.isConnected = false;
      this.emit('connecting');
    } else if (connection === 'open') {
      this.isConnected = true;
      this._pairingRequested = false;
      if (this._pairingTimeout) {
        clearTimeout(this._pairingTimeout);
        this._pairingTimeout = null;
      }
      this.reconnectManager.reset();
      this.emit('connection_open', this.sock);
    } else if (connection === 'close') {
      this.isConnected = false;
      this._pairingRequested = false;
      if (this._pairingTimeout) {
        clearTimeout(this._pairingTimeout);
        this._pairingTimeout = null;
      }

      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : (lastDisconnect?.error?.code || null);
      
      const reason = this._classifyDisconnect(statusCode);
      this.emit('connection_close', { statusCode, reason, error: lastDisconnect?.error });

      if (reason === RECONNECT_REASONS.LOGGED_OUT) {
        this.emit('logged_out', lastDisconnect?.error);
      } else if (!this._isShuttingDown) {
        this._handleAutoReconnect(reason);
      }
    }
  }

  _classifyDisconnect(statusCode) {
    if (!statusCode) return RECONNECT_REASONS.UNKNOWN_TRANSIENT;
    if (statusCode === DisconnectReason.loggedOut) return RECONNECT_REASONS.LOGGED_OUT;
    if (statusCode === DisconnectReason.badSession) return RECONNECT_REASONS.SESSION_CORRUPTED;
    if (statusCode === DisconnectReason.connectionReplaced) return RECONNECT_REASONS.CONNECTION_REPLACED;
    if (statusCode === DisconnectReason.connectionLost) return RECONNECT_REASONS.NETWORK_LOST;
    if (statusCode === DisconnectReason.timedOut) return RECONNECT_REASONS.TIMED_OUT;
    if (statusCode === DisconnectReason.restartRequired) return RECONNECT_REASONS.RESTART_REQUIRED;
    if (statusCode === DisconnectReason.multideviceMismatch) return RECONNECT_REASONS.MULTIDEVICE_MISMATCH;
    return RECONNECT_REASONS.UNKNOWN_TRANSIENT;
  }

  async _handleAutoReconnect(reason) {
    if (Object.values(NON_RECOVERABLE_REASONS).includes(reason)) {
      return;
    }

    const decision = typeof this.reconnectManager?.shouldReconnect === 'function'
      ? this.reconnectManager.shouldReconnect(reason)
      : { shouldReconnect: false, attempts: 0, delayMs: 0 };
    if (!decision.shouldReconnect) {
      this.emit('reconnect_failed', { reason, attempts: decision.attempts });
      return;
    }

    this.emit('reconnecting', {
      attempt: decision.attempts,
      delayMs: decision.delayMs,
      reason
    });

    await new Promise(resolve => setTimeout(resolve, decision.delayMs));
    if (!this._isShuttingDown) {
      await this.createSocket();
    }
  }

  async closeSocket() {
    this._isShuttingDown = true;
    if (this._pairingTimeout) {
      clearTimeout(this._pairingTimeout);
      this._pairingTimeout = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }
    this.isConnected = false;
  }
}
