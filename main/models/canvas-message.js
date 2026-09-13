import AIRichMessage from './ai-rich-message.js';
import { ContentValidationError } from '../errors.js';

/**
 * CanvasMessage — WhatsApp Interactive Canvas HTML / Mini App Builder.
 * Menjalankan Mini App / Game HTML5 (seperti Dino Runner, Flappy Bird, Calculator)
 * langsung di dalam WhatsApp menggunakan protokol Meta AI Rich Response (GenAIaeacdsnwHtmlPrimitive)
 * dan auto fast-edit bypass agar 100% ter-render di WhatsApp Android.
 */
class CanvasMessage extends AIRichMessage {
  #html;
  #trustedSources;

  constructor(client) {
    super(client);
    this.#html = '';
    this.#trustedSources = ['nixel.dev', 'whatsapp.com'];
  }

  /**
   * Set isi kode HTML, CSS, & JS game/canvas
   * @param {string} html - Kode HTML lengkap (DOCTYPE html)
   * @param {Object} [options]
   * @param {Array<string>} [options.trustedSources] - Whitelist domain jika memuat resource eksternal
   */
  setHtml(html, { trustedSources = ['nixel.dev', 'whatsapp.com'] } = {}) {
    if (typeof html !== 'string') {
      throw new ContentValidationError('HTML harus berupa string');
    }
    this.#html = html;
    this.#trustedSources = Array.isArray(trustedSources) ? trustedSources : [trustedSources];
    return this;
  }

  build(jid, options = {}) {
    if (!this.#html && this._sections.length === 0) {
      throw new ContentValidationError('HTML konten wajib disetel dengan setHtml()');
    }

    if (this.#html) {
      this._sections = [];
      this._submessages = [];
      this.addHtml(this.#html, { trustedSources: this.#trustedSources });
    }

    return super.build(jid, options);
  }
}

export default CanvasMessage;
