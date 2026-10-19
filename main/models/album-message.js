import crypto from 'crypto';
import { generateWAMessage, generateWAMessageFromContent } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors/LeavesError.js';

/**
 * AlbumMessage - Builder untuk mengirim beberapa media (foto/video) sekaligus
 * yang dikelompokkan menjadi satu album WhatsApp asli (WhatsApp Native Album).
 *
 * Contoh pakai:
 *   const album = new AlbumMessage(sock)
 *     .addImage('https://example.com/photo1.jpg', { caption: 'Foto 1' })
 *     .addImage(fs.readFileSync('./photo2.jpg'), { caption: 'Foto 2' })
 *     .addVideo('https://example.com/video.mp4', { caption: 'Video Promo' });
 *
 *   await album.send('6281234567890@s.whatsapp.net');
 */
export class AlbumMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._items = [];
  }

  /**
   * Menambahkan satu item media (image atau video) ke dalam album.
   * @param {Object} mediaContent Objek konten media Baileys, misalnya { image: ... } atau { video: ... }
   * @returns {AlbumMessage}
   */
  addMedia(mediaContent) {
    if (!mediaContent || typeof mediaContent !== 'object') {
      throw new ContentValidationError('Item media harus berupa object ({ image } atau { video })');
    }
    this._items.push(mediaContent);
    return this;
  }

  /**
   * Menambahkan gambar ke dalam album.
   * @param {string|Buffer} source URL, file path, atau Buffer gambar
   * @param {Object} [options] Opsi tambahan seperti caption
   * @returns {AlbumMessage}
   */
  addImage(source, options = {}) {
    if (!source) throw new ContentValidationError('Source gambar wajib diisi');
    const mediaPayload = Buffer.isBuffer(source) ? source : (typeof source === 'object' && source.url) ? source : { url: source };
    this._items.push({
      image: mediaPayload,
      caption: options.caption ? this._render(options.caption) : undefined,
      ...options,
    });
    return this;
  }

  /**
   * Menambahkan video ke dalam album.
   * @param {string|Buffer} source URL, file path, atau Buffer video
   * @param {Object} [options] Opsi tambahan seperti caption
   * @returns {AlbumMessage}
   */
  addVideo(source, options = {}) {
    if (!source) throw new ContentValidationError('Source video wajib diisi');
    const mediaPayload = Buffer.isBuffer(source) ? source : (typeof source === 'object' && source.url) ? source : { url: source };
    this._items.push({
      video: mediaPayload,
      caption: options.caption ? this._render(options.caption) : undefined,
      ...options,
    });
    return this;
  }

  /**
   * Mengatur seluruh daftar item media secara sekaligus.
   * @param {Array<Object>} items Daftar item media
   * @returns {AlbumMessage}
   */
  setItems(items) {
    if (!Array.isArray(items)) {
      throw new ContentValidationError('Items album harus berupa array');
    }
    this._items = [...items];
    return this;
  }

  /**
   * Memvalidasi dan mengirim album ke target JID.
   * @param {string} jid Target WhatsApp JID
   * @param {Object} [options] Opsi pengiriman tambahan
   * @returns {Promise<Object>} Mengembalikan pesan parent album
   */
  async send(jid, options = {}) {
    const rawSock = this.#client;
    if (!rawSock || typeof rawSock.relayMessage !== 'function') {
      throw new Error('Socket tidak valid atau tidak memiliki relayMessage');
    }

    if (!Array.isArray(this._items) || this._items.length < 2) {
      throw new ContentValidationError('Album WhatsApp membutuhkan minimal 2 item media (gambar/video)');
    }

    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;

    const messageSecret = new Uint8Array(32);
    crypto.getRandomValues(messageSecret);

    const expectedImageCount = this._items.filter((a) => a?.image).length;
    const expectedVideoCount = this._items.filter((a) => a?.video).length;

    const albumContent = {
      messageContextInfo: {
        messageSecret,
      },
      albumMessage: {
        expectedImageCount,
        expectedVideoCount,
      },
    };

    const uploadFn = rawSock.waUploadToServer
      ? (typeof rawSock.waUploadToServer === 'function' ? rawSock.waUploadToServer.bind(rawSock) : rawSock.waUploadToServer)
      : (rawSock.upload ? rawSock.upload.bind(rawSock) : undefined);

    const generationOptions = {
      userJid: rawSock.user?.id,
      upload: uploadFn,
      quoted: options.quoted || this._quotedMessage || null,
      ephemeralExpiration: options.ephemeralExpiration || options.quoted?.expiration || 0,
    };

    const album = generateWAMessageFromContent(targetJid, albumContent, generationOptions);

    await rawSock.relayMessage(album.key.remoteJid, album.message, {
      messageId: album.key.id,
      ...options,
    });

    await Promise.all(
      this._items.map(async (content) => {
        const mediaSecret = new Uint8Array(32);
        crypto.getRandomValues(mediaSecret);

        const mediaMsg = await generateWAMessage(album.key.remoteJid, content, {
          upload: uploadFn,
          ephemeralExpiration: options.ephemeralExpiration || options.quoted?.expiration || 0,
        });

        mediaMsg.message = mediaMsg.message || {};
        mediaMsg.message.messageContextInfo = {
          messageSecret: mediaSecret,
          messageAssociation: {
            associationType: 1,
            parentMessageKey: album.key,
          },
        };

        return rawSock.relayMessage(mediaMsg.key.remoteJid, mediaMsg.message, {
          messageId: mediaMsg.key.id,
        });
      })
    );

    return album;
  }
}

export default AlbumMessage;
