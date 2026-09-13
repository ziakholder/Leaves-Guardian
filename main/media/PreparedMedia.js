import fs from 'fs';
import { Readable } from 'stream';
import { MediaError } from '../errors/LeavesError.js';
import { MEDIA_ERROR_CODES, MEDIA_REPRESENTATION } from './MediaConstants.js';
import { OutputManager } from './OutputManager.js';

/**
 * PreparedMedia is the authoritative single-active-representation holder for prepared media assets.
 */
export class PreparedMedia {
  /**
   * @param {Object} params
   * @param {string} params.representation - 'buffer' | 'stream' | 'file'
   * @param {Buffer} [params.buffer]
   * @param {string} [params.filePath]
   * @param {Readable} [params.stream]
   * @param {number} params.sizeBytes
   * @param {string} params.mimetype
   * @param {string} params.mediaType
   * @param {string} [params.filename]
   * @param {{ width?: number, height?: number }} [params.dimensions]
   * @param {number} [params.durationSeconds]
   * @param {Record<string, any>} [params.metadata]
   * @param {string} [params.jobId]
   * @param {string} [params.tempDir]
   * @param {number} [params.maxBufferLimit]
   */
  constructor(params) {
    this._representation = params.representation || MEDIA_REPRESENTATION.BUFFER;
    this._buffer = params.buffer || null;
    this._filePath = params.filePath || null;
    this._stream = params.stream || null;
    this.sizeBytes = params.sizeBytes || 0;
    this.mimetype = params.mimetype || 'application/octet-stream';
    this.mediaType = params.mediaType || 'document';
    this.filename = params.filename || '';
    this.dimensions = params.dimensions || undefined;
    this.durationSeconds = params.durationSeconds || undefined;
    this.metadata = params.metadata || {};
    this._jobId = params.jobId || null;
    this._tempDir = params.tempDir || null;
    this._maxBufferLimit = params.maxBufferLimit || (50 * 1024 * 1024); // default 50MB safe buffer conversion
    this._released = false;
  }

  /**
   * Active representation ('buffer' | 'stream' | 'file').
   * @returns {string}
   */
  get representation() {
    this._assertNotReleased();
    return this._representation;
  }

  /**
   * Returns media data as a Buffer.
   * @returns {Promise<Buffer>}
   */
  async getBuffer() {
    this._assertNotReleased();

    if (this._representation === MEDIA_REPRESENTATION.BUFFER && this._buffer) {
      return this._buffer;
    }

    if (this._representation === MEDIA_REPRESENTATION.FILE && this._filePath) {
      if (this.sizeBytes > this._maxBufferLimit) {
        throw new MediaError(
          `Cannot convert file of ${this.sizeBytes} bytes to Buffer (exceeds safe buffer limit of ${this._maxBufferLimit} bytes)`,
          MEDIA_ERROR_CODES.REPRESENTATION_UNAVAILABLE,
          { sizeBytes: this.sizeBytes, maxBufferLimit: this._maxBufferLimit }
        );
      }
      try {
        return await fs.promises.readFile(this._filePath);
      } catch (err) {
        throw new MediaError(`Failed reading backing media file: ${err.message}`, MEDIA_ERROR_CODES.REPRESENTATION_UNAVAILABLE, { cause: err });
      }
    }

    throw new MediaError(
      `Buffer representation is unavailable for active representation "${this._representation}"`,
      MEDIA_ERROR_CODES.REPRESENTATION_UNAVAILABLE
    );
  }

  /**
   * Returns media data as a Readable stream.
   * @returns {Promise<Readable>}
   */
  async getStream() {
    this._assertNotReleased();

    if (this._representation === MEDIA_REPRESENTATION.BUFFER && this._buffer) {
      return Readable.from(this._buffer);
    }

    if (this._representation === MEDIA_REPRESENTATION.FILE && this._filePath) {
      return fs.createReadStream(this._filePath);
    }

    if (this._representation === MEDIA_REPRESENTATION.STREAM && this._stream) {
      return this._stream;
    }

    throw new MediaError('Stream representation is unavailable', MEDIA_ERROR_CODES.REPRESENTATION_UNAVAILABLE);
  }

  /**
   * Returns backing file path if active representation is FILE, otherwise null.
   * @returns {Promise<string|null>}
   */
  async getFilePath() {
    this._assertNotReleased();
    if (this._representation === MEDIA_REPRESENTATION.FILE && this._filePath) {
      return this._filePath;
    }
    return null;
  }

  /**
   * Releases all owned resources and removes temporary file artifacts (idempotent).
   * @returns {Promise<void>}
   */
  async release() {
    if (this._released) return;
    this._released = true;

    if (this._filePath) {
      await OutputManager.removeFile(this._filePath);
      this._filePath = null;
    }

    if (this._jobId && this._tempDir) {
      await OutputManager.cleanJobDir(this._jobId, this._tempDir);
    }

    this._buffer = null;
    this._stream = null;
  }

  /**
   * Checks if resource has been released.
   * @private
   */
  _assertNotReleased() {
    if (this._released) {
      throw new MediaError(
        'Prepared media resource has already been released',
        MEDIA_ERROR_CODES.RESOURCE_RELEASED
      );
    }
  }
}
