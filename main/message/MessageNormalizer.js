import { Message } from './Message.js';
import { MessageTypes } from './MessageTypes.js';
import { MessageNormalizationError } from '../errors/LeavesError.js';
import { resolveLidToPn } from '../helpers/lid-resolver.js';

export class MessageNormalizer {
  /**
   * Main entry point to normalize raw Baileys messages into standardized Message objects.
   * @param {Object} rawBaileysMsg
   * @returns {Message|null}
   */
  static normalize(rawBaileysMsg) {
    if (!rawBaileysMsg) return null;

    try {
      // 1. Validate
      const key = rawBaileysMsg.key;
      if (!key || typeof key !== 'object') {
        throw new MessageNormalizationError('Invalid message key', { raw: rawBaileysMsg });
      }

      const id = key.id || '';
      let remoteJid = key.remoteJid || '';
      const remoteJidAlt = key.remoteJidAlt || rawBaileysMsg.remoteJidAlt || '';
      const isGroup = remoteJid.endsWith('@g.us');
      const isMe = Boolean(key.fromMe);
      let senderJid = isGroup ? (key.participant || rawBaileysMsg.participant || '') : remoteJid;

      if (!isGroup && remoteJid.includes('@lid')) {
        if (remoteJidAlt && typeof remoteJidAlt === 'string' && remoteJidAlt.endsWith('@s.whatsapp.net')) {
          remoteJid = remoteJidAlt;
        } else {
          remoteJid = resolveLidToPn(remoteJid);
        }
        senderJid = remoteJid;
      } else if (isGroup && senderJid.includes('@lid')) {
        const participantAlt = key.participantAlt || rawBaileysMsg.participantAlt;
        if (participantAlt && typeof participantAlt === 'string' && participantAlt.endsWith('@s.whatsapp.net')) {
          senderJid = participantAlt;
        } else {
          senderJid = resolveLidToPn(senderJid);
        }
      }

      // 2. Unwrap
      const rawContent = rawBaileysMsg.message;
      if (!rawContent || typeof rawContent !== 'object') {
        return new Message({
          id,
          chat: { id: remoteJid, isGroup },
          sender: { id: senderJid, isMe },
          type: MessageTypes.UNKNOWN,
          timestamp: Number(rawBaileysMsg.messageTimestamp) * 1000 || Date.now(),
          raw: rawBaileysMsg
        });
      }

      const { content, isViewOnce, isEdited } = MessageNormalizer.unwrap(rawContent);

      // 3. Detect type & extract details
      const detected = MessageNormalizer.detectAndExtract(content, rawContent);

      return new Message({
        id,
        chat: { id: remoteJid, isGroup },
        sender: { id: senderJid, isMe },
        type: detected.type,
        text: detected.text,
        mentions: detected.mentions,
        quoted: detected.quoted,
        media: detected.media ? { ...detected.media, isViewOnce } : null,
        timestamp: Number(rawBaileysMsg.messageTimestamp) * 1000 || Date.now(),
        raw: rawBaileysMsg
      });
    } catch (err) {
      if (err instanceof MessageNormalizationError) {
        // Safe fallback rather than crashing the bot
        return new Message({
          id: rawBaileysMsg?.key?.id || 'error-id',
          chat: { id: rawBaileysMsg?.key?.remoteJid || '', isGroup: false },
          sender: { id: rawBaileysMsg?.key?.remoteJid || '', isMe: false },
          type: MessageTypes.UNKNOWN,
          text: '',
          raw: rawBaileysMsg
        });
      }
      throw new MessageNormalizationError(`Unexpected error during normalization: ${err.message}`, { cause: err, raw: rawBaileysMsg });
    }
  }

  /**
   * Unwraps nested wrapper messages like viewOnce, ephemeral, edited, etc.
   */
  static unwrap(message) {
    let current = message;
    let isViewOnce = false;
    let isEdited = false;

    // Iterate unwrap depth up to 5 levels to avoid circular/deep nesting
    for (let depth = 0; depth < 5; depth++) {
      if (!current || typeof current !== 'object') break;

      if (current.ephemeralMessage?.message) {
        current = current.ephemeralMessage.message;
        continue;
      }
      if (current.viewOnceMessage?.message) {
        isViewOnce = true;
        current = current.viewOnceMessage.message;
        continue;
      }
      if (current.viewOnceMessageV2?.message) {
        isViewOnce = true;
        current = current.viewOnceMessageV2.message;
        continue;
      }
      if (current.viewOnceMessageV2Extension?.message) {
        isViewOnce = true;
        current = current.viewOnceMessageV2Extension.message;
        continue;
      }
      if (current.documentWithCaptionMessage?.message) {
        current = current.documentWithCaptionMessage.message;
        continue;
      }
      if (current.editedMessage?.message?.protocolMessage?.editedMessage) {
        isEdited = true;
        current = current.editedMessage.message.protocolMessage.editedMessage;
        continue;
      }
      break;
    }

    return { content: current || {}, isViewOnce, isEdited };
  }

