import fs from 'fs';
import http from 'http';
import https from 'https';
import dns from 'dns';
import { URL } from 'url';
import { Readable, Transform } from 'stream';
import { MediaError } from '../errors/LeavesError.js';
import { MEDIA_ERROR_CODES } from './MediaConstants.js';

/**
 * Checks if an IP address string belongs to private, loopback, or reserved ranges.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;

  // Handle IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // IPv6 checks
  if (ip.includes(':')) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7
    if (normalized.startsWith('fe80') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true; // fe80::/10
    if (normalized.startsWith('ff')) return true; // multicast
    return false;
  }

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return true; // invalid IP is considered unsafe
  }

  const [a, b] = parts;

  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (carrier NAT)
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;    // Benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true;  // TEST-NET-3
  if (a >= 224) return true;                          // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved)

  return false;
}

/**
 * Validates the network destination of a URL via DNS resolution (SSRF guard).
 * @param {string} urlString
 * @param {boolean} allowPrivateIp
 * @returns {Promise<void>}
 */
export async function validateSsrfDestination(urlString, allowPrivateIp = false) {
  if (allowPrivateIp) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new MediaError(`Invalid URL: "${urlString}"`, MEDIA_ERROR_CODES.INVALID_SOURCE);
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets if any

  // Direct IP check
  if (netIsIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new MediaError(
        `Destination IP "${hostname}" is blocked (SSRF Protection)`,
        MEDIA_ERROR_CODES.SSRF_BLOCKED,
        { hostname, ip: hostname }
      );
    }
    return;
  }

  // DNS resolution & verification
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      throw new MediaError(`DNS lookup returned no addresses for "${hostname}"`, MEDIA_ERROR_CODES.FETCH_FAILED);
    }

    for (const record of addresses) {
      if (isPrivateOrReservedIp(record.address)) {
        throw new MediaError(
          `Resolved destination IP "${record.address}" for host "${hostname}" is blocked (SSRF Protection)`,
          MEDIA_ERROR_CODES.SSRF_BLOCKED,
          { hostname, ip: record.address }
        );
      }
    }
  } catch (err) {
    if (err instanceof MediaError) throw err;
    throw new MediaError(`DNS resolution failed for "${hostname}": ${err.message}`, MEDIA_ERROR_CODES.FETCH_FAILED, { cause: err });
  }
}

function netIsIP(input) {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(input)) return 4;
  if (/^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$/.test(input) || input.includes(':')) return 6;
  return 0;
}

/**
 * Creates a stream Transform that counts bytes and enforces maximum limit in real-time.
 * @param {number} maxBytes
 * @param {Function} onExceeded
 * @returns {Transform}
 */
export function createProgressiveByteLimiter(maxBytes, onExceeded) {
  let bytesRead = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        const err = new MediaError(
          `Input media exceeds maximum allowed size of ${maxBytes} bytes`,
          MEDIA_ERROR_CODES.SIZE_EXCEEDED,
          { bytesRead, maxBytes }
        );
        if (typeof onExceeded === 'function') {
          onExceeded(err);
        }
        return callback(err);
      }
      callback(null, chunk);
    }
  });
}

/**
 * Source Resolver class responsible for acquiring raw bytes from diverse input sources.
 */
