import crypto from 'crypto';
import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors/LeavesError.js';
import { processThumbnailBuffer } from '../helpers/thumbnail-processor.js';

/**
 * OrderMessage - Builder untuk pesan pesanan / invoice katalog resmi WhatsApp (OrderMessage).
 * Menampilkan rincian pesanan, total harga, thumbnail produk, dan status pesanan.
 *
 * Contoh pakai:
 *   const order = new OrderMessage(sock)
 *     .setOrderTitle('Pesanan Kopi Susu')
 *     .setMessage('2x Kopi Susu Aren + 1x Croissant')
 *     .setItemCount(3)
 *     .setTotalAmount(45000, 'IDR')
 *     .setThumbnail('https://example.com/kopi.jpg');
 *
 *   await order.send('6281234567890@s.whatsapp.net');
 */
export class OrderMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._orderId = '';
    this._orderTitle = 'Order';
    this._message = '';
    this._itemCount = 1;
    this._status = proto.Message.OrderMessage.OrderStatus.INQUIRY;
    this._surface = proto.Message.OrderMessage.OrderSurface.CATALOG;
    this._sellerJid = '';
    this._token = '';
    this._totalAmount1000 = 0;
    this._totalCurrencyCode = 'IDR';
    this._thumbnail = null;
  }

  setOrderId(orderId) {
    this._orderId = String(orderId);
    return this;
  }

  setOrderTitle(title) {
    this._orderTitle = this._render(title);
    return this;
  }

  setMessage(message) {
    this._message = this._render(message);
    return this;
  }

  setItemCount(count) {
    const parsed = parseInt(count, 10);
    this._itemCount = isNaN(parsed) || parsed < 1 ? 1 : parsed;
    return this;
  }

  setStatus(status) {
    this._status = status;
    return this;
  }

  setSurface(surface) {
    this._surface = surface;
    return this;
  }

  setSeller(sellerJid) {
    this._sellerJid = sellerJid;
    return this;
  }

  setToken(token) {
    this._token = token;
    return this;
  }

  /**
   * Mengatur total pembayaran dalam satuan mata uang normal (misal 50000 untuk Rp50.000).
   * Otomatis dikalikan 1000 sesuai format internal proto WhatsApp.
   * @param {number} amount Nilai nominal
   * @param {string} [currency='IDR'] Kode mata uang (IDR, USD, dll)
   * @returns {OrderMessage}
   */
  setTotalAmount(amount, currency = 'IDR') {
    const num = Number(amount);
    if (isNaN(num) || num < 0) {
      throw new ContentValidationError('Total amount harus berupa angka valid');
    }
    this._totalAmount1000 = Math.round(num * 1000);
    this._totalCurrencyCode = currency;
    return this;
  }

  /**
   * Mengatur gambar thumbnail pesanan (URL, file path, atau Buffer).
   * Diproses secara aman dengan format JPEG 300x300 <=30KB.
   * @param {string|Buffer} source
   * @returns {OrderMessage}
   */
  setThumbnail(source) {
    this._thumbnail = source;
    return this;
  }

  async build(jid, options = {}) {
    const rawSock = this.#client;
    const sellerJid = this._sellerJid || rawSock.user?.id || '';

    let thumbnailBuffer = null;
    if (this._thumbnail) {
      thumbnailBuffer = await processThumbnailBuffer(this._thumbnail, {
        width: 300,
        height: 300,
        quality: 85,
        banner: false,
      });
    }

    const orderId = this._orderId || `order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const orderMessage = proto.Message.OrderMessage.fromObject({
      orderId,
      thumbnail: thumbnailBuffer || undefined,
      itemCount: this._itemCount,
      status: this._status,
      surface: this._surface,
      message: this._message || this._body || '',
      orderTitle: this._orderTitle || this._title || 'Order',
      sellerJid,
      token: this._token || '',
      totalAmount1000: this._totalAmount1000,
      totalCurrencyCode: this._totalCurrencyCode,
      contextInfo: {
        ...this._buildContextInfo(),
        ...(options.contextInfo || {}),
      },
    });

    const msgContent = proto.Message.create({
      orderMessage,
    });

    return generateWAMessageFromContent(jid, msgContent, {
      userJid: rawSock.user?.id,
      timestamp: options.timestamp || new Date(),
      quoted: options.quoted || this._quotedMessage || null,
      ephemeralExpiration: options.ephemeralExpiration || options.quoted?.expiration || 0,
      messageId: options.messageId || null,
    });
  }

  async send(jid, options = {}) {
    const rawSock = this.#client;
    if (!rawSock || typeof rawSock.relayMessage !== 'function') {
      throw new Error('Socket tidak valid atau tidak memiliki relayMessage');
    }

    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;

    const message = await this.build(targetJid, options);

    await rawSock.relayMessage(message.key.remoteJid, message.message, {
      messageId: message.key.id,
      ...options,
    });

    return message;
  }
}

export default OrderMessage;
