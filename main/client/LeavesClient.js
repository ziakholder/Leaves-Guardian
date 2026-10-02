import { EventEmitter } from 'events';
import qrcode from 'qrcode-terminal';
import { LeavesTerminal } from './LeavesTerminal.js';
import { LoggerAdapter } from './LoggerAdapter.js';
import { SessionManager } from './SessionManager.js';
import { ReconnectManager } from './ReconnectManager.js';
import { EventManager } from './EventManager.js';
import { ConnectionManager } from './ConnectionManager.js';
import { MessageNormalizer } from '../message/MessageNormalizer.js';
import { StateError, ConnectionError, CollectorError, CollectorTimeoutError, PromptError, PaginatorError, LeavesValidationError, EphemeralError, AutoDeleteError, SmartStoreError } from '../errors/LeavesError.js';
import { MessageCollector, COLLECTOR_END_REASONS } from '../collector/MessageCollector.js';
import { Prompt, PROMPT_STATES } from '../prompt/Prompt.js';
import { Paginator, PAGINATOR_STATES, PAGINATOR_ACTIONS } from '../paginator/Paginator.js';
import { EphemeralMessage, EPHEMERAL_DURATIONS, DEFAULT_EPHEMERAL_DURATION } from '../ephemeral/EphemeralMessage.js';
import { AutoDeleteManager, AUTODELETE_STATES, validateDelay } from '../autodelete/AutoDeleteManager.js';
import { SmartStore } from '../smartstore/SmartStore.js';
import { SessionRecovery } from '../recovery/SessionRecovery.js';
import { HealthMonitor } from '../health/HealthMonitor.js';
import { Watchdog } from '../watchdog/Watchdog.js';
import { MemoryGuard } from '../memory/MemoryGuard.js';
import { TrafficController, TRAFFIC_STATE } from '../traffic/TrafficController.js';
import { MediaPipeline } from '../media/MediaPipeline.js';
import { IngressRateLimiter } from '../limiter/IngressRateLimiter.js';
import { IngressDeduplicator } from '../dedup/IngressDeduplicator.js';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { PresentationAdapter } from '../terminal/PresentationAdapter.js';
import { resolveLidToPn } from '../helpers/lid-resolver.js';


export const CLIENT_STATES = Object.freeze({
  IDLE: 'IDLE',
  INITIALIZING: 'INITIALIZING',
  AUTHENTICATING: 'AUTHENTICATING',
  CONNECTING: 'CONNECTING',
  OPEN: 'OPEN',
  READY: 'READY',
  DISCONNECTED: 'DISCONNECTED',
  RECONNECTING: 'RECONNECTING',
  LOGGED_OUT: 'LOGGED_OUT',
  SHUTDOWN: 'SHUTDOWN'
});

export class LeavesClient extends EventEmitter {
  #activeCollectors = new Set();
  #activePrompts = new Set();
  #activePaginators = new Set();



