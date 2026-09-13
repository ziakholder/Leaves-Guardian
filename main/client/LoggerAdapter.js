import pino from 'pino';

/**
 * LoggerAdapter bridges Baileys internal logger to LeavesTerminal.
 * Filters out raw binary spam and formats critical events into human-readable lines.
 */
export class LoggerAdapter {
  constructor(terminal, options = {}) {
    this.terminal = terminal;
    this.level = options.level || 'warn'; // By default, only intercept warn and above from Baileys
  }

  createPinoLogger() {
    const terminal = this.terminal;
    const filterNoise = (msg) => {
      if (!msg) return true;
      const noisePatterns = [
        'recv ', 'sending ', 'frame ', 'decode ', 'write ', 'read ',
        'unhandled message', 'node_modules', 'ping', 'pong'
      ];
      const lower = String(msg).toLowerCase();
      return noisePatterns.some((p) => lower.includes(p));
    };

    // Return a proxy-like custom logger object compatible with Baileys
    const customLogger = {
      level: this.level,
      trace: (...args) => {
        if (this.level === 'trace' && !filterNoise(args[0]?.msg || args[0])) {
          terminal.debug('BAILEYS', typeof args[0] === 'string' ? args[0] : (args[0]?.msg || JSON.stringify(args[0])));
        }
      },
      debug: (...args) => {
        if ((this.level === 'debug' || this.level === 'trace') && !filterNoise(args[0]?.msg || args[0])) {
          terminal.debug('BAILEYS', typeof args[0] === 'string' ? args[0] : (args[0]?.msg || JSON.stringify(args[0])));
        }
      },
      info: (...args) => {
        if (this.level === 'info' || this.level === 'debug' || this.level === 'trace') {
          const msg = typeof args[0] === 'string' ? args[0] : (args[0]?.msg || '');
          if (msg && !filterNoise(msg)) {
            terminal.info('BAILEYS', msg);
          }
        }
      },
      warn: (...args) => {
        const msg = typeof args[0] === 'string' ? args[0] : (args[0]?.msg || JSON.stringify(args[0]));
        if (msg && !filterNoise(msg)) {
          terminal.warn('BAILEYS', msg);
        }
      },
      error: (...args) => {
        const msg = typeof args[0] === 'string' ? args[0] : (args[0]?.msg || JSON.stringify(args[0]));
        terminal.error('BAILEYS', msg);
      },
      fatal: (...args) => {
        const msg = typeof args[0] === 'string' ? args[0] : (args[0]?.msg || JSON.stringify(args[0]));
        terminal.error('BAILEYS', msg);
      },
      child: () => customLogger
    };

    return customLogger;
  }
}
