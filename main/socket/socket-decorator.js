import ButtonMessage from '../models/button-message.js';
import ButtonMessageV2, { ButtonV2 } from '../models/button-message-v2.js';
import CarouselMessage from '../models/carousel-message.js';
import AIRichMessage from '../models/ai-rich-message.js';
import AlbumMessage from '../models/album-message.js';
import OrderMessage from '../models/order-message.js';
import StickerPackMessage from '../models/sticker-pack-message.js';
import ListMessage from '../models/list-message.js';
import TextMessage from '../models/text-message.js';
import MediaMessage from '../models/media-message.js';
import ProductMessage from '../models/product-message.js';
import PollMessage from '../models/poll-message.js';
import StickerMessage from '../models/sticker-message.js';
import A2UIMessage from '../models/a2ui-message.js';
import CanvasMessage from '../models/canvas-message.js';
import { getPNFromLid, getLidFromPN } from '../helpers/lid-resolver.js';

/**
 * Membuat proxy fluent chaining builder untuk menyusun berbagai jenis pesan WhatsApp.
 *
 * @param {Object} socket Socket Baileys
 * @param {string} jid Target WhatsApp JID
 * @param {Object} [options]
 * @returns {Proxy}
 */
export function createMessageBuilder(socket, jid, options = {}) {
  let currentInstancePromise = null;

  const handler = {
    get(target, propKey) {
      if (propKey === 'then') return undefined;

      if (propKey === 'setType') {
        return function(type) {
          currentInstancePromise = Promise.resolve().then(async () => {
            const t = String(type).toLowerCase();
            if (t === 'button') return new ButtonMessage(socket);
            if (t === 'buttonv2' || t === 'legacybutton') return new ButtonMessageV2(socket);
            if (t === 'carousel') return new CarouselMessage(socket);
            if (t === 'canvas') return new CanvasMessage(socket);
            if (t === 'airich' || t === 'ai' || t === 'html') return new AIRichMessage(socket);
            if (t === 'album') return new AlbumMessage(socket);
            if (t === 'order') return new OrderMessage(socket);
            if (t === 'stickerpack') return new StickerPackMessage(socket);
            if (t === 'list') return new ListMessage(socket);
            if (t === 'text') return new TextMessage(socket);
            if (t === 'media') return new MediaMessage(socket);
            if (t === 'product') return new ProductMessage(socket);
            if (t === 'poll') return new PollMessage(socket);
            if (t === 'sticker') return new StickerMessage(socket);
            if (t === 'a2ui') return new A2UIMessage(socket);
            throw new Error(`MessageBuilder type "${type}" tidak dikenali.`);
          });
          return proxy;
        };
      }

      if (propKey === 'send') {
        return async function() {
          if (!currentInstancePromise) {
            throw new Error('Panggil .setType() terlebih dahulu sebelum .send()');
          }
          const instance = await currentInstancePromise;
          return instance.send(jid, options);
        };
      }

      return function(...args) {
        if (!currentInstancePromise) {
          throw new Error(`Panggil .setType() terlebih dahulu sebelum .${propKey}()`);
        }

        currentInstancePromise = currentInstancePromise.then(async (instance) => {
          if (typeof instance[propKey] !== 'function') {
            throw new TypeError(`Method .${propKey}() tidak tersedia di builder ini.`);
          }
          const res = await instance[propKey](...args);
          return (res && typeof res === 'object') ? res : instance;
        });

        return proxy;
      };
    },
  };

  const proxy = new Proxy({}, handler);
  return proxy;
}

/**
 * Menghias instance socket Baileys dengan method-method ekstensi tingkat lanjut:
 * sendAlbum, sendOrder, sendButton, sendCard, sendStickerPack, sendSticker,
 * messageBuilder, getPNFromLid, getLidFromPN.
 *
 * @param {Object} socket Instance Baileys socket
 * @returns {Object} Instance socket yang telah diinjeksi
 */
