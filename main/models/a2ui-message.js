import crypto from 'crypto';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors.js';
import { buildInteractiveNodes } from '../helpers/stanza-nodes.js';

/**
 * A2UIMessage — Builder pesan antarmuka generatif A2UI (Agent-To-User Interface)
 * berbasis protokol Meta Bloks / StarCore Widget untuk WhatsApp Multi-Device.
 */
export class A2UIMessage extends BaseBuilder {
  #client;

  constructor(client, {
    catalogId = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
    version = 'v0.9'
  } = {}) {
    super();
    if (!client) throw new Error('Socket Baileys wajib di-pass ke constructor');
    this.#client = BaseBuilder.resolveSocket(client);
    this._version = version;
    this._catalogId = catalogId;
    this._components = new Map();
    this._counter = 0;
    this._rootChildren = [];
    this._listCardPayload = null;
    this._singleScreen = true;
    this._surfaceId = null;
    this._widgetType = 'im_a2ui';
    this._wrapped = true;
  }

  #nextId(prefix) {
    return `${prefix}_${(this._counter++).toString(36)}`;
  }

  #reg(id, component, extra = {}) {
    id = id ?? this.#nextId(component.toLowerCase());
    if (this._components.has(id)) {
      throw new Error(`Component id "${id}" already used`);
    }
    this._components.set(id, { id, component, ...extra });
    return id;
  }

  setSingleScreen(single = true) {
    this._singleScreen = Boolean(single);
    return this;
  }

  setSurfaceId(id) {
    this._surfaceId = id;
    return this;
  }

  setCatalogId(id) {
    this._catalogId = id;
    return this;
  }

  text(text, { id, variant = 'body' } = {}) {
    return this.#reg(id, 'Text', { text: this._render(text), variant });
  }

  image(url, { id, variant, fit = 'cover' } = {}) {
    return this.#reg(id, 'Image', { url: this._render(url), ...(variant ? { variant } : {}), fit });
  }

  video(url, { id } = {}) {
    return this.#reg(id, 'Video', { url: this._render(url) });
  }

  checkbox(label, { id, value = false } = {}) {
    return this.#reg(id, 'CheckBox', { label: this._render(label), value });
  }

  textField(label, { id, variant = 'text' } = {}) {
    return this.#reg(id, 'TextField', { label: this._render(label), variant });
  }

  button(childId, { id, variant = 'primary', action } = {}) {
    if (!childId) {
      throw new TypeError('button(childId) requires the id of a child component (e.g. from text())');
    }
    return this.#reg(id, 'Button', { child: childId, variant, ...(action ? { action } : {}) });
  }

  card(childId, { id } = {}) {
    return this.#reg(id, 'Card', { child: childId });
  }

  column(children = [], { id, justify, align } = {}) {
    if (!children.length) {
      throw new TypeError('column(children) requires at least one child id');
    }
    return this.#reg(id, 'Column', { children, ...(justify ? { justify } : {}), ...(align ? { align } : {}) });
  }

  row(children = [], { id } = {}) {
    if (!children.length) {
      throw new TypeError('row(children) requires at least one child id');
    }
    return this.#reg(id, 'Row', { children });
  }

  divider({ id } = {}) {
    return this.#reg(id, 'Divider', {});
  }

  choicePicker(label, options, { id, variant = 'mutuallyExclusive', value, displayStyle = 'checkbox', filterable = false } = {}) {
    if (!Array.isArray(options) || !options.length) {
      throw new TypeError('choicePicker requires non-empty options array');
    }
    return this.#reg(id, 'ChoicePicker', {
      label: this._render(label),
      variant,
      ...(value !== undefined ? { value } : {}),
      options,
      displayStyle,
      filterable
    });
  }

  root(children) {
    if (!Array.isArray(children) || !children.length) {
      throw new TypeError('root(children) requires non-empty array of top-level component ids');
    }
    this._rootChildren = children;
    return this;
  }

  listCard({ title, items, fallbackText, uuid = crypto.randomUUID() } = {}) {
    if (!title) throw new TypeError('listCard requires a title');
    if (!Array.isArray(items) || !items.length) {
      throw new TypeError('listCard requires a non-empty items array');
    }
    this._listCardPayload = {
      uuid,
      data: JSON.stringify({
        type: 'list_card',
        title: this._render(title),
        fallback_text: fallbackText ?? '',
        items: items.map((it) => ({
          asset_id: it.assetId ?? crypto.randomUUID().replace(/-/g, '').slice(0, 17),
          asset_type: it.assetType ?? 'PRODUCT_ITEM',
          title: this._render(it.title),
          trailing_label: this._render(it.price ?? it.trailingLabel ?? ''),
          trailing_emphasis: it.emphasis ?? 'strong'
        }))
      }),
      type: 'im_a2ui',
      fallback: fallbackText ?? ''
    };
    return this;
  }

  buildWidget({ uuid = crypto.randomUUID(), surfaceId, type = 'im_a2ui', wrapped = true } = {}) {
    if (this._listCardPayload) return this._listCardPayload;
    if (!this._rootChildren.length) {
      throw new ContentValidationError('Call root([...ids]) before build()');
    }
    const root = { id: 'root', component: 'Column', children: this._rootChildren };
    const components = [root, ...this._components.values()];
    const data = wrapped
      ? {
          version: this._version,
          createSurface: {
            surfaceId: surfaceId ?? this._surfaceId ?? `starcore-widget=${uuid}`,
            catalogId: this._catalogId,
            components
          }
        }
      : { components };

    return {
      uuid,
      data: JSON.stringify(data),
      type,
      fallback: this._body || ''
    };
  }

  build() {
    const { title, body, footer } = this._renderAll();
    const widget = this.buildWidget({
      surfaceId: this._surfaceId,
      type: this._widgetType,
      wrapped: this._wrapped
    });

    const nativeFlowMessage = {
      buttons: [],
      messageParamsJson: ''
    };

    const contextInfo = this._buildContextInfo();

    const interactiveMessage = this._singleScreen
      ? {
          nativeFlowMessage,
          bloksWidget: widget,
          ...(Object.keys(contextInfo).length ? { contextInfo } : {})
        }
      : {
          ...(footer ? { header: { hasMediaAttachment: false, ...(title ? { title } : {}) } } : {}),
          ...(body ? { body: { text: body } } : {}),
          ...(footer ? { footer: { text: footer } } : {}),
          nativeFlowMessage,
          bloksWidget: widget,
          ...(Object.keys(contextInfo).length ? { contextInfo } : {})
        };

    return {
      interactiveMessage
    };
  }

  async send(jid, options = {}) {
    const targetJid = (jid && typeof jid === 'string' && /:\d+@/gi.test(jid))
      ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}`
      : jid;

    let userJid = null;
    try {
      userJid = this.#client?.user?.id || this.#client?.authState?.creds?.me?.id || null;
    } catch (_) {}

    const sendOpts = { ...(userJid ? { userJid } : {}), ...options };
    if (this._quotedMessage && this._quotedMessage.message) {
      const cleanQuoted = { ...this._quotedMessage };
      if (cleanQuoted.key) {
        cleanQuoted.key = {
          ...cleanQuoted.key,
          remoteJid: targetJid
        };
      }
      sendOpts.quoted = cleanQuoted;
    }

    const content = this.build();
    const payload = {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            messageSecret: crypto.randomBytes(32)
          },
          ...content
        }
      }
    };

    const msg = generateWAMessageFromContent(targetJid, payload, sendOpts);
    const additionalNodes = buildInteractiveNodes(targetJid);

    await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
      messageId: msg.key.id,
      additionalNodes,
      ...options
    });

    return msg;
  }
}

export default A2UIMessage;