  constructor(options = {}) {
    super();
    this.options = options;
    this.state = CLIENT_STATES.IDLE;

    // Terminal & Presentation Subsystem (Layer 5.5)
    const terminalOpts = {
      enabled: options.terminal?.enabled !== false,
      minLevel: options.terminal?.minLevel || (options.terminal?.logLevel === 'debug' ? 'DEBUG' : options.terminal?.logLevel === 'warn' ? 'WARN' : options.terminal?.logLevel === 'error' ? 'ERROR' : 'INFO'),
      privacyMasking: options.terminal?.privacyMasking ?? (options.terminal?.privacy !== false),
      renderer: options.terminal?.renderer,
      sink: options.terminal?.sink,
      clock: options.terminal?.clock,
      maxDispatchDepth: options.terminal?.maxDispatchDepth
    };
    this.terminalManager = new TerminalManager(terminalOpts);
    this.terminal = new LeavesTerminal(this.terminalManager, options.terminal);

    this.presentationAdapter = new PresentationAdapter(this.terminalManager);
    this.presentationAdapter.attach(this);

    this.loggerAdapter = new LoggerAdapter(this.terminal, {
      level: options.loggerLevel || 'warn'
    });

    // Session & Auth
    this.sessionManager = new SessionManager({
      directory: options.auth?.directory || './session',
      method: options.auth?.method || (options.auth?.phoneNumber ? 'pairing' : 'qr'),
      phoneNumber: options.auth?.phoneNumber
    });

    // Reconnection
    this.reconnectManager = new ReconnectManager({
      enabled: options.reconnect?.enabled !== false,
      maxAttempts: options.reconnect?.maxAttempts ?? Infinity,
      initialDelay: options.reconnect?.initialDelay || 1000,
      maxDelay: options.reconnect?.maxDelay || 30000,
      jitter: options.reconnect?.jitter ?? 1000
    });

    // Event & Socket Connection
    this.eventManager = new EventManager();
    this.connectionManager = new ConnectionManager({
      sessionManager: this.sessionManager,
      reconnectManager: this.reconnectManager,
      terminal: this.terminal,
      loggerAdapter: this.loggerAdapter,
      eventManager: this.eventManager,
      socketFactory: options.socketFactory,
      browser: options.browser || ['Leaves Guardian', 'Chrome', '1.0.0'],
      markOnlineOnConnect: options.markOnlineOnConnect !== false
    });

    // Auto-Delete Lifecycle Manager
    this.autoDelete = new AutoDeleteManager(this, options.autoDelete || {});

    // Lightweight State & KV Store (Layer 3.1)
    this.store = new SmartStore(options.store || {});

    // Disk-level Session & Auth Integrity Recovery (Layer 3.2)
    this.recovery = new SessionRecovery({
      sessionDirectory: this.sessionManager.directory,
      ...(options.recovery || {})
    });

    // Lifecycle Timestamps & Throughput Trackers
    this.connectedAt = null;
    this.readyAt = null;
    this.disconnectedAt = null;
    this.throughput = {
      messagesReceivedTotal: 0,
      messagesSentTotal: 0,
      errorsTotal: 0
    };

    // Central Observability & Health Engine (Layer 3.3)
    this.health = new HealthMonitor({
      client: this,
      ...(options.health || {})
    });

    if (options.health?.autoStart !== false && this.health.enabled) {
      this.health.start();
    }

    // Socket Liveness & Zombie Watchdog Subsystem (Layer 3.4)
    this.watchdog = new Watchdog({
      client: this,
      connectionManager: this.connectionManager,
      ...(options.watchdog || {})
    });

    if (options.watchdog?.autoStart !== false && this.watchdog.enabled) {
      this.watchdog.start();
    }

    // Process-Level Memory Observation & Mitigation Subsystem (Layer 3.5)
    const memGuardOptions = { ...(options.memoryGuard || {}) };
    const memGuardAutoStart = memGuardOptions.autoStart !== false;
    delete memGuardOptions.autoStart;

    this.memoryGuard = new MemoryGuard({
      client: this,
      ...memGuardOptions
    });

    if (this.store && typeof this.store.sweep === 'function') {
      this.memoryGuard.registerMitigationHook('smartStore.sweep', async () => {
        const evictedCount = this.store.sweep();
        return { evictedCount };
      });
    }

    if (memGuardAutoStart && this.memoryGuard.enabled) {
      this.memoryGuard.start();
    }

    // Egress Dispatch & Traffic Control Engine (Layer 5.1)
    const trafficOptions = { ...(options.traffic || {}) };
    this.trafficController = new TrafficController({
      transportFn: (jid, content, opts) => this._rawSend(jid, content, opts),
      ...trafficOptions
    });
    this.traffic = this.trafficController;

    // Media Preparation & Pipeline (Layer 5.2)
    const mediaOptions = { ...(options.media || {}) };
    this.mediaPipeline = new MediaPipeline(mediaOptions);
    this.media = this.mediaPipeline;

    // Ingress Rate Limiting Subsystem (Layer 5.3)
    const rateLimiterOptions = { ...(options.rateLimiter || {}) };
    this.rateLimiter = new IngressRateLimiter(rateLimiterOptions);

    // Ingress Deduplication Subsystem (Layer 5.4)
    const deduplicatorOptions = { ...(options.deduplicator || {}) };
    this.deduplicator = new IngressDeduplicator(deduplicatorOptions);

    this._setupInternalListeners();
    this._setupGracefulShutdown();
  }



