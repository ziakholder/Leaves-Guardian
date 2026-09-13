/**
 * PresentationSanitizer implements the Tri-Tier Security & Canonicalization Pipeline (Contract v1.3).
 * Operates on an owned snapshot and guarantees zero retained references to raw internal structures.
 */

const SENSITIVE_KEY_PATTERN = /^(creds|noiseKey|signedIdentityKey|pairingCode|authKey|identityKey|privateKey|secret|token|password|pin|clientSecret|clientToken)$/i;
const ABSOLUTE_PATH_PATTERN = /(?:[a-zA-Z]:[\\/][^\s"']+|\/(?:home|Users|usr|var|etc|opt|tmp|app)[^\s"']*)/g;

/**
 * Masks a WhatsApp Phone JID into privacy format.
 * @param {string} jid
 * @param {Object} [options]
 * @returns {string}
 */
export function maskJid(jid, options = {}) {
  if (!jid) return 'Unknown';
  const str = String(jid).split('@')[0].replace(/[^0-9]/g, '');
  if (str.length <= 6) return '******';
  const prefixLen = options.prefixLength || 5;
  const suffixLen = options.suffixLength || 2;
  if (str.length <= prefixLen + suffixLen) return '******';
  return `${str.slice(0, prefixLen)}******${str.slice(-suffixLen)}`;
}

/**
 * Sanitizes absolute filesystem paths deterministically.
 * @param {string} str
 * @returns {string}
 */
export function sanitizePath(str) {
  if (typeof str !== 'string') return str;
  return str.replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const normalized = match.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return `[LOCAL_PATH]/${parts.slice(-2).join('/')}`;
    }
    return `[LOCAL_PATH]/${parts[parts.length - 1] || 'file'}`;
  });
}

/**
 * Deep freezes an object recursively.
 * @param {any} obj
 * @returns {any}
 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;

  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Canonicalizes and sanitizes raw data into an owned, safe, deep-frozen snapshot.
 * @param {any} input
 * @param {Object} [options]
 * @param {boolean} [options.privacyMasking=true]
 * @returns {any} Sanitized owned snapshot
 */
export function sanitizeData(input, options = {}) {
  const privacyMasking = options.privacyMasking !== false;
  const activeAncestors = new Set();

  function processValue(val, keyName = '') {
    if (val === null || val === undefined) {
      return val;
    }

    // 1. Mandatory Secret Redaction (Non-bypassable)
    if (keyName && SENSITIVE_KEY_PATTERN.test(keyName)) {
      return '[REDACTED_SECRET]';
    }

    // 2. Primitives
    const type = typeof val;
    if (type === 'boolean') return val;
    if (type === 'number') return Number.isFinite(val) ? val : String(val);
    if (type === 'bigint') return val.toString();
    if (type === 'string') {
      let cleaned = sanitizePath(val);
      if (cleaned.includes('@s.whatsapp.net') || /^\d{10,15}$/.test(cleaned)) {
        cleaned = privacyMasking ? maskJid(cleaned) : String(cleaned).split('@')[0];
      }
      return cleaned;
    }

    // Dropped types
    if (type === 'function' || type === 'symbol') {
      return undefined;
    }

    // 3. Object-based special instances
    if (type === 'object') {
      // Buffer / Uint8Array
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) {
        return { type: 'Buffer', lengthBytes: val.length };
      }
      if (val instanceof Uint8Array) {
        return { type: 'Uint8Array', lengthBytes: val.byteLength };
      }

      // Date
      if (val instanceof Date) {
        return Number.isNaN(val.getTime()) ? '[Invalid Date]' : val.toISOString();
      }

      // RegExp
      if (val instanceof RegExp) {
        return val.toString();
      }

      // Error
      if (val instanceof Error) {
        return {
          name: String(val.name || 'Error'),
          message: sanitizePath(String(val.message || '')),
          code: val.code ? String(val.code) : undefined
        };
      }

      // Dropped live stream/socket/promise/timer objects
      if (
        typeof val.then === 'function' ||
        typeof val.pipe === 'function' ||
        typeof val._destroy === 'function' ||
        val.constructor?.name === 'Socket' ||
        val.constructor?.name === 'Timeout' ||
        val.constructor?.name === 'Immediate'
      ) {
        return { className: val.constructor?.name || 'LiveObject' };
      }

      // Cycle Detection
      if (activeAncestors.has(val)) {
        return '[Circular]';
      }

      activeAncestors.add(val);

      try {
        // Array
        if (Array.isArray(val)) {
          const arrResult = [];
          for (let i = 0; i < val.length; i++) {
            let item;
            try {
              item = val[i];
            } catch (_) {
              item = '[Unserializable]';
            }
            const processed = processValue(item, '');
            arrResult.push(processed === undefined ? null : processed);
          }
          return arrResult;
        }

        // Plain / Custom Object
        const objResult = {};
        const keys = Object.keys(val);

        for (const k of keys) {
          let propVal;
          try {
            propVal = val[k];
          } catch (_) {
            propVal = '[Unserializable]';
          }

          const processed = processValue(propVal, k);
          if (processed !== undefined) {
            objResult[k] = processed;
          }
        }

        return objResult;
      } finally {
        activeAncestors.delete(val);
      }
    }

    return String(val);
  }

  const rawSnapshot = processValue(input, '');
  return deepFreeze(rawSnapshot);
}

export const PresentationSanitizer = Object.freeze({
  maskJid,
  sanitizePath,
  sanitizeData,
  deepFreeze
});
