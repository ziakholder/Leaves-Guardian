import crypto from 'crypto';
import { MediaError } from '../errors/LeavesError.js';
import { MEDIA_ERROR_CODES, MEDIA_JOB_STATE, MEDIA_REPRESENTATION } from './MediaConstants.js';
import { SourceResolver } from './SourceResolver.js';
import { MimeDetector } from './MimeDetector.js';
import { OutputManager } from './OutputManager.js';
import { PreparedMedia } from './PreparedMedia.js';

/**
 * Valid state transitions table for MediaJob finite state machine.
 */
const ALLOWED_TRANSITIONS = {
  [MEDIA_JOB_STATE.PENDING]: [MEDIA_JOB_STATE.RESOLVING, MEDIA_JOB_STATE.CANCELLED, MEDIA_JOB_STATE.FAILED],
  [MEDIA_JOB_STATE.RESOLVING]: [MEDIA_JOB_STATE.DETECTING, MEDIA_JOB_STATE.CANCELLED, MEDIA_JOB_STATE.FAILED],
  [MEDIA_JOB_STATE.DETECTING]: [MEDIA_JOB_STATE.VALIDATING, MEDIA_JOB_STATE.CANCELLED, MEDIA_JOB_STATE.FAILED],
  [MEDIA_JOB_STATE.VALIDATING]: [MEDIA_JOB_STATE.TRANSFORMING, MEDIA_JOB_STATE.CANCELLED, MEDIA_JOB_STATE.FAILED],
  [MEDIA_JOB_STATE.TRANSFORMING]: [MEDIA_JOB_STATE.FINALIZING, MEDIA_JOB_STATE.CANCELLED, MEDIA_JOB_STATE.FAILED],
  [MEDIA_JOB_STATE.FINALIZING]: [MEDIA_JOB_STATE.COMPLETED, MEDIA_JOB_STATE.CANCELLED, MEDIA_JOB_STATE.FAILED],
  [MEDIA_JOB_STATE.COMPLETED]: [],
  [MEDIA_JOB_STATE.FAILED]: [],
  [MEDIA_JOB_STATE.CANCELLED]: []
};

/**
 * MediaJob manages single media preparation lifecycle through a deterministic FSM.
 */
export class MediaJob {
  /**
   * @param {Object} params
   * @param {Buffer|Readable|string} params.source
   * @param {Object} params.options
   * @param {import('./TransformerRegistry.js').TransformerRegistry} params.transformerRegistry
   * @param {AbortSignal} [params.signal]
   */
  constructor(params) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.source = params.source;
    this.options = params.options;
    this.transformerRegistry = params.transformerRegistry;
    this.signal = params.signal || null;

    this.state = MEDIA_JOB_STATE.PENDING;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.result = null;

