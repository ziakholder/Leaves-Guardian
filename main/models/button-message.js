import { generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import crypto from 'crypto';
import fs from 'fs';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';
import { resolveLidToPn } from '../helpers/lid-resolver.js';
import { buildInteractiveNodes } from '../helpers/stanza-nodes.js';
import { processThumbnailBuffer } from '../helpers/thumbnail-processor.js';

/**
 * ButtonMessage - wrapper custom di atas InteractiveMessage.NativeFlowMessage (Baileys).
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
    this._locationHeader = null;
    this._currentSelectionIndex = -1;
    this._currentSectionIndex = -1;
    this._params = {};
  }

  addReply(displayText, id = '') {
    this._buttons.push({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: this._render(displayText), id }),
    });
    return this;
  }

  addUrl(displayText, url = '', webviewInteraction = false) {
    this._buttons.push({
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: this._render(displayText),
        url: this._render(url),
        webview_interaction: webviewInteraction,
      }),
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

  addButton(name, params) {
    this._buttons.push({
      name,
      buttonParamsJson: typeof params === 'string' ? params : JSON.stringify(params),
    });
    return this;
  }

  addSelection(title, options = {}) {
    this._buttons.push({
      ...options,
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: this._render(title),
        sections: [],
      }),
    });
    this._currentSelectionIndex = this._buttons.length - 1;
    this._currentSectionIndex = -1;
    return this;
  }

  makeSection(title = '', highlight_label = '') {
    if (this._currentSelectionIndex === -1) {
      throw new Error('You need to create a selection first via addSelection()');
    }
    const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
    buttonParams.sections.push({
      title: this._render(title),
      highlight_label: this._render(highlight_label),
      rows: [],
    });
    this._currentSectionIndex = buttonParams.sections.length - 1;
    this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
    return this;
  }

  makeRow(header = '', title = '', description = '', id = '') {
    if (this._currentSelectionIndex === -1 || this._currentSectionIndex === -1) {
      throw new Error('You need to create a selection and a section first');
    }
    const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
    buttonParams.sections[this._currentSectionIndex].rows.push({
      header: this._render(header),
      title: this._render(title),
      description: this._render(description),
      id: this._render(id),
    });
    this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
    return this;
  }

  /**
   * Tambah tombol list dropdown (single_select) secara deklaratif dengan array sections.
   * @param {string} title - Teks tombol dropdown (misal: "📋 Lihat Semua Menu")
   * @param {Array<{title: string, highlight_label?: string, rows: Array<{title: string, description?: string, id: string, header?: string}>}>} sections
   */
  addDropdown(title, sections = []) {
    this.addSelection(title);
    for (const sec of sections) {
      this.makeSection(sec.title || '', sec.highlight_label || '');
      if (Array.isArray(sec.rows)) {
        for (const row of sec.rows) {
          this.makeRow(row.header || '', row.title || '', row.description || '', row.id || '');
        }
      }
    }
    return this;
  }

  /** Alias untuk addDropdown */
  addList(title, sections = []) {
    return this.addDropdown(title, sections);
  }

  setBottomSheet(title, { inThreadButtonsLimit = 1, dividerIndices = [1, 2] } = {}) {
    this._params.bottom_sheet = {
      in_thread_buttons_limit: inThreadButtonsLimit,
      divider_indices: dividerIndices,
      list_title: title,
      button_title: title,
    };
    return this;
  }

  /**
   * Banner promo dengan timer kedaluwarsa (Limited Time Offer / LTO)
   */
  addLimitedOffer(displayText, { expiration_time, days = 7, url = 'https://whatsapp.com', copy_code = '' } = {}) {
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

    this._params.limited_time_offer = {
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

  /** Tambah dokumen header */
  setDocument(path, { fileName = 'document', mimetype = 'application/octet-stream' } = {}) {
    this._media = path;
    this._mediaType = 'document';
    this._mediaOptions = { fileName, mimetype };
    return this;
  }

  /** Tombol banner flow / galaxy message */
  addGalaxy(flowCta, { flowAction = 'navigate', screen = 'SATISFACTION_SCREEN', data = {} } = {}) {
    this._buttons.push({
      name: 'galaxy_message',
      buttonParamsJson: JSON.stringify({
        flow_cta: this._render(flowCta),
        icon: '',
        flow_message_version: '3',
        flow_action: flowAction,
        flow_action_payload: {
          screen,
          data,
        },
      }),
    });
    return this;
  }

  /**
   * Set kartu header lokasi interaktif (seperti kartu map dengan pin dan thumbnail kanan).
   * @param {Object|string} nameOrOpts - Objek konfigurasi atau string nama/judul lokasi
   * @param {string} [address] - Deskripsi / alamat di bawah judul jika argumen pertama adalah string
   * @param {string|Buffer} [thumbnail] - Gambar thumbnail persegi di sebelah kanan (URL, file path, atau Buffer)
   */
  setLocationHeader(nameOrOpts, address, thumbnail, extraOpts = {}) {
    let opts = {};
    if (typeof nameOrOpts === 'object' && nameOrOpts !== null) {
      opts = nameOrOpts;
    } else {
      opts = {
        name: nameOrOpts,
        address,
        thumbnail,
        ...extraOpts,
      };
    }
    this._locationHeader = {
      name: opts.name || opts.title || '',
      address: opts.address || opts.description || '',
      thumbnail: opts.thumbnail || opts.image || null,
      latitude: opts.latitude ?? opts.degreesLatitude ?? 0,
      longitude: opts.longitude ?? opts.degreesLongitude ?? 0,
      thumbWidth: opts.width || opts.thumbWidth || 300,
      thumbHeight: opts.height || opts.thumbHeight || 300,
      thumbQuality: opts.quality || opts.thumbQuality || 85,
    };
    return this;
  }

  /** Alias untuk setLocationHeader */
  setLocation(nameOrOpts, address, thumbnail, extraOpts = {}) {
    return this.setLocationHeader(nameOrOpts, address, thumbnail, extraOpts);
  }

  async build() {
    const { title, body, footer } = this._renderAll();

    if (this._buttons.length === 0) {
      throw new ContentValidationError('Minimal 1 button sebelum build()/send()');
    }

    let header = { hasMediaAttachment: false };
    if (this._locationHeader) {
      const thumbBuffer = await processThumbnailBuffer(this._locationHeader.thumbnail, {
        width: this._locationHeader.thumbWidth || 300,
        height: this._locationHeader.thumbHeight || 300,
        quality: this._locationHeader.thumbQuality || 85,
        banner: false,
      });

      header = {
        title: title || undefined,
        hasMediaAttachment: true,
        jpegThumbnail: thumbBuffer || undefined,
        locationMessage: {
          degreesLatitude: Number(this._locationHeader.latitude) || 0,
          degreesLongitude: Number(this._locationHeader.longitude) || 0,
          name: this._render(this._locationHeader.name),
          address: this._render(this._locationHeader.address),
          jpegThumbnail: thumbBuffer || undefined,
        },
      };
    } else if (this._media) {
      let rawMedia = this._media;
      if (typeof this._media === 'string' && fs.existsSync(this._media)) {
        try {
          rawMedia = fs.readFileSync(this._media);
        } catch (_) {}
      }
      if (Buffer.isBuffer(rawMedia)) {
        try {
          const { createCanvas, loadImage } = await import('@napi-rs/canvas');
          const img = await loadImage(rawMedia);
          const targetW = 1280;
          const targetH = 720;
          const canvas = createCanvas(targetW, targetH);
          const ctx = canvas.getContext('2d');
          const scale = Math.max(targetW / img.width, targetH / img.height);
          const x = (targetW - img.width * scale) / 2;
          const y = (targetH - img.height * scale) / 2;
          ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
          rawMedia = canvas.toBuffer('image/jpeg');
        } catch (_) {}
      }

      const mediaKey = this._mediaType;
      const mediaPayload = {
        [mediaKey]: Buffer.isBuffer(rawMedia) ? rawMedia : { url: rawMedia },
        ...this._mediaOptions,
      };

      try {
        const uploadFn = this.#client.waUploadToServer
          ? (typeof this.#client.waUploadToServer === 'function' ? this.#client.waUploadToServer.bind(this.#client) : this.#client.waUploadToServer)
          : (this.#client.upload ? this.#client.upload.bind(this.#client) : undefined);

        const prepared = await prepareWAMessageMedia(mediaPayload, {
          upload: uploadFn,
        });

        const messageKey = `${this._mediaType}Message`;
        header = {
          title: title || undefined,
          hasMediaAttachment: true,
          [messageKey]: prepared[messageKey],
        };
      } catch (mediaErr) {
        if (title) {
          header = { title, hasMediaAttachment: false };
        }
      }
    } else if (title) {
      header = { title, hasMediaAttachment: false };
    }

    return {
      interactiveMessage: {
        header: Object.keys(header).length > 0 ? header : undefined,
        body: { text: body },
        footer: footer ? { text: footer } : undefined,
        nativeFlowMessage: {
          buttons: this._buttons,
          messageParamsJson: Object.keys(this._params).length > 0 ? JSON.stringify(this._params) : undefined,
        },
        contextInfo: this._buildContextInfo(),
      },
    };
  }

  async send(jid, options = {}) {
    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;
    let userJid = null;
    try {
      userJid = this.#client?.user?.id || this.#client?.authState?.creds?.me?.id || null;
    } catch (_) {}
    const sendOpts = { ...(userJid ? { userJid } : {}), ...options };
    if (this._quotedMessage) {
      const cleanQuoted = { ...this._quotedMessage };
      if (cleanQuoted.key) {
        cleanQuoted.key = {
          ...cleanQuoted.key,
          remoteJid: targetJid,
        };
      }
      sendOpts.quoted = cleanQuoted;
    }

    const { title, body, footer } = this._renderAll();

    const additionalNodes = buildInteractiveNodes(targetJid);

    const content = await this.build();
    const payload = {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            messageSecret: crypto.randomBytes(32),
          },
          ...content,
        },
      },
    };

    try {
      const msg = generateWAMessageFromContent(targetJid, payload, sendOpts);
      await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
        messageId: msg.key.id,
        additionalNodes,
      });
      return msg;
    } catch (relayErr) {
      // Fallback for legacy clients without native flow support
      const legacyButtons = [];
      for (const b of this._buttons) {
        if (b.name === 'quick_reply') {
          const parsed = typeof b.buttonParamsJson === 'string' ? JSON.parse(b.buttonParamsJson) : b.buttonParamsJson;
          legacyButtons.push({
            buttonId: parsed.id || '.menu',
            buttonText: { displayText: parsed.display_text || 'Tombol' },
            type: 1,
          });
        } else if (b.name === 'single_select') {
          const parsed = typeof b.buttonParamsJson === 'string' ? JSON.parse(b.buttonParamsJson) : b.buttonParamsJson;
          legacyButtons.push({
            buttonId: '.menu all',
            buttonText: { displayText: parsed.title || '📂 Kategori Menu' },
            type: 1,
          });
        }
        if (legacyButtons.length >= 3) break;
      }

      if (legacyButtons.length > 0) {
        const fallbackPayload = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
                messageSecret: crypto.randomBytes(32),
              },
              buttonsMessage: {
                contentText: body,
                footerText: footer || '',
                headerType: 1,
                buttons: legacyButtons,
              },
            },
          },
        };
        const fallbackMsg = generateWAMessageFromContent(targetJid, fallbackPayload, sendOpts);
        await this.#client.relayMessage(fallbackMsg.key.remoteJid, fallbackMsg.message, {
          messageId: fallbackMsg.key.id,
        });
        return fallbackMsg;
      }
      throw relayErr;
    }
  }

  /**
   * Mengubah instance ButtonMessage menjadi format kartu Carousel (Carousel Card).
   * @returns {Promise<Object>}
   */
  async toCard() {
    const { title, body, footer } = this._renderAll();
    let header = { hasMediaAttachment: false };

    if (this._locationHeader) {
      const thumbBuffer = await processThumbnailBuffer(this._locationHeader.thumbnail, {
        width: this._locationHeader.thumbWidth || 300,
        height: this._locationHeader.thumbHeight || 300,
        quality: this._locationHeader.thumbQuality || 85,
        banner: false,
      });

      header = {
        title: title || undefined,
        hasMediaAttachment: true,
        jpegThumbnail: thumbBuffer || undefined,
        locationMessage: {
          degreesLatitude: Number(this._locationHeader.latitude) || 0,
          degreesLongitude: Number(this._locationHeader.longitude) || 0,
          name: this._render(this._locationHeader.name),
          address: this._render(this._locationHeader.address),
          jpegThumbnail: thumbBuffer || undefined,
        },
      };
    } else if (this._media) {
      const rawSock = this.#client;
      const uploadFn = rawSock?.waUploadToServer
        ? (typeof rawSock.waUploadToServer === 'function' ? rawSock.waUploadToServer.bind(rawSock) : rawSock.waUploadToServer)
        : (rawSock?.upload ? rawSock.upload.bind(rawSock) : undefined);

      const mediaKey = this._mediaType;
      const mediaPayload = {
        [mediaKey]: Buffer.isBuffer(this._media) ? this._media : { url: this._media },
        ...this._mediaOptions,
      };

      try {
        const prepared = await prepareWAMessageMedia(mediaPayload, { upload: uploadFn });
        const messageKey = `${this._mediaType}Message`;
        header = {
          title: title || undefined,
          hasMediaAttachment: true,
          [messageKey]: prepared[messageKey],
        };
      } catch (_) {
        if (title) header = { title, hasMediaAttachment: false };
      }
    } else if (title) {
      header = { title, hasMediaAttachment: false };
    }

    return {
      header: Object.keys(header).length > 0 ? header : undefined,
      body: { text: body },
      footer: footer ? { text: footer } : undefined,
      nativeFlowMessage: {
        buttons: this._buttons,
        messageParamsJson: Object.keys(this._params).length > 0 ? JSON.stringify(this._params) : '',
      },
    };
  }
}

export { ButtonMessage };
export default ButtonMessage;
