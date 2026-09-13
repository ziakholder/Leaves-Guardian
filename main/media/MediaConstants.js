import os from 'os';
import path from 'path';

/**
 * Frozen Media Error Codes (Contract Baseline v1)
 */
export const MEDIA_ERROR_CODES = Object.freeze({
  INVALID_SOURCE: 'MEDIA_INVALID_SOURCE',
  SIZE_EXCEEDED: 'MEDIA_SIZE_EXCEEDED',
  UNSUPPORTED_TYPE: 'MEDIA_UNSUPPORTED_TYPE',
  FETCH_FAILED: 'MEDIA_FETCH_FAILED',
  FETCH_TIMEOUT: 'MEDIA_FETCH_TIMEOUT',
  SSRF_BLOCKED: 'MEDIA_SSRF_BLOCKED',
  REDIRECT_LIMIT: 'MEDIA_REDIRECT_LIMIT',
  TRANSFORM_FAILED: 'MEDIA_TRANSFORM_FAILED',
  QUEUE_FULL: 'MEDIA_QUEUE_FULL',
  PIPELINE_ABORTED: 'MEDIA_PIPELINE_ABORTED',
  REPRESENTATION_UNAVAILABLE: 'MEDIA_REPRESENTATION_UNAVAILABLE',
  RESOURCE_RELEASED: 'MEDIA_RESOURCE_RELEASED'
});

/**
 * MediaJob Finite State Machine States (Contract Baseline v1)
 */
export const MEDIA_JOB_STATE = Object.freeze({
  PENDING: 'PENDING',
  RESOLVING: 'RESOLVING',
  DETECTING: 'DETECTING',
  VALIDATING: 'VALIDATING',
  TRANSFORMING: 'TRANSFORMING',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

/**
 * Single Active Representation Types
 */
export const MEDIA_REPRESENTATION = Object.freeze({
  BUFFER: 'buffer',
  STREAM: 'stream',
  FILE: 'file'
});

/**
 * Media Type Categories
 */
export const MEDIA_TYPE = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  STICKER: 'sticker'
});

/**
 * Default Media Pipeline Configuration
 */
export const DEFAULT_MEDIA_OPTIONS = Object.freeze({
  maxInputBytes: 100 * 1024 * 1024,      // 100 MB
  maxOutputBytes: 100 * 1024 * 1024,     // 100 MB
  bufferThresholdBytes: 10 * 1024 * 1024, // 10 MB
  fetchTimeoutMs: 30000,                  // 30 seconds
  maxRedirects: 5,
  tempDir: path.join(os.tmpdir(), 'leaves-media'),
  maxConcurrentJobs: 3,
  maxWaitingJobs: 50,
  allowPrivateIp: false
});

/**
 * Validates and merges user options with defaults.
 * @param {Object} [options]
 * @returns {Object} Validated options
 */
export function validateMediaOptions(options = {}) {
  const merged = { ...DEFAULT_MEDIA_OPTIONS, ...options };

  if (typeof merged.maxInputBytes !== 'number' || merged.maxInputBytes <= 0) {
    throw new TypeError('maxInputBytes must be a positive number');
  }
  if (typeof merged.maxOutputBytes !== 'number' || merged.maxOutputBytes <= 0) {
    throw new TypeError('maxOutputBytes must be a positive number');
  }
  if (typeof merged.bufferThresholdBytes !== 'number' || merged.bufferThresholdBytes <= 0) {
    throw new TypeError('bufferThresholdBytes must be a positive number');
  }
  if (typeof merged.fetchTimeoutMs !== 'number' || merged.fetchTimeoutMs <= 0) {
    throw new TypeError('fetchTimeoutMs must be a positive number');
  }
  if (typeof merged.maxRedirects !== 'number' || merged.maxRedirects < 0) {
    throw new TypeError('maxRedirects must be a non-negative integer');
  }
  if (typeof merged.tempDir !== 'string' || !merged.tempDir.trim()) {
    throw new TypeError('tempDir must be a non-empty string');
  }
  if (typeof merged.maxConcurrentJobs !== 'number' || merged.maxConcurrentJobs <= 0) {
    throw new TypeError('maxConcurrentJobs must be a positive integer');
  }
  if (typeof merged.maxWaitingJobs !== 'number' || merged.maxWaitingJobs < 0) {
    throw new TypeError('maxWaitingJobs must be a non-negative integer');
  }
  if (typeof merged.allowPrivateIp !== 'boolean') {
    throw new TypeError('allowPrivateIp must be a boolean');
  }

  return merged;
}