  _transition(newState, meta = {}) {
    const prevState = this.state;
    this.state = newState;
    this.emit('state_change', { from: prevState, to: newState, ...meta });
  }

  getState() {
    return this.state;
  }

  isReady() {
    return this.state === CLIENT_STATES.READY;
  }

  /**
   * Advanced API — direct Baileys access.
   * WARNING: Direct Baileys access bypasses Leaves Guardian lifecycle and reliability guarantees.
   */
  getRawSocket() {
    return this.connectionManager.sock;
  }

  _setupInternalListeners() {
    this.connectionManager.on('connecting', () => {
      this._transition(CLIENT_STATES.CONNECTING);
      this.terminal.info('CONNECT', 'Connecting to WhatsApp...');
      this.emit('connecting');
    });

    this.connectionManager.on('qr', (qr) => {
      if (this.options.printQR !== false) {
        this.terminal.info('AUTH', 'Please scan the QR code below:');
        qrcode.generate(qr, { small: true });
      }
      this.emit('qr', qr);
    });

    this.connectionManager.on('pairing_eligible', async ({ phoneNumber }) => {
      this.emit('pairing_required', { phoneNumber });
      try {
        await this.connectionManager.requestPairingCode(phoneNumber);
      } catch (err) {
        this.terminal.error('PAIRING', err.message);
        this.emit('error', err);
      }
    });

    this.connectionManager.on('pairing_code', (data) => {
      console.log(`\n🔑 WHATSAPP PAIRING CODE: ${data.code}\n`);
      this.terminal.success('PAIRING', `Pairing code generated for ${this.terminal.mask(data.phoneNumber)}: ${data.code}`);
      this.emit('pairing_code', data);
    });

    this.connectionManager.on('connection_open', async (sock) => {
      // Record lifecycle connection timestamp
      this.connectedAt = Date.now();
      this.disconnectedAt = null;

      // 1. Mark OPEN state
      this._transition(CLIENT_STATES.OPEN);
      this.terminal.success('CONNECT', 'WhatsApp socket connection open');
      this.emit('connection_open');

      // 2. Perform real readiness initialization pipeline (OPEN !== READY)
      try {
        await this._initializeRuntime();
        await this._verifyReadyState();

        this._transition(CLIENT_STATES.READY);
        this.readyAt = Date.now();
        const userJid = sock.user?.id || sock.authState?.creds?.me?.id || sock.user?.jid || 'Bot';
        this.terminal.success('READY', `Client initialized and ready! Logged in as ${this.terminal.mask(userJid)}`);

        // 3. Authenticated session verified -> reset terminal state & create auto-snapshot
        if (this.recovery) {
          this.recovery.resetTerminalState();
          if (this.recovery.autoSnapshotOnConnect) {
            this.recovery.createSnapshot('AUTHENTICATED_READY').catch((err) => {
              this.recovery.emit('snapshot_error', err);
            });
          }
        }

        if (this.watchdog) {
          this.watchdog.resume();
        }

        if (this.memoryGuard) {
          this.memoryGuard.resume();
        }

        if (this.trafficController) {
          if (this.trafficController.state === TRAFFIC_STATE.STOPPED) {
            this.trafficController.start();
          } else if (this.trafficController.state === TRAFFIC_STATE.PAUSED) {
            this.trafficController.resume();
          }
        }

        this.emit('ready', { user: sock.user || sock.authState?.creds?.me });
      } catch (initErr) {
        this.terminal.error('RUNTIME', `Initialization failed after connection open: ${initErr.message}`);
        this.emit('error', initErr);
      }
    });

    this.connectionManager.on('connection_close', ({ statusCode, reason, error }) => {
      // Record lifecycle disconnect timestamp
      this.disconnectedAt = Date.now();
      this.readyAt = null;

      if (this.watchdog) {
        this.watchdog.pause();
      }

      if (this.memoryGuard) {
        this.memoryGuard.pause();
      }

      if (this.trafficController) {
        this.trafficController.pause();
      }

      if (reason === 'LOGGED_OUT' || statusCode === 401) {
        this._transition(CLIENT_STATES.LOGGED_OUT);
        this.emit('connection_close', { statusCode, reason, error });
        return;
      }
      this._transition(CLIENT_STATES.DISCONNECTED, { statusCode, reason });
      this.terminal.warn('DISCONNECT', `Connection closed (${reason || statusCode || 'Unknown'})`);
      this.emit('connection_close', { statusCode, reason, error });
    });

    this.connectionManager.on('reconnecting', ({ reason }) => {
      this._transition(CLIENT_STATES.RECONNECTING, { reason });
      this.terminal.info('RECONNECT', `Attempting auto-recovery reconnect for reason: ${reason}`);
      this.emit('reconnecting', { reason });
    });

    this.connectionManager.on('logged_out', (err) => {
      this.disconnectedAt = Date.now();
      this.readyAt = null;

      if (this.watchdog) {
        this.watchdog.pause();
      }

      if (this.memoryGuard) {
        this.memoryGuard.pause();
      }

      if (this.trafficController) {
        this.trafficController.pause();
      }

      this._transition(CLIENT_STATES.LOGGED_OUT);
      this.terminal.error('LOGOUT', 'Device logged out or unlinked. Reconnection stopped.');
      if (this.recovery) {
        this.recovery.handleLoggedOut().catch(() => {});
      }
      this.emit('logged_out', err);
    });

    this.connectionManager.on('socket_activity', ({ source }) => {
      this.watchdog?.recordActivity(source);
    });

    this.connectionManager.on('pong', () => {
      this.watchdog?.recordActivity('pong');
    });

    this.connectionManager.on('raw_messages_upsert', (m) => {
      this.watchdog?.recordActivity('message');
      if (m.type !== 'notify' || !Array.isArray(m.messages)) return;
      for (const rawMsg of m.messages) {
        const normalized = MessageNormalizer.normalize(rawMsg);
        if (normalized) {
          this.throughput.messagesReceivedTotal++;
          if (this.options.logIncomingMessages !== false) {
            this.terminal.message(normalized.sender.id, normalized.text, {
              isGroup: normalized.chat.isGroup,
              chatId: normalized.chat.id,
              type: normalized.type
            });
          }
          this.emit('message', normalized);
        }
      }
    });

    this.connectionManager.on('error', (err) => {
      this.throughput.errorsTotal++;
      this.terminal.error('CLIENT', err.message);
      this.emit('error', err);
    });

  }

