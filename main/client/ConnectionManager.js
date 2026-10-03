import { EventEmitter } from 'events';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { ConnectionError, AuthenticationError } from '../errors/LeavesError.js';
import { RECONNECT_REASONS, NON_RECOVERABLE_REASONS } from './ReconnectManager.js';

export class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionManager = options.sessionManager;
    this.reconnectManager = options.reconnectManager;
    this.terminal = options.terminal;
    this.loggerAdapter = options.loggerAdapter;
    this.eventManager = options.eventManager;
    this.socketFactory = options.socketFactory || makeWASocket;
    this.browser = options.browser || Browsers.ubuntu('Chrome');
    this.markOnlineOnConnect = options.markOnlineOnConnect !== false;
    
    this.sock = null;
    this.isConnected = false;
    this._isShuttingDown = false;
    this._pairingRequested = false;
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
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
      patchMessageBeforeSending: (message) => {
        const requiresPatch = Boolean(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage ||
          message.interactiveMessage
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

    return this.sock;
  }

  async requestPairingCode(phoneNumber) {
    if (!this.sock) {
      throw new ConnectionError('Cannot request pairing code before socket is created');
    }
    if (this.sessionManager.isRegistered()) {
      return null;
    }

    const cleanNumber = String(phoneNumber || this.sessionManager.phoneNumber).replace(/[^0-9]/g, '');
    if (!cleanNumber) {
      throw new ConnectionError('Phone number is required for pairing code authentication');
    }

    try {
      this._pairingRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const code = await this.sock.requestPairingCode(cleanNumber);
      this.emit('pairing_code', { code, phoneNumber: cleanNumber });
      return code;
    } catch (err) {
      this._pairingRequested = false;
      throw new ConnectionError(`Failed to request pairing code: ${err.message}`, { cause: err });
    }
  }

  _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    // Deterministic Pairing Code trigger: ONLY when QR is generated (signaling socket is ready for auth)
    if (
      qr &&
      !this.sessionManager.isRegistered() &&
      this.sessionManager.authMethod === 'pairing' &&
      this.sessionManager.phoneNumber &&
      !this._pairingRequested
    ) {
      this._pairingRequested = true;
      this.emit('pairing_eligible', { phoneNumber: this.sessionManager.phoneNumber });
    }

    if (qr && this.sessionManager.authMethod !== 'pairing') {
      this.emit('qr', qr);
    }

    if (connection === 'connecting') {
      this.emit('connecting');
    } else if (connection === 'open') {
      this.isConnected = true;
      this._pairingRequested = false;
      this.reconnectManager.reset();
      this.emit('connection_open', this.sock);
    } else if (connection === 'close') {
      this.isConnected = false;
      this._handleDisconnection(lastDisconnect);
    }
  }

  _handleDisconnection(lastDisconnect) {
    if (this._isShuttingDown) {
      this.emit('connection_close', { reason: 'SHUTDOWN' });
      return;
    }

    const err = lastDisconnect?.error ? new Boom(lastDisconnect.error) : null;
    const statusCode = err?.output?.statusCode;
    let reason = RECONNECT_REASONS.UNKNOWN_TRANSIENT;
    let isNonRecoverable = false;

    if ((statusCode === DisconnectReason.loggedOut || statusCode === 401) && this.sessionManager.isRegistered()) {
      reason = NON_RECOVERABLE_REASONS.LOGGED_OUT;
      isNonRecoverable = true;
      this.emit('logged_out', new AuthenticationError('Account logged out of WhatsApp', { statusCode }));
    } else if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
      reason = RECONNECT_REASONS.UNKNOWN_TRANSIENT;
      this._pairingRequested = false;
    } else if (statusCode === DisconnectReason.connectionClosed || statusCode === 428) {
      reason = RECONNECT_REASONS.CONNECTION_CLOSED;
    } else if (statusCode === DisconnectReason.connectionLost || statusCode === 408) {
      reason = RECONNECT_REASONS.NETWORK_ERROR;
    } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
      reason = RECONNECT_REASONS.UNKNOWN_TRANSIENT;
    } else if (statusCode === DisconnectReason.timedOut) {
      reason = RECONNECT_REASONS.NETWORK_ERROR;
    } else if (statusCode === 503) {
      reason = RECONNECT_REASONS.SERVER_UNAVAILABLE;
    } else if (statusCode === 440) {
      reason = RECONNECT_REASONS.CONFLICT;
    }

    this.emit('connection_close', { statusCode, reason, error: err });

    if (!isNonRecoverable && this.reconnectManager.isRecoverable(reason)) {
      this.reconnectManager.schedule(reason, async () => {
        this.emit('reconnecting', { reason });
        try {
          await this.createSocket();
        } catch (reconnectErr) {
          this.emit('error', reconnectErr);
        }
      });
    }
  }

  /**
   * Synchronous dispatch of WebSocket ping control frame across the wire.
   * @returns {boolean} True if ping frame was dispatched, false if socket unavailable or errored.
   */
  sendPing() {
    if (!this.isConnected || !this.sock) {
      return false;
    }
    try {
      if (this.sock.ws && typeof this.sock.ws.ping === 'function') {
        this.sock.ws.ping();
        return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Initiates termination of the active Baileys socket with Boom 408 status code.
   * @param {string} [reason='ZOMBIE_SOCKET_DETECTED']
   * @returns {boolean|Promise<boolean>} True if termination request was accepted and dispatched (sock.end).
   */
  terminateSocket(reason = 'ZOMBIE_SOCKET_DETECTED') {
    if (!this.sock) return false;
    try {
      if (typeof this.sock.end === 'function') {
        this.sock.end(new Boom(`Socket terminated: ${reason}`, { statusCode: 408 }));
        return true;
      }
    } catch (_) {}
    return false;
  }

  async close() {
    this._isShuttingDown = true;
    this.reconnectManager.setShutdown();
    this.sessionManager.releaseLock();
    if (this.sock && typeof this.sock.end === 'function') {
      try {
        this.sock.end(undefined);
      } catch (_) {}
    }
    this.isConnected = false;
  }
}
