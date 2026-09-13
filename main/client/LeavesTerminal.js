import chalk from 'chalk';
import { PresentationSanitizer } from '../terminal/PresentationSanitizer.js';
import { TERMINAL_LEVEL, TERMINAL_DOMAIN } from '../terminal/TerminalConstants.js';
import { TerminalManager } from '../terminal/TerminalManager.js';

const SENSITIVE_PATTERNS = [
  /^Closing session:\s/i,
  /^Opening session:\s/i,
  /^Removing old closed session:\s/i,
  /^Session already closed\b/i
];

export class LeavesTerminal {
  /**
   * @param {TerminalManager|Object} [managerOrOptions]
   * @param {Object} [options]
   */
  constructor(managerOrOptions = {}, options = {}) {
    if (managerOrOptions && typeof managerOrOptions.dispatch === 'function') {
      this._manager = managerOrOptions;
      this.options = options;
    } else {
      this.options = managerOrOptions || {};
      const privacy = this.options.privacy !== false;
      const enabled = this.options.enabled !== false;
      const minLevel = this.options.logLevel === 'debug'
        ? TERMINAL_LEVEL.DEBUG
        : this.options.logLevel === 'warn'
          ? TERMINAL_LEVEL.WARN
          : this.options.logLevel === 'error'
            ? TERMINAL_LEVEL.ERROR
            : TERMINAL_LEVEL.INFO;
      this._manager = new TerminalManager({
        enabled,
        privacyMasking: privacy,
        minLevel,
        renderer: this.options.renderer,
        sink: this.options.sink
      });
    }

    this.privacy = this._manager.options.privacyMasking;
    this.enabled = this._manager.options.enabled;
    this.logLevel = this.options.logLevel || (this._manager.options.minLevel ? this._manager.options.minLevel.toLowerCase() : 'info');
    this._installSanitizer();
  }

  _installSanitizer() {
    if (LeavesTerminal._sanitizerInstalled) return;
    LeavesTerminal._sanitizerInstalled = true;

    const origLog = console.log;
    const origInfo = console.info;

    const isSensitive = (args) => {
      for (const arg of args) {
        if (!arg) continue;
        if (typeof arg === 'string') {
          for (const pattern of SENSITIVE_PATTERNS) {
            if (pattern.test(arg)) return true;
          }
          if (arg.includes('SessionEntry {') || arg.includes('currentRatchet:') || arg.includes('pendingPreKey:')) {
            return true;
          }
        } else if (typeof arg === 'object') {
          if (arg?.constructor?.name === 'SessionEntry' || arg?.constructor?.name === 'SessionRecord') {
            return true;
          }
          if (arg?._chains && arg?.currentRatchet) {
            return true;
          }
        }
      }
      return false;
    };

    console.log = (...args) => {
      if (isSensitive(args)) return;
      origLog.apply(console, args);
    };

    console.info = (...args) => {
      if (isSensitive(args)) return;
      origInfo.apply(console, args);
    };
  }

  static maskPhone(number, options = {}) {
    return PresentationSanitizer.maskJid(number, options);
  }

  mask(number) {
    if (!this.privacy && !this._manager.options.privacyMasking) {
      if (!number) return 'Unknown';
      return String(number).split('@')[0];
    }
    return PresentationSanitizer.maskJid(number);
  }

  banner(botName = 'LEAVES GUARDIAN', subtitle = 'Baileys Wrapper & Infrastructure Library') {
    if (!this.enabled || !this._manager.options.enabled) return;
    console.log('\n');
    console.log(chalk.green('╭──────────────────────────────────────────────────────────────╮'));
    console.log(chalk.green('│') + chalk.bold.white(`                    🍃 ${botName.toUpperCase()} 🍃                     `).padEnd(70) + chalk.green('│'));
    console.log(chalk.green('│') + chalk.gray(`         ${subtitle}          `).padEnd(70) + chalk.green('│'));
    console.log(chalk.green('╰──────────────────────────────────────────────────────────────╯'));
    console.log('');
  }

  info(tag, ...messages) {
    if (!messages.length) {
      messages = [tag];
      tag = 'INFO';
    }
    this._manager.dispatch({
      level: TERMINAL_LEVEL.INFO,
      domain: TERMINAL_DOMAIN.CLIENT,
      type: tag,
      message: messages.join(' ')
    });
  }

  success(tag, ...messages) {
    if (!messages.length) {
      messages = [tag];
      tag = 'READY';
    }
    this._manager.dispatch({
      level: TERMINAL_LEVEL.INFO,
      domain: TERMINAL_DOMAIN.CLIENT,
      type: tag,
      message: messages.join(' '),
      data: { _legacySuccess: true }
    });
  }

  warn(tag, ...messages) {
    if (!messages.length) {
      messages = [tag];
      tag = 'WARN';
    }
    this._manager.dispatch({
      level: TERMINAL_LEVEL.WARN,
      domain: TERMINAL_DOMAIN.CLIENT,
      type: tag,
      message: messages.join(' ')
    });
  }

  error(tag, ...messages) {
    if (!messages.length) {
      messages = [tag];
      tag = 'ERROR';
    }
    this._manager.dispatch({
      level: TERMINAL_LEVEL.ERROR,
      domain: TERMINAL_DOMAIN.CLIENT,
      type: tag,
      message: messages.join(' ')
    });
  }

  debug(tag, ...messages) {
    if (!messages.length) {
      messages = [tag];
      tag = 'DEBUG';
    }
    this._manager.dispatch({
      level: TERMINAL_LEVEL.DEBUG,
      domain: TERMINAL_DOMAIN.CLIENT,
      type: tag,
      message: messages.join(' ')
    });
  }

  message(sender, text, meta = {}) {
    this._manager.dispatch({
      level: TERMINAL_LEVEL.INFO,
      domain: TERMINAL_DOMAIN.CLIENT,
      type: 'MESSAGE',
      message: text || `[${meta.type || 'Media'}]`,
      data: {
        sender,
        text,
        chat: {
          id: meta.chatId,
          isGroup: Boolean(meta.isGroup)
        },
        type: meta.type
      }
    });
  }
}
