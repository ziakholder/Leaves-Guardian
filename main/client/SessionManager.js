import fs from 'fs';
import path from 'path';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { SessionError } from '../errors/LeavesError.js';

export class SessionManager {
  constructor(options = {}) {
    this.directory = options.directory || './session';
    this.authMethod = options.method || (options.phoneNumber ? 'pairing' : 'qr');
    this.phoneNumber = options.phoneNumber ? String(options.phoneNumber).replace(/[^0-9]/g, '') : null;
    this.lockFile = path.join(this.directory, '.session.lock');
    this._isLocked = false;
    this.authState = null;
    this.saveCreds = null;
  }

  hasSession() {
    const credsPath = path.join(this.directory, 'creds.json');
    return fs.existsSync(credsPath);
  }

  isRegistered() {
    if (!this.authState || !this.authState.state) return false;
    return Boolean(this.authState.state.creds?.registered);
  }

  /**
   * Atomic file write: write to temp file -> flush -> rename to target
   */
  writeAtomic(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
      throw new SessionError(`Failed atomic write to "${filePath}": ${err.message}`, { cause: err });
    }
  }

  acquireLock() {
    try {
      if (!fs.existsSync(this.directory)) {
        fs.mkdirSync(this.directory, { recursive: true });
      }
      if (fs.existsSync(this.lockFile)) {
        const lockInfo = fs.readFileSync(this.lockFile, 'utf8');
        try {
          const parsed = JSON.parse(lockInfo);
          // If another process PID holds the lock
          if (parsed.pid && parsed.pid !== process.pid) {
            try {
              process.kill(parsed.pid, 0);
              throw new SessionError(`Session directory "${this.directory}" is locked by active PID ${parsed.pid}`);
            } catch (e) {
              if (e.code === 'ESRCH') {
                // Dead process, safe to reclaim
              } else {
                throw e;
              }
            }
          }
          // If same process PID holds the lock (re-entrant / reconnect), update lock
        } catch (e) {
          if (e instanceof SessionError) throw e;
        }
      }
      this.writeAtomic(this.lockFile, { pid: process.pid, time: Date.now() });
      this._isLocked = true;
    } catch (err) {
      if (err instanceof SessionError) throw err;
      throw new SessionError(`Failed to acquire session lock in "${this.directory}": ${err.message}`, { cause: err });
    }
  }

  releaseLock() {
    if (this._isLocked && fs.existsSync(this.lockFile)) {
      try {
        fs.unlinkSync(this.lockFile);
      } catch (_) {}
      this._isLocked = false;
    }
  }

  async initAuth() {
    this.acquireLock();
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.directory);
      this.authState = { state, saveCreds };
      this.saveCreds = saveCreds;
      return this.authState;
    } catch (err) {
      this.releaseLock();
      throw new SessionError(`Failed to initialize auth state in "${this.directory}": ${err.message}`, { cause: err });
    }
  }
}
