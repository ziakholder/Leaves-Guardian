import BaseBuilder from './base-builder.js';
import resolveMedia from '../helpers/media-resolver.js';
import { ContentValidationError } from '../errors.js';

const VALID_TYPES = ['image', 'video', 'document', 'sticker', 'audio'];

/**
 * MediaMessage — wrapper terpadu untuk imageMessage/videoMessage/documentMessage/
 * stickerMessage/audioMessage. Satu class buat semua tipe media, tinggal set
 * tipe-nya lewat constructor atau method setType().
 *
 * Contoh pakai:
 *   const media = new MediaMessage(sock, 'image')
 *     .setSource('https://example.com/produk.jpg')
 *     .setBody('Halo {{nama}}, ini foto produknya 📸')
 *     .setVars({ nama: 'Rafa' });
 *
 *   await media.send('6281234567890@s.whatsapp.net');
 *
 *   // Document butuh nama file
 *   const doc = new MediaMessage(sock, 'document')
 *     .setSource(pdfBuffer)
 *     .setFileName('invoice.pdf')
 *     .setMimetype('application/pdf');
 *
 *   await doc.send(jid);
 */
class MediaMessage extends BaseBuilder {
  #client;

  constructor(client, type = 'image') {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    if (!VALID_TYPES.includes(type)) {
      throw new ContentValidationError(`Tipe media "${type}" tidak valid. Pilihan: ${VALID_TYPES.join(', ')}`);
    }
    this.#client = BaseBuilder.resolveSocket(client);
    this._type = type;
    this._source = null;
    this._fileName = null;
    this._mimetype = null;
    this._ptt = false; // voice note flag khusus audio
    this._gifPlayback = false; // khusus video yang mau dikirim sebagai GIF
  }

  setType(type) {
    if (!VALID_TYPES.includes(type)) {
      throw new ContentValidationError(`Tipe media "${type}" tidak valid. Pilihan: ${VALID_TYPES.join(', ')}`);
    }
    this._type = type;
    return this;
  }

  /** source bisa url, Buffer, atau base64 string */
  setSource(source) {
    this._source = source;
    return this;
  }

  /** Wajib diisi untuk type 'document' */
  setFileName(name) {
    this._fileName = name;
    return this;
  }

  setMimetype(mimetype) {
    this._mimetype = mimetype;
    return this;
  }

  /** Tandai audio sebagai voice note (bulat, bukan file audio biasa) */
  asVoiceNote() {
    if (this._type !== 'audio') {
      throw new ContentValidationError('asVoiceNote() cuma berlaku untuk type "audio"');
    }
    this._ptt = true;
    return this;
  }

  /** Tandai video untuk diputar sebagai GIF (autoplay, loop, no sound controls) */
  asGif() {
    if (this._type !== 'video') {
      throw new ContentValidationError('asGif() cuma berlaku untuk type "video"');
    }
    this._gifPlayback = true;
    return this;
  }

  async build() {
    if (!this._source) {
      throw new ContentValidationError('Source media wajib diisi — pakai .setSource()');
    }
    if (this._type === 'document' && !this._fileName) {
      throw new ContentValidationError('Document wajib punya fileName — pakai .setFileName()');
    }

    const { body } = this._renderAll();
    const resolvedUrl = await resolveMedia(this.#client, this._source, this._type, { result: 'url' });

    const payload = {
      [this._type]: { url: resolvedUrl },
      caption: this._type !== 'sticker' && this._type !== 'audio' ? body : undefined,
      contextInfo: this._buildContextInfo(),
    };

    if (this._type === 'document') {
      payload.fileName = this._fileName;
      if (this._mimetype) payload.mimetype = this._mimetype;
    }
    if (this._type === 'audio') {
      payload.ptt = this._ptt;
      if (this._mimetype) payload.mimetype = this._mimetype;
    }
    if (this._type === 'video') {
      payload.gifPlayback = this._gifPlayback;
    }

    return payload;
  }

  async send(jid, options = {}) {
    const { default: resolveLidToPn } = await import('../helpers/lid-resolver.js');
    const targetJid = resolveLidToPn(jid);
    const message = await this.build();
    const sendOptions = { ...options };
    if (this._quotedMessage) {
      sendOptions.quoted = this._quotedMessage;
    }
    return await this.#client.sendMessage(targetJid, message, sendOptions);
  }
}

export default MediaMessage;
