import { TERMINAL_LEVEL, TERMINAL_DOMAIN } from './TerminalConstants.js';

/**
 * PresentationAdapter maps and filters internal LeavesClient & subsystem events
 * into semantic TerminalEvent inputs (Contract Baseline v1.3).
 */
export class PresentationAdapter {
  /**
   * @param {Object} terminalManager - TerminalManager instance
   */
  constructor(terminalManager) {
    this.terminalManager = terminalManager;
    this._unsubscribers = [];
  }

  /**
   * Attaches to LeavesClient internal event listeners.
   * @param {Object} client - LeavesClient instance
   */
  attach(client) {
    if (!client || typeof client.on !== 'function') return;

    const onReady = ({ user }) => {
      const userJid = user?.id || user?.jid || 'Bot';
      this.terminalManager.dispatch({
        level: TERMINAL_LEVEL.INFO,
        domain: TERMINAL_DOMAIN.CLIENT,
        type: 'READY',
        message: `Client initialized and ready! Logged in as ${userJid}`,
        data: { _legacySuccess: true, user }
      });
    };

    const onDisconnect = ({ statusCode, reason }) => {
      this.terminalManager.dispatch({
        level: TERMINAL_LEVEL.WARN,
        domain: TERMINAL_DOMAIN.CLIENT,
        type: 'DISCONNECT',
        message: `Connection closed (${reason || statusCode || 'Unknown'})`,
        data: { statusCode, reason }
      });
    };

    const onReconnecting = ({ reason }) => {
      this.terminalManager.dispatch({
        level: TERMINAL_LEVEL.INFO,
        domain: TERMINAL_DOMAIN.CLIENT,
        type: 'RECONNECT',
        message: `Attempting auto-recovery reconnect for reason: ${reason}`,
        data: { reason }
      });
    };

    const onLoggedOut = (err) => {
      this.terminalManager.dispatch({
        level: TERMINAL_LEVEL.ERROR,
        domain: TERMINAL_DOMAIN.CLIENT,
        type: 'LOGOUT',
        message: 'Device logged out or unlinked. Reconnection stopped.',
        data: { error: err }
      });
    };

    const onError = (err) => {
      this.terminalManager.dispatch({
        level: TERMINAL_LEVEL.ERROR,
        domain: TERMINAL_DOMAIN.CLIENT,
        type: 'RUNTIME',
        message: err?.message || String(err),
        data: { error: err }
      });
    };

    client.on('ready', onReady);
    client.on('connection_close', onDisconnect);
    client.on('reconnecting', onReconnecting);
    client.on('logged_out', onLoggedOut);
    client.on('error', onError);

    this._unsubscribers.push(() => {
      if (typeof client.off === 'function' || typeof client.removeListener === 'function') {
        const remove = client.off ? client.off.bind(client) : client.removeListener.bind(client);
        remove('ready', onReady);
        remove('connection_close', onDisconnect);
        remove('reconnecting', onReconnecting);
        remove('logged_out', onLoggedOut);
        remove('error', onError);
      }
    });
  }

  /**
   * Detaches all attached listeners cleanly.
   */
  detach() {
    for (const unsub of this._unsubscribers) {
      try {
        unsub();
      } catch (_) {}
    }
    this._unsubscribers = [];
  }
}
