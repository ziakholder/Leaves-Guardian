import BaseBuilder from './base-builder.js';

/**
 * TextMessage — wrapper custom di atas extendedTextMessage (Baileys).
 * Model paling basic: teks biasa, bisa quote/reply pesan lain, bisa mention orang,
 * adReply preview, channel forward, dan otomatis dapet fitur text templating dari BaseBuilder.
 *
 * Contoh pakai:
 *   const text = new TextMessage(sock)
 *     .setBody('Halo {{nama}}, pesananmu {{status}} ✅')
 *     .setVars({ nama: 'Rafa', status: 'sudah diproses' })
 *     .mention(['6281234567890@s.whatsapp.net'])
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
  }

  /** Matikan link preview otomatis kalau body mengandung URL */
  disableLinkPreview() {
    this._linkPreview = false;
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
      throw new Error('Body wajib diisi sebelum send() — pakai .setBody()');
    }
    const { default: resolveLidToPn } = await import('../helpers/lid-resolver.js');
    const targetJid = resolveLidToPn(jid);
    const message = this.build();
    const sendOptions = { ...options };

    if (this._quotedMessage) {
      sendOptions.quoted = this._quotedMessage;
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

export default TextMessage;