  async _initializeRuntime() {
    return Promise.resolve();
  }

  async _verifyReadyState() {
    const sock = this.connectionManager.sock;
    if (!sock) {
      throw new ConnectionError('Underlying socket not available during readiness verification', 'SOCKET_UNAVAILABLE');
    }

    // In Baileys, an authenticated ready session strictly requires sock.user or authState.creds.me identity
    const user = sock.user || sock.authState?.creds?.me;
    if (!user || (!user.id && !user.jid)) {
      throw new ConnectionError('Socket is OPEN but authenticated user identity is not present (OPEN !== READY)', 'NOT_AUTHENTICATED');
    }

    return Promise.resolve();
  }

  async connect() {
    if (this.state !== CLIENT_STATES.IDLE && this.state !== CLIENT_STATES.DISCONNECTED) {
      throw new StateError(`Cannot connect while client is in ${this.state} state`);
    }

    this.terminal.banner();
    this._transition(CLIENT_STATES.INITIALIZING);
    this.terminal.info('INIT', 'Initializing Leaves Guardian client...');

    // Pre-flight session inspection and auto-recovery
    if (this.recovery && this.recovery.autoRestoreOnCorruption) {
      try {
        const inspection = await this.recovery.inspectSession();
        if (inspection.isCorrupted) {
          this.terminal.warn('RECOVERY', `Corrupted auth session detected (${inspection.status}). Initiating auto-recovery...`);
          this.emit('session_corrupted', inspection);
          await this.recovery.quarantineCurrentSession(inspection);
          await this.recovery.restoreLatestValidSnapshot();
          this.terminal.success('RECOVERY', 'Auth session successfully restored from healthy snapshot');
        }
      } catch (recoveryErr) {
        this.terminal.error('RECOVERY', `Session auto-recovery failed: ${recoveryErr.message}`);
        this.emit('recovery_failed', { error: recoveryErr });
      }
    }

    this._transition(CLIENT_STATES.AUTHENTICATING);
    await this.connectionManager.createSocket();
    return this;
  }