  /**
   * Detects the message type and extracts text, media, mentions, and quoted messages.
   */
  static detectAndExtract(content, rootContent) {
    let type = MessageTypes.UNKNOWN;
    let text = '';
    let media = null;
    let contextInfo = null;

    if (content.conversation) {
      type = MessageTypes.TEXT;
      text = content.conversation;
    } else if (content.extendedTextMessage) {
      type = MessageTypes.TEXT;
      text = content.extendedTextMessage.text || '';
      contextInfo = content.extendedTextMessage.contextInfo;
    } else if (content.imageMessage) {
      type = MessageTypes.IMAGE;
      text = content.imageMessage.caption || '';
      contextInfo = content.imageMessage.contextInfo;
      media = {
        mimetype: content.imageMessage.mimetype || 'image/jpeg',
        fileLength: content.imageMessage.fileLength,
        url: content.imageMessage.url
      };
    } else if (content.videoMessage) {
      type = MessageTypes.VIDEO;
      text = content.videoMessage.caption || '';
      contextInfo = content.videoMessage.contextInfo;
      media = {
        mimetype: content.videoMessage.mimetype || 'video/mp4',
        seconds: content.videoMessage.seconds,
        gifPlayback: Boolean(content.videoMessage.gifPlayback)
      };
    } else if (content.audioMessage) {
      type = MessageTypes.AUDIO;
      contextInfo = content.audioMessage.contextInfo;
      media = {
        mimetype: content.audioMessage.mimetype || 'audio/ogg',
        seconds: content.audioMessage.seconds,
        ptt: Boolean(content.audioMessage.ptt)
      };
    } else if (content.documentMessage) {
      type = MessageTypes.DOCUMENT;
      text = content.documentMessage.caption || '';
      contextInfo = content.documentMessage.contextInfo;
      media = {
        fileName: content.documentMessage.fileName || 'document',
        mimetype: content.documentMessage.mimetype || 'application/octet-stream',
        fileLength: content.documentMessage.fileLength
      };
    } else if (content.stickerMessage) {
      type = MessageTypes.STICKER;
      contextInfo = content.stickerMessage.contextInfo;
      media = {
        mimetype: content.stickerMessage.mimetype || 'image/webp',
        isAnimated: Boolean(content.stickerMessage.isAnimated)
      };
    } else if (content.locationMessage) {
      type = MessageTypes.LOCATION;
      text = content.locationMessage.name || content.locationMessage.address || '';
      contextInfo = content.locationMessage.contextInfo;
    } else if (content.contactMessage || content.contactsArrayMessage) {
      type = MessageTypes.CONTACT;
      text = content.contactMessage?.displayName || '';
      contextInfo = content.contactMessage?.contextInfo;
    } else if (content.reactionMessage) {
      type = MessageTypes.REACTION;
      text = content.reactionMessage.text || '';
    } else if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) {
      type = MessageTypes.POLL;
      const poll = content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3;
      text = poll.name || '';
      contextInfo = poll.contextInfo;
    } else if (content.buttonsResponseMessage || content.templateButtonReplyMessage || content.interactiveResponseMessage) {
      type = MessageTypes.BUTTON;
      let interactiveText = '';
      if (content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
          const params = content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson;
          const parsed = typeof params === 'string' ? JSON.parse(params) : params;
          interactiveText = parsed.id || parsed.selected_id || parsed.selectedRowId || parsed.copy_code || parsed.command || parsed.text || '';
        } catch {
          interactiveText = String(content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson || '');
        }
      }
      if (!interactiveText && content.interactiveResponseMessage?.body?.text) {
        interactiveText = content.interactiveResponseMessage.body.text;
      }
      text = content.buttonsResponseMessage?.selectedButtonId ||
             content.buttonsResponseMessage?.selectedDisplayText ||
             content.templateButtonReplyMessage?.selectedId ||
             content.templateButtonReplyMessage?.selectedDisplayText ||
             interactiveText || '';
      contextInfo = content.buttonsResponseMessage?.contextInfo ||
                    content.templateButtonReplyMessage?.contextInfo ||
                    content.interactiveResponseMessage?.contextInfo;
    } else if (content.listResponseMessage) {
      type = MessageTypes.LIST;
      text = content.listResponseMessage.singleSelectReply?.selectedRowId ||
             content.listResponseMessage.title || '';
      contextInfo = content.listResponseMessage.contextInfo;
    }

    // Extract mentions & quoted message
    if (!contextInfo) {
      contextInfo = rootContent?.contextInfo || {};
    }

    const mentions = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];

    let quoted = null;
    if (contextInfo?.quotedMessage) {
      const q = contextInfo.quotedMessage;
      const qUnwrapped = MessageNormalizer.unwrap(q).content;
      quoted = {
        id: contextInfo.stanzaId || '',
        senderId: contextInfo.participant || '',
        text: qUnwrapped.conversation || qUnwrapped.extendedTextMessage?.text || qUnwrapped.imageMessage?.caption || ''
      };
    }

    return { type, text, media, mentions, quoted };
  }
}
