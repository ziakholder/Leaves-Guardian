import { generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import crypto from 'crypto';
import fs from 'fs';
import BaseBuilder from './base-builder.js';
import { ContentValidationError, DuplicateIdError, ItemNotFoundError } from '../errors.js';
import { resolveLidToPn } from '../helpers/lid-resolver.js';

/**
 * ListMessage — wrapper di atas InteractiveMessage (Native Flow: single_select) di Baileys.
 * Dipakai buat kirim menu/katalog dalam bentuk list pilihan yang kompatibel dengan WhatsApp modern.
 *
 * Contoh pakai:
 *   import { ListMessage } from 'leaves-guardian';
 *
 *   const list = new ListMessage(sock)
 *     .setTitle('Menu {{namaToko}}')
 *     .setImage('https://example.com/banner.jpg')
 *     .setBody('Halo {{nama}}, silakan pilih menu favoritmu 🍃')
 *     .setButtonText('Lihat Menu')
 *     .setVars({ namaToko: 'Royal Store', nama: 'Rafa' })
 *     .addSection('Makanan', [
 *        { title: 'Nasi Goreng', description: 'Rp15.000', id: 'menu_nasgor' },
 *        { title: 'Mie Ayam', description: 'Rp13.000', id: 'menu_mieayam' },
 *     ]);
 *
 *   await list.send('6281234567890@s.whatsapp.net');
 */
class ListMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._buttonText = 'Pilih';
    this._sections = [];
    this._media = null;
    this._mediaType = null;
    this._mediaOptions = {};
  }

  setButtonText(text) {
    this._buttonText = text;
    return this;
  }

  /** Tambah gambar header banner */
  setImage(pathOrBuffer) {
    this._media = pathOrBuffer;
    this._mediaType = 'image';
    return this;
  }

  /** Tambah video header */
  setVideo(pathOrBuffer) {
    this._media = pathOrBuffer;
    this._mediaType = 'video';
    return this;
  }

  /** Tambah dokumen header */
  setDocument(pathOrBuffer, { fileName = 'document', mimetype = 'application/octet-stream' } = {}) {
    this._media = pathOrBuffer;
    this._mediaType = 'document';
    this._mediaOptions = { fileName, mimetype };
    return this;
  }

  /**
   * Tambah satu section berisi beberapa row (item menu).
   * rows: array of { title, description, id, header }
   * title/description otomatis kena text templating juga.
   */
  addSection(sectionTitle, rows = []) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ContentValidationError('Section harus punya minimal 1 row', { sectionTitle });
    }

    const existingIds = this._sections.flatMap((s) => s.rows.map((r) => r.rowId));
    for (const row of rows) {
      if (existingIds.includes(row.id)) {
        throw new DuplicateIdError(row.id);
      }
    }

    this._sections.push({
      title: this._render(sectionTitle),
      rows: rows.map((row) => ({
        header: this._render(row.header || ''),
        title: this._render(row.title),
        description: this._render(row.description || ''),
        rowId: row.id,
      })),
    });

    return this;
  }

  /** Cari row berdasarkan id. Lempar ItemNotFoundError kalau tidak ketemu. */
  findRow(id) {
    for (const section of this._sections) {
      const row = section.rows.find((r) => r.rowId === id);
      if (row) return row;
    }
    const availableIds = this._sections.flatMap((s) => s.rows.map((r) => r.rowId));
    throw new ItemNotFoundError(id, availableIds);
  }

  /** Rakit jadi payload Baileys modern (Interactive single_select) */
  async build() {
    const { title, body, footer } = this._renderAll();

    const sections = this._sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        header: r.header || '',
        title: r.title,
        description: r.description || '',
        id: r.rowId,
      })),
    }));

    const buttonParamsJson = JSON.stringify({
      title: this._render(this._buttonText),
      sections,
    });

    let header = { hasMediaAttachment: false };
    if (this._media) {
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
          const canvas = createCanvas(300, 170);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 300, 170);
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
          buttons: [
            {
              name: 'single_select',
              buttonParamsJson,
            },
          ],
        },
        contextInfo: this._buildContextInfo(),
      },
    };
  }

  async send(jid, options = {}) {
    if (this._sections.length === 0) {
      throw new ContentValidationError('Minimal 1 section sebelum send()');
    }
    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;
    const content = await this.build();
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

    const wrappedContent = {
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

    const isGroup = typeof targetJid === 'string' && targetJid.endsWith('@g.us');
    const additionalNodes = [
      {
        tag: 'biz',
        attrs: {},
        content: [{
          tag: 'interactive',
          attrs: {
            type: 'native_flow',
            v: '1',
          },
          content: [{
            tag: 'native_flow',
            attrs: {
              v: '9',
              name: 'mixed',
            },
          }],
        }],
      },
    ];

    if (!isGroup) {
      additionalNodes.push({
        tag: 'bot',
        attrs: { biz_bot: '1' },
      });
    }

    const msg = generateWAMessageFromContent(targetJid, wrappedContent, sendOpts);

    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      additionalNodes,
    });

    return msg;
  }
}

export default ListMessage;
