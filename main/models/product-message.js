import { generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';
import { resolveLidToPn } from '../helpers/lid-resolver.js';

/**
 * ProductMessage — Builder kartu produk interaktif untuk WhatsApp.
 * Menampilkan foto produk, judul, harga berformat mata uang, deskripsi, dan tombol pesan/beli.
 * Bekerja secara universal di semua jenis akun WhatsApp (Personal maupun Business).
 *
 * Contoh pakai:
 *   const product = new ProductMessage(sock)
 *     .setTitle('Nasi Goreng Spesial')
 *     .setDescription('Porsi jumbo, pedas sesuai selera')
 *     .setPrice(15000, 'IDR')
 *     .setImage('https://example.com/nasgor.jpg')
 *     .setRetailerId('menu_nasgor_001')
 *     .setButtonText('Pesan Sekarang')
 *     .setVars({ nama: 'Rafa' });
 *
 *   await product.send('6281234567890@s.whatsapp.net');
 */
class ProductMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._productImage = null;
    this._priceAmount = 0;
    this._currencyCode = 'IDR';
    this._retailerId = '';
    this._url = '';
    this._buttonText = 'Beli Sekarang';
    this._useBusinessCatalog = false;
  }

  setDescription(desc) {
    this._description = desc;
    return this;
  }

  /**
   * Set harga produk dalam satuan normal.
   * Contoh: setPrice(15000, 'IDR') -> Rp15.000
   */
  setPrice(amount, currencyCode = 'IDR') {
    if (typeof amount !== 'number' || amount < 0) {
      throw new ContentValidationError('Price harus berupa angka positif');
    }
    this._priceAmount = amount;
    this._currencyCode = currencyCode;
    return this;
  }

  setImage(source) {
    this._productImage = source;
    return this;
  }

  /** ID unik produk untuk tracking pesanan */
  setRetailerId(id) {
    this._retailerId = id;
    return this;
  }

  /** Link ke halaman web toko / produk */
  setUrl(url) {
    this._url = url;
    return this;
  }

  /** Teks pada tombol aksi (default: 'Beli Sekarang') */
  setButtonText(text) {
    this._buttonText = text;
    return this;
  }

  /** JID penjual / seller toko */
  setSeller(jid) {
    this._sellerJid = jid;
    return this;
  }

  /**
   * Aktifkan jika akun Anda adalah WhatsApp Business dengan katalog resmi Meta
   */
  useBusinessCatalog(value = true) {
    this._useBusinessCatalog = Boolean(value);
    return this;
  }

  static formatPrice(amount, currency = 'IDR') {
    if (currency === 'IDR') {
      return 'Rp ' + Number(amount).toLocaleString('id-ID');
    }
    return `${currency} ${amount}`;
  }

  async build() {
    if (!this._title) {
      throw new ContentValidationError('Title produk wajib diisi — pakai .setTitle()');
    }
    if (!this._productImage) {
      throw new ContentValidationError('Image produk wajib diisi — pakai .setImage()');
    }

    const { title, body, footer } = this._renderAll();
    const renderedDesc = this._render(this._description || '');
    const priceText = this._priceAmount ? ProductMessage.formatPrice(this._priceAmount, this._currencyCode) : '';

    if (this._useBusinessCatalog) {
      const media = await prepareWAMessageMedia(
        { image: Buffer.isBuffer(this._productImage) ? this._productImage : { url: this._productImage } },
        { upload: this.#client.waUploadToServer }
      );
      return {
        text: body,
        contextInfo: this._contextInfo,
        productMessage: {
          product: {
            productImage: media.imageMessage,
            productId: this._retailerId,
            title,
            description: renderedDesc,
            currencyCode: this._currencyCode,
            priceAmount1000: Math.round(this._priceAmount * 1000),
            retailerId: this._retailerId,
            url: this._url,
          },
          businessOwnerJid: this.#client.user?.id,
        },
      };
    }

    const media = await prepareWAMessageMedia(
      { image: Buffer.isBuffer(this._productImage) ? this._productImage : { url: this._productImage } },
      { upload: this.#client.waUploadToServer }
    );

    const bodySections = [];
    if (priceText) bodySections.push(`🏷️ *Harga:* ${priceText}`);
    if (renderedDesc) bodySections.push(renderedDesc);
    if (body) bodySections.push(body);

    const buttons = [];
    const btnLabel = this._render(this._buttonText);

    if (this._url) {
      buttons.push({
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({ display_text: btnLabel, url: this._url }),
      });
    } else {
      buttons.push({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: btnLabel,
          id: `order_${this._retailerId || 'item'}`,
        }),
      });
    }

    return {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: {
              title: `🛍️ ${title}`,
              hasMediaAttachment: true,
              imageMessage: media.imageMessage,
            },
            body: { text: bodySections.join('\n\n') },
            footer: footer ? { text: footer } : undefined,
            nativeFlowMessage: {
              buttons,
            },
            contextInfo: this._contextInfo,
          },
        },
      },
    };
  }

  async send(jid, options = {}) {
    const targetJid = resolveLidToPn(jid);
    const content = await this.build();
    const payload = content.viewOnceMessage ? content : content;
    const msg = generateWAMessageFromContent(targetJid, payload, { userJid: this.#client.user?.id, ...options });

    if (this._useBusinessCatalog) {
      await this.#client.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
    } else {
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
    }

    return msg;
  }
}

export default ProductMessage;
