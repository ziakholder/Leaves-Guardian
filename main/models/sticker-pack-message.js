import crypto from 'crypto';
import { generateMessageID, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors/LeavesError.js';

/**
 * StickerPackMessage - Builder untuk mengirim satu paket stiker lengkap (WhatsApp Sticker Pack Message).
 *
 * Contoh pakai:
 *   const pack = new StickerPackMessage(sock)
 *     .setName('Stiker Keren Leaves')
 *     .setPublisher('Royal Engine Studio')
 *     .setDescription('Koleksi stiker resmi')
 *     .setCover(fs.readFileSync('./cover.webp'))
 *     .addSticker(fs.readFileSync('./s1.webp'), ['🔥'])
 *     .addSticker(fs.readFileSync('./s2.webp'), ['🎉']);
 *
 *   await pack.send('6281234567890@s.whatsapp.net');
 */
export class StickerPackMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._name = 'Sticker Pack';
    this._publisher = 'Leaves Guardian';
    this._description = '';
    this._cover = null;
    this._stickers = [];
  }

  setName(name) {
    this._name = this._render(name);
    return this;
  }

  setPublisher(publisher) {
    this._publisher = this._render(publisher);
    return this;
  }

  setDescription(description) {
    this._description = this._render(description);
    return this;
  }

  /**
   * Mengatur gambar cover / icon tray paket stiker (format WebP buffer).
   * @param {Buffer} coverBuffer
   * @returns {StickerPackMessage}
   */
  setCover(coverBuffer) {
    this._cover = coverBuffer;
    return this;
  }

  /**
   * Menambahkan stiker ke dalam paket stiker.
   * @param {Buffer|string} data Buffer stiker WebP
   * @param {Array<string>|string} [emojis=['🎨']] Emoji asosiasi
   * @param {Object} [options]
   * @returns {StickerPackMessage}
   */
  addSticker(data, emojis = ['🎨'], options = {}) {
    if (!data) throw new ContentValidationError('Data stiker wajib diisi');
    this._stickers.push({
      data,
      emojis: Array.isArray(emojis) ? emojis : [emojis],
      isAnimated: Boolean(options.isAnimated),
      accessibilityLabel: options.accessibilityLabel || '',
    });
    return this;
  }

  setStickers(stickers) {
    if (!Array.isArray(stickers)) {
      throw new ContentValidationError('Stickers harus berupa array');
    }
    this._stickers = [...stickers];
    return this;
  }

  async send(jid, options = {}) {
    const rawSock = this.#client;
    if (!rawSock || typeof rawSock.relayMessage !== 'function') {
      throw new Error('Socket tidak valid atau tidak memiliki relayMessage');
    }

    if (!this._cover) {
      throw new ContentValidationError('Cover paket stiker wajib diisi via .setCover(buffer)');
    }

    if (!Array.isArray(this._stickers) || this._stickers.length === 0) {
      throw new ContentValidationError('Minimal 1 stiker di dalam paket stiker');
    }

    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;

    const uploadFn = rawSock.waUploadToServer
      ? (typeof rawSock.waUploadToServer === 'function' ? rawSock.waUploadToServer.bind(rawSock) : rawSock.waUploadToServer)
      : (rawSock.upload ? rawSock.upload.bind(rawSock) : undefined);

    const mediaMessage = await prepareWAMessageMedia(
      {
        document: this._cover,
        mimetype: 'image/webp',
        fileName: 'cover.webp',
      },
      {
        upload: uploadFn,
      }
    );

    const docInfo = mediaMessage.documentMessage;
    if (!docInfo) {
      throw new Error('Gagal mengunggah media cover stiker');
    }

    const formattedStickers = this._stickers.map((s) => {
      const buf = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data);
      const hash = crypto.createHash('sha256').update(buf).digest('base64');
      const safeFileName = hash.replace(/\+/g, '-').replace(/\//g, '_') + '.webp';

      return {
        fileName: safeFileName,
        isAnimated: Boolean(s.isAnimated),
        emojis: Array.isArray(s.emojis) ? s.emojis : [s.emojis || '🎨'],
        accessibilityLabel: s.accessibilityLabel || '',
        isLottie: false,
        mimetype: 'image/webp',
      };
    });

    const stickerPackId = generateMessageID ? generateMessageID() : crypto.randomUUID();

    const stickerPackMessage = {
      stickerPackId,
      name: this._name,
      publisher: this._publisher,
      packDescription: this._description || '',
      stickers: formattedStickers,
      fileLength: docInfo.fileLength,
      fileSha256: docInfo.fileSha256,
      fileEncSha256: docInfo.fileEncSha256,
      mediaKey: docInfo.mediaKey,
      directPath: docInfo.directPath,
      mediaKeyTimestamp: docInfo.mediaKeyTimestamp || Math.floor(Date.now() / 1000).toString(),
      trayIconFileName: `${stickerPackId}.webp`,
      imageDataHash: docInfo.fileSha256 ? docInfo.fileSha256.toString('base64') : '',
      stickerPackSize: docInfo.fileLength,
      stickerPackOrigin: 'THIRD_PARTY',
      contextInfo: {
        ...this._buildContextInfo(),
        ...(options.contextInfo || {}),
        ...(options.quoted ? {
          stanzaId: options.quoted.key.id,
          participant: options.quoted.key.participant || options.quoted.key.remoteJid,
          quotedMessage: options.quoted.message,
        } : {}),
      },
    };

    return rawSock.relayMessage(
      targetJid,
      { stickerPackMessage },
      { messageId: options.messageId || null, ...options }
    );
  }
}

export default StickerPackMessage;
