import { EventEmitter } from 'events';
import { Boom } from '@hapi/boom';

export class FakeSocket {
  constructor(options = {}) {
    this.options = options;
    this.ev = new EventEmitter();
    this.user = { id: '628123456789@s.whatsapp.net', name: 'Leaves Bot Tester' };
    this.sentMessages = [];
    this.isClosed = false;
    this.pairingCodeMock = '1234-5678';
  }

  async sendMessage(jid, content, options = {}) {
    if (this.isClosed) throw new Error('Cannot send on closed socket');
    const record = { jid, content, options, timestamp: Date.now() };
    this.sentMessages.push(record);
    return { key: { id: `fake-msg-${Date.now()}`, remoteJid: jid } };
  }

  async requestPairingCode(phoneNumber) {
    return this.pairingCodeMock;
  }

  end(error) {
    this.isClosed = true;
  }

  // Simulation helpers for tests
  simulateConnecting() {
    this.ev.emit('connection.update', { connection: 'connecting' });
  }

  simulateOpen() {
    this.ev.emit('connection.update', { connection: 'open' });
  }

  simulateClose(statusCode = 503, message = 'Service Unavailable') {
    this.simulateDisconnect(statusCode, message);
  }

  simulateDisconnect(statusCode = 503, message = 'Service Unavailable') {
    const error = new Boom(message, { statusCode });
    this.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error, date: new Date() }
    });
  }

  simulateNetworkFailure() {
    this.simulateDisconnect(408, 'Connection Lost / Network Failure');
  }

  simulatePairingCode(code = '9999-0000', phoneNumber = '628123456789') {
    this.pairingCodeMock = code;
    this.ev.emit('connection.update', { connection: 'connecting' });
  }

  simulateMessage(msg) {
    this.ev.emit('messages.upsert', {
      type: 'notify',
      messages: Array.isArray(msg) ? msg : [msg]
    });
  }

  simulateMalformedMessage() {
    this.simulateMessage({
      key: null,
      message: 'broken-string-payload'
    });
  }

  simulateViewOnce(text = 'View once media', isGroup = false) {
    this.simulateMessage({
      key: {
        id: `VO_${Date.now()}`,
        remoteJid: isGroup ? '120363000000000000@g.us' : '628123456789@s.whatsapp.net',
        fromMe: false
      },
      message: {
        viewOnceMessageV2: {
          message: {
            imageMessage: {
              caption: text,
              mimetype: 'image/jpeg'
            }
          }
        }
      },
      messageTimestamp: Math.floor(Date.now() / 1000)
    });
  }
}

export function createFakeSocketFactory() {
  let latestInstance = null;
  const instances = [];

  const factory = (options) => {
    latestInstance = new FakeSocket(options);
    instances.push(latestInstance);
    return latestInstance;
  };

  factory.getLatestInstance = () => latestInstance;
  factory.getAllInstances = () => instances;
  return factory;
}
