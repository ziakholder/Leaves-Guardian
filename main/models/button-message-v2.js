import crypto from 'crypto';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors/LeavesError.js';
import { buildInteractiveNodes } from '../helpers/stanza-nodes.js';
import { processThumbnailBuffer } from '../helpers/thumbnail-processor.js';

/**
 * ButtonMessageV2 (ButtonV2) - Builder untuk pesan tombol WhatsApp format klasik (buttonsMessage).
 * Menggunakan headerType: 6 (Location Message Header Fallback) dengan thumbnail 300x300 JPEG
 * agar tombol klasik tetap dapat tampil di berbagai klien WhatsApp Android/iOS lawas maupun web.
 *
 * Contoh pakai:
 *   const btn = new ButtonMessageV2(sock)
 *     .setTitle('Menu Bot')
 *     .setSubtitle('Pilih salah satu menu di bawah:')
 *     .setBody('Halo kak! Ada yang bisa kami bantu?')
 *     .setFooter('Leaves Guardian v0.3.16')
 *     .setThumbnail('https://example.com/logo.jpg')
 *     .addButton('Daftar Menu', 'menu')
 *     .addButton('Info Bot', 'info');
 *
 *   await btn.send('6281234567890@s.whatsapp.net');
 */
export class ButtonMessageV2 extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._subtitle = '';
    this._image = null;
    this._data = null;
    this._buttons = [];
    this._extraPayload = {};
  }

  setSubtitle(subtitle) {
    this._subtitle = this._render(subtitle);
    return this;
  }

  /**
   * Mengatur gambar thumbnail header (URL, file path, atau Buffer).
   * Otomatis dioptimalkan menjadi format JPEG 300x300 <=30KB.
   * @param {string|Buffer} source
   * @returns {ButtonMessageV2}
   */
  setThumbnail(source) {
    if (!source) throw new ContentValidationError('Thumbnail URL atau buffer diperlukan');
    this._image = source;
    return this;
  }

  setRawThumbnail(thumbnail) {
    if (!thumbnail) throw new ContentValidationError('Raw thumbnail diperlukan');
    this._image = { is_raw: true, data: thumbnail };
    return this;
  }

  setMedia(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new TypeError('Media harus berupa plain object');
    }
    this._data = obj;
    return this;
  }

  addButton(displayText = '', buttonId = crypto.randomUUID()) {
    this._buttons.push({
      buttonId,
      buttonText: { displayText: this._render(displayText) },
      type: 1,
    });
    return this;
  }

  addRawButton(buttonObj) {
    if (typeof buttonObj !== 'object' || buttonObj === null || Array.isArray(buttonObj)) {
      throw new TypeError('Button harus berupa plain object');
    }
    this._buttons.push(buttonObj);
    return this;
  }

  loadFrom(msg) {
    if (!msg || !msg.buttonsMessage) {
      throw new Error('Pesan buttonsMessage tidak ditemukan untuk loadFrom()');
    }

    const { buttonsMessage, ...extraPayload } = msg;
    const bM = buttonsMessage;
    const location = bM.locationMessage || {};

    this._title = location.name || '';
    this._subtitle = location.address || '';
    this._body = bM.contentText || '';
    this._footer = bM.footerText || '';
    this._contextInfo = bM.contextInfo || {};
    this._extraPayload = extraPayload;

    this._buttons = Array.isArray(bM.buttons)
      ? bM.buttons.map((button) => ({
          ...button,
          ...(button.nativeFlowInfo
            ? {
                nativeFlowInfo: {
                  ...button.nativeFlowInfo,
                  paramsJson: typeof button.nativeFlowInfo.paramsJson === 'string'
                    ? button.nativeFlowInfo.paramsJson
                    : JSON.stringify(button.nativeFlowInfo.paramsJson || {}),
                },
              }
            : {}),
        }))
      : [];

    this._image = location.jpegThumbnail || null;
    return this;
  }

  async build(jid, options = {}) {
    let thumbnailBuffer = null;
    if (this._image) {
      if (this._image.is_raw) {
        thumbnailBuffer = Buffer.isBuffer(this._image.data)
          ? this._image.data
          : Buffer.from(this._image.data, 'base64');
      } else {
        thumbnailBuffer = await processThumbnailBuffer(this._image, {
          width: 300,
          height: 300,
          quality: 85,
          banner: false,
        });
      }
    }

    const { title, body, footer } = this._renderAll();

    const buttonsMessage = {
      contentText: body,
      footerText: footer,
      ...(this._data
        ? this._data
        : {
            headerType: 6,
            locationMessage: {
              degreesLatitude: 0,
              degreesLongitude: 0,
              name: title || '',
              address: this._subtitle || '',
              jpegThumbnail: thumbnailBuffer || undefined,
            },
          }),
      viewOnce: true,
      contextInfo: {
        ...this._buildContextInfo(),
        ...(options.contextInfo || {}),
      },
      buttons: [...this._buttons],
    };

    const messageContent = {
      ...this._extraPayload,
      buttonsMessage,
    };

    return generateWAMessageFromContent(
      jid,
      messageContent,
      {
        userJid: this.#client.user?.id,
        quoted: options.quoted || this._quotedMessage || null,
        ephemeralExpiration: options.ephemeralExpiration || options.quoted?.expiration || 0,
        messageId: options.messageId || null,
        ...options,
      }
    );
  }

  async send(jid, options = {}) {
    const rawSock = this.#client;
    if (!rawSock || typeof rawSock.relayMessage !== 'function') {
      throw new Error('Socket tidak valid atau tidak memiliki relayMessage');
    }

    if (!Array.isArray(this._buttons) || this._buttons.length === 0) {
      throw new ContentValidationError('ButtonMessageV2 membutuhkan minimal 1 button sebelum send()');
    }

    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;

    const msg = await this.build(targetJid, options);

    const additionalNodes = [
      ...buildInteractiveNodes(targetJid),
      ...(options.additionalNodes || []),
    ];

    await rawSock.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      additionalNodes,
      ...options,
    });

    return msg;
  }
}

export const ButtonV2 = ButtonMessageV2;
export default ButtonMessageV2;
