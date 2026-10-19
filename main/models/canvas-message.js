import crypto from 'crypto';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import AIRichMessage from './ai-rich-message.js';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';

/**
 * CanvasMessage — WhatsApp Interactive Canvas HTML / Mini App Builder.
 * Menjalankan Mini App / Game HTML5 (seperti Dino Runner, Tic Tac Toe, Flappy Bird)
 * langsung di dalam WhatsApp menggunakan protokol Meta AI Rich Response (GenAIaeacdsnwHtmlPrimitive)
 * dengan container FOAIDNixelButtonSheets, verificationMetadata, dan auto fast-edit bypass.
 */
class CanvasMessage extends AIRichMessage {
  #tabs;
  #client;

  constructor(client) {
    super(client);
    this.#client = BaseBuilder.resolveSocket(client);
    this.#tabs = [];
  }

  /**
   * Set isi kode HTML game/canvas untuk tab utama
   * @param {string} html - Kode HTML lengkap (DOCTYPE html)
   * @param {Object} [options]
   * @param {string} [options.tabHeader='Canvas'] - Nama tab di preview sheet
   * @param {string} [options.url='https://nixel.dev'] - Canonical URL
   * @param {Array<string>} [options.trustedSources=['nixel.dev']] - Whitelist domain
   */
  setHtml(html, { tabHeader = 'Canvas', url = 'https://nixel.dev', trustedSources = ['nixel.dev'] } = {}) {
    if (typeof html !== 'string' || !html.trim()) {
      throw new ContentValidationError('HTML harus berupa string non-kosong');
    }
    this.#tabs = [{
      id: 'tab_0',
      tabHeader,
      html,
      url,
      trustedSources: Array.isArray(trustedSources) ? trustedSources : [trustedSources]
    }];
    return this;
  }

  /**
   * Tambah tab game/canvas baru (Mendukung multi-tab mini app)
   * @param {string} tabHeader - Nama tab (misal: "Tic Tac Toe", "Dino", "Doom")
   * @param {string} html - Kode HTML game
   * @param {Object} [options]
   */
  addTab(tabHeader, html, { url = 'https://nixel.dev', trustedSources = ['nixel.dev'] } = {}) {
    if (typeof html !== 'string' || !html.trim()) {
      throw new ContentValidationError('HTML harus berupa string non-kosong');
    }
    const idx = this.#tabs.length;
    this.#tabs.push({
      id: `tab_${idx}`,
      tabHeader: tabHeader || `Tab ${idx + 1}`,
      html,
      url,
      trustedSources: Array.isArray(trustedSources) ? trustedSources : [trustedSources]
    });
    return this;
  }

  build(jid, options = {}) {
    if (this.#tabs.length === 0) {
      throw new ContentValidationError('Minimal 1 konten HTML wajib disetel dengan setHtml() atau addTab()');
    }

    const { title, body } = this._renderAll();
    const effectiveTitle = title || this._title || '✦ Interactive Canvas Mini App ✦';
    const effectiveBody = body || this._body || '> Membuka Interactive HTML Canvas di WhatsApp...';

    const tabsData = this.#tabs.map((tab) => ({
      id: tab.id,
      tab_header: tab.tabHeader,
      sections: [
        {
          __typename: 'GenAIUnifiedResponseSection',
          view_model: {
            __typename: 'GenAISingleLayoutViewModel',
            primitive: {
              __typename: 'GenAIaeacdsnwHtmlPrimitive',
              payload: tab.html,
              url: tab.url,
              trusted_sources: tab.trustedSources
            }
          }
        }
      ],
      step_entries: []
    }));

    const unifiedPayload = {
      response_id: this._responseId || crypto.randomUUID(),
      sections: [
        {
          view_model: {
            primitive: {
              text: effectiveBody,
              __typename: 'GenAIMarkdownTextUXPrimitive'
            },
            __typename: 'GenAISingleLayoutViewModel'
          }
        }
      ],
      embedded_screens: [
        {
          title: 'Preview',
          content: [
            {
              __typename: 'FOAIDNixelButtonSheets',
              tabs: tabsData
            }
          ]
        }
      ]
    };

    const effectiveQuoted = options.quoted || this._quotedMessage;
    const qObj = effectiveQuoted
      ? {
          stanzaId: effectiveQuoted?.key?.id || effectiveQuoted?.id,
          participant: options.quotedParticipant || effectiveQuoted?.key?.participant || effectiveQuoted?.participant || effectiveQuoted?.key?.remoteJid,
          quotedType: 0,
          quotedMessage: typeof effectiveQuoted === 'object' && effectiveQuoted !== null ? (effectiveQuoted.message ?? effectiveQuoted) : undefined,
        }
      : {};

    const forward = options.forwarded !== false
      ? {
          forwardingScore: 1,
          isForwarded: true,
          forwardedAiBotMessageInfo: {
            botJid: '0@bot',
          },
          forwardOrigin: 4,
        }
      : {};

    return generateWAMessageFromContent(
      jid,
      {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
          botMetadata: {
            messageDisclaimerText: effectiveTitle,
            botResponseId: this._botResponseId || crypto.randomUUID(),
            verificationMetadata: AIRichMessage.generateVerificationMetadata(),
          },
        },
        botForwardedMessage: {
          message: {
            richResponseMessage: {
              messageType: 1,
              submessages: [
                {
                  messageType: 2,
                  messageText: effectiveBody,
                }
              ],
              unifiedResponse: {
                data: Buffer.from(JSON.stringify(unifiedPayload)).toString('base64'),
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

  async send(jid, { bypassDownload = true, fastEdit = false, placeholderText = '⚡ *[Sylphiette Mini App]* Memuat Canvas...', ...options } = {}) {
    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;

    if (fastEdit) {
      try {
        const placeholder = await this.#client.sendMessage(targetJid, { text: placeholderText }, options);
        if (placeholder?.key?.id) {
          return await this.sendEdit(targetJid, placeholder.key.id, options);
        }
      } catch (_) {
        // Fallback ke direct relay jika sendMessage placeholder gagal
      }
    }

    const msg = this.build(targetJid, options);
    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      ...options,
    });

    if (bypassDownload !== false) {
      try {
        await this.sendEdit(targetJid, msg.key.id, {
          msg: msg.message,
          ...options,
        });
      } catch (_) {}
    }

    return msg;
  }
}

export { CanvasMessage };
export default CanvasMessage;
