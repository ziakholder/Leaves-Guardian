/**
 * Immutable DeduplicationResult value object representing an ingress deduplication evaluation result.
 */
export class DeduplicationResult {
  /**
   * @param {Object} params
   * @param {boolean} params.isDuplicate
   * @param {string} params.key
   * @param {number} params.firstSeenAt
   * @param {number} params.lastSeenAt
   * @param {number} params.seenCount
   * @param {number} params.expiresAt
   * @param {number} params.ttlRemainingMs
   */
  constructor(params) {
    this.isDuplicate = Boolean(params.isDuplicate);
    this.key = String(params.key);
    this.firstSeenAt = Number(params.firstSeenAt);
    this.lastSeenAt = Number(params.lastSeenAt);
    this.seenCount = Number(params.seenCount);
    this.expiresAt = Number(params.expiresAt);
    this.ttlRemainingMs = Number(params.ttlRemainingMs);
    Object.freeze(this);
  }

  toJSON() {
    return {
      isDuplicate: this.isDuplicate,
      key: this.key,
      firstSeenAt: this.firstSeenAt,
      lastSeenAt: this.lastSeenAt,
      seenCount: this.seenCount,
      expiresAt: this.expiresAt,
      ttlRemainingMs: this.ttlRemainingMs
    };
  }
}
