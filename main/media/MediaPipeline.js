import { MediaError } from '../errors/LeavesError.js';
import {
  DEFAULT_MEDIA_OPTIONS,
  MEDIA_ERROR_CODES,
  validateMediaOptions
} from './MediaConstants.js';
import { TransformerRegistry } from './TransformerRegistry.js';
import { MediaJob } from './MediaJob.js';
import { OutputManager } from './OutputManager.js';

/**
 * MediaPipeline is the central media preparation, inspection, validation, and transformation engine.
 */
export class MediaPipeline {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    this.options = validateMediaOptions(options);
    this.transformerRegistry = new TransformerRegistry();

    this._activeJobs = 0;
    this._waitingQueue = [];
    this._activeJobControllers = new Map(); // jobId -> AbortController

    this._totalProcessed = 0;
    this._totalFailed = 0;
    this._destroyed = false;
  }

  /**
   * Registers a pluggable media transformer.
   * @param {Object} transformer
   */
  registerTransformer(transformer) {
    this.transformerRegistry.register(transformer);
  }

  /**
   * Prepares, inspects, validates, and transforms a media source into a PreparedMedia instance.
   * @param {Buffer|import('stream').Readable|string} source
   * @param {Object} [options]
   * @returns {Promise<import('./PreparedMedia.js').PreparedMedia>}
   */
  async prepare(source, options = {}) {
    if (this._destroyed) {
      throw new MediaError('MediaPipeline has been destroyed', MEDIA_ERROR_CODES.PIPELINE_ABORTED);
    }

    const mergedOptions = { ...this.options, ...options };
    const abortController = new AbortController();

    // Link caller signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        throw new MediaError('Media preparation cancelled by signal', MEDIA_ERROR_CODES.PIPELINE_ABORTED);
      }
      options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const job = new MediaJob({
      source,
      options: mergedOptions,
      transformerRegistry: this.transformerRegistry,
      signal: abortController.signal
    });

    // Concurrency & Admission Gate (PENDING Queue Capacity)
    if (this._activeJobs >= this.options.maxConcurrentJobs) {
      if (this._waitingQueue.length >= this.options.maxWaitingJobs) {
        throw new MediaError(
          `MediaPipeline waiting queue is full (${this._waitingQueue.length}/${this.options.maxWaitingJobs} jobs waiting)`,
          MEDIA_ERROR_CODES.QUEUE_FULL,
          { waitingJobs: this._waitingQueue.length, maxWaitingJobs: this.options.maxWaitingJobs }
        );
      }

      return new Promise((resolve, reject) => {
        this._waitingQueue.push({
          job,
          abortController,
          resolve,
          reject
        });
      });
    }

    return this._executeJob(job, abortController);
  }

  /**
   * Executes a job and schedules the next waiting job upon completion.
   * @param {MediaJob} job
   * @param {AbortController} abortController
   * @returns {Promise<import('./PreparedMedia.js').PreparedMedia>}
   * @private
   */
  async _executeJob(job, abortController) {
    this._activeJobs++;
    this._activeJobControllers.set(job.id, abortController);

    try {
      const result = await job.run();
      this._totalProcessed++;
      return result;
    } catch (err) {
      this._totalFailed++;
      throw err;
    } finally {
      this._activeJobs--;
      this._activeJobControllers.delete(job.id);
      this._drainNext();
    }
  }

  /**
   * Drains next pending job from FIFO queue.
   * @private
   */
  _drainNext() {
    if (this._destroyed) return;
    if (this._waitingQueue.length === 0) return;
    if (this._activeJobs >= this.options.maxConcurrentJobs) return;

    const next = this._waitingQueue.shift();
    if (!next) return;

    this._executeJob(next.job, next.abortController)
      .then(next.resolve)
      .catch(next.reject);
  }

  /**
   * Returns current concurrency and metrics status.
   * @returns {{ activeJobs: number, waitingJobs: number, totalProcessed: number, totalFailed: number, isDestroyed: boolean }}
   */
  getStatus() {
    return {
      activeJobs: this._activeJobs,
      waitingJobs: this._waitingQueue.length,
      totalProcessed: this._totalProcessed,
      totalFailed: this._totalFailed,
      isDestroyed: this._destroyed
    };
  }

  /**
   * Destroys pipeline, cancels waiting/in-flight jobs, and cleans orphan directories.
   * Preserves files owned by COMPLETED PreparedMedia.
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // 1. Cancel all waiting PENDING jobs
    while (this._waitingQueue.length > 0) {
      const item = this._waitingQueue.shift();
      if (item) {
        item.abortController.abort();
        item.reject(new MediaError('MediaPipeline was destroyed', MEDIA_ERROR_CODES.PIPELINE_ABORTED));
      }
    }

    // 2. Abort all active in-flight jobs
    for (const controller of this._activeJobControllers.values()) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    this._activeJobControllers.clear();
  }
}
