import crypto from 'crypto';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';

const VERSION = '4.7';

function stringifyEscaped(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * Helper untuk ekstraksi inline hyperlink [teks](url), sitasi, dan latex
 */
function extractIE(text, { hyperlink = true, citation = true, latex = true } = {}) {
  let inline_entities = [];
  let result = '';
  let last = 0;
  let citation_index = 1;
  let hyperlink_index = 0;
  let latex_index = 0;
  let stack = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && text[i - 1] !== '\\') {
      stack.push(i);
    } else if (text[i] === ']' && (text[i + 1] === '(' || text[i + 1] === '<')) {
      const start = stack.pop();
      if (start == null) continue;

      const open = text[i + 1];
      const close = open === '(' ? ')' : '>';
      const type = open === '(' ? 'link' : 'latex';
      let end = i + 2;
      let depth = 1;

      while (end < text.length && depth) {
        if (text[end] === open && text[end - 1] !== '\\') depth++;
        else if (text[end] === close && text[end - 1] !== '\\') depth--;
        end++;
      }

      if (depth) continue;

      const raw = text.slice(start + 1, i).trim();
      const url = text.slice(i + 2, end - 1).trim();

      let key;
      let tag;

      if (type === 'latex' && latex) {
        const [txt = '', width = null, height = null, font_height = null, padding = null] = raw.split('|');
        key = `\u004E\u0049\u0058\u0045\u004C_LATEX_${latex_index++}`;
        tag = `{{${key}}}${txt || 'formula'}{{/${key}}}`;

        inline_entities.push({
          key,
          metadata: {
            latex_expression: txt,
            latex_image: {
              url,
              width: Number(width) || 100,
              height: Number(height) || 100,
            },
            font_height: Number(font_height) || 83.333333333333,
            padding: Number(padding) || 15,
            __typename: 'GenAILatexItem',
          },
        });
      } else if (raw && hyperlink) {
        const trusted = !url.startsWith('!');
        const cleanUrl = trusted ? url : url.slice(1);
        key = `\u004E\u0049\u0058\u0045\u004C_HYPERLINK_${hyperlink_index++}`;
        tag = `{{${key}}}${cleanUrl}{{/${key}}}`;

        inline_entities.push({
          key,
          metadata: {
            display_name: raw,
            is_trusted: trusted,
            url: cleanUrl,
            __typename: 'GenAIInlineLinkItem',
          },
        });
      } else if (citation) {
        key = `\u004E\u0049\u0058\u0045\u004C_CITATION_${citation_index - 1}`;
        tag = `{{${key}}}${url}{{/${key}}}`;

        inline_entities.push({
          key,
          metadata: {
            reference_id: citation_index++,
            reference_url: url,
            reference_title: url,
            reference_display_name: url,
            sources: [],
            __typename: 'GenAISearchCitationItem',
          },
        });
      }

      result += text.slice(last, start) + tag;
      last = end;
      i = end - 1;
    }
  }

  result += text.slice(last);

  return {
    text: result,
    inline_entities,
  };
}

/**
 * Tokenizer kata kunci untuk syntax highlighting kode
 */
const KEYWORDS_MAP = {
  javascript: new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'true', 'false', 'null', 'undefined']),
  typescript: new Set(['abstract', 'any', 'as', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'interface', 'let', 'module', 'namespace', 'never', 'new', 'null', 'number', 'package', 'private', 'protected', 'public', 'readonly', 'require', 'return', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'await']),
  python: new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']),
  json: new Set(['true', 'false', 'null']),
};

