import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AlbumMessage,
  OrderMessage,
  StickerPackMessage,
  ButtonMessageV2,
  ButtonV2,
  createMessageBuilder,
  decorateSocket,
  resolveLidToPn,
  getPNFromLid,
  getLidFromPN,
  LeavesClient,
  audioToOpus,
  useSQLiteAuthState,
  withLinkPreview,
  TextMessage,
  ButtonMessage,
  CarouselMessage,
  AIRichMessage,
} from '../main/index.js';
import { FakeSocket } from '../main/test-utils/FakeSocket.js';

class MockRelaySocket extends FakeSocket {
  constructor(options = {}) {
    super(options);
    this.relayedMessages = [];
  }

  async relayMessage(jid, message, options = {}) {
    const record = { jid, message, options, id: options.messageId || `msg_${Date.now()}` };
    this.relayedMessages.push(record);
    return { key: { id: record.id, remoteJid: jid }, message };
  }

  async waUploadToServer(payload) {
    return {
      directPath: '/v/dummy-image-path',
      url: 'https://example.com/mock.jpg',
      documentMessage: {
        fileLength: 1024,
        fileSha256: Buffer.from('dummy-sha-256'),
        fileEncSha256: Buffer.from('dummy-enc-sha-256'),
        mediaKey: Buffer.from('dummy-media-key'),
        directPath: '/v/dummy-path',
        mediaKeyTimestamp: Math.floor(Date.now() / 1000).toString(),
      },
      imageMessage: {
        url: 'https://example.com/mock.jpg',
        mimetype: 'image/jpeg',
      },
    };
  }

  async groupMetadata(jid) {
    return {
      id: jid,
      participants: [
        { id: '111122223333@lid', phoneNumber: '628123456789@s.whatsapp.net' },
        { id: '444455556666@lid', phoneNumber: '628987654321@s.whatsapp.net' },
      ],
    };
  }
}

test('AlbumMessage should construct and relay album and association messages', async () => {
  const sock = new MockRelaySocket();
  const album = new AlbumMessage(sock)
    .addImage(Buffer.from('fake-image-1'), { caption: 'Foto 1' })
    .addImage(Buffer.from('fake-image-2'), { caption: 'Foto 2' });

  const res = await album.send('628123456789@s.whatsapp.net');
  assert.ok(res);
  assert.ok(res.key);
  assert.ok(sock.relayedMessages.length >= 3, 'Parent album message + 2 child media messages');
  assert.ok(sock.relayedMessages[0].message.albumMessage, 'First message should be albumMessage');
  assert.equal(sock.relayedMessages[0].message.albumMessage.expectedImageCount, 2);
});

test('AlbumMessage should throw error if less than 2 items are provided', async () => {
  const sock = new MockRelaySocket();
  const album = new AlbumMessage(sock).addImage(Buffer.from('fake-image-1'));

  await assert.rejects(
    async () => {
      await album.send('628123456789@s.whatsapp.net');
    },
    /Album WhatsApp membutuhkan minimal 2 item media/
  );
});

test('OrderMessage should build and relay catalog invoice order', async () => {
  const sock = new MockRelaySocket();
  const order = new OrderMessage(sock)
    .setOrderTitle('Kopi Susu Gula Aren')
    .setMessage('2 gelas ukuran large')
    .setItemCount(2)
    .setTotalAmount(36000, 'IDR');

  const res = await order.send('628123456789@s.whatsapp.net');
  assert.ok(res);
  assert.equal(sock.relayedMessages.length, 1);
  const msgObj = sock.relayedMessages[0].message;
  assert.ok(msgObj.orderMessage);
  assert.equal(msgObj.orderMessage.orderTitle, 'Kopi Susu Gula Aren');
  assert.equal(Number(msgObj.orderMessage.totalAmount1000), 36000000);
  assert.equal(msgObj.orderMessage.totalCurrencyCode, 'IDR');
});

test('ButtonMessageV2 should build legacy buttonsMessage with headerType 6', async () => {
  const sock = new MockRelaySocket();
  const btn = new ButtonMessageV2(sock)
    .setTitle('Lokasi Outlet')
    .setSubtitle('Jl. Sudirman No. 1')
    .setBody('Silakan klik menu di bawah')
    .setFooter('Leaves Guardian')
    .addButton('Lihat Promo', 'btn_promo')
    .addButton('Kontak CS', 'btn_cs');

  assert.equal(ButtonV2, ButtonMessageV2);
  const res = await btn.send('628123456789@s.whatsapp.net');
  assert.ok(res);
  assert.equal(sock.relayedMessages.length, 1);
  const bm = sock.relayedMessages[0].message.buttonsMessage;
  assert.ok(bm);
  assert.equal(bm.headerType, 6);
  assert.equal(bm.locationMessage.name, 'Lokasi Outlet');
  assert.equal(bm.locationMessage.address, 'Jl. Sudirman No. 1');
  assert.equal(bm.buttons.length, 2);
});

