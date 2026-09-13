import crypto from 'crypto';
import BaseBuilder from './base-builder.js';
import { ContentValidationError } from '../errors/LeavesError.js';

/**
 * EventMessage — Builder undangan acara / event resmi WhatsApp (Group Event).
 * Mendukung penetapan judul, deskripsi, waktu mulai/selesai, lokasi, dan link call WhatsApp.
 */
export class EventMessage extends BaseBuilder {
  #client;

  constructor(client) {
    super();
    this.#client = BaseBuilder.resolveSocket(client);
    this._name = '';
    this._description = '';
    this._startTime = Date.now() + 3600000; // default 1 hour from now
    this._endTime = null;
    this._location = null;
    this._callLink = null;
    this._isCanceled = false;
  }

  setName(name) {
    if (typeof name !== 'string') throw new TypeError('Event name harus berupa string');
    this._name = name;
    return this;
  }

  setDescription(desc) {
    if (typeof desc !== 'string') throw new TypeError('Description harus berupa string');
    this._description = desc;
    return this;
  }

  setStartTime(dateOrTs) {
    const ts = dateOrTs instanceof Date ? dateOrTs.getTime() : Number(dateOrTs);
    if (isNaN(ts)) throw new ContentValidationError('Start time tidak valid');
    this._startTime = ts;
    return this;
  }

  setEndTime(dateOrTs) {
    const ts = dateOrTs instanceof Date ? dateOrTs.getTime() : Number(dateOrTs);
    if (isNaN(ts)) throw new ContentValidationError('End time tidak valid');
    this._endTime = ts;
    return this;
  }

  setLocation(locationName) {
    this._location = locationName;
    return this;
  }

  setCallLink(url) {
    this._callLink = url;
    return this;
  }

  setCanceled(isCanceled = true) {
    this._isCanceled = Boolean(isCanceled);
    return this;
  }

  build() {
    if (!this._name) {
      throw new ContentValidationError('Event name wajib diisi — gunakan .setName()');
    }

    const name = this._render(this._name);
    const description = this._render(this._description);
    const startDate = new Date(this._startTime);
    const endDate = this._endTime ? new Date(this._endTime) : undefined;

    return {
      event: {
        name,
        description,
        startDate,
        endDate,
        location: this._location ? { name: this._render(this._location) } : undefined,
        isCancelled: this._isCanceled,
        messageSecret: crypto.randomBytes(32),
      },
    };
  }

  async send(jid, options = {}) {
    if (!this.#client) {
      throw new Error('Client / Socket belum di-pass ke EventMessage constructor');
    }
    const message = this.build();
    const sendOpts = { ...options };
    if (this._quotedMessage) {
      sendOpts.quoted = this._quotedMessage;
    }
    return await this.#client.sendMessage(jid, message, sendOpts);
  }
}

export default EventMessage;