function tokenizeCode(code, lang = 'javascript') {
  const keywords = KEYWORDS_MAP[lang.toLowerCase()] || KEYWORDS_MAP.javascript;
  const tokens = [];
  const lines = code.split('\n');

  for (const line of lines) {
    const words = line.split(/(\s+|[^\w$])/g).filter(Boolean);
    for (const w of words) {
      if (keywords.has(w)) {
        tokens.push({ codeContent: w, highlightType: 1 });
      } else if (/^['"`].*['"`]$/.test(w)) {
        tokens.push({ codeContent: w, highlightType: 3 });
      } else {
        tokens.push({ codeContent: w, highlightType: 0 });
      }
    }
    tokens.push({ codeContent: '\n', highlightType: 0 });
  }

  const typeNames = { 0: 'DEFAULT', 1: 'KEYWORD', 2: 'METHOD', 3: 'STR' };
  return {
    codeBlocks: tokens,
    unified_codeBlock: tokens.map((t) => ({ content: t.codeContent, type: typeNames[t.highlightType] || 'DEFAULT' })),
  };
}

/**
 * AIRichMessage — WhatsApp Meta AI Rich Response Builder (Zaileys / NIXCODE Protocol).
 * Mendukung Inline Link Markdown, Suggestion Chips, LaTeX Formula, Syntax Highlighting,
 * dan fitur auto-bypass WhatsApp Android via protocol message edit.
 */
class AIRichMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._sections = [];
    this._submessages = [];
    this._responseId = crypto.randomUUID();
    this._botResponseId = crypto.randomUUID();
    this._lastMessageKey = null;
  }

  static _newLayout(name, data) {
    return {
      view_model: {
        [Array.isArray(data) ? 'primitives' : 'primitive']: data,
        __typename: `GenAI${name}LayoutViewModel`,
      },
    };
  }

  /**
   * Dummy proofs signature & certificate chain untuk verifikasi Meta AI
   */
  static generateVerificationMetadata() {
    const signatureMaterial = Buffer.from(
      `\u004E\u0049\u0058\u0045\u004C\u002E\u004D\u0065\u0073\u0073\u0061\u0067\u0065\u0042\u0075\u0069\u006C\u0064\u0065\u0072\u0056${VERSION}\u002D\u0056\u0065\u0072\u0069\u0066\u0069\u0063\u0061\u0074\u0069\u006F\u006E\u0053\u0069\u0067\u006E\u0061\u0074\u0075\u0072\u0065\u002E\u004D\u0065\u0074\u0061\u0064\u0061\u0074\u0061`
    );

    const certificateMaterial = Buffer.from(
      `\u004E\u0049\u0058\u0045\u004C\u002E\u004D\u0065\u0073\u0073\u0061\u0067\u0065\u0042\u0075\u0069\u006C\u0064\u0065\u0072\u0056${VERSION}\u002D\u0043\u0065\u0072\u0074\u0069\u0066\u0069\u0063\u0061\u0074\u0065\u0043\u0068\u0061\u0069\u006E\u002E\u004D\u0065\u0074\u0061\u0064\u0061\u0074\u0061`
    );

    const signature = Buffer.concat([signatureMaterial, crypto.randomBytes(Math.max(0, 64 - signatureMaterial.length))]).toString('base64');
    const certChain = [
      Buffer.concat([certificateMaterial, crypto.randomBytes(Math.max(0, 684 - certificateMaterial.length))]).toString('base64'),
      Buffer.concat([certificateMaterial, crypto.randomBytes(Math.max(0, 892 - certificateMaterial.length))]).toString('base64'),
    ];

    return {
      proofs: [
        {
          version: 1,
          useCase: 1,
          signature,
          certificateChain: certChain,
        },
      ],
    };
  }

  /**
   * Tambah teks dengan dukungan Inline Hyperlink [Nama Link](https://...) dan LaTeX
   */
  addText(text, { hyperlink = true, citation = true, latex = true } = {}) {
    const rendered = this._render(text);
    const { text: parsedText, inline_entities } = extractIE(rendered, { hyperlink, citation, latex });

    const section = AIRichMessage._newLayout('Single', {
      text: parsedText,
      ...(inline_entities.length > 0 ? { inline_entities } : {}),
      __typename: 'GenAIMarkdownTextUXPrimitive',
    });

    this._sections.push(section);
    this._submessages.push({ messageType: 2, messageText: rendered });
    return this;
  }

  /**
   * Tambah blok kode dengan syntax highlighting Meta AI
   */
  addCode(language, code) {
    const rendered = this._render(code);
    const meta = tokenizeCode(rendered, language);

    const section = AIRichMessage._newLayout('Single', {
      language,
      code_blocks: meta.unified_codeBlock,
      __typename: 'GenAICodeUXPrimitive',
    });

    this._sections.push(section);
    this._submessages.push({
      messageType: 5,
      codeMetadata: {
        codeLanguage: language,
        codeBlocks: meta.codeBlocks,
      },
    });
    return this;
  }

  /**
   * Tambah tabel Meta AI
   */
  addTable(table) {
    if (!Array.isArray(table) || table.length < 1) {
      throw new ContentValidationError('Table harus berupa array baris dengan minimal 1 baris header');
    }

    const [header, ...rows] = table;
    const maxCols = Math.max(header.length, ...rows.map((r) => r.length));
    const padRow = (r) => [...r, ...Array(maxCols - r.length).fill('')];

    const unifiedRows = [
      { is_header: true, cells: padRow(header).map((c) => this._render(String(c))) },
      ...rows.map((r) => ({ is_header: false, cells: padRow(r).map((c) => this._render(String(c))) })),
    ];

    const section = AIRichMessage._newLayout('Single', {
      rows: unifiedRows,
      __typename: 'GenATableUXPrimitive',
    });

    this._sections.push(section);
    this._submessages.push({
      messageType: 4,
      tableMetadata: {
        title: '',
        rows: unifiedRows.map((r) => ({ items: r.cells, isHeading: r.is_header })),
      },
    });
    return this;
  }

  /**
   * Tambah Suggestion Chip tunggal atau list
   */
  addChip(label, query = label) {
    const section = AIRichMessage._newLayout('Single', {
      suggestions: [
        {
          prompt_text: this._render(label),
          query: this._render(query),
          __typename: 'GenAISuggestionListPromptItem',
        },
      ],
      __typename: 'GenAISuggestionListUXPrimitive',
    });
    this._sections.push(section);
    return this;
  }

  /**
   * Tambah link sitasi sumber
   */
  addCitation(index, url, title = '') {
    const text = `[${index}] [${title || url}](${url})`;
    return this.addText(text);
  }

  /**
   * Tambah Suggestion Chips (tombol rekomendasi / prompt AI di bawah pesan)
   * @param {Array<string>} suggestions - Daftar teks pilihan
   */
  addSuggest(suggestions = []) {
    const list = Array.isArray(suggestions) ? suggestions : [suggestions];
    const items = list.map((text) => ({
      prompt_text: this._render(text),
      query: this._render(text),
      __typename: 'GenAISuggestionListPromptItem',
    }));

    const section = AIRichMessage._newLayout('Single', {
      suggestions: items,
      __typename: 'GenAISuggestionListUXPrimitive',
    });

    this._sections.push(section);
    return this;
  }

  /**
   * Tambah catatan tip kecil di bawah
   */
  addTip(text) {
    const rendered = this._render(text);
    const section = AIRichMessage._newLayout('Single', {
      text: 'ⓘ ' + rendered,
      __typename: 'GenAIMetadataTextPrimitive',
    });

    this._sections.push(section);
    this._submessages.push({ messageType: 2, messageText: rendered });
    return this;
  }

  /**
   * Tambah Interactive HTML Widget / Mini App / Canvas Game (seperti Dino Runner)
   * @param {string} htmlPayload - Kode HTML, CSS, dan JavaScript
   * @param {Object} [options]
   * @param {Array<string>} [options.trustedSources=['nixel.dev']] - Domain sumber yang di-whitelist
   * @param {string} [options.typename='GenAIaeacdsnwHtmlPrimitive'] - Typename primitive HTML
   */
  addHtml(htmlPayload, { trustedSources = ['nixel.dev'], typename = 'GenAIaeacdsnwHtmlPrimitive' } = {}) {
    if (typeof htmlPayload !== 'string') {
      throw new TypeError('HTML payload harus berupa string');
    }

    const section = AIRichMessage._newLayout('Single', {
      payload: htmlPayload,
      trusted_sources: Array.isArray(trustedSources) ? trustedSources : [trustedSources],
      __typename: typename,
    });

    this._sections.push(section);
    this._submessages.push({
      messageType: 2,
      messageText: 'Interactive HTML Widget',
    });
    return this;
  }

  build(jid, options = {}) {
    if (this._sections.length === 0) {
      throw new ContentValidationError('Minimal 1 konten (addText/addCode/addTable/addSuggest) sebelum build()');
    }

    const { title, footer } = this._renderAll();
    const finalSections = [...this._sections];

    if (footer) {
      finalSections.push(
        AIRichMessage._newLayout('Single', {
          text: footer,
          __typename: 'GenAIMetadataTextPrimitive',
        })
      );
    }

    const payloadJson = stringifyEscaped({
      response_id: this._responseId,
      sections: finalSections,
    });

    // Wajib ada forwardedAiBotMessageInfo agar WhatsApp tahu ini format Meta AI resmi
    const forward = {
      forwardingScore: 1,
      isForwarded: true,
      forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
      forwardOrigin: 4,
    };

    const qObj = this._quotedMessage
      ? {
          stanzaId: this._quotedMessage?.key?.id || this._quotedMessage?.id,
          participant: this._quotedMessage?.key?.participant || this._quotedMessage?.participant || this._quotedMessage?.key?.remoteJid,
          quotedType: 0,
          quotedMessage: typeof this._quotedMessage === 'object' ? (this._quotedMessage.message ?? this._quotedMessage) : undefined,
        }
      : {};

    return generateWAMessageFromContent(
      jid,
      {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
          botMetadata: {
            messageDisclaimerText: title || '',
            verificationMetadata: AIRichMessage.generateVerificationMetadata(),
            botResponseId: this._botResponseId,
          },
        },
        botForwardedMessage: {
          message: {
            richResponseMessage: {
              messageType: 1,
              submessages: this._submessages,
              unifiedResponse: {
                data: Buffer.from(payloadJson).toString('base64'),
              },
              contextInfo: {
                ...forward,
                ...qObj,
                ...this._buildContextInfo(),
              },
            },
          },
        },
      },
      { userJid: this.#client.user?.id, ...options }
    );
  }

  /**
   * Kirim pesan AI Rich Response dengan trik auto-bypass edit agar langsung dirender di WhatsApp Android
   */
  async send(jid, options = {}) {
    const msg = this.build(jid, options);

    // 1. Relay pesan utama
    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      ...options,
    });

    // 2. Bypass Download WhatsApp Android via fast protocolMessage type 14 (Edit)
    try {
      const editMessage = generateWAMessageFromContent(
        jid,
        {
          botForwardedMessage: {
            message: {
              protocolMessage: {
                key: {
                  remoteJid: jid,
                  fromMe: true,
                  id: msg.key.id,
                },
                type: 14,
                editedMessage: msg.message,
              },
            },
          },
        },
        { userJid: this.#client.user?.id }
      );

      await this.#client.relayMessage(jid, editMessage.message, {
        messageId: editMessage.key.id,
      });
    } catch {
      // Abaikan jika relay edit gagal di background
    }

    this._lastMessageKey = msg.key;
    return msg;
  }
}

export default AIRichMessage;
