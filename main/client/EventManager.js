import { EventEmitter } from 'events';

export class EventManager extends EventEmitter {
  constructor() {
    super();
  }

  /**
   * Bind Baileys socket event emitter to our normalized EventManager.
   */
  bindSocketEvents(sock, handlers = {}) {
    if (!sock || !sock.ev) return;

    sock.ev.on('connection.update', (update) => {
      this.emit('connection.update', update);
      if (typeof handlers.onConnectionUpdate === 'function') {
        handlers.onConnectionUpdate(update);
      }
    });

    sock.ev.on('creds.update', (creds) => {
      this.emit('creds.update', creds);
      if (typeof handlers.onCredsUpdate === 'function') {
        handlers.onCredsUpdate(creds);
      }
    });

    sock.ev.on('messages.upsert', (upsert) => {
      this.emit('messages.upsert', upsert);
      if (typeof handlers.onMessagesUpsert === 'function') {
        handlers.onMessagesUpsert(upsert);
      }
    });
  }
}
