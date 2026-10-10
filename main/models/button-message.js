import { generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';
import { resolveLidToPn } from '../helpers/lid-resolver.js';

/**
 * ButtonMessage — wrapper custom di atas InteractiveMessage.NativeFlowMessage (Baileys).
 * Mendukung berbagai macam tombol interaktif, banner promo (Limited Time Offer),
 * header media (Gambar/Video/Dokumen), adReply preview, dan forward channel.
 *
 * Contoh pakai:
 *   const btn = new ButtonMessage(sock)
 *     .setBody('Halo {{nama}}, mau lanjut checkout?')
 *     .setVars({ nama: 'Rafa' })
 *     .addReply('Ya, lanjut', 'checkout_yes')
 *     .addCopy('Salin kode promo', 'HEMAT20')
 *     .addLimitedOffer('Diskon 50% Berakhir', { days: 7 });
 *
 *   await btn.send('6281234567890@s.whatsapp.net');
 */
class ButtonMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._buttons = [];
    this._media = null;
    this._mediaType = null;
    this._mediaOptions = {};
    this._currentSelectionIndex = -1;
    this._currentSectionIndex = -1;
    this._params = {};
  }

  addReply(displayText, id = '') {
    this._buttons.push({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: this._render(displayText), id }),
    });
    return this;
  }

  addUrl(displayText, url = '', webviewInteraction = false) {
    this._buttons.push({
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: this._render(displayText),
        url: this._render(url),
        webview_interaction: webviewInteraction,
      }),
    });
    return this;
  }

  /** Tombol "salin kode/link" (cta_copy) */
  addCopy(displayText, copyCode) {
    this._buttons.push({
      name: 'cta_copy',
      buttonParamsJson: JSON.stringify({
        display_text: this._render(displayText),
        copy_code: this._render(copyCode),
      }),
    });
    return this;
  }

  addButton(name, params) {
    this._buttons.push({
      name,
      buttonParamsJson: typeof params === 'string' ? params : JSON.stringify(params),
    });
    return this;
  }

  addSelection(title, options = {}) {
    this._buttons.push({
      ...options,
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: this._render(title),
        sections: [],
      }),
    });
    this._currentSelectionIndex = this._buttons.length - 1;
    this._currentSectionIndex = -1;
    return this;
  }

  makeSection(title = '', highlight_label = '') {
    if (this._currentSelectionIndex === -1) {
      throw new Error('You need to create a selection first via addSelection()');
    }
    const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
    buttonParams.sections.push({
      title: this._render(title),
      highlight_label: this._render(highlight_label),
      rows: [],
    });
    this._currentSectionIndex = buttonParams.sections.length - 1;
    this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
    return this;
  }

  makeRow(header = '', title = '', description = '', id = '') {
    if (this._currentSelectionIndex === -1 || this._currentSectionIndex === -1) {
      throw new Error('You need to create a selection and a section first');
    }
    const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
    buttonParams.sections[this._currentSectionIndex].rows.push({
      header: this._render(header),
      title: this._render(title),
      description: this._render(description),
      id: this._render(id),
    });
    this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
    return this;
  }

  setBottomSheet(title, { inThreadButtonsLimit = 1, dividerIndices = [1, 2] } = {}) {
    this._params.bottom_sheet = {
      in_thread_buttons_limit: inThreadButtonsLimit,
      divider_indices: dividerIndices,
      list_title: title,
      button_title: title,
    };
    return this;
  }

  /**
   * Banner promo dengan timer kedaluwarsa (Limited Time Offer / LTO)
   */
  addLimitedOffer(displayText, { expiration_time, days = 7, url = 'https://whatsapp.com', copy_code = '' } = {}) {
    const expireSec = expiration_time || Math.floor(Date.now() / 1000) + Math.round(days * 86400);

    this._buttons.push({
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: this._render(displayText),
        url,
        copy_code,
        merchant_url: url,
      }),
    });

    this._params.limited_time_offer = {
      text: this._render(displayText),
      url,
      copy_code,
      expiration_time: expireSec,
    };
    return this;
  }

  /** Alias untuk addLimitedOffer */
  setBanner(bannerText, opts = {}) {
    return this.addLimitedOffer(bannerText, opts);
  }

  /** Tambah gambar header */
  setImage(path) {
    this._media = path;
    this._mediaType = 'image';
    return this;
  }

  /** Tambah video header */
  setVideo(path) {
    this._media = path;
    this._mediaType = 'video';
    return this;
  }

  /** Tambah dokumen header */
  setDocument(path, { fileName = 'document', mimetype = 'application/octet-stream' } = {}) {
    this._media = path;
    this._mediaType = 'document';
    this._mediaOptions = { fileName, mimetype };
    return this;
  }

  /** Tombol banner flow / galaxy message */
  addGalaxy(flowCta, { flowAction = 'navigate', screen = 'SATISFACTION_SCREEN', data = {} } = {}) {
    this._buttons.push({
      name: 'galaxy_message',
      buttonParamsJson: JSON.stringify({
        flow_cta: this._render(flowCta),
        icon: '',
        flow_message_version: '3',
        flow_action: flowAction,
        flow_action_payload: {
          screen,
          data,
        },
      }),
    });
    return this;
  }

  async build() {
    const { title, body, footer } = this._renderAll();

    if (this._buttons.length === 0) {
      throw new ContentValidationError('Minimal 1 button sebelum build()/send()');
    }

    let header = { hasMediaAttachment: false };
    if (this._media) {
      const mediaKey = this._mediaType;
      const mediaPayload = {
        [mediaKey]: Buffer.isBuffer(this._media) ? this._media : { url: this._media },
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
          buttons: this._buttons,
          messageParamsJson: Object.keys(this._params).length > 0 ? JSON.stringify(this._params) : undefined,
        },
        contextInfo: this._buildContextInfo(),
      },
    };
  }

  async send(jid, options = {}) {
    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;
    const content = await this.build();
    const sendOpts = { userJid: this.#client.user?.id, ...options };
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
          },
          ...content,
        },
      },
    };

    const msg = generateWAMessageFromContent(targetJid, wrappedContent, sendOpts);
    const additionalNodes = [
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
    ];

    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      additionalNodes,
    });

    return msg;
  }
}

export default ButtonMessage;
