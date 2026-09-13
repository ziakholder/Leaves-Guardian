import { generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';

/**
 * ButtonMessage — wrapper custom di atas InteractiveMessage.NativeFlowMessage (Baileys).
 * Mendukung berbagai macam tombol interaktif, banner promo (Limited Time Offer),
 * header media (Gambar/Video/Dokumen), adReply preview, dan forward channel.
 *
 * Contoh pakai:
 *   const btn = new ButtonMessage(sock)
 *     .setBody('Halo {{nama}}, mau lanjut checkout?')
 *     .setVars({ nama: 'Rafa' })
 *     .addReply('Ya, lanjut', 'checkout_yes')
 *     .addCopy('Salin kode promo', 'HEMAT20')
 *     .addLimitedOffer('Diskon 50% Berakhir', { days: 7 });
 *
 *   await btn.send('6281234567890@s.whatsapp.net');
 */
class ButtonMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._buttons = [];
    this._media = null;
    this._mediaType = null;
    this._mediaOptions = {};
  }

  addReply(displayText, id) {
    this._buttons.push({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: this._render(displayText), id }),
    });
    return this;
  }

  addUrl(displayText, url) {
    this._buttons.push({
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({ display_text: this._render(displayText), url }),
    });
    return this;
  }

  /** Tombol "salin kode/link" (cta_copy) */
  addCopy(displayText, copyCode) {
    this._buttons.push({
      name: 'cta_copy',
      buttonParamsJson: JSON.stringify({
        display_text: this._render(displayText),
        copy_code: this._render(copyCode),
      }),
    });
    return this;
  }

  /**
   * Banner promo dengan timer kedaluwarsa (Limited Time Offer / LTO)
   * Menampilkan badge tag berikon "Saran Command" / "Nama Promo" di atas pesan.
   *
   * @param {string} displayText - Teks judul promo/banner
   * @param {Object} [opts]
   * @param {number} [opts.expiration_time] - Unix timestamp (detik)
   * @param {number} [opts.days=7] - Jumlah hari sebelum tawaran berakhir (jika expiration_time tidak diisi)
   * @param {string} [opts.url] - URL info promo
   * @param {string} [opts.copy_code] - Kode promo yang otomatis bisa disalin
   */
  addLimitedOffer(displayText, { expiration_time, days = 7, url = 'https://whatsapp.com', copy_code } = {}) {
    const expireSec = expiration_time || Math.floor(Date.now() / 1000) + Math.round(days * 86400);

    this._buttons.push({
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: this._render(displayText),
        url,
        copy_code,
        merchant_url: url,
      }),
    });

    this._extraPayload_limitedOffer = {
      text: this._render(displayText),
      url,
      copy_code,
      expiration_time: expireSec,
    };
    return this;
  }

  /** Alias untuk addLimitedOffer */
  setBanner(bannerText, opts = {}) {
    return this.addLimitedOffer(bannerText, opts);
  }

  /** Tambah gambar header */
  setImage(path) {
    this._media = path;
    this._mediaType = 'image';
    return this;
  }

  /** Tambah video header */
  setVideo(path) {
    this._media = path;
    this._mediaType = 'video';
    return this;
  }

  /**
   * Tambah dokumen / file header (menampilkan card file [JPG]/[PDF] seperti di screenshot)
   * @param {string|Buffer} path - Path / URL / Buffer file
   * @param {Object} [options]
   * @param {string} [options.fileName='document'] - Nama file yang ditampilkan
   * @param {string} [options.mimetype='application/octet-stream'] - Mimetype file
   */
  setDocument(path, { fileName = 'document', mimetype = 'application/octet-stream' } = {}) {
    this._media = path;
    this._mediaType = 'document';
    this._mediaOptions = { fileName, mimetype };
    return this;
  }

  async build() {
    const { body, footer } = this._renderAll();

    if (this._buttons.length === 0) {
      throw new ContentValidationError('Minimal 1 button sebelum build()/send()');
    }

    let header = { hasMediaAttachment: false };
    if (this._media) {
      const mediaKey = this._mediaType;
      const mediaPayload = {
        [mediaKey]: Buffer.isBuffer(this._media) ? this._media : { url: this._media },
        ...this._mediaOptions,
      };

      const prepared = await prepareWAMessageMedia(mediaPayload, {
        upload: this.#client.waUploadToServer,
      });

      const messageKey = `${this._mediaType}Message`;
      header = {
        hasMediaAttachment: true,
        [messageKey]: prepared[messageKey],
      };
    }

    return {
      interactiveMessage: {
        header,
        body: { text: body },
        footer: footer ? { text: footer } : undefined,
        nativeFlowMessage: {
          buttons: this._buttons,
          messageParamsJson: this._extraPayload_limitedOffer
            ? JSON.stringify({ limited_time_offer: this._extraPayload_limitedOffer })
            : undefined,
        },
        contextInfo: this._buildContextInfo(),
      },
    };
  }

  async send(jid, options = {}) {
    const content = await this.build();
    const sendOpts = { userJid: this.#client.user?.id, ...options };
    if (this._quotedMessage) {
      sendOpts.quoted = this._quotedMessage;
    }

    const msg = generateWAMessageFromContent(jid, content, sendOpts);

    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: [
        {
          tag: 'biz',
          attrs: {},
          content: [
            {
              tag: 'interactive',
              attrs: { type: 'native_flow', v: '1' },
              content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
            },
          ],
        },
      ],
    });

    return msg;
  }
}

export default ButtonMessage;