test('StickerPackMessage should build and relay WhatsApp sticker pack', async () => {
  const sock = new MockRelaySocket();
  const pack = new StickerPackMessage(sock)
    .setName('Koleksi Stiker Lucu')
    .setPublisher('Royal Studio')
    .setDescription('Stiker resmi')
    .setCover(Buffer.from('fake-webp-cover'))
    .addSticker(Buffer.from('fake-sticker-1'), ['🐱'])
    .addSticker(Buffer.from('fake-sticker-2'), ['🐶']);

  const res = await pack.send('628123456789@s.whatsapp.net');
  assert.ok(res);
  assert.equal(sock.relayedMessages.length, 1);
  const packMsg = sock.relayedMessages[0].message.stickerPackMessage;
  assert.ok(packMsg);
  assert.equal(packMsg.name, 'Koleksi Stiker Lucu');
  assert.equal(packMsg.stickers.length, 2);
});

test('decorateSocket should inject all helper methods onto Baileys socket', async () => {
  const rawSock = new MockRelaySocket();
  decorateSocket(rawSock);

  assert.equal(typeof rawSock.messageBuilder, 'function');
  assert.equal(typeof rawSock.sendAlbum, 'function');
  assert.equal(typeof rawSock.sendOrder, 'function');
  assert.equal(typeof rawSock.sendButton, 'function');
  assert.equal(typeof rawSock.sendCard, 'function');
  assert.equal(typeof rawSock.sendStickerPack, 'function');
  assert.equal(typeof rawSock.sendSticker, 'function');
  assert.equal(typeof rawSock.getPNFromLid, 'function');
  assert.equal(typeof rawSock.getLidFromPN, 'function');
});

test('createMessageBuilder should proxy to specific builder and chain send()', async () => {
  const sock = new MockRelaySocket();
  decorateSocket(sock);

  const builder = sock.messageBuilder('628123456789@s.whatsapp.net')
    .setType('Order')
    .setOrderTitle('Order Lewat MessageBuilder')
    .setTotalAmount(50000, 'IDR');

  const res = await builder.send();
  assert.ok(res);
  assert.equal(sock.relayedMessages.length, 1);
  assert.equal(sock.relayedMessages[0].message.orderMessage.orderTitle, 'Order Lewat MessageBuilder');
});

test('LID to Phone Number resolution utilities', async () => {
  const sock = new MockRelaySocket();

  // Test in Group context
  const mockMsgGroup = { chat: '120363000000000000@g.us', key: {} };
  const pn = await getPNFromLid(mockMsgGroup, '111122223333@lid', sock);
  assert.equal(pn, '628123456789@s.whatsapp.net');

  const lid = await getLidFromPN(mockMsgGroup, '628987654321@s.whatsapp.net', sock);
  assert.equal(lid, '444455556666@lid');

  // Test in Private Chat context
  const mockMsgPrivate = {
    chat: '628111222333@s.whatsapp.net',
    key: { remoteJid: '999988887777@lid', remoteJidAlt: '628111222333@s.whatsapp.net' },
  };
  const pnPriv = await getPNFromLid(mockMsgPrivate, '999988887777@lid', sock);
  assert.equal(pnPriv, '628111222333@s.whatsapp.net');
});

test('LeavesClient direct convenience methods', async () => {
  const fakeSock = new MockRelaySocket();
  const client = new LeavesClient({
    socketFactory: () => fakeSock,
    terminal: { enabled: false },
    reconnect: { enabled: false },
  });

  // Mock getRawSocket to return our MockRelaySocket
  client.getRawSocket = () => fakeSock;

  // Test client.sendOrder
  const resOrder = await client.sendOrder('628123456789@s.whatsapp.net', {
    orderTitle: 'Pesanan Client Langsung',
    totalAmount: 25000,
  });
  assert.ok(resOrder);

  // Test client.sendAlbum
  const resAlbum = await client.sendAlbum('628123456789@s.whatsapp.net', [
    { image: Buffer.from('img-1') },
    { image: Buffer.from('img-2') },
  ]);
  assert.ok(resAlbum);

  // Test client.messageBuilder
  const builder = client.messageBuilder('628123456789@s.whatsapp.net')
    .setType('Order')
    .setOrderTitle('Client Builder Order')
    .setTotalAmount(15000);
  const resBuilder = await builder.send();
  assert.ok(resBuilder);
  await client.disconnect();
});

test('AudioToOpus and useSQLiteAuthState should provide clean, descriptive error if native dependencies are missing', async () => {
  // AudioToOpus validation
  await assert.rejects(
    async () => {
      await audioToOpus('not-a-buffer');
    },
    /Input audio harus berupa Buffer/
  );

  // useSQLiteAuthState validation
  try {
    await useSQLiteAuthState('./test-temp-auth.db');
  } catch (err) {
    assert.ok(
      err.message.includes('better-sqlite3') || err.message.includes('MODULE_NOT_FOUND'),
      'Should mention better-sqlite3 requirement'
    );
  }
});

