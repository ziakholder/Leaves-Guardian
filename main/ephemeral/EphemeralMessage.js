import BaseBuilder from '../models/base-builder.js';
import { LeavesValidationError, EphemeralError } from '../errors/LeavesError.js';

export const EPHEMERAL_DURATIONS = Object.freeze({
  ONE_DAY: 86400,          // 24 Hours (24 * 3600)
  ONE_WEEK: 604800,        // 7 Days (7 * 24 * 3600) -> Leaves Guardian Default
  THREE_MONTHS: 7776000,   // 90 Days (90 * 24 * 3600)
  DISABLED: 0              // Turn off ephemeral
});

export const DEFAULT_EPHEMERAL_DURATION = EPHEMERAL_DURATIONS.ONE_WEEK;

const KNOWN_MESSAGE_PROPERTIES = Object.freeze(new Set([
  'text',
  'caption',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'poll',
  'contacts',
  'location',
  'viewOnce',
  'mentions',
  'react',
  'buttons',
  'templateButtons',
  'interactiveMessage',
  'listMessage',
  'forward',
  'contextInfo'
]));

/**
 * EphemeralMessage — Native WhatsApp Disappearing & Ephemeral Message Builder/Wrapper (Layer 4.4).
 * Provides stateless outbound message building and wrapping for WhatsApp native ephemeral protocols.
 * Zero Node.js timers, zero message deletion/revocation.
 */
export class EphemeralMessage extends BaseBuilder {
  #client = null;
  #expiration = DEFAULT_EPHEMERAL_DURATION;
  #wrappedContent = null;

  /**
   * @param {import('../client/LeavesClient.js').LeavesClient|any} [client]
   * @param {Object} [options={}]
   * @param {number} [options.expiration=604800]
   * @param {any} [options.content]
   */
  constructor(client, options = {}) {
    super();
    if (client) {
      this.#client = client;
    }

    if (options.expiration !== undefined) {
      this.setExpiration(options.expiration);
    } else {
      this.#expiration = DEFAULT_EPHEMERAL_DURATION;
    }

    if (options.content !== undefined) {
      this.setContent(options.content);
    }
  }

  get client() {
    return this.#client;
  }

  get expiration() {
    return this.#expiration;
  }

  /**
   * Validates that expiration is a finite, non-negative integer.
   * @param {any} seconds
   * @returns {number}
   */
  static validateExpiration(seconds) {
    if (
      typeof seconds !== 'number' ||
      !Number.isInteger(seconds) ||
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      throw new LeavesValidationError(
        `Invalid ephemeral expiration: must be a non-negative integer in seconds (received: ${seconds})`,
        'EPHEMERAL_INVALID_EXPIRATION',
        { expiration: seconds }
      );
    }
    return seconds;
  }

  /**
   * Set ephemeral expiration in seconds.
   * @param {number} seconds
   * @returns {this}
   */
  setExpiration(seconds) {
    this.#expiration = EphemeralMessage.validateExpiration(seconds);
    return this;
  }

  /**
   * Set wrapped builder or content payload.
   * @param {any} contentOrBuilder
   * @returns {this}
   */
  setContent(contentOrBuilder) {
    EphemeralMessage.validateAndResolveContent(contentOrBuilder);
    this.#wrappedContent = contentOrBuilder;
    return this;
  }

