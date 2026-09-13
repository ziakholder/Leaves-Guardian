import { MessageTypes } from './MessageTypes.js';

export class Message {
  constructor(data = {}) {
    this.id = data.id || '';
    this.chat = Object.freeze({
      id: data.chat?.id || '',
      isGroup: Boolean(data.chat?.isGroup)
    });
    this.sender = Object.freeze({
      id: data.sender?.id || '',
      isMe: Boolean(data.sender?.isMe)
    });
    this.type = data.type || MessageTypes.UNKNOWN;
    this.text = data.text || '';
    this.mentions = Object.freeze(Array.isArray(data.mentions) ? [...data.mentions] : []);
    this.quoted = data.quoted ? Object.freeze({ ...data.quoted }) : null;
    this.media = data.media ? Object.freeze({ ...data.media }) : null;
    this.timestamp = data.timestamp || Date.now();
    
    // Advanced escape hatch to raw Baileys message
    this.raw = data.raw || null;

    Object.freeze(this);
  }
}
