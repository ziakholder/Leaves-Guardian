import BaseBuilder from './base-builder.js';
import { withLinkPreview } from '../helpers/link-preview.js';

/**
 * TextMessage - wrapper custom di atas extendedTextMessage (Baileys).
 * Model paling basic: teks biasa, bisa quote/reply pesan lain, bisa mention orang,
 * adReply preview, channel forward, link preview dengan favicon, dan text templating dari BaseBuilder.
 *
 * Contoh pakai:
 *   const text = new TextMessage(sock)
 *     .setBody('Halo {{nama}}, pesananmu {{status}} ✅')
 *     .setVars({ nama: 'Rafa', status: 'sudah diproses' })
 *     .mention(['6281234567890@s.whatsapp.net'])
 *     .setLinkPreview({
 *       url: 'https://example.com',
 *       title: 'Website Kami',
 *       description: 'Kunjungi link ini',
 *       thumbnail: './thumb.jpg'
 *     })
 *     .quote(originalMsg);
 *
 *   await text.send('6281234567890@s.whatsapp.net');
 */
class TextMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._linkPreview = true;
    this._customLinkPreview = null;
  }

  /** Matikan link preview otomatis kalau body mengandung URL */
  disableLinkPreview() {
    this._linkPreview = false;
    this._customLinkPreview = null;
    return this;
  }

  /**
   * Mengatur link preview kustom lengkap dengan judul, deskripsi, thumbnail, dan favicon.
   * @param {Object} options Opsi link preview
   * @returns {TextMessage}
   */
  setLinkPreview(options) {
    this._customLinkPreview = options;
    this._linkPreview = true;
    return this;
  }

  build() {
    const { body } = this._renderAll();
    const ctx = this._buildContextInfo();

    return {
      text: body,
      mentions: this._mentions.length > 0 ? this._mentions : undefined,
      linkPreview: this._linkPreview,
      contextInfo: Object.keys(ctx).length > 0 ? ctx : undefined,
    };
  }

  async send(jid, options = {}) {
    if (!this._body) {
      throw new Error('Body wajib diisi sebelum send() - pakai .setBody()');
    }
    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;
    const message = this.build();
    const sendOptions = { ...options };

    if (this._quotedMessage) {
      sendOptions.quoted = this._quotedMessage;
    }

    // Process custom link preview if configured
    if (this._customLinkPreview) {
      try {
        const previewData = await withLinkPreview(this._customLinkPreview, this.#client);
        message.linkPreview = previewData.linkPreview;
        if (previewData.extendedTextMessage) {
          message.text = this._customLinkPreview.url
            ? (message.text.includes(this._customLinkPreview.url) ? message.text : `${this._customLinkPreview.url}\n${message.text}`)
            : message.text;
          message.matchedText = previewData.extendedTextMessage.matchedText;
          message.title = previewData.extendedTextMessage.title;
          message.description = previewData.extendedTextMessage.description;
          message.jpegThumbnail = previewData.extendedTextMessage.jpegThumbnail;
          if (previewData.extendedTextMessage.faviconMMSMetadata) {
            message.faviconMMSMetadata = previewData.extendedTextMessage.faviconMMSMetadata;
          }
        }
      } catch (_) {}
    }

    // Auto-fetch thumbnail Buffer for externalAdReply if only URL is present
    if (message.contextInfo?.externalAdReply) {
      const ad = message.contextInfo.externalAdReply;
      const targetUrl = ad.thumbnailUrl || (typeof ad.thumbnail === 'string' ? ad.thumbnail : null);
      if (targetUrl && !Buffer.isBuffer(ad.thumbnail)) {
        try {
          const res = await fetch(targetUrl);
          if (res.ok) {
            ad.thumbnail = Buffer.from(await res.arrayBuffer());
          }
        } catch (_) {}
      }
    }

    return await this.#client.sendMessage(targetJid, message, sendOptions);
  }
}

export { TextMessage };
export default TextMessage;