    this._terminal = false;
  }

  /**
   * Transitions state machine to next state.
   * @param {string} nextState
   * @private
   */
  _transition(nextState) {
    if (this._terminal) {
      return; // Terminal state is permanent (exactly once)
    }

    const validNextStates = ALLOWED_TRANSITIONS[this.state] || [];
    if (!validNextStates.includes(nextState)) {
      throw new MediaError(
        `Invalid state transition: Cannot transition from ${this.state} to ${nextState}`,
        MEDIA_ERROR_CODES.TRANSFORM_FAILED
      );
    }

    this.state = nextState;

    if (
      nextState === MEDIA_JOB_STATE.COMPLETED ||
      nextState === MEDIA_JOB_STATE.FAILED ||
      nextState === MEDIA_JOB_STATE.CANCELLED
    ) {
      this._terminal = true;
      this.finishedAt = Date.now();
    }
  }

  /**
   * Executes the media processing workflow.
   * @returns {Promise<PreparedMedia>}
   */
  async run() {
    this.startedAt = Date.now();

    try {
      if (this.signal && this.signal.aborted) {
        throw new MediaError('Media processing cancelled by signal', MEDIA_ERROR_CODES.PIPELINE_ABORTED);
      }

      // 1. RESOLVING
      this._transition(MEDIA_JOB_STATE.RESOLVING);
      const resolution = await SourceResolver.resolve(this.source, this.options, this.signal);

      // 2. DETECTING (initial sniffing if chunk available)
      this._transition(MEDIA_JOB_STATE.DETECTING);
      let detectedMime = null;
      if (resolution.initialChunk && resolution.initialChunk.length > 0) {
        detectedMime = MimeDetector.detect(resolution.initialChunk, resolution.filenameHint);
      }

      // 3. VALIDATING
      this._transition(MEDIA_JOB_STATE.VALIDATING);
      if (resolution.estimatedSize && resolution.estimatedSize > this.options.maxInputBytes) {
        throw new MediaError(
          `Media estimated size (${resolution.estimatedSize} bytes) exceeds limit of ${this.options.maxInputBytes} bytes`,
          MEDIA_ERROR_CODES.SIZE_EXCEEDED
        );
      }

      // 4. TRANSFORMING (Streaming, Auto-Spill & Transformer execution)
      this._transition(MEDIA_JOB_STATE.TRANSFORMING);
      let captured = await OutputManager.captureStream(
        resolution.stream,
        this.id,
        this.options,
        this.signal
      );

      // Sniff MIME if not detected earlier
      if (!detectedMime || detectedMime.unknown) {
        detectedMime = MimeDetector.detect(captured.initialChunk, resolution.filenameHint);
      }

      // Apply transformers if transform options are requested
      if (this.options.transform && Object.keys(this.options.transform).length > 0) {
        const transformed = await this.transformerRegistry.execute(
          captured,
          detectedMime,
          this.options.transform,
          {
            signal: this.signal,
            tempDir: this.options.tempDir,
            jobId: this.id
          }
        );

        if (transformed.buffer) {
          captured = {
            representation: MEDIA_REPRESENTATION.BUFFER,
            buffer: transformed.buffer,
            sizeBytes: transformed.buffer.length,
            initialChunk: transformed.buffer.subarray(0, 64)
          };
          detectedMime = MimeDetector.detect(captured.initialChunk, resolution.filenameHint);
        } else if (transformed.filePath) {
          const fs = await import('fs');
          const stat = await fs.promises.stat(transformed.filePath);
          captured = {
            representation: MEDIA_REPRESENTATION.FILE,
            filePath: transformed.filePath,
            sizeBytes: stat.size,
            initialChunk: captured.initialChunk
          };
        }
      }

      // 5. FINALIZING
      this._transition(MEDIA_JOB_STATE.FINALIZING);
      const filename = this.options.filename || (resolution.filenameHint ? resolution.filenameHint.split(/[/\\]/).pop() : `media_${Date.now()}.${detectedMime.extension}`);

      const preparedMedia = new PreparedMedia({
        representation: captured.representation,
        buffer: captured.buffer,
        filePath: captured.filePath,
        sizeBytes: captured.sizeBytes,
        mimetype: this.options.mimetype || detectedMime.mimetype,
        mediaType: this.options.mediaType || detectedMime.mediaType,
        filename,
        metadata: this.options.metadata || {},
        jobId: this.id,
        tempDir: this.options.tempDir
      });

      // 6. COMPLETED (Ownership transferred to PreparedMedia)
      this._transition(MEDIA_JOB_STATE.COMPLETED);
      this.result = preparedMedia;
      return preparedMedia;
    } catch (err) {
      let finalError = err;
      if (!(finalError instanceof MediaError)) {
        finalError = new MediaError(`Media processing failed: ${err.message}`, MEDIA_ERROR_CODES.TRANSFORM_FAILED, { cause: err });
      }

      const isAborted =
        (this.signal && this.signal.aborted) ||
        finalError.code === MEDIA_ERROR_CODES.PIPELINE_ABORTED;

      if (isAborted) {
        this._transition(MEDIA_JOB_STATE.CANCELLED);
      } else {
        this._transition(MEDIA_JOB_STATE.FAILED);
      }

      this.error = finalError;

      // Immediate cleanup of temporary directory on failure/cancellation
      try {
        await OutputManager.cleanJobDir(this.id, this.options.tempDir);
      } catch {
        // ignore cleanup error
      }

      throw finalError;
    }
  }
}
