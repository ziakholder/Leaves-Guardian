import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { SessionRecoveryError } from '../errors/LeavesError.js';

export const SESSION_RECOVERY_CODES = Object.freeze({
  SESSION_CORRUPTED: 'SESSION_CORRUPTED',
  SNAPSHOT_CREATION_FAILED: 'SNAPSHOT_CREATION_FAILED',
  SNAPSHOT_INCONSISTENT: 'SNAPSHOT_INCONSISTENT',
  SNAPSHOT_CORRUPTED: 'SNAPSHOT_CORRUPTED',
  SESSION_UNRECOVERABLE: 'SESSION_UNRECOVERABLE',
  RESTORE_FAILED: 'RESTORE_FAILED',
  RESTORE_ACTIVATION_FAILED: 'RESTORE_ACTIVATION_FAILED',
  RECOVERY_BLOCKED_401: 'RECOVERY_BLOCKED_401',
  RECOVERY_BUSY: 'RECOVERY_BUSY',
  INVALID_PARAMETER: 'INVALID_PARAMETER'
});

export const SESSION_STATUS = Object.freeze({
  FRESH_SESSION: 'FRESH_SESSION',
  HEALTHY: 'HEALTHY',
  CORRUPTED_ZERO_BYTE: 'CORRUPTED_ZERO_BYTE',
  CORRUPTED_SYNTAX_ERROR: 'CORRUPTED_SYNTAX_ERROR',
  CORRUPTED_SCHEMA_INVALID: 'CORRUPTED_SCHEMA_INVALID'
});

/**
 * Strict Regex Whitelist for Baileys auth files.
 * Non-auth JSON files (e.g. my-config.json, debug.json) and control directories are NEVER matched.
 */
const AUTH_FILE_PATTERNS = [
  /^creds\.json$/,
  /^pre-key-\d+\.json$/,
  /^session-[a-zA-Z0-9_\-\.\:\@]+\.json$/,
  /^sender-key-[a-zA-Z0-9_\-\.\:\@]+\.json$/,
  /^sender-key-memory-[a-zA-Z0-9_\-\.\:\@]+\.json$/,
  /^app-state-sync-key-[a-zA-Z0-9_\-\.\:\@]+\.json$/,
  /^app-state-sync-version-[a-zA-Z0-9_\-\.\:\@]+\.json$/
];

export function isEligibleAuthFile(filename) {
  if (typeof filename !== 'string') return false;
  const basename = path.basename(filename);
  return AUTH_FILE_PATTERNS.some((regex) => regex.test(basename));
}

