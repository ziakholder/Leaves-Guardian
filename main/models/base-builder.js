import withChannelForward from '../helpers/channel-forward.js';
import withAdReply from '../helpers/ad-reply.js';

/**
 * BaseBuilder — parent class semua model message.
 * Semua model custom (ButtonMessage, ListMessage, TextMessage, dst) extends dari sini
 * biar dapet fitur shared: title, body, footer, text templating, adReply, channelForward, mention, dan quote.
 */
class BaseBuilder {
  constructor() {
    this._title = '';
    this._body = '';
    this._footer = '';
    this._contextInfo = {};
    this._vars = {};
    this._quotedMessage = null;
    this._mentions = [];
  }

  /**
   * Helper to resolve client: accepts either LeavesClient instance or raw Baileys socket.
   */
  static resolveSocket(client) {
    if (!client) return null;
    if (typeof client.getRawSocket === 'function') {
      return client.getRawSocket();
    }
    return client;
  }

  setTitle(title) {
    if (typeof title !== 'string') throw new TypeError('Title harus string');
    this._title = title;
    return this;
  }

  setBody(body) {
    if (typeof body !== 'string') throw new TypeError('Body harus string');
    this._body = body;
    return this;
  }

  setFooter(footer) {
    this._footer = footer;
    return this;
  }

  setContextInfo(obj) {
    if (typeof obj !== 'object' || obj === null) {
      throw new TypeError('ContextInfo harus berupa object');
    }
    this._contextInfo = { ...this._contextInfo, ...obj };
    return this;
  }

  setAdReply(opts = {}) {
    const adReplyObj = withAdReply({
      ...opts,
      title: this._render(opts.title || ''),
      body: this._render(opts.body || ''),
    });
    this.setContextInfo(adReplyObj);
    return this;
  }

  setChannelForward(opts = {}) {
    const channelObj = withChannelForward(opts);
    this.setContextInfo(channelObj);
    return this;
  }

  mention(jids = []) {
    const list = Array.isArray(jids) ? jids : [jids];
    this._mentions.push(...list);
    return this;
  }

  quote(quotedMsg) {
    this._quotedMessage = quotedMsg;
    return this;
  }

  setVars(vars = {}) {
    Object.assign(this._vars, vars);
    return this;
  }

  _render(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return Object.prototype.hasOwnProperty.call(this._vars, key)
        ? String(this._vars[key])
        : match;
    });
  }

  _renderAll() {
    return {
      title: this._render(this._title),
      body: this._render(this._body),
      footer: this._render(this._footer),
    };
  }

  _buildContextInfo() {
    const ctx = { ...this._contextInfo };
    if (this._mentions.length > 0) {
      ctx.mentionedJid = [...new Set([...(ctx.mentionedJid || []), ...this._mentions])];
    }
    return ctx;
  }
}

export default BaseBuilder;
