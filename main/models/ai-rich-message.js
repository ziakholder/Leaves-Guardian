import crypto from 'crypto';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';
import { resolveLidToPn } from '../helpers/lid-resolver.js';

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
  let i = 0;

  const push = (content, type) => {
    if (!content) return;
    const last = tokens[tokens.length - 1];
    if (last && last.highlightType === type) last.codeContent += content;
    else tokens.push({ codeContent: content, highlightType: type });
  };

  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      let s = i;
      while (i < code.length && /\s/.test(code[i])) i++;
      push(code.slice(s, i), 0);
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      let s = i;
      i += 2;
      while (i < code.length && code[i] !== '\n') i++;
      push(code.slice(s, i), 5);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let s = i;
      const q = c;
      i++;
      while (i < code.length) {
        if (code[i] === '\\' && i + 1 < code.length) i += 2;
        else if (code[i] === q) {
          i++;
          break;
        } else i++;
      }
      push(code.slice(s, i), 3);
      continue;
    }
    if (/[0-9]/.test(c)) {
      let s = i;
      while (i < code.length && /[0-9.]/.test(code[i])) i++;
      push(code.slice(s, i), 4);
      continue;
    }
    if (/[a-zA-Z_$]/.test(c)) {
      let s = i;
      while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) i++;
      const word = code.slice(s, i);
      let type = 0;
      if (keywords.has(word)) type = 1;
      else {
        let j = i;
        while (j < code.length && /\s/.test(code[j])) j++;
        if (code[j] === '(') type = 2;
      }
      push(word, type);
      continue;
    }
    push(c, 0);
    i++;
  }

  const TYPE_MAP = { 0: 'DEFAULT', 1: 'KEYWORD', 2: 'METHOD', 3: 'STR', 4: 'NUMBER', 5: 'COMMENT' };
  return {
    codeBlocks: tokens,
    unified_codeBlock: tokens.map((t) => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] || 'DEFAULT' })),
  };
}

/**
 * AIRichMessage — WhatsApp Meta AI Rich Response Builder (Zaileys / NIXCODE / Ryuu Protocol).
 * Supports Markdown Text, Suggestion ActionRow Pills, Syntax Highlighting, Tables, Media, Products, and Posts.
 */
class AIRichMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._sections = [];
    this._submessages = [];
    this._richResponseSources = [];
    this._responseId = crypto.randomUUID();
    this._botResponseId = crypto.randomUUID();
  }

  static newLayout(name, data) {
    return {
      view_model: {
        [Array.isArray(data) ? 'primitives' : 'primitive']: data,
        __typename: `GenAI${name}LayoutViewModel`,
      },
    };
  }

  static _newLayout(name, data) {
    return AIRichMessage.newLayout(name, data);
  }

  /**
   * Tambah teks dengan dukungan Inline Hyperlink [Nama Link](https://...) dan LaTeX
   */
  addText(text, { hyperlink = true, citation = true, latex = true } = {}) {
    const rendered = this._render(text);
    const extracted = extractIE(rendered, { hyperlink, citation, latex });

    const inline_entities = extracted.inline_entities.map((item) => {
      if (item.metadata) return item;
      return item;
    });

    this._submessages.push({
      messageType: 2,
      messageText: extracted.text,
    });

    this._sections.push(
      AIRichMessage.newLayout('Single', {
        text: extracted.text,
        ...(inline_entities.length > 0 && { inline_entities }),
        __typename: 'GenAIMarkdownTextUXPrimitive',
      })
    );

    return this;
  }

  /**
   * Tambah blok kode dengan syntax highlighting Meta AI
   */
  addCode(language, code) {
    const rendered = this._render(code);
    const meta = tokenizeCode(rendered, language);

    this._submessages.push({
      messageType: 5,
      codeMetadata: {
        codeLanguage: language,
        codeBlocks: meta.codeBlocks,
      },
    });

    this._sections.push(
      AIRichMessage.newLayout('Single', {
        language,
        code_blocks: meta.unified_codeBlock,
        __typename: 'GenAICodeUXPrimitive',
      })
    );

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
      {
        is_header: true,
        cells: padRow(header).map((c) => this._render(String(c))),
        markdown_cells: padRow(header).map((c) => ({ text: this._render(String(c)) })),
      },
      ...rows.map((r) => ({
        is_header: false,
        cells: padRow(r).map((c) => this._render(String(c))),
        markdown_cells: padRow(r).map((c) => ({ text: this._render(String(c)) })),
      })),
    ];

    this._submessages.push({
      messageType: 4,
      tableMetadata: {
        title: '',
        rows: unifiedRows.map((r) => ({ items: r.cells, ...(r.is_header ? { isHeading: true } : {}) })),
      },
    });

    this._sections.push(
      AIRichMessage.newLayout('Single', {
        rows: unifiedRows,
        __typename: 'GenATableUXPrimitive',
      })
    );

    return this;
  }

  /**
   * Tambah Suggestion ActionRow Pills (Pill tombol rekomendasi prompt)
   * @param {Array<string>|string} suggestion - Teks rekomendasi
   */
  addSuggest(suggestion) {
    const list = Array.isArray(suggestion) ? suggestion : [suggestion];
    const suggest = list.map((text) => ({
      prompt_text: this._render(text),
      prompt_type: 'SUGGESTED_PROMPT',
      __typename: 'GenAIFollowUpSuggestionPillPrimitive',
    }));

    this._sections.push(AIRichMessage.newLayout('ActionRow', suggest));
    return this;
  }

  /** Alias untuk addSuggest */
  addChip(label, query = label) {
    return this.addSuggest([label]);
  }

  /**
   * Tambah catatan tip kecil di bawah
   */
  addTip(text) {
    const rendered = this._render(text);
    this._submessages.push({
      messageType: 2,
      messageText: rendered,
    });

    this._sections.push(
      AIRichMessage.newLayout('Single', {
        text: rendered,
        __typename: 'GenAIMetadataTextPrimitive',
      })
    );

    return this;
  }

  /**
   * Tambah blok HTML / Interactive Canvas
   * @param {string} html - Kode HTML
   * @param {Object} [options]
   * @param {Array<string>} [options.trustedSources]
   */
  addHtml(html, { trustedSources = ['nixel.dev', 'whatsapp.com'] } = {}) {
    const rendered = this._render(html);
    this._submessages.push({
      messageType: 2,
      messageText: rendered,
    });

    this._sections.push(
      AIRichMessage.newLayout('Single', {
        html_code: rendered,
        trusted_sources: Array.isArray(trustedSources) ? trustedSources : [trustedSources],
        __typename: 'GenAIaeacdsnwHtmlPrimitive',
      })
    );

    return this;
  }

  /**
   * Tambah gambar AI
   */
  addImage(imageUrl) {
    const list = Array.isArray(imageUrl) ? imageUrl : [imageUrl];
    const imageUrls = list.map((url) => ({
      imagePreviewUrl: url,
      imageHighResUrl: url,
      sourceUrl: 'https://whatsapp.com',
    }));

    this._submessages.push({
      messageType: 1,
      gridImageMetadata: {
        gridImageUrl: {
          imagePreviewUrl: list[0],
        },
        imageUrls,
      },
    });

    imageUrls.forEach(({ imagePreviewUrl }) => {
      this._sections.push(
        AIRichMessage.newLayout('Single', {
          media: {
            url: imagePreviewUrl,
            mime_type: 'image/png',
          },
          imagine_type: 'IMAGE',
          status: { status: 'READY' },
          __typename: 'GenAIImaginePrimitive',
        })
      );
    });

    return this;
  }

  /**
   * Tambah video AI
   */
  addVideo(videoUrl) {
    const list = Array.isArray(videoUrl) ? videoUrl : [videoUrl];
    const videoUrls = list.map((item) => {
      const [url, duration = 0] = item.split('|');
      return {
        videoPreviewUrl: url,
        videoHighResUrl: url,
        duration: Number(duration) || 0,
        sourceUrl: 'https://whatsapp.com',
      };
    });

    this._submessages.push({
      messageType: 2,
      messageText: '[ CANNOT_LOAD_VIDEO ]',
    });

    videoUrls.forEach(({ videoPreviewUrl, duration }) => {
      this._sections.push(
        AIRichMessage.newLayout('Single', {
          media: {
            url: videoPreviewUrl,
            mime_type: 'video/mp4',
            duration,
          },
          imagine_type: 'ANIMATE',
          status: { status: 'READY' },
          __typename: 'GenAIImaginePrimitive',
        })
      );
    });

    return this;
  }

  /**
   * Tambah link sitasi sumber
   */
  addSource(sources = []) {
    const list = sources.every((item) => typeof item === 'string') ? [sources] : sources;
    const source = list.map(([profile_url, url, text]) => ({
      source_type: 'THIRD_PARTY',
      source_display_name: text ?? '',
      source_subtitle: 'AI',
      source_url: url ?? '',
      favicon: {
        url: profile_url ?? '',
        mime_type: 'image/jpeg',
        width: 16,
        height: 16,
      },
    }));

    this._sections.push(
      AIRichMessage.newLayout('Single', {
        sources: source,
        __typename: 'GenAISearchResultPrimitive',
      })
    );

    return this;
  }

  build(jid, {
    forwarded = true,
    includesUnifiedResponse = true,
    includesSubmessages = true,
    quoted,
    quotedParticipant,
    ...options
  } = {}) {
    if (this._sections.length === 0) {
      throw new ContentValidationError('Minimal 1 konten (addText/addCode/addTable/addSuggest) sebelum build()');
    }

    const { title, footer } = this._renderAll();
    const finalSections = footer
      ? [
          ...this._sections,
          AIRichMessage.newLayout('Single', {
            text: footer,
            __typename: 'GenAIMetadataTextPrimitive',
          }),
        ]
      : [...this._sections];

    const payloadJson = stringifyEscaped({
      response_id: this._responseId,
      sections: finalSections,
    });

    const forward = forwarded
      ? {
          forwardingScore: 1,
          isForwarded: true,
          forwardedAiBotMessageInfo: {
            botJid: '0@bot',
          },
          forwardOrigin: 4,
        }
      : {};

    const effectiveQuoted = quoted || this._quotedMessage;
    const qObj = effectiveQuoted
      ? {
          stanzaId: effectiveQuoted?.key?.id || effectiveQuoted?.id,
          participant: quotedParticipant || effectiveQuoted?.key?.participant || effectiveQuoted?.participant || effectiveQuoted?.key?.remoteJid,
          quotedType: 0,
          quotedMessage: typeof effectiveQuoted === 'object' && effectiveQuoted !== null ? (effectiveQuoted.message ?? effectiveQuoted) : undefined,
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
            richResponseSourcesMetadata: {
              sources: this._richResponseSources,
            },
          },
        },
        botForwardedMessage: {
          message: {
            richResponseMessage: {
              messageType: 1,
              submessages: includesSubmessages ? this._submessages : [],
              unifiedResponse: {
                data: includesUnifiedResponse ? Buffer.from(payloadJson).toString('base64') : '',
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

  async send(jid, options = {}) {
    const targetJid = resolveLidToPn(jid);
    const msg = this.build(targetJid, options);

    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      ...options,
    });

    return msg;
  }
}

export default AIRichMessage;