function computeSha256(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function removeDirRecursive(dirPath) {
  if (fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * SessionRecovery handles disk-level auth filesystem integrity, atomic snapshotting,
 * complete-tree forensics quarantine, safe staging, and exact-tree rollback recovery.
 */
export class SessionRecovery extends EventEmitter {
  #mutationQueue = Promise.resolve();

  constructor(options = {}) {
    super();
    this.sessionDirectory = options.sessionDirectory || './session';
    this.backupDirectory = options.backupDirectory || path.join(this.sessionDirectory, '.backup');
    this.quarantineDirectory = options.quarantineDirectory || path.join(this.sessionDirectory, '.quarantine');
    this.maxSnapshots = Math.max(1, Math.min(10, options.maxSnapshots ?? 3));
    this.maxQuarantineEntries = Math.max(1, Math.min(100, options.maxQuarantineEntries ?? 10));
    this.autoSnapshotOnConnect = options.autoSnapshotOnConnect !== false;
    this.autoRestoreOnCorruption = options.autoRestoreOnCorruption !== false;
    this.purgeBackupsOn401 = options.purgeBackupsOn401 !== false;

    this._isTerminalLoggedOut = false;
    this._isShuttingDown = false;
  }

  /**
   * Internal serializer to guarantee all mutating operations run sequentially
   * without race conditions or queue poisoning.
   */
  #serialize(fn) {
    if (this._isShuttingDown) {
      return Promise.reject(
        new SessionRecoveryError('SessionRecovery is shutting down', SESSION_RECOVERY_CODES.RECOVERY_BUSY)
      );
    }
    const task = this.#mutationQueue.catch(() => {}).then(() => fn());
    this.#mutationQueue = task;
    return task;
  }

  /**
   * List only eligible auth files in the specified directory.
   */
  #listEligibleAuthFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && isEligibleAuthFile(entry.name))
        .map((entry) => entry.name);
    } catch (_) {
      return [];
    }
  }

  /**
   * Generates a collision-safe snapshot ID: snapshot_<timestamp>_<randomHex8>
   */
  #generateSnapshotId() {
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex'); // 8 hex characters
    return `snapshot_${ts}_${rand}`;
  }

  /**
   * Inspects current active session directory integrity (Read-Only).
   */
  async inspectSession() {
    if (!fs.existsSync(this.sessionDirectory)) {
      return {
        status: SESSION_STATUS.FRESH_SESSION,
        isCorrupted: false,
        details: 'Session directory does not exist'
      };
    }

    const credsPath = path.join(this.sessionDirectory, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      return {
        status: SESSION_STATUS.FRESH_SESSION,
        isCorrupted: false,
        details: 'creds.json missing'
      };
    }

    let stats;
    try {
      stats = fs.statSync(credsPath);
    } catch (err) {
      return {
        status: SESSION_STATUS.CORRUPTED_SYNTAX_ERROR,
        isCorrupted: true,
        details: `Failed to stat creds.json: ${err.message}`
      };
    }

    if (stats.size === 0) {
      return {
        status: SESSION_STATUS.CORRUPTED_ZERO_BYTE,
        isCorrupted: true,
        details: 'creds.json is 0 bytes'
      };
    }

    let parsed;
    try {
      const content = fs.readFileSync(credsPath, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        status: SESSION_STATUS.CORRUPTED_SYNTAX_ERROR,
        isCorrupted: true,
        details: `JSON parse failed: ${err.message}`,
        error: err
      };
    }

    // Structural validation for Baileys auth credentials
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.noiseKey ||
      !parsed.signedIdentityKey ||
      !parsed.signedPreKey ||
      parsed.registrationId === undefined
    ) {
      return {
        status: SESSION_STATUS.CORRUPTED_SCHEMA_INVALID,
        isCorrupted: true,
        details: 'creds.json missing mandatory Baileys authentication keys'
      };
    }

    return {
      status: SESSION_STATUS.HEALTHY,
      isCorrupted: false,
      registered: Boolean(parsed.registered || parsed.me),
      accountJid: parsed.me?.id || null
    };
  }

  /**
   * Creates an atomic, source-consistent snapshot of eligible auth files.
   */
  async createSnapshot(reason = 'MANUAL') {
    return this.#serialize(async () => {
      if (this._isTerminalLoggedOut) {
        throw new SessionRecoveryError(
          'Cannot create snapshot on terminal logged-out session',
          SESSION_RECOVERY_CODES.RECOVERY_BLOCKED_401
        );
      }

      if (!fs.existsSync(this.sessionDirectory)) {
        throw new SessionRecoveryError(
          `Session directory "${this.sessionDirectory}" does not exist`,
          SESSION_RECOVERY_CODES.SNAPSHOT_CREATION_FAILED
        );
      }

      const credsPath = path.join(this.sessionDirectory, 'creds.json');
      if (!fs.existsSync(credsPath)) {
        throw new SessionRecoveryError(
          'Cannot create snapshot: creds.json not found in active session',
          SESSION_RECOVERY_CODES.SNAPSHOT_CREATION_FAILED
        );
      }

      if (!fs.existsSync(this.backupDirectory)) {
        fs.mkdirSync(this.backupDirectory, { recursive: true });
      }

      const startTime = Date.now();
      const maxRetries = 2;
      let attempt = 0;
      let consistent = false;
      let eligibleFiles = [];
      let tmpDir = '';

      while (attempt <= maxRetries && !consistent) {
        attempt++;
        const randTmp = crypto.randomBytes(4).toString('hex');
        tmpDir = path.join(this.backupDirectory, `.tmp_snapshot_${Date.now()}_${randTmp}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        eligibleFiles = this.#listEligibleAuthFiles(this.sessionDirectory);
        const sourceStats = new Map();

        // 1. Capture source metadata
        for (const file of eligibleFiles) {
          const filePath = path.join(this.sessionDirectory, file);
          try {
            const st = fs.statSync(filePath);
            sourceStats.set(file, { size: st.size, mtimeMs: st.mtimeMs });
          } catch (_) {}
        }

        // 2. Copy eligible files to temporary snapshot dir
        for (const file of eligibleFiles) {
          const src = path.join(this.sessionDirectory, file);
          const dst = path.join(tmpDir, file);
          try {
            fs.copyFileSync(src, dst);
          } catch (err) {
            removeDirRecursive(tmpDir);
            throw new SessionRecoveryError(
              `Failed copying "${file}" during snapshot: ${err.message}`,
              SESSION_RECOVERY_CODES.SNAPSHOT_CREATION_FAILED,
              { cause: err }
            );
          }
        }

        // 3. Re-stat source files to verify source consistency
        let mutated = false;
        for (const [file, original] of sourceStats.entries()) {
          const filePath = path.join(this.sessionDirectory, file);
          try {
            const current = fs.statSync(filePath);
            if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
              mutated = true;
              break;
            }
          } catch (_) {
            mutated = true;
            break;
          }
        }

        if (!mutated) {
          consistent = true;
        } else {
          removeDirRecursive(tmpDir);
          if (attempt > maxRetries) {
            throw new SessionRecoveryError(
              'Source files mutated during snapshot copy exceeding retry limit',
              SESSION_RECOVERY_CODES.SNAPSHOT_INCONSISTENT
            );
          }
        }
      }

      // 4. Generate mandatory Manifest v1
      const manifestFiles = [];
      for (const file of eligibleFiles) {
        const filePath = path.join(tmpDir, file);
        const st = fs.statSync(filePath);
        manifestFiles.push({
          name: file,
          size: st.size,
          sha256: computeSha256(filePath)
        });
      }

      // Sort files alphabetically for deterministic manifests
      manifestFiles.sort((a, b) => a.name.localeCompare(b.name));

      let snapshotId = this.#generateSnapshotId();
      let targetPath = path.join(this.backupDirectory, snapshotId);

      // 5. Exclusive Filesystem Publication Guarantee
      let publishRetries = 0;
      while (fs.existsSync(targetPath) && publishRetries < 5) {
        publishRetries++;
        snapshotId = this.#generateSnapshotId();
        targetPath = path.join(this.backupDirectory, snapshotId);
      }

      if (fs.existsSync(targetPath)) {
        removeDirRecursive(tmpDir);
        throw new SessionRecoveryError(
          'Target snapshot directory collision could not be resolved',
          SESSION_RECOVERY_CODES.SNAPSHOT_CREATION_FAILED
        );
      }

      const manifest = {
        schemaVersion: 1,
        snapshotId,
        createdAt: Date.now(),
        createdAtISO: new Date().toISOString(),
        reason,
        platform: process.platform,
        fileCount: manifestFiles.length,
        files: manifestFiles
      };

      const manifestPath = path.join(tmpDir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      // 6. Atomic Rename to published snapshot
      try {
        fs.renameSync(tmpDir, targetPath);
      } catch (err) {
        removeDirRecursive(tmpDir);
        throw new SessionRecoveryError(
          `Failed publishing snapshot: ${err.message}`,
          SESSION_RECOVERY_CODES.SNAPSHOT_CREATION_FAILED,
          { cause: err }
        );
      }

      // 7. Prune snapshots to maxSnapshots
      await this.#pruneSnapshotsInternal();

      const durationMs = Date.now() - startTime;
      const metadata = {
        snapshotId,
        createdAt: manifest.createdAt,
        reason,
        fileCount: manifest.fileCount,
        durationMs
      };

      this.emit('snapshot_created', metadata);
      return metadata;
    });
  }

  /**
   * Validates a snapshot directory against its mandatory manifest and schema.
   */
  async validateSnapshot(snapshotIdOrPath) {
    let fullPath;
    if (path.isAbsolute(snapshotIdOrPath)) {
      fullPath = snapshotIdOrPath;
    } else if (fs.existsSync(snapshotIdOrPath)) {
      fullPath = path.resolve(snapshotIdOrPath);
    } else {
      fullPath = path.join(this.backupDirectory, snapshotIdOrPath);
    }

    if (!fs.existsSync(fullPath)) {
      return { valid: false, reason: 'Snapshot directory does not exist' };
    }

    const manifestPath = path.join(fullPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { valid: false, reason: 'manifest.json is mandatory in Schema v1 but missing' };
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      return { valid: false, reason: `manifest.json is malformed: ${err.message}` };
    }

    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
      return { valid: false, reason: 'Unsupported or invalid manifest schema' };
    }

    // Verify each file listed in manifest
    for (const entry of manifest.files) {
      const filePath = path.join(fullPath, entry.name);
      if (!fs.existsSync(filePath)) {
        return { valid: false, reason: `File "${entry.name}" missing from snapshot` };
      }
      try {
        const stats = fs.statSync(filePath);
        if (stats.size !== entry.size) {
          return { valid: false, reason: `Size mismatch for "${entry.name}"` };
        }
        const hash = computeSha256(filePath);
        if (hash !== entry.sha256) {
          return { valid: false, reason: `SHA-256 checksum mismatch for "${entry.name}"` };
        }
      } catch (err) {
        return { valid: false, reason: `Failed verifying "${entry.name}": ${err.message}` };
      }
    }

    // Verify creds.json content
    const credsPath = path.join(fullPath, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      return { valid: false, reason: 'creds.json missing from snapshot' };
    }

    try {
      const credsParsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      if (
        !credsParsed ||
        typeof credsParsed !== 'object' ||
        !credsParsed.noiseKey ||
        !credsParsed.signedIdentityKey ||
        !credsParsed.signedPreKey ||
        credsParsed.registrationId === undefined
      ) {
        return { valid: false, reason: 'creds.json in snapshot has invalid Baileys schema' };
      }
    } catch (err) {
      return { valid: false, reason: `creds.json parse failed: ${err.message}` };
    }

    return { valid: true, manifest };
  }

  /**
   * List all stored snapshots sorted descending (newest first).
   */
  async listSnapshots() {
    if (!fs.existsSync(this.backupDirectory)) return [];
    try {
      const entries = fs.readdirSync(this.backupDirectory, { withFileTypes: true });
      const snapshots = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('snapshot_')) {
          const snapDir = path.join(this.backupDirectory, entry.name);
          const manifestPath = path.join(snapDir, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              snapshots.push({
                snapshotId: entry.name,
                createdAt: manifest.createdAt || 0,
                createdAtISO: manifest.createdAtISO || '',
                reason: manifest.reason || 'UNKNOWN',
                fileCount: manifest.fileCount || 0
              });
            } catch (_) {}
          }
        }
      }

      snapshots.sort((a, b) => b.createdAt - a.createdAt);
      return snapshots;
    } catch (_) {
      return [];
    }
  }

  /**
   * Restores a specified snapshot with staging, replacement semantics, and exact-tree rollback.
   */
  async restoreSnapshot(snapshotIdOrPath) {
    return this.#serialize(async () => {
      if (this._isTerminalLoggedOut) {
        throw new SessionRecoveryError(
          'Cannot restore snapshot: session is in terminal logged-out state',
          SESSION_RECOVERY_CODES.RECOVERY_BLOCKED_401
        );
      }

      let snapPath;
      if (path.isAbsolute(snapshotIdOrPath)) {
        snapPath = snapshotIdOrPath;
      } else if (fs.existsSync(snapshotIdOrPath)) {
        snapPath = path.resolve(snapshotIdOrPath);
      } else {
        snapPath = path.join(this.backupDirectory, snapshotIdOrPath);
      }

      const validation = await this.validateSnapshot(snapPath);
      if (!validation.valid) {
        throw new SessionRecoveryError(
          `Snapshot validation failed: ${validation.reason}`,
          SESSION_RECOVERY_CODES.SNAPSHOT_CORRUPTED,
          { reason: validation.reason }
        );
      }

      const manifest = validation.manifest;
      if (!fs.existsSync(this.sessionDirectory)) {
        fs.mkdirSync(this.sessionDirectory, { recursive: true });
      }

      const randSuffix = crypto.randomBytes(4).toString('hex');
      const stagingDir = path.join(this.backupDirectory, `.tmp_restore_${Date.now()}_${randSuffix}`);
      const rollbackDir = path.join(this.backupDirectory, `.tmp_rollback_${Date.now()}_${randSuffix}`);

      // 1. Stage restoration
      try {
        fs.mkdirSync(stagingDir, { recursive: true });
        for (const entry of manifest.files) {
          const src = path.join(snapPath, entry.name);
          const dst = path.join(stagingDir, entry.name);
          fs.copyFileSync(src, dst);
        }
      } catch (err) {
        removeDirRecursive(stagingDir);
        throw new SessionRecoveryError(
          `Failed staging restore files: ${err.message}`,
          SESSION_RECOVERY_CODES.RESTORE_FAILED,
          { cause: err }
        );
      }

      // 2. Prepare Pre-Activation Rollback Archive (exact current active eligible auth tree)
      try {
        fs.mkdirSync(rollbackDir, { recursive: true });
        const currentActiveEligible = this.#listEligibleAuthFiles(this.sessionDirectory);
        const rollbackFiles = [];

        for (const file of currentActiveEligible) {
          const src = path.join(this.sessionDirectory, file);
          const dst = path.join(rollbackDir, file);
          fs.copyFileSync(src, dst);
          const st = fs.statSync(src);
          rollbackFiles.push({
            name: file,
            size: st.size,
            sha256: computeSha256(src)
          });
        }

        const rollbackManifest = {
          schemaVersion: 1,
          createdAt: Date.now(),
          files: rollbackFiles
        };
        fs.writeFileSync(
          path.join(rollbackDir, 'rollback_manifest.json'),
          JSON.stringify(rollbackManifest, null, 2),
          'utf8'
        );
      } catch (err) {
        removeDirRecursive(stagingDir);
        removeDirRecursive(rollbackDir);
        throw new SessionRecoveryError(
          `Failed preparing rollback safety archive: ${err.message}`,
          SESSION_RECOVERY_CODES.RESTORE_FAILED,
          { cause: err }
        );
      }

      // 3. Execute Controlled Activation with Exact-Tree Rollback
      let staleFilesRemoved = 0;
      let filesRestored = 0;

      try {
        // Copy staged files to active session
        for (const entry of manifest.files) {
          const src = path.join(stagingDir, entry.name);
          const dst = path.join(this.sessionDirectory, entry.name);
          fs.copyFileSync(src, dst);
          filesRestored++;
        }

        // Stale cleanup: delete eligible active files NOT present in snapshot
        const snapshotFileNames = new Set(manifest.files.map((f) => f.name));
        const activeEligibleAfterCopy = this.#listEligibleAuthFiles(this.sessionDirectory);

        for (const file of activeEligibleAfterCopy) {
          if (!snapshotFileNames.has(file)) {
            const stalePath = path.join(this.sessionDirectory, file);
            fs.unlinkSync(stalePath);
            staleFilesRemoved++;
          }
        }

        // Verify active tree integrity against snapshot manifest
        for (const entry of manifest.files) {
          const activeFile = path.join(this.sessionDirectory, entry.name);
          if (!fs.existsSync(activeFile)) {
            throw new Error(`Restored file "${entry.name}" missing from active session`);
          }
          const hash = computeSha256(activeFile);
          if (hash !== entry.sha256) {
            throw new Error(`Checksum mismatch on active file "${entry.name}"`);
          }
        }
      } catch (activationErr) {
        // Activation failed -> Execute Exact-Tree Rollback!
        let rollbackStatus = 'UNRECOVERABLE';
        let rollbackError = null;

        try {
          const rollbackManifest = JSON.parse(
            fs.readFileSync(path.join(rollbackDir, 'rollback_manifest.json'), 'utf8')
          );
          const rollbackFileNames = new Set(rollbackManifest.files.map((f) => f.name));
          const currentEligible = this.#listEligibleAuthFiles(this.sessionDirectory);

          // 1. Remove eligible files absent from rollback archive
          for (const file of currentEligible) {
            if (!rollbackFileNames.has(file)) {
              try {
                fs.unlinkSync(path.join(this.sessionDirectory, file));
              } catch (_) {}
            }
          }

          // 2. Restore archived files from rollback archive
          for (const f of rollbackManifest.files) {
            fs.copyFileSync(path.join(rollbackDir, f.name), path.join(this.sessionDirectory, f.name));
          }

          // 3. Verify resulting active tree against rollback manifest
          for (const f of rollbackManifest.files) {
            const activeFile = path.join(this.sessionDirectory, f.name);
            const hash = computeSha256(activeFile);
            if (hash !== f.sha256) {
              throw new Error(`Rollback hash mismatch on "${f.name}"`);
            }
          }

          rollbackStatus = 'SUCCESS';
        } catch (rErr) {
          rollbackError = rErr.message;
          rollbackStatus = 'UNRECOVERABLE';
        } finally {
          removeDirRecursive(stagingDir);
          removeDirRecursive(rollbackDir);
        }

        throw new SessionRecoveryError(
          `Restore activation failed: ${activationErr.message}`,
          SESSION_RECOVERY_CODES.RESTORE_ACTIVATION_FAILED,
          {
            activationError: activationErr.message,
            rollbackStatus,
            rollbackError
          }
        );
      } finally {
        removeDirRecursive(stagingDir);
        removeDirRecursive(rollbackDir);
      }

      const result = {
        snapshotId: manifest.snapshotId,
        filesRestored,
        staleFilesRemoved,
        timestamp: Date.now()
      };

      this.emit('session_restored', result);
      return result;
    });
  }

  /**
   * Cascading recovery: restores the latest valid snapshot.
   */
  async restoreLatestValidSnapshot() {
    const snapshots = await this.listSnapshots();
    if (snapshots.length === 0) {
      throw new SessionRecoveryError(
        'No backup snapshots available for recovery',
        SESSION_RECOVERY_CODES.SESSION_UNRECOVERABLE
      );
    }

    let lastError = null;
    for (const snap of snapshots) {
      try {
        const result = await this.restoreSnapshot(snap.snapshotId);
        return result;
      } catch (err) {
        lastError = err;
      }
    }

    throw new SessionRecoveryError(
      `All ${snapshots.length} available snapshots failed validation or restoration: ${lastError?.message || 'unknown'}`,
      SESSION_RECOVERY_CODES.SESSION_UNRECOVERABLE,
      { cause: lastError }
    );
  }

  /**
   * Quarantines the complete active eligible auth tree to .quarantine for full forensic inspection.
   */
  async quarantineCurrentSession(diagnostics = {}) {
    return this.#serialize(async () => {
      if (!fs.existsSync(this.sessionDirectory)) {
        return { quarantined: false, reason: 'Session directory does not exist' };
      }

      const eligibleFiles = this.#listEligibleAuthFiles(this.sessionDirectory);
      if (eligibleFiles.length === 0) {
        return { quarantined: false, reason: 'No eligible auth files to quarantine' };
      }

      if (!fs.existsSync(this.quarantineDirectory)) {
        fs.mkdirSync(this.quarantineDirectory, { recursive: true });
      }

      const randSuffix = crypto.randomBytes(4).toString('hex');
      const quarantineId = `corrupted_${Date.now()}_${randSuffix}`;
      const targetQuarantineDir = path.join(this.quarantineDirectory, quarantineId);
      fs.mkdirSync(targetQuarantineDir, { recursive: true });

      const quarantinedFiles = [];
      for (const file of eligibleFiles) {
        const src = path.join(this.sessionDirectory, file);
        const dst = path.join(targetQuarantineDir, file);
        try {
          fs.copyFileSync(src, dst);
          quarantinedFiles.push(file);
        } catch (_) {}
      }

      const diagPayload = {
        quarantineId,
        timestamp: Date.now(),
        timestampISO: new Date().toISOString(),
        detectionReason: diagnostics.reason || 'SESSION_CORRUPTED',
        errorStack: diagnostics.errorStack || diagnostics.details || null,
        platform: process.platform,
        filesPreserved: quarantinedFiles
      };

      fs.writeFileSync(
        path.join(targetQuarantineDir, 'diagnostics.json'),
        JSON.stringify(diagPayload, null, 2),
        'utf8'
      );

      // Clean active eligible files from session directory
      for (const file of eligibleFiles) {
        try {
          fs.unlinkSync(path.join(this.sessionDirectory, file));
        } catch (_) {}
      }

      // Enforce bounded quarantine entries
      await this.#pruneQuarantineInternal();

      const result = {
        quarantined: true,
        quarantineId,
        quarantinePath: targetQuarantineDir,
        quarantinedFiles,
        totalQuarantined: quarantinedFiles.length
      };

      this.emit('session_quarantined', result);
      return result;
    });
  }

  /**
   * Cleans only eligible auth files in sessionDirectory without touching control/custom files.
   */
  async cleanEligibleAuthFiles() {
    return this.#serialize(async () => {
      const eligibleFiles = this.#listEligibleAuthFiles(this.sessionDirectory);
      const cleaned = [];
      for (const file of eligibleFiles) {
        try {
          fs.unlinkSync(path.join(this.sessionDirectory, file));
          cleaned.push(file);
        } catch (_) {}
      }
      return cleaned;
    });
  }

  /**
   * Terminal 401 handler: blocks restore, purges backups, and cleans eligible auth files.
   */
  async handleLoggedOut() {
    return this.#serialize(async () => {
      this._isTerminalLoggedOut = true;

      if (this.purgeBackupsOn401) {
        await this.#clearBackupsInternal();
      }

      // Clean active eligible auth files so session directory is ready for fresh pairing
      const eligibleFiles = this.#listEligibleAuthFiles(this.sessionDirectory);
      for (const file of eligibleFiles) {
        try {
          fs.unlinkSync(path.join(this.sessionDirectory, file));
        } catch (_) {}
      }

      this.emit('backups_purged', { reason: '401_LOGGED_OUT', timestamp: Date.now() });
    });
  }

  /**
   * Explicitly resets terminal logged-out state when new authenticated login occurs.
   */
  resetTerminalState() {
    this._isTerminalLoggedOut = false;
  }

  /**
   * Internal snapshot pruning enforcing maxSnapshots limit.
   */
  async #pruneSnapshotsInternal() {
    const snapshots = await this.listSnapshots();
    const prunedSnapshots = [];

    if (snapshots.length > this.maxSnapshots) {
      const toRemove = snapshots.slice(this.maxSnapshots);
      for (const snap of toRemove) {
        const dir = path.join(this.backupDirectory, snap.snapshotId);
        removeDirRecursive(dir);
        prunedSnapshots.push(snap.snapshotId);
      }
    }

    if (prunedSnapshots.length > 0) {
      this.emit('snapshot_pruned', {
        prunedSnapshots,
        remainingCount: Math.min(snapshots.length, this.maxSnapshots)
      });
    }

    return prunedSnapshots;
  }

  async pruneSnapshots() {
    return this.#serialize(() => this.#pruneSnapshotsInternal());
  }

  /**
   * Internal quarantine pruning enforcing maxQuarantineEntries limit.
   */
  async #pruneQuarantineInternal() {
    if (!fs.existsSync(this.quarantineDirectory)) return [];
    const pruned = [];
    try {
      const entries = fs.readdirSync(this.quarantineDirectory, { withFileTypes: true });
      const quarantineDirs = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('corrupted_')) {
          const fullPath = path.join(this.quarantineDirectory, entry.name);
          const diagPath = path.join(fullPath, 'diagnostics.json');
          let timestamp = 0;
          if (fs.existsSync(diagPath)) {
            try {
              const diag = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
              timestamp = diag.timestamp || 0;
            } catch (_) {}
          }
          quarantineDirs.push({ name: entry.name, fullPath, timestamp });
        }
      }

      quarantineDirs.sort((a, b) => b.timestamp - a.timestamp);

      if (quarantineDirs.length > this.maxQuarantineEntries) {
        const toRemove = quarantineDirs.slice(this.maxQuarantineEntries);
        for (const item of toRemove) {
          removeDirRecursive(item.fullPath);
          pruned.push(item.name);
        }
      }
    } catch (_) {}

    return pruned;
  }

  async pruneQuarantine() {
    return this.#serialize(() => this.#pruneQuarantineInternal());
  }

  async #clearBackupsInternal() {
    if (fs.existsSync(this.backupDirectory)) {
      const entries = fs.readdirSync(this.backupDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && (entry.name.startsWith('snapshot_') || entry.name.startsWith('.tmp_'))) {
          removeDirRecursive(path.join(this.backupDirectory, entry.name));
        }
      }
    }
  }

  /**
   * Clears all snapshot backups (Serialized Mutation).
   */
  async clearBackups() {
    return this.#serialize(() => this.#clearBackupsInternal());
  }

  /**
   * Graceful shutdown of SessionRecovery.
   */
  async stop() {
    this._isShuttingDown = true;
    await this.#mutationQueue.catch(() => {});
  }
}