  /**
   * Validates and resolves raw or builder content to a valid WhatsApp message object or builder.
   * @param {any} contentOrBuilder
   * @returns {Object}
   */
  static validateAndResolveContent(contentOrBuilder) {
    if (contentOrBuilder === null || contentOrBuilder === undefined) {
      throw new LeavesValidationError(
        'EphemeralMessage content or builder cannot be null or undefined',
        'EPHEMERAL_INVALID_CONTENT'
      );
    }

    // 1. Non-empty string
    if (typeof contentOrBuilder === 'string') {
      const trimmed = contentOrBuilder.trim();
      if (!trimmed) {
        throw new LeavesValidationError(
          'EphemeralMessage text content cannot be empty',
          'EPHEMERAL_INVALID_CONTENT'
        );
      }
      return { text: contentOrBuilder };
    }

    // 2. Object or Builder instance
    if (typeof contentOrBuilder === 'object') {
      // If it's a builder instance (with build or send method)
      if (typeof contentOrBuilder.build === 'function' || typeof contentOrBuilder.send === 'function') {
        return contentOrBuilder;
      }
      if (typeof contentOrBuilder.buildPayload === 'function') {
        return contentOrBuilder;
      }

      // Check if it is a plain object with recognized message properties
      const keys = Object.keys(contentOrBuilder);
      if (keys.length === 0) {
        throw new LeavesValidationError(
          'EphemeralMessage plain object content cannot be empty',
          'EPHEMERAL_INVALID_CONTENT'
        );
      }

      const hasRecognizedProp = keys.some(
        (k) => KNOWN_MESSAGE_PROPERTIES.has(k) || k.endsWith('Message')
      );
      if (!hasRecognizedProp) {
        throw new LeavesValidationError(
          `EphemeralMessage content does not contain any recognizable message fields: [${keys.join(', ')}]`,
          'EPHEMERAL_INVALID_CONTENT'
        );
      }

      return contentOrBuilder;
    }

    throw new LeavesValidationError(
      `Unsupported EphemeralMessage content type: ${typeof contentOrBuilder}`,
      'EPHEMERAL_INVALID_CONTENT'
    );
  }

  /**
   * Build message payload for sending.
   * @returns {Promise<Object>|Object}
   */
  build() {
    if (this.#wrappedContent) {
      if (typeof this.#wrappedContent.build === 'function') {
        const built = this.#wrappedContent.build();
        if (built && typeof built.then === 'function') {
          return built.then((res) => EphemeralMessage.validateAndResolveContent(res));
        }
        return EphemeralMessage.validateAndResolveContent(built);
      }
      if (typeof this.#wrappedContent.buildPayload === 'function') {
        const built = this.#wrappedContent.buildPayload();
        if (built && typeof built.then === 'function') {
          return built.then((res) => EphemeralMessage.validateAndResolveContent(res));
        }
        return EphemeralMessage.validateAndResolveContent(built);
      }
      return EphemeralMessage.validateAndResolveContent(this.#wrappedContent);
    }

    const { body } = this._renderAll();
    if (!body || !body.trim()) {
      throw new LeavesValidationError(
        'Body content is required before sending EphemeralMessage (use .setBody() or .setContent())',
        'EPHEMERAL_INVALID_CONTENT'
      );
    }

    const ctx = this._buildContextInfo();
    return {
      text: body,
      mentions: this._mentions.length > 0 ? this._mentions : undefined,
      contextInfo: Object.keys(ctx).length > 0 ? ctx : undefined
    };
  }

  /**
   * Send ephemeral message to target JID.
   * @param {string} jid
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async send(jid, options = {}) {
    if (!jid || typeof jid !== 'string') {
      throw new LeavesValidationError('Target jid string is required to send EphemeralMessage', 'INVALID_TARGET');
    }

    const client = this.#client || options.client;
    const sendOptions = { ...options };

    // Set ephemeral expiration option when > 0
    if (this.#expiration > 0) {
      sendOptions.ephemeralExpiration = this.#expiration;
    }

    if (this._quotedMessage) {
      sendOptions.quoted = this._quotedMessage;
    }

    // If wrapped content has its own send() method (e.g. ButtonMessage, ListMessage)
    if (this.#wrappedContent && typeof this.#wrappedContent.send === 'function') {
      return await this.#wrappedContent.send(jid, sendOptions);
    }

    if (!client || typeof client.sendMessage !== 'function') {
      throw new EphemeralError('LeavesClient instance with sendMessage() is required to send EphemeralMessage');
    }

    const payload = await this.build();
    return await client.sendMessage(jid, payload, sendOptions);
  }

  /**
   * Static factory helper to wrap any builder or content as an EphemeralMessage.
   * @param {any} builderOrContent
   * @param {Object} [options={}]
   * @param {number} [options.expiration=604800]
   * @param {any} [options.client]
   * @returns {EphemeralMessage}
   */
  static wrap(builderOrContent, options = {}) {
    const expiration = options.expiration !== undefined ? options.expiration : DEFAULT_EPHEMERAL_DURATION;
    EphemeralMessage.validateExpiration(expiration);
    EphemeralMessage.validateAndResolveContent(builderOrContent);

    const client = options.client || builderOrContent?.client || builderOrContent?._client;
    return new EphemeralMessage(client, {
      ...options,
      content: builderOrContent,
      expiration
    });
  }
}

export default EphemeralMessage;
