/**
 * withAdReply — helper untuk membuat kartu preview link / profil (externalAdReply)
 * seperti kartu "Luna✧ Ryuu Reïnzz api.ryuu-dev.my.id" di WhatsApp.
 *
 * @param {Object} opts
 * @param {string} opts.title - Judul kartu (cth: "Luna✧" atau "Bot Official")
 * @param {string} [opts.body] - Deskripsi / subtitle (cth: "Ryuu Reïnzz")
 * @param {string|Buffer} [opts.thumbnail] - Buffer atau URL gambar thumbnail
 * @param {string} [opts.thumbnailUrl] - URL gambar thumbnail
 * @param {string} [opts.sourceUrl] - URL tujuan saat kartu diklik (cth: "https://api.ryuu-dev.my.id")
 * @param {boolean} [opts.renderLargerThumbnail=false] - True jika ingin thumbnail kartu berukuran besar
 * @param {boolean} [opts.showAdAttribution=false] - Menampilkan label iklan/sponsored
 * @param {number} [opts.mediaType=1] - 1: Gambar, 2: Video
 */
import fs from 'fs';

function withAdReply({
  title,
  body = '',
  thumbnail,
  thumbnailUrl,
  sourceUrl = 'https://whatsapp.com',
  mediaUrl,
  renderLargerThumbnail = false,
  showAdAttribution = false,
  mediaType = 1,
} = {}) {
  if (!title) {
    throw new Error('title wajib diisi untuk adReply');
  }

  let thumbBuf = Buffer.isBuffer(thumbnail) ? thumbnail : undefined;
  let thumbUrl = thumbnailUrl || (typeof thumbnail === 'string' && /^https?:\/\//i.test(thumbnail) ? thumbnail : undefined);

  if (!thumbBuf && typeof thumbnail === 'string' && !/^https?:\/\//i.test(thumbnail)) {
    try {
      if (fs.existsSync(thumbnail)) {
        thumbBuf = fs.readFileSync(thumbnail);
      }
    } catch (_) {}
  }

  const externalAdReply = {
    title,
    body,
    mediaType,
    thumbnailUrl: thumbUrl,
    thumbnail: thumbBuf,
    jpegThumbnail: thumbBuf,
    sourceUrl: sourceUrl || mediaUrl || 'https://whatsapp.com',
    mediaUrl: mediaUrl || sourceUrl || 'https://whatsapp.com',
    renderLargerThumbnail: Boolean(renderLargerThumbnail),
    showAdAttribution: Boolean(showAdAttribution),
  };

  return {
    externalAdReply,
  };
}

export default withAdReply;
