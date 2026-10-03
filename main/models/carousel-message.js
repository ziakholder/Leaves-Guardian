import { generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError, DuplicateIdError } from '../errors.js';

/**
 * CarouselCard — satu kartu di dalam Carousel. Dibuat lewat CarouselMessage.newCard(),
 * bukan langsung di-instantiate.
 */
class CarouselCard {
  #render;

  constructor(renderFn) {
    this.#render = renderFn;
    this._title = '';
    this._body = '';
    this._footer = '';
    this._image = null;
    this._buttons = [];
  }

  setTitle(title) {
    this._title = title;
    return this;
  }

  setBody(body) {
    this._body = body;
    return this;
  }

  setFooter(footer) {
    this._footer = footer;
    return this;
  }

  setImage(source) {
    this._image = source;
    return this;
  }

  addReply(displayText, id) {
    this._buttons.push({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: this.#render(displayText), id }),
    });
    return this;
  }

  addUrl(displayText, url) {
    this._buttons.push({
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({ display_text: this.#render(displayText), url }),
    });
    return this;
  }

  addCopy(displayText, copyCode) {
    this._buttons.push({
      name: 'cta_copy',
      buttonParamsJson: JSON.stringify({ display_text: this.#render(displayText), copy_code: copyCode }),
    });
    return this;
  }
}

/**
 * CarouselMessage — Builder kartu geser (Carousel) interaktif untuk WhatsApp.
 * Menampilkan beberapa kartu horizontal yang bisa digeser oleh user di Android, iOS, maupun WhatsApp Web/Desktop.
 *
 * Contoh pakai:
 *   const carousel = new CarouselMessage(sock)
 *     .setBody('Halo {{nama}}, ini menu promo minggu ini')
 *     .setVars({ nama: 'Rafa' });
 *
 *   carousel.newCard('nasgor')
 *     .setTitle('Nasi Goreng')
 *     .setImage('https://example.com/nasgor.jpg')
 *     .setBody('Rp15.000')
 *     .addReply('Pesan', 'order_nasgor');
 *
 *   carousel.newCard('mieayam')
 *     .setTitle('Mie Ayam')
 *     .setImage('https://example.com/mieayam.jpg')
 *     .setBody('Rp13.000')
 *     .addReply('Pesan', 'order_mieayam');
 *
 *   await carousel.send('6281234567890@s.whatsapp.net');
 */
class CarouselMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._cards = new Map();
  }

  /** Tambah card baru lewat callback atau instance (chainable ke CarouselMessage) */
  addCard(cardOrFn) {
    const cardId = `card_${this._cards.size + 1}`;
    const card = new CarouselCard((text) => this._render(text));
    if (typeof cardOrFn === 'function') {
      cardOrFn(card);
    }
    this._cards.set(cardId, card);
    return this;
  }

  /** Bikin card baru dengan id unik, return instance CarouselCard untuk di-chain */
  newCard(id) {
    if (this._cards.has(id)) {
      throw new DuplicateIdError(id);
    }
    const card = new CarouselCard((text) => this._render(text));
    this._cards.set(id, card);
    return card;
  }

  async build() {
    if (this._cards.size < 2) {
      throw new ContentValidationError('Carousel minimal butuh 2 card (kalau cuma 1, pakai ButtonMessage biasa)');
    }

    const { body, footer } = this._renderAll();

    const cards = await Promise.all(
      [...this._cards.values()].map(async (card) => {
        let header = { hasMediaAttachment: false };
        if (card._image) {
          const media = await prepareWAMessageMedia(
            { image: Buffer.isBuffer(card._image) ? card._image : { url: card._image } },
            { upload: this.#client.waUploadToServer }
          );
          header = {
            title: card._title ? this._render(card._title) : '',
            hasMediaAttachment: true,
            imageMessage: media.imageMessage,
          };
        } else if (card._title) {
          header = {
            title: this._render(card._title),
            hasMediaAttachment: false,
          };
        }

        return {
          header,
          body: { text: this._render(card._body) },
          footer: card._footer ? { text: this._render(card._footer) } : undefined,
          nativeFlowMessage: {
            buttons: card._buttons,
            messageParamsJson: '',
          },
        };
      })
    );

    return {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage: {
            header: { hasMediaAttachment: false },
            body: { text: body },
            footer: footer ? { text: footer } : undefined,
            carouselMessage: {
              cards,
              messageVersion: 1,
            },
            contextInfo: this._contextInfo,
          },
        },
      },
    };
  }

  async send(jid, options = {}) {
    const { default: resolveLidToPn } = await import('../helpers/lid-resolver.js');
    const targetJid = resolveLidToPn(jid);
    const content = await this.build();

    const msg = generateWAMessageFromContent(
      targetJid,
      content,
      { userJid: this.#client.user?.id, ...options }
    );

    const isGroup = targetJid.endsWith('@g.us');
    const additionalNodes = [
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
      ...(isGroup
        ? []
        : [
            {
              tag: 'bot',
              attrs: { biz_bot: '1' },
            },
          ]),
    ];

    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      additionalNodes,
    });

    return msg;
  }
}

export default CarouselMessage;