export class SourceResolver {
  /**
   * Resolves raw source into a readable stream with metadata and progressive byte limiting.
   * @param {Buffer|Readable|string} source
   * @param {Object} options
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ stream: Readable, filenameHint: string, estimatedSize?: number, initialChunk?: Buffer }>}
   */
  static async resolve(source, options, signal) {
    if (signal && signal.aborted) {
      throw new MediaError('Media resolution aborted by caller', MEDIA_ERROR_CODES.PIPELINE_ABORTED);
    }

    // 1. Buffer Source
    if (Buffer.isBuffer(source)) {
      if (source.length > options.maxInputBytes) {
        throw new MediaError(
          `Input Buffer size (${source.length} bytes) exceeds limit of ${options.maxInputBytes} bytes`,
          MEDIA_ERROR_CODES.SIZE_EXCEEDED,
          { size: source.length, maxInputBytes: options.maxInputBytes }
        );
      }
      return {
        stream: Readable.from(source),
        filenameHint: '',
        estimatedSize: source.length,
        initialChunk: source.subarray(0, 64)
      };
    }

    // 2. Readable Stream Source
    if (source && typeof source.pipe === 'function' && typeof source.on === 'function') {
      const limiter = createProgressiveByteLimiter(options.maxInputBytes, (err) => {
        source.destroy(err);
      });

      // Prevent unhandled error event on source stream when destroyed
      source.on('error', () => {});

      if (signal) {
        const onAbort = () => {
          source.destroy(new MediaError('Stream aborted', MEDIA_ERROR_CODES.PIPELINE_ABORTED));
          limiter.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        limiter.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      const pipedStream = source.pipe(limiter);
      return {
        stream: pipedStream,
        filenameHint: ''
      };
    }

    // 3. String Source (URL or Local File Path)
    if (typeof source === 'string' && source.trim().length > 0) {
      const trimmed = source.trim();

      // HTTP / HTTPS URL
      if (/^https?:\/\//i.test(trimmed)) {
        return this.fetchUrl(trimmed, options, signal);
      }

      // Local File Path
      let stats;
      try {
        stats = await fs.promises.stat(trimmed);
      } catch (err) {
        throw new MediaError(
          `Local file not found or inaccessible: "${trimmed}"`,
          MEDIA_ERROR_CODES.INVALID_SOURCE,
          { path: trimmed, cause: err }
        );
      }

      if (!stats.isFile()) {
        throw new MediaError(`Path is not a regular file: "${trimmed}"`, MEDIA_ERROR_CODES.INVALID_SOURCE, { path: trimmed });
      }

      if (stats.size > options.maxInputBytes) {
        throw new MediaError(
          `File size (${stats.size} bytes) exceeds maximum input limit of ${options.maxInputBytes} bytes`,
          MEDIA_ERROR_CODES.SIZE_EXCEEDED,
          { size: stats.size, maxInputBytes: options.maxInputBytes }
        );
      }

      const fileStream = fs.createReadStream(trimmed);
      if (signal) {
        const onAbort = () => fileStream.destroy(new MediaError('File read aborted', MEDIA_ERROR_CODES.PIPELINE_ABORTED));
        signal.addEventListener('abort', onAbort, { once: true });
        fileStream.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      return {
        stream: fileStream,
        filenameHint: trimmed,
        estimatedSize: stats.size
      };
    }

    throw new MediaError(
      'Invalid media source: must be a Buffer, Readable stream, valid file path, or HTTP/HTTPS URL',
      MEDIA_ERROR_CODES.INVALID_SOURCE
    );
  }

  /**
   * Fetches URL with SSRF destination validation, redirect loop control, and timeouts.
   * @param {string} initialUrl
   * @param {Object} options
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ stream: Readable, filenameHint: string, estimatedSize?: number }>}
   */
  static async fetchUrl(initialUrl, options, signal) {
    let currentUrl = initialUrl;
    let redirectCount = 0;

    while (redirectCount <= options.maxRedirects) {
      if (signal && signal.aborted) {
        throw new MediaError('URL fetch aborted', MEDIA_ERROR_CODES.PIPELINE_ABORTED);
      }

      // SSRF validation with DNS re-resolution before connection
      await validateSsrfDestination(currentUrl, options.allowPrivateIp);

      const parsed = new URL(currentUrl);
      const transport = parsed.protocol === 'https:' ? https : http;

      const response = await new Promise((resolve, reject) => {
        let timer = null;
        let aborted = false;

        const req = transport.get(
          currentUrl,
          {
            timeout: options.fetchTimeoutMs,
            headers: {
              'User-Agent': 'Leaves-Guardian-MediaPipeline/1.0'
            }
          },
          (res) => {
            if (timer) clearTimeout(timer);
            resolve(res);
          }
        );

        if (options.fetchTimeoutMs > 0) {
          timer = setTimeout(() => {
            aborted = true;
            req.destroy();
            reject(
              new MediaError(
                `Fetch timeout after ${options.fetchTimeoutMs}ms for "${currentUrl}"`,
                MEDIA_ERROR_CODES.FETCH_TIMEOUT,
                { url: currentUrl, timeoutMs: options.fetchTimeoutMs }
              )
            );
          }, options.fetchTimeoutMs);
        }

        if (signal) {
          const onAbort = () => {
            if (timer) clearTimeout(timer);
            aborted = true;
            req.destroy();
            reject(new MediaError('URL fetch aborted by signal', MEDIA_ERROR_CODES.PIPELINE_ABORTED));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          req.on('close', () => signal.removeEventListener('abort', onAbort));
        }

        req.on('error', (err) => {
          if (timer) clearTimeout(timer);
          if (aborted) return;
          reject(new MediaError(`HTTP request failed: ${err.message}`, MEDIA_ERROR_CODES.FETCH_FAILED, { cause: err, url: currentUrl }));
        });
      });

      const statusCode = response.statusCode || 200;

      // Redirect Handling (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        redirectCount++;
        if (redirectCount > options.maxRedirects) {
          response.destroy();
          throw new MediaError(
            `Maximum redirect limit (${options.maxRedirects}) exceeded`,
            MEDIA_ERROR_CODES.REDIRECT_LIMIT,
            { maxRedirects: options.maxRedirects, url: initialUrl }
          );
        }

        // Resolve relative redirect against currentUrl
        const nextUrl = new URL(response.headers.location, currentUrl).toString();
        response.resume(); // drain response
        currentUrl = nextUrl;
        continue;
      }

      // Check HTTP Status
      if (statusCode < 200 || statusCode >= 300) {
        response.destroy();
        throw new MediaError(
          `HTTP request failed with status code ${statusCode}`,
          MEDIA_ERROR_CODES.FETCH_FAILED,
          { statusCode, url: currentUrl }
        );
      }

      // Check Content-Length if present
      const contentLengthHeader = response.headers['content-length'];
      const estimatedSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
      if (estimatedSize && estimatedSize > options.maxInputBytes) {
        response.destroy();
        throw new MediaError(
          `Remote resource size (${estimatedSize} bytes) exceeds limit of ${options.maxInputBytes} bytes`,
          MEDIA_ERROR_CODES.SIZE_EXCEEDED,
          { estimatedSize, maxInputBytes: options.maxInputBytes }
        );
      }

      const limiter = createProgressiveByteLimiter(options.maxInputBytes, (err) => {
        response.destroy(err);
      });

      const piped = response.pipe(limiter);

      return {
        stream: piped,
        filenameHint: parsed.pathname,
        estimatedSize
      };
    }

    throw new MediaError(`Maximum redirect limit (${options.maxRedirects}) exceeded`, MEDIA_ERROR_CODES.REDIRECT_LIMIT);
  }
}
