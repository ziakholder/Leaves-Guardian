/**
 * Immutable RateLimitDecision value object representing an ingress rate limit evaluation result.
 */
export class RateLimitDecision {
  /**
   * @param {Object} params
   * @param {boolean} params.allowed
   * @param {string} params.key
   * @param {number} params.currentCount
   * @param {number} params.limit
   * @param {number} params.remaining
   * @param {number} params.resetMs
   * @param {number} params.retryAfterMs
   * @param {boolean} params.isPenalty
   */
  constructor(params) {
    this.allowed = Boolean(params.allowed);
    this.key = String(params.key);
    this.currentCount = Number(params.currentCount);
    this.limit = Number(params.limit);
    this.remaining = Number(params.remaining);
    this.resetMs = Number(params.resetMs);
    this.retryAfterMs = Number(params.retryAfterMs);
    this.isPenalty = Boolean(params.isPenalty);
    Object.freeze(this);
  }

  toJSON() {
    return {
      allowed: this.allowed,
      key: this.key,
      currentCount: this.currentCount,
      limit: this.limit,
      remaining: this.remaining,
      resetMs: this.resetMs,
      retryAfterMs: this.retryAfterMs,
      isPenalty: this.isPenalty
    };
  }
}
