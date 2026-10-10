import crypto from 'crypto';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';

/**
 * PollMessage — wrapper custom di atas proto.Message.PollCreationMessage (Baileys).
 * Dipakai buat kirim polling/voting sederhana ke user atau grup.
 *
 * Contoh pakai:
 *   const poll = new PollMessage(sock)
 *     .setTitle('Menu favorit hari ini apa?')
 *     .addOption('Nasi Goreng')
 *     .addOption('Mie Ayam')
 *     .addOption('Soto Ayam')
 *     .allowMultipleAnswers(false);
 *
 *   await poll.send('120363000000000000@g.us');
 */
class PollMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._options = [];
    this._selectableCount = 1; // 1 = single-select, 0 = multi-select (unlimited)
  }

  addOption(name) {
    if (this._options.length >= 12) {
      throw new ContentValidationError('Poll WhatsApp maksimal 12 opsi');
    }
    this._options.push(this._render(name));
    return this;
  }

  /** Alias untuk setTitle (pertanyaan polling) */
  setQuestion(question) {
    return this.setTitle(question);
  }

  /** Set jumlah opsi yang bisa dipilih */
  setSelectableCount(count) {
    this._selectableCount = Number(count);
    return this;
  }

  /** true = boleh pilih lebih dari 1, false = single-select (default) */
  allowMultipleAnswers(allow = true) {
    this._selectableCount = allow ? 0 : 1;
    return this;
  }

  build() {
    if (!this._title) {
      throw new ContentValidationError('Title/pertanyaan poll wajib diisi — pakai .setTitle()');
    }
    if (this._options.length < 2) {
      throw new ContentValidationError('Poll minimal butuh 2 opsi');
    }

    const { title } = this._renderAll();

    return {
      poll: {
        name: title,
        values: this._options,
        selectableCount: this._selectableCount,
        messageSecret: crypto.randomBytes(32),
      },
    };
  }

  async send(jid, options = {}) {
    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;
    const message = this.build();
    const sendOptions = { ...options };
    if (this._quotedMessage) {
      sendOptions.quoted = this._quotedMessage;
    }
    return await this.#client.sendMessage(targetJid, message, sendOptions);
  }
}

export default PollMessage;