  async requestPairingCode(phoneNumber) {
    return this.connectionManager.requestPairingCode(phoneNumber);
  }

  async _rawSend(jid, contentOrBuilder, options = {}) {
    if (!this.isReady()) {
      throw new ConnectionError(`Cannot send message while client is not READY (current: ${this.state})`);
    }
    const targetJid = resolveLidToPn(jid);
    let res;
    // If a builder instance is passed directly
    if (contentOrBuilder && typeof contentOrBuilder.send === 'function') {
      res = await contentOrBuilder.send(targetJid, options);
    } else {
      const sock = this.getRawSocket();
      if (!sock) {
        throw new ConnectionError('Socket not available for sending message');
      }
      res = await sock.sendMessage(targetJid, contentOrBuilder, options);
    }
    this.throughput.messagesSentTotal++;
    return res;
  }

  async sendMessage(jid, contentOrBuilder, options = {}) {
    const targetJid = resolveLidToPn(jid);
    if (options?.traffic?.enabled === false || this.options?.traffic?.enabled === false) {
      return this._rawSend(targetJid, contentOrBuilder, options);
    }
    return this.trafficController.enqueue(targetJid, contentOrBuilder, options);
  }


  async send(jid, contentOrBuilder, options = {}) {
    return this.sendMessage(jid, contentOrBuilder, options);
  }


  async sendText(jid, text, options = {}) {
    return this.sendMessage(jid, { text }, options);
  }

  async deleteMessage(key) {
    if (!this.isReady()) {
      throw new ConnectionError(`Cannot delete message while client is not READY (current: ${this.state})`);
    }
    const sock = this.getRawSocket();
    const targetJid = resolveLidToPn(key?.remoteJid);
    return sock.sendMessage(targetJid, { delete: key });
  }

  async sendAndAutoDelete(jid, contentOrBuilder, delayMs, options = {}) {
    // 1. Atomic validation: validate delay BEFORE sending message
    validateDelay(delayMs);

    // 2. Send message
    const sentMessage = await this.sendMessage(jid, contentOrBuilder, options.sendOptions || {});

    // 3. Register auto-delete task
    try {
      const task = this.autoDelete.schedule(sentMessage, delayMs, options.scheduleOptions || {});
      return { message: sentMessage, task };
    } catch (err) {
      throw new AutoDeleteError(
        `Failed to schedule auto-delete for sent message: ${err.message}`,
        'AUTODELETE_SCHEDULE_FAILED',
        { message: sentMessage, cause: err }
      );
    }
  }

  createAutoDeleteManager(options = {}) {
    if (this.state === CLIENT_STATES.SHUTDOWN) {
      throw new AutoDeleteError('Cannot create auto-delete manager on a shutdown client', 'AUTODELETE_SHUTDOWN');
    }
    return new AutoDeleteManager(this, options);
  }

