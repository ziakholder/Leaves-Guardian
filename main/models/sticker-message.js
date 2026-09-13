import fs from 'fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors/LeavesError.js';

/**
 * StickerMessage — Builder pengiriman stiker dengan metadata EXIF (Nama Pack & Author).
 * Otomatis mengonversi gambar (PNG, JPG, dll) ke format WebP 512x512 jika diperlukan.
 */
export class StickerMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    this.#client = BaseBuilder.resolveSocket(client);
    this._source = null;
    this._packName = 'Leaves Guardian';
    this._author = 'Royal Engine Studio';
    this._categories = ['🍃'];
  }

  setSource(source) {
    this._source = source;
    return this;
  }

  setPackName(name) {
    this._packName = name;
    return this;
  }

  setAuthor(author) {
    this._author = author;
    return this;
  }

  setCategories(categories) {
    this._categories = Array.isArray(categories) ? categories : [categories];
    return this;
  }

  /**
   * Builds custom WhatsApp EXIF metadata Buffer
   */
  static createExif(packName = 'Leaves Guardian', author = 'Royal Engine Studio', categories = ['🍃']) {
    const json = {
      'sticker-pack-id': `leaves_guardian_${Date.now()}`,
      'sticker-pack-name': packName,
      'sticker-pack-publisher': author,
      'emojis': categories,
    };

    const exifAttr = Buffer.from([
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
      0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
    ]);

    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const exif = Buffer.concat([exifAttr, jsonBuffer]);
    exif.writeUIntLE(jsonBuffer.length, 14, 4);

    return exif;
  }

  /**
   * Helper to attach EXIF metadata chunk to WebP buffer
   */
  static attachExifToWebp(webpBuffer, exifBuffer) {
    if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 12) return webpBuffer;
    
    // Check if valid RIFF WEBP
    const header = webpBuffer.subarray(0, 12);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WEBP') {
      return webpBuffer;
    }

    const buf = Buffer.from(webpBuffer);
    const exifPadding = exifBuffer.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    const exifChunk = Buffer.concat([
      Buffer.from('EXIF', 'ascii'),
      Buffer.alloc(4),
      exifBuffer,
      exifPadding,
    ]);
    exifChunk.writeUInt32LE(exifBuffer.length, 4);

    const firstChunkTag = buf.toString('ascii', 12, 16);
    if (firstChunkTag === 'VP8X') {
      // Set EXIF flag bit (bit 3 / 0x08) at offset 20
      buf[20] = buf[20] | 0x08;
      const newBuf = Buffer.concat([buf, exifChunk]);
      newBuf.writeUInt32LE(newBuf.length - 8, 4);
      return newBuf;
    }

    // Insert VP8X chunk (18 bytes total)
    const vp8xChunk = Buffer.alloc(18);
    vp8xChunk.write('VP8X', 0, 4, 'ascii');
    vp8xChunk.writeUInt32LE(10, 4);
    vp8xChunk[8] = 0x08; // EXIF bit
    vp8xChunk.writeUIntLE(511, 12, 3);
    vp8xChunk.writeUIntLE(511, 15, 3);

    const newBuf = Buffer.concat([
      buf.subarray(0, 12),
      vp8xChunk,
      buf.subarray(12),
      exifChunk,
    ]);
    newBuf.writeUInt32LE(newBuf.length - 8, 4);
    return newBuf;
  }

  /**
   * Helper to convert an image buffer to 512x512 WebP if not already in proper WebP format
   */
  static async convertToWebp(buffer) {
    if (
      Buffer.isBuffer(buffer) &&
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return buffer;
    }

    try {
      const img = await loadImage(buffer);
      const canvas = createCanvas(512, 512);
      const ctx = canvas.getContext('2d');

      // Calculate scale to fit inside 512x512 while keeping aspect ratio
      const scale = Math.min(512 / img.width, 512 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (512 - w) / 2;
      const y = (512 - h) / 2;

      ctx.clearRect(0, 0, 512, 512);
      ctx.drawImage(img, x, y, w, h);

      return await canvas.encode('webp');
    } catch {
      return buffer;
    }
  }

  async build() {
    if (!this._source) {
      throw new ContentValidationError('Source stiker wajib diisi — gunakan .setSource(buffer | url | filePath)');
    }

    let buffer;
    if (Buffer.isBuffer(this._source)) {
      buffer = this._source;
    } else if (typeof this._source === 'string' && /^https?:\/\//i.test(this._source)) {
      try {
        const res = await fetch(this._source);
        if (!res.ok) throw new ContentValidationError(`Gagal mengambil media stiker dari URL: HTTP ${res.status}`);
        buffer = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof ContentValidationError) throw err;
        throw new ContentValidationError(`Gagal mengunduh stiker dari URL: ${err.message}`);
      }
    } else if (typeof this._source === 'string') {
      try {
        buffer = await fs.readFile(this._source);
      } catch {
        buffer = Buffer.from(this._source, 'base64');
      }
    }

    // Convert to 512x512 WebP if needed
    const webpBuffer = await StickerMessage.convertToWebp(buffer);

    const exif = StickerMessage.createExif(
      this._render(this._packName),
      this._render(this._author),
      this._categories
    );

    const finalWebp = StickerMessage.attachExifToWebp(webpBuffer, exif);

    return {
      sticker: finalWebp,
      mimetype: 'image/webp',
      contextInfo: this._buildContextInfo(),
    };
  }

  async send(jid, options = {}) {
    if (!this.#client) {
      throw new Error('Client / Socket belum di-pass ke StickerMessage constructor');
    }
    const message = await this.build();
    const sendOpts = { ...options };
    if (this._quotedMessage) {
      sendOpts.quoted = this._quotedMessage;
    }
    return await this.#client.sendMessage(jid, message, sendOpts);
  }
}

export default StickerMessage;

