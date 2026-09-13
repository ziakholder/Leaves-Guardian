import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';

/**
 * RichMessage — Builder pesan terstruktur dan berformat rapi untuk WhatsApp.
 * Menampilkan teks, tabel ringkas/monospace, blok kode yang bersih, dan tips berformat quote.
 *
 * Contoh pakai:
 *   const rich = new RichMessage(sock)
 *     .setTitle('Laporan Sistem')
 *     .setVars({ nama: 'Rafa' })
 *     .addText('Halo {{nama}}, berikut status server:')
 *     .addTable([
 *        ['Metric', 'Value'],
 *        ['Uptime', '1h 31m'],
 *        ['RAM', '63.2%'],
 *     ])
 *     .addCode('javascript', 'const status = "ONLINE";')
 *     .addTip('Gunakan command .help untuk bantuan');
 *
 *   await rich.send('6281234567890@s.whatsapp.net');
 */
class RichMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._elements = [];
  }

  /** Tambah header / judul besar pada pesan rich */
  addHeader(text) {
    return this.setTitle(text);
  }

  /** Tambah teks biasa atau paragraf (mendukung variabel {{namaVar}}) */
  addText(text) {
    if (typeof text !== 'string') throw new TypeError('Text harus berupa string');
    this._elements.push({ type: 'text', content: text });
    return this;
  }

  /**
   * Tambah tabel terstruktur. Mendukung format addTable([headers, ...rows]) atau addTable(headers, rows).
   */
  addTable(headersOrTable, rowsOrOpts = {}, opts = {}) {
    let table = headersOrTable;
    let style = 'list';
    if (Array.isArray(rowsOrOpts)) {
      table = [headersOrTable, ...rowsOrOpts];
      style = opts.style || 'list';
    } else if (typeof rowsOrOpts === 'object' && rowsOrOpts !== null) {
      style = rowsOrOpts.style || 'list';
    }
    if (!Array.isArray(table) || table.length < 1) {
      throw new ContentValidationError('Table harus berupa array baris dengan minimal 1 baris header');
    }
    this._elements.push({ type: 'table', content: table, style });
    return this;
  }

  /**
   * Tambah blok kode yang bersih
   * @param {string} [language] - Nama bahasa pemrograman (cth: 'javascript', 'python', 'json')
   * @param {string} code - Kode sumber
   */
  addCode(language, code) {
    if (code === undefined) {
      code = language;
      language = '';
    }
    if (typeof code !== 'string') {
      throw new TypeError('Code harus berupa string');
    }
    this._elements.push({ type: 'code', language: language || '', content: code });
    return this;
  }

  /**
   * Tambah catatan kecil / tips berformat quote di bagian bawah
   * @param {string} text - Pesan tip
   */
  addTip(text) {
    if (typeof text !== 'string') throw new TypeError('Tip harus berupa string');
    this._elements.push({ type: 'tip', content: text });
    return this;
  }

  /** Format tabel ke style bullet card yang elegan dan ramah font mobile */
  static formatTableList(tableData) {
    if (!tableData || tableData.length === 0) return '';
    const [header, ...rows] = tableData;

    // Jika tabel 2 kolom (contoh: Metric - Value)
    if (header.length === 2) {
      return rows
        .map((row) => `• *${row[0] || '-'}* : ${row[1] || '-'}`)
        .join('\n');
    }

    // Jika tabel >2 kolom
    return rows
      .map((row, idx) => {
        const itemLines = row.map((val, cIdx) => `  ▫️ _${header[cIdx] || 'Col'}_: ${val}`);
        return `*#${idx + 1}*\n${itemLines.join('\n')}`;
      })
      .join('\n\n');
  }

  /** Format tabel ke style ASCII standard (anti broken-font) */
  static formatTableAscii(tableData) {
    if (!tableData || tableData.length === 0) return '';
    const colCount = Math.max(...tableData.map((row) => row.length));
    const normalized = tableData.map((row) => {
      const copy = row.map((cell) => String(cell ?? ''));
      while (copy.length < colCount) copy.push('');
      return copy;
    });

    const colWidths = Array.from({ length: colCount }, (_, colIdx) => {
      return Math.max(...normalized.map((row) => row[colIdx].length), 1);
    });

    const pad = (str, len) => str + ' '.repeat(Math.max(0, len - str.length));

    const [header, ...rows] = normalized;
    const headerLine = header.map((h, i) => pad(h, colWidths[i])).join(' | ');
    const sepLine = colWidths.map((w) => '-'.repeat(w)).join('-+-');

    const bodyLines = rows.map((row) =>
      row.map((cell, i) => pad(cell, colWidths[i])).join(' | ')
    );

    return '```\n' + [headerLine, sepLine, ...bodyLines].join('\n') + '\n```';
  }

  /** Rakit seluruh elemen menjadi string WhatsApp terstruktur */
  formatMessage() {
    const { title, footer } = this._renderAll();
    const parts = [];

    if (title) {
      parts.push(`📊 *${title}*`);
    }

    for (const el of this._elements) {
      if (el.type === 'text') {
        parts.push(this._render(el.content));
      } else if (el.type === 'table') {
        const renderedTable = el.content.map((row) => row.map((cell) => this._render(String(cell))));
        const formatted = el.style === 'table'
          ? RichMessage.formatTableAscii(renderedTable)
          : RichMessage.formatTableList(renderedTable);
        parts.push(formatted);
      } else if (el.type === 'code') {
        const header = el.language ? `💻 *Code (${el.language})*:\n` : '';
        // WhatsApp tidak mendukung syntax highlight warna, jadi nama bahasa dipisah di label atas
        parts.push(`${header}\`\`\`\n${this._render(el.content)}\n\`\`\``);
      } else if (el.type === 'tip') {
        parts.push(`> 💡 _${this._render(el.content)}_`);
      }
    }

    if (footer) {
      parts.push(`_${footer}_`);
    }

    return parts.join('\n\n');
  }

  build() {
    if (this._elements.length === 0 && !this._title && !this._body) {
      throw new ContentValidationError('Minimal 1 konten (addText/addTable/addCode/addTip) sebelum build()/send()');
    }

    const text = this.formatMessage();
    return {
      text,
      contextInfo: this._contextInfo,
    };
  }

  async send(jid, options = {}) {
    const content = this.build();
    return await this.#client.sendMessage(jid, content, options);
  }
}

export default RichMessage;