  createMessageCollector(options = {}) {
    if (this.state === CLIENT_STATES.SHUTDOWN) {
      throw new CollectorError('Cannot create message collector on a shutdown client', 'COLLECTOR_SHUTDOWN');
    }
    const collector = new MessageCollector(this, options);
    this.#activeCollectors.add(collector);
    collector.once('end', () => {
      this.#activeCollectors.delete(collector);
    });
    return collector;
  }

  awaitMessage(options = {}) {
    return new Promise((resolve, reject) => {
      const timeout = options.timeout ?? options.time ?? 30000;
      let collector;
      try {
        collector = this.createMessageCollector({
          ...options,
          max: 1,
          timeout,
        });
      } catch (err) {
        return reject(err);
      }

      collector.once('end', (collected, reason) => {
        if (reason === COLLECTOR_END_REASONS.LIMIT || collected.size > 0) {
          const firstMsg = Array.from(collected.values())[0];
          resolve(firstMsg);
        } else if (reason === COLLECTOR_END_REASONS.TIME) {
          reject(
            new CollectorTimeoutError(
              `Timed out after ${timeout}ms waiting for matching message`,
              { timeout, chatId: options.chatId, senderId: options.senderId }
            )
          );
        } else if (reason === COLLECTOR_END_REASONS.SHUTDOWN) {
          reject(new CollectorError('Client shutdown while waiting for message', 'COLLECTOR_SHUTDOWN'));
        } else if (reason === COLLECTOR_END_REASONS.CANCELED) {
          reject(new CollectorError('Message collector was canceled', 'COLLECTOR_CANCELED'));
        } else {
          reject(new CollectorError(`Message collector ended with reason: ${reason}`, 'COLLECTOR_ENDED', { reason }));
        }
      });
    });
  }

  awaitMessages(options = {}) {
    return new Promise((resolve, reject) => {
      const timeout = options.timeout ?? options.time ?? 30000;
      let collector;
      try {
        collector = this.createMessageCollector({
          ...options,
          timeout,
        });
      } catch (err) {
        return reject(err);
      }

      collector.once('end', (collected, reason) => {
        const messages = Array.from(collected.values());
        if (reason === COLLECTOR_END_REASONS.SHUTDOWN) {
          reject(new CollectorError('Client shutdown while waiting for messages', 'COLLECTOR_SHUTDOWN'));
        } else if (reason === COLLECTOR_END_REASONS.CANCELED) {
          reject(new CollectorError('Message collector was canceled', 'COLLECTOR_CANCELED'));
        } else {
          resolve(messages);
        }
      });
    });
  }

  createPrompt(options = {}) {
    if (this.state === CLIENT_STATES.SHUTDOWN) {
      throw new PromptError('Cannot create prompt on a shutdown client', 'PROMPT_SHUTDOWN');
    }
    return new Prompt(this, options);
  }

  _registerPrompt(prompt) {
    this.#activePrompts.add(prompt);
  }

  _unregisterPrompt(prompt) {
    this.#activePrompts.delete(prompt);
  }

  get activePromptsCount() {
    return this.#activePrompts.size;
  }

  createPaginator(options = {}) {
    if (this.state === CLIENT_STATES.SHUTDOWN) {
      throw new PaginatorError('Cannot create paginator on a shutdown client', 'PAGINATOR_SHUTDOWN');
    }
    return new Paginator(this, options);
  }

  createEphemeralMessage(contentOrBuilder, options = {}) {
    if (this.state === CLIENT_STATES.SHUTDOWN) {
      throw new EphemeralError('Cannot create ephemeral message on a shutdown client', 'EPHEMERAL_SHUTDOWN');
    }
    if (contentOrBuilder) {
      return EphemeralMessage.wrap(contentOrBuilder, { client: this, ...options });
    }
    return new EphemeralMessage(this, options);
  }

  _registerPaginator(paginator) {
    this.#activePaginators.add(paginator);
  }

