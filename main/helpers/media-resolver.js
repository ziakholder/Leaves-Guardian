import { prepareWAMessageMedia } from '@whiskeysockets/baileys';

const isUrl = (str) => /^https?:\/\/.+/i.test(str);
const isWAUrl = (str) => /^https?:\/\/[^/]*\.whatsapp\.net\//i.test(str);

async function fetchBuffer(url, options = {}, { silent = true } = {}) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (silent) return Buffer.alloc(0);
    throw error;
  }
}

async function toWAUrl(client, path, mediaType = 'document') {
  if (!path) throw new Error('Url atau buffer wajib diisi');
  const media = await prepareWAMessageMedia(
    { [mediaType]: Buffer.isBuffer(path) ? path : { url: path } },
    { upload: client.waUploadToServer, jid: '@newsletter' }
  );
  return Object.values(media)[0]?.url;
}

/**
 * resolveMedia — normalisasi media dari berbagai bentuk input jadi bentuk output yang diminta.
 * Berguna kalau kamu nggak mau pusing user kirim media dalam bentuk apa
 * (url WA, url biasa, Buffer, base64 string) — tinggal panggil ini sekali,
 * hasilnya konsisten.
 *
 * Contoh pakai:
 *   const buffer = await resolveMedia(sock, someInput, 'image', { result: 'buffer' });
 *   const url = await resolveMedia(sock, someBuffer, 'image', { result: 'url' });
 *
 * @param {Object} client - socket Baileys (dibutuhkan kalau result: 'url')
 * @param {string|Buffer|Array} media - input media: url, buffer, base64 string, atau array dari itu
 * @param {string} [mediaType='image'] - 'image' | 'video' | 'document' | 'audio'
 * @param {Object} [opts]
 * @param {boolean} [opts.resolveUrl=false] - kalau true, url biasa (bukan WA) tetap di-fetch jadi buffer dulu
 * @param {boolean} [opts.resolveWAUrl=false] - kalau true, url WA di-fetch ulang jadi buffer
 * @param {'url'|'buffer'|'base64'} [opts.result='url'] - bentuk output yang diinginkan
 * @returns {Promise<string|Buffer|Array>}
 */
async function resolveMedia(client, media, mediaType = 'image', { resolveUrl = false, resolveWAUrl = false, result = 'url' } = {}) {
  if (Array.isArray(media)) {
    return Promise.all(media.map((item) => resolveMedia(client, item, mediaType, { resolveUrl, resolveWAUrl, result })));
  }

  const originalIsBuffer = Buffer.isBuffer(media);

  if (typeof media === 'string' && isUrl(media)) {
    if (isWAUrl(media)) {
      if (resolveWAUrl) {
        media = await fetchBuffer(media);
      } else if (result === 'url') {
        return media;
      } else {
        media = await fetchBuffer(media);
      }
    } else {
      if (result === 'url' && !resolveUrl) return media;
      media = await fetchBuffer(media);
    }
  }

  if (typeof media === 'string' && !isUrl(media)) {
    media = Buffer.from(media, 'base64');
  }

  if (!Buffer.isBuffer(media) || !media.length) {
    return undefined;
  }

  if (result === 'buffer') return media;
  if (result === 'base64') return media.toString('base64');

  // result === 'url' tapi kita sudah punya buffer (dari fetch di atas) → upload ulang ke WA
  if (!client) throw new Error('client wajib diisi kalau result: "url"');
  return toWAUrl(client, media, mediaType);
}

export default resolveMedia;
