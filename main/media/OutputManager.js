import fs from 'fs';
import path from 'path';
import { MediaError } from '../errors/LeavesError.js';
import { MEDIA_ERROR_CODES, MEDIA_REPRESENTATION } from './MediaConstants.js';

/**
 * OutputManager manages bounded buffering, auto-spill to disk, and temporary directory/artifact allocation.
 */
export class OutputManager {
  /**
   * Captures incoming readable stream into either in-memory Buffer or temporary file (Auto-Spill).
   * @param {import('stream').Readable} stream
   * @param {string} jobId
   * @param {Object} options
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ representation: string, buffer?: Buffer, filePath?: string, sizeBytes: number, initialChunk: Buffer }>}
   */
  static async captureStream(stream, jobId, options, signal) {
    if (signal && signal.aborted) {
      stream.destroy();
      throw new MediaError('Stream capture aborted', MEDIA_ERROR_CODES.PIPELINE_ABORTED);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let totalBytes = 0;
      const memoryChunks = [];
      let initialChunk = null;
      let isSpilled = false;
      let fileStream = null;
      let tempFilePath = null;
      let jobDir = null;

      const cleanupOnError = async () => {
        if (fileStream) {
          fileStream.destroy();
        }
        if (jobDir) {
          try {
            await OutputManager.cleanJobDir(jobId, options.tempDir);
          } catch {
            // ignore cleanup errors on failure
          }
        }
      };

      const fail = async (err) => {
        if (settled) return;
        settled = true;
        stream.destroy(err);
        await cleanupOnError();
        reject(err);
      };

      const onAbort = async () => {
        await fail(new MediaError('Stream capture aborted by signal', MEDIA_ERROR_CODES.PIPELINE_ABORTED));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      stream.on('error', async (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        await fail(err);
      });

      stream.on('data', (chunk) => {
        if (settled) return;

        totalBytes += chunk.length;

        // Check output byte limits
        if (totalBytes > options.maxOutputBytes) {
          if (signal) signal.removeEventListener('abort', onAbort);
          return fail(
            new MediaError(
              `Media stream exceeded maximum output size of ${options.maxOutputBytes} bytes`,
              MEDIA_ERROR_CODES.SIZE_EXCEEDED,
              { totalBytes, maxOutputBytes: options.maxOutputBytes }
            )
          );
        }

        // Capture initial chunk for sniffing (up to 64 bytes)
        if (!initialChunk) {
          initialChunk = chunk.subarray(0, 64);
        } else if (initialChunk.length < 64) {
          initialChunk = Buffer.concat([initialChunk, chunk]).subarray(0, 64);
        }

        // Check if spill is needed
        if (!isSpilled) {
          if (totalBytes > options.bufferThresholdBytes) {
            // Threshold crossed: Transition to disk file representation
            isSpilled = true;
            try {
              jobDir = OutputManager.getJobDir(jobId, options.tempDir);
              fs.mkdirSync(jobDir, { recursive: true });
              tempFilePath = path.join(jobDir, `media_${Date.now()}.bin`);
              fileStream = fs.createWriteStream(tempFilePath);

              fileStream.on('error', (err) => {
                fail(new MediaError(`Failed writing temporary media file: ${err.message}`, MEDIA_ERROR_CODES.TRANSFORM_FAILED, { cause: err }));
              });

              // Write all previously buffered chunks
              for (const buffered of memoryChunks) {
                fileStream.write(buffered);
              }
              memoryChunks.length = 0; // free memory array

              // Write current chunk
              fileStream.write(chunk);
            } catch (err) {
              return fail(new MediaError(`Failed to initialize spill to disk: ${err.message}`, MEDIA_ERROR_CODES.TRANSFORM_FAILED, { cause: err }));
            }
          } else {
            memoryChunks.push(chunk);
          }
        } else {
          // Already spilled to file
          if (fileStream) {
            const canContinue = fileStream.write(chunk);
            if (!canContinue) {
              stream.pause();
              fileStream.once('drain', () => {
                if (!settled) stream.resume();
              });
            }
          }
        }
      });

      stream.on('end', async () => {
        if (settled) return;
        if (signal) signal.removeEventListener('abort', onAbort);

        if (!initialChunk) {
          initialChunk = Buffer.alloc(0);
        }

        if (isSpilled) {
          if (fileStream) {
            fileStream.end(async () => {
              if (settled) return;
              settled = true;
              resolve({
                representation: MEDIA_REPRESENTATION.FILE,
                filePath: tempFilePath,
                sizeBytes: totalBytes,
                initialChunk
              });
            });
          }
        } else {
          settled = true;
          const finalBuffer = Buffer.concat(memoryChunks);
          resolve({
            representation: MEDIA_REPRESENTATION.BUFFER,
            buffer: finalBuffer,
            sizeBytes: totalBytes,
            initialChunk
          });
        }
      });
    });
  }

  /**
   * Returns job temporary directory path.
   * @param {string} jobId
   * @param {string} tempDir
   * @returns {string}
   */
  static getJobDir(jobId, tempDir) {
    return path.join(tempDir, `job_${jobId}`);
  }

  /**
   * Cleans up a job directory and all its files recursively.
   * @param {string} jobId
   * @param {string} tempDir
   * @returns {Promise<void>}
   */
  static async cleanJobDir(jobId, tempDir) {
    const targetDir = this.getJobDir(jobId, tempDir);
    try {
      if (fs.existsSync(targetDir)) {
        await fs.promises.rm(targetDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  /**
   * Removes a specific file safely.
   * @param {string} filePath
   * @returns {Promise<void>}
   */
  static async removeFile(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Cleans orphan job directories on pipeline destruction.
   * @param {string} tempDir
   * @returns {Promise<void>}
   */
  static async cleanOrphanDirs(tempDir) {
    try {
      if (!fs.existsSync(tempDir)) return;
      const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('job_')) {
          await fs.promises.rm(path.join(tempDir, entry.name), { recursive: true, force: true });
        }
      }
    } catch {
      // ignore
    }
  }
}