export function decorateSocket(socket) {
  if (!socket || typeof socket !== 'object') return socket;

  socket.messageBuilder = function(jid, options = {}) {
    return createMessageBuilder(socket, jid, options);
  };

  socket.sendAlbum = async function(jid, items = [], options = {}) {
    const album = new AlbumMessage(socket).setItems(items);
    return album.send(jid, options);
  };

  socket.sendOrder = async function(jid, orderData = {}, options = {}) {
    const order = new OrderMessage(socket);
    if (orderData.orderId) order.setOrderId(orderData.orderId);
    if (orderData.orderTitle) order.setOrderTitle(orderData.orderTitle);
    if (orderData.message) order.setMessage(orderData.message);
    if (orderData.itemCount) order.setItemCount(orderData.itemCount);
    if (orderData.status !== undefined) order.setStatus(orderData.status);
    if (orderData.surface !== undefined) order.setSurface(orderData.surface);
    if (orderData.sellerJid) order.setSeller(orderData.sellerJid);
    if (orderData.token) order.setToken(orderData.token);
    if (orderData.thumbnail) order.setThumbnail(orderData.thumbnail);
    if (orderData.totalAmount !== undefined) {
      order.setTotalAmount(orderData.totalAmount, orderData.totalCurrencyCode || 'IDR');
    } else if (orderData.totalAmount1000 !== undefined) {
      order.setTotalAmount(orderData.totalAmount1000 / 1000, orderData.totalCurrencyCode || 'IDR');
    }
    return order.send(jid, options);
  };

  socket.sendCard = async function(jid, options = {}) {
    const { text = '', footer = '', cards = [], quoted = null } = options;
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new Error('sendCard memerlukan properti cards berupa array yang tidak kosong');
    }
    const carousel = new CarouselMessage(socket)
      .setBody(text)
      .setFooter(footer);
    if (quoted) carousel.quote(quoted);

    for (let i = 0; i < cards.length; i++) {
      const item = cards[i];
      const card = carousel.newCard(`card_${i + 1}`);
      if (item.caption || item.title) card.setTitle(item.caption || item.title);
      if (item.image) card.setImage(item.image);
      if (item.body) card.setBody(item.body);
      if (item.footer) card.setFooter(item.footer);

      if (Array.isArray(item.buttons)) {
        for (const btn of item.buttons) {
          if (btn.name === 'cta_url' || btn.url) {
            const params = typeof btn.buttonParamsJson === 'string'
              ? JSON.parse(btn.buttonParamsJson)
              : (btn.buttonParamsJson || btn);
            card.addUrl(params.display_text || params.text || 'Link', params.url);
          } else if (btn.name === 'cta_copy' || btn.copy_code || btn.copyCode) {
            const params = typeof btn.buttonParamsJson === 'string'
              ? JSON.parse(btn.buttonParamsJson)
              : (btn.buttonParamsJson || btn);
            card.addCopy(params.display_text || params.text || 'Copy', params.copy_code || params.copyCode);
          } else {
            const params = typeof btn.buttonParamsJson === 'string'
              ? JSON.parse(btn.buttonParamsJson)
              : (btn.buttonParamsJson || btn);
            card.addReply(params.display_text || params.text || btn.text || 'Pilih', params.id || btn.id || `card_btn_${i}`);
          }
        }
      }
    }
    return carousel.send(jid, options);
  };

  socket.sendButton = async function(jid, content = {}, options = {}) {
    const btn = new ButtonMessage(socket);
    if (content.title) btn.setTitle(content.title);
    if (content.text || content.body || content.caption) {
      btn.setBody(content.text || content.body || content.caption);
    }
    if (content.footer) btn.setFooter(content.footer);
    if (options.quoted || content.quoted) btn.quote(options.quoted || content.quoted);

    if (content.image) btn.setImage(content.image);
    else if (content.video) btn.setVideo(content.video);
    else if (content.document) {
      btn.setDocument(content.document, { fileName: content.fileName, mimetype: content.mimetype });
    } else if (content.location) {
      btn.setLocation(content.location);
    }

    if (content.bottom_sheet) {
      btn.addBottomSheet(content.bottom_name || 'Menu');
    }
    if (content.limited_time_offer) {
      btn.addLimitedOffer(content.limited_time_offer_text || 'Promo Terbatas', {
        url: content.limited_time_offer_url || 'https://whatsapp.com',
        copy_code: content.limited_time_offer_code || '',
      });
    }

    if (Array.isArray(content.buttons)) {
      for (let i = 0; i < content.buttons.length; i++) {
        const b = content.buttons[i];
        if (b.name === 'cta_url' || b.url) {
          btn.addUrl(b.displayText || b.text || b.display_text || 'Link', b.url);
        } else if (b.name === 'cta_copy' || b.copyCode || b.copy_code) {
          btn.addCopy(b.displayText || b.text || b.display_text || 'Salin', b.copyCode || b.copy_code);
        } else if (typeof b === 'object' && b.name && b.buttonParamsJson) {
          btn.addButton(b.name, b.buttonParamsJson);
        } else {
          const text = typeof b === 'string' ? b : (b.displayText || b.text || b.display_text || `Button ${i + 1}`);
          const id = typeof b === 'string' ? `btn_${i + 1}` : (b.id || b.buttonId || `btn_${i + 1}`);
          btn.addReply(text, id);
        }
      }
    }

    if (content.contextInfo) {
      btn.setContextInfo(content.contextInfo);
    }

    return btn.send(jid, options);
  };

  socket.sendStickerPack = async function(jid, packData = {}, options = {}) {
    const pack = new StickerPackMessage(socket);
    if (packData.name) pack.setName(packData.name);
    if (packData.publisher) pack.setPublisher(packData.publisher);
    if (packData.description) pack.setDescription(packData.description);
    if (packData.cover) pack.setCover(packData.cover);
    if (Array.isArray(packData.stickers)) pack.setStickers(packData.stickers);
    return pack.send(jid, options);
  };

  socket.sendSticker = async function(jid, options = {}, other = {}) {
    const source = options.sticker || options.source || options;
    const sticker = new StickerMessage(socket).setSource(source);
    if (options.packname || options.pack) sticker.setPackName(options.packname || options.pack);
    if (options.author) sticker.setAuthor(options.author);
    if (options.categories || options.emojis) sticker.setCategories(options.categories || options.emojis);
    if (options.contextInfo) sticker.setContextInfo(options.contextInfo);
    return sticker.send(jid, other);
  };

  socket.sendCanvas = async function(jid, options = {}, other = {}) {
    const canvas = new CanvasMessage(socket);
    if (typeof options === 'string') {
      canvas.setHtml(options);
    } else if (typeof options === 'object') {
      if (options.title) canvas.setTitle(options.title);
      if (options.html) canvas.setHtml(options.html);
      if (options.body) canvas.setBody(options.body);
      if (options.footer) canvas.setFooter(options.footer);
      if (options.quoted) canvas.quote(options.quoted);
      if (Array.isArray(options.tabs)) {
        for (const t of options.tabs) {
          canvas.addTab(t.id || t.title, t.title || t.id, t.html || t.content || '');
        }
      }
    }
    return canvas.send(jid, other);
  };

  socket.getPNFromLid = async function(m, lidInput) {
    return getPNFromLid(m, lidInput, socket);
  };

  socket.getLidFromPN = async function(m, jidInput) {
    return getLidFromPN(m, jidInput, socket);
  };

  return socket;
}

export const addProperty = decorateSocket;
export default decorateSocket;
