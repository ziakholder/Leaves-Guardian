import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError, DuplicateIdError, ItemNotFoundError } from '../errors.js';

/**
 * ListMessage — wrapper di atas InteractiveMessage (Native Flow: single_select) di Baileys.
 * Dipakai buat kirim menu/katalog dalam bentuk list pilihan yang kompatibel dengan WhatsApp modern.
 *
 * Contoh pakai:
 *   import { ListMessage } from 'leaves-guardian';
 *
 *   const list = new ListMessage(sock)
 *     .setTitle('Menu {{namaToko}}')
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
  }

  setButtonText(text) {
    this._buttonText = text;
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
  build() {
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

    return {
      interactiveMessage: {
        header: title ? { title, hasMediaAttachment: false } : undefined,
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
    const content = this.build();
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

export default ListMessage;