test('withLinkPreview should build preview structure and handle thumbnail/favicon metadata', async () => {
  const sock = new MockRelaySocket();
  const thumb = Buffer.from('test-thumbnail-data');
  const fav = Buffer.from('test-favicon-data');

  const result = await withLinkPreview(
    {
      url: 'https://example.com/guide',
      title: 'Documentation Guide',
      description: 'A comprehensive guide for bots',
      thumbnail: thumb,
      favicon: fav,
      largerThumbnail: true,
    },
    sock
  );

  assert.ok(result.linkPreview);
  assert.equal(result.linkPreview.title, 'Documentation Guide');
  assert.equal(result.linkPreview['matched-text'], 'https://example.com/guide');
  assert.ok(result.extendedTextMessage);
  assert.equal(result.extendedTextMessage.title, 'Documentation Guide');
  assert.equal(result.extendedTextMessage.matchedText, 'https://example.com/guide');
  assert.equal(result.extendedTextMessage.thumbnailDirectPath, '/v/dummy-image-path');
  assert.ok(result.extendedTextMessage.faviconMMSMetadata);
  assert.equal(result.extendedTextMessage.faviconMMSMetadata.thumbnailDirectPath, '/v/dummy-image-path');
});

test('withLinkPreview should throw if url is missing', async () => {
  await assert.rejects(
    async () => {
      await withLinkPreview({ title: 'No URL' });
    },
    /URL link preview wajib diisi/
  );
});

test('TextMessage setLinkPreview should integrate with withLinkPreview', async () => {
  const sock = new MockRelaySocket();
  const textMsg = new TextMessage(sock)
    .setBody('Kunjungi website kami: https://example.com')
    .setLinkPreview({
      url: 'https://example.com',
      title: 'Contoh Web',
      description: 'Website resmi',
    });

  const res = await textMsg.send('628123456789@s.whatsapp.net');
  assert.ok(res);
  assert.equal(sock.sentMessages.length, 1);
  const sent = sock.sentMessages[0].content;
  assert.equal(sent.title, 'Contoh Web');
  assert.equal(sent.description, 'Website resmi');
  assert.equal(sent.matchedText, 'https://example.com');
});

test('ButtonMessage toCard and CarouselMessage addCard should integrate seamlessly', async () => {
  const sock = new MockRelaySocket();

  const btn1 = new ButtonMessage(sock)
    .setTitle('Paket Hemat')
    .setBody('Dapatkan diskon 50%')
    .setFooter('Syarat & Ketentuan berlaku')
    .addReply('Beli Paket 1', 'buy_1');

  const btn2 = new ButtonMessage(sock)
    .setTitle('Paket Premium')
    .setBody('Akses fitur tanpa batas')
    .setFooter('Garansi 30 hari')
    .addReply('Beli Paket 2', 'buy_2');

  const carousel = new CarouselMessage(sock)
    .setBody('Pilih promo langganan terbaik untukmu:')
    .addCard([btn1, btn2]);

  const built = await carousel.build();
  assert.ok(built);
  const cards = built.interactiveMessage.carouselMessage.cards;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].header.title, 'Paket Hemat');
  assert.equal(cards[0].body.text, 'Dapatkan diskon 50%');
  assert.equal(cards[0].footer.text, 'Syarat & Ketentuan berlaku');
  assert.equal(cards[1].header.title, 'Paket Premium');
});

test('AIRichMessage addHtml should build unifiedResponse with FOAHtmlPrimitiveDemoDONOTUSE', async () => {
  const sock = new MockRelaySocket();
  const aiMsg = new AIRichMessage(sock)
    .setTitle('AI Interactive Demo')
    .addHtml('<html><body><h1>Halo dari AI</h1></body></html>', {
      trustedSources: ['nixel.dev', 'ryuu.biz.id'],
    });

  const built = await aiMsg.build('628123456789@s.whatsapp.net');
  assert.ok(built);
  assert.ok(built.message);
  const botMsg = built.message.botForwardedMessage.message.richResponseMessage;
  assert.ok(botMsg);
  assert.ok(botMsg.unifiedResponse?.data);

  const decoded = JSON.parse(Buffer.from(botMsg.unifiedResponse.data, 'base64').toString('utf8'));
  assert.ok(decoded.sections);
  assert.equal(decoded.sections.length, 1);
  const section = decoded.sections[0];
  assert.equal(section.view_model?.__typename, 'GenAISingleLayoutViewModel');
  assert.equal(section.view_model?.primitive?.__typename, 'FOAHtmlPrimitiveDemoDONOTUSE');
  assert.equal(section.view_model?.primitive?.payload, '<html><body><h1>Halo dari AI</h1></body></html>');
  assert.deepEqual(section.view_model?.primitive?.trusted_sources, ['nixel.dev', 'ryuu.biz.id']);
});


