/**
 * withChannelForward — helper buat bikin pesan keliatan "diteruskan dari channel"
 * (yang bikin bot keliatan lebih resmi, kayak header "~ Luna" + tombol
 * "Lihat saluran" di screenshot kamu).
 *
 * Ini BUKAN model message baru — ini modifier yang nempel ke contextInfo
 * model message manapun (ListMessage, ButtonMessage, RichMessage, dll).
 *
 * Contoh pakai:
 *   import { ListMessage, withChannelForward } from 'leaves-guardian';
 *
 *   const list = new ListMessage(sock)
 *     .setContextInfo(withChannelForward({
 *        channelJid: '120363000000000000@newsletter',
 *        channelName: 'Royal Store Official',
 *     }))
 *     .setBody('Halo, ini menu hari ini')
 *     .addSection('Menu', [...]);
 *
 *   await list.send(jid);
 *
 * @param {Object} opts
 * @param {string} opts.channelJid  - JID channel/newsletter (format: xxxx@newsletter)
 * @param {string} opts.channelName - Nama channel yang ditampilkan
 * @param {number} [opts.serverMessageId] - ID pesan di channel (opsional, biar bisa di-track)
 */
function withChannelForward({ channelJid, channelName, serverMessageId = 1 }) {
  if (!channelJid || !channelName) {
    throw new Error('channelJid dan channelName wajib diisi');
  }

  return {
    forwardingScore: 9999, // angka tinggi = ditampilkan sebagai "Diteruskan"
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: channelJid,
      newsletterName: channelName,
      serverMessageId,
    },
  };
}

export default withChannelForward;