  _unregisterPaginator(paginator) {
    this.#activePaginators.delete(paginator);
  }

  get activePaginatorsCount() {
    return this.#activePaginators.size;
  }

  async disconnect() {
    this._transition(CLIENT_STATES.SHUTDOWN);
    this.readyAt = null;
    this.terminal.info('SHUTDOWN', 'Gracefully closing Leaves Guardian client...');

    // Stop and clean up all active paginators gracefully
    for (const paginator of Array.from(this.#activePaginators)) {
      try {
        paginator.stop('clientShutdown');
      } catch (_) {}
    }
    this.#activePaginators.clear();

    // Cancel and clean up all active prompts gracefully
    for (const prompt of Array.from(this.#activePrompts)) {
      try {
        prompt.cancel('clientShutdown');
      } catch (_) {}
    }
    this.#activePrompts.clear();

    // Stop and clean up all active collectors gracefully
    for (const collector of Array.from(this.#activeCollectors)) {
      collector.stop(COLLECTOR_END_REASONS.SHUTDOWN);
    }
    this.#activeCollectors.clear();

    // Stop and clean up all active auto-delete tasks gracefully
    if (this.autoDelete) {
      try {
        this.autoDelete.stop();
      } catch (_) {}
    }

    // Stop and flush SmartStore gracefully
    if (this.store) {
      try {
        await this.store.stop();
      } catch (_) {}
    }

    // Stop SessionRecovery gracefully
    if (this.recovery) {
      try {
        await this.recovery.stop();
      } catch (_) {}
    }

    // Stop HealthMonitor gracefully
    if (this.health) {
      try {
        this.health.stop();
      } catch (_) {}
    }

    // Stop Watchdog gracefully
    if (this.watchdog) {
      try {
        this.watchdog.stop();
      } catch (_) {}
    }

    // Stop MemoryGuard gracefully
    if (this.memoryGuard) {
      try {
        this.memoryGuard.stop();
      } catch (_) {}
    }

    // Stop TrafficController gracefully
    if (this.trafficController) {
      try {
        this.trafficController.stop();
      } catch (_) {}
    }

    // Stop MediaPipeline gracefully
    if (this.mediaPipeline) {
      try {
        await this.mediaPipeline.destroy();
      } catch (_) {}
    }

    // Stop IngressRateLimiter gracefully
    if (this.rateLimiter) {
      try {
        this.rateLimiter.destroy();
      } catch (_) {}
    }

    // Stop IngressDeduplicator gracefully
    if (this.deduplicator) {
      try {
        this.deduplicator.destroy();
      } catch (_) {}
    }

    // Stop PresentationAdapter & TerminalManager gracefully
    if (this.presentationAdapter) {
      try {
        this.presentationAdapter.detach();
      } catch (_) {}
    }

    if (this.terminalManager) {
      try {
        this.terminalManager.destroy();
      } catch (_) {}
    }

    await this.connectionManager.close();
    this.emit('shutdown');

  }

  registerMemoryMitigationHook(name, fn, options = {}) {
    if (!this.memoryGuard) {
      throw new Error('MemoryGuard is not initialized on this client');
    }
    return this.memoryGuard.registerMitigationHook(name, fn, options);
  }


  _setupGracefulShutdown() {
    const handleSignal = async (signal) => {
      this.terminal.warn('PROCESS', `Received ${signal}. Initiating graceful shutdown...`);
      try {
        await this.disconnect();
      } catch (_) {}
      process.exit(0);
    };

    if (this.options.handleShutdown !== false) {
      process.once('SIGINT', () => handleSignal('SIGINT'));
      process.once('SIGTERM', () => handleSignal('SIGTERM'));
    }
  }

  get activeCollectorsCount() {
    return this.#activeCollectors.size;
  }

  getRawSocket() {
    return this.connectionManager.sock;
  }

  getUser() {
    return this.connectionManager.getUser();
  }

  isReady() {
    return this.state === CLIENT_STATES.READY;
  }
}

