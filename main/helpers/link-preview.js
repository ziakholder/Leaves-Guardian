import { prepareWAMessageMedia } from '@whiskeysockets/baileys';
import { processThumbnailBuffer } from './thumbnail-processor.js';

/**
 * Membangun payload link preview tingkat lanjut untuk pesan WhatsApp (extendedTextMessage),
 * lengkap dengan judul, deskripsi, thumbnail berkualitas tinggi, dan favicon resmi (MMS metadata).
 *
 * @param {Object} options Opsi konfigurasi link preview
 * @param {string} options.url URL tujuan
 * @param {string} options.title Judul halaman / preview
 * @param {string} [options.description=''] Deskripsi singkat
 * @param {string|Buffer} [options.thumbnail] Gambar thumbnail preview
 * @param {string|Buffer} [options.favicon] Ikon favicon website
 * @param {boolean} [options.largerThumbnail=false] Tampilkan thumbnail banner besar
 * @param {Object} [socket] Instance socket Baileys untuk mengunggah media ke WhatsApp server
 * @returns {Promise<Object>} Objek link preview yang siap dimasukkan ke pesan
 */
export async function withLinkPreview(options = {}, socket = null) {
  const {
    url,
    sourceUrl,
    title = '',
    description = '',
    thumbnail = null,
    favicon = null,
    largerThumbnail = false,
  } = options;

  const targetUrl = url || sourceUrl || '';
  if (!targetUrl) {
    throw new TypeError('URL link preview wajib diisi (http/https)');
  }

  const uploadFn = socket?.waUploadToServer
    ? (typeof socket.waUploadToServer === 'function' ? socket.waUploadToServer.bind(socket) : socket.waUploadToServer)
    : (socket?.upload ? socket.upload.bind(socket) : undefined);

  let thumbBuffer = null;
  if (thumbnail) {
    thumbBuffer = await processThumbnailBuffer(thumbnail, {
      width: largerThumbnail ? 420 : 300,
      height: largerThumbnail ? 236 : 300,
      quality: 85,
      banner: largerThumbnail,
    });
  }

  let uploadedThumbnail = null;
  if (thumbBuffer && uploadFn) {
    try {
      uploadedThumbnail = await prepareWAMessageMedia(
        { image: thumbBuffer },
        { upload: uploadFn, mediaTypeOverride: 'thumbnail-link' }
      );
    } catch (_) {}
  }

  let uploadedFavicon = null;
  if (favicon && uploadFn) {
    try {
      let favBuffer = null;
      if (Buffer.isBuffer(favicon)) {
        favBuffer = favicon;
      } else if (typeof favicon === 'string' && favicon.startsWith('http')) {
        const res = await fetch(favicon);
        if (res.ok) favBuffer = Buffer.from(await res.arrayBuffer());
      } else if (typeof favicon === 'string') {
        const fs = await import('fs');
        if (fs.existsSync(favicon)) favBuffer = fs.readFileSync(favicon);
      }

      if (favBuffer) {
        const miniFav = await processThumbnailBuffer(favBuffer, {
          width: 48,
          height: 48,
          quality: 85,
          banner: false,
        });
        if (miniFav) {
          uploadedFavicon = await prepareWAMessageMedia(
            { image: miniFav },
            { upload: uploadFn, mediaTypeOverride: 'thumbnail-link' }
          );
        }
      }
    } catch (_) {}
  }

  const thumbInfo = uploadedThumbnail?.imageMessage;
  const favInfo = uploadedFavicon?.imageMessage;

  const linkPreviewPayload = {
    matchedText: targetUrl,
    title,
    description,
    previewType: 'NONE',
    jpegThumbnail: thumbBuffer || undefined,
    type: 'thumbnail',
    inviteLinkGroupTypeV2: 'DEFAULT',
  };

  if (largerThumbnail && thumbInfo) {
    linkPreviewPayload.thumbnailDirectPath = thumbInfo.directPath;
    linkPreviewPayload.thumbnailSha256 = thumbInfo.fileSha256;
    linkPreviewPayload.thumbnailEncSha256 = thumbInfo.fileEncSha256;
    linkPreviewPayload.mediaKey = thumbInfo.mediaKey;
    linkPreviewPayload.mediaKeyTimestamp = Math.floor(Date.now() / 1000).toString();
    linkPreviewPayload.thumbnailHeight = thumbInfo.height;
    linkPreviewPayload.thumbnailWidth = thumbInfo.width;
  }

  if (favInfo) {
    linkPreviewPayload.faviconMMSMetadata = {
      thumbnailDirectPath: favInfo.directPath,
      thumbnailSha256: favInfo.fileSha256,
      thumbnailEncSha256: favInfo.fileEncSha256,
      mediaKey: favInfo.mediaKey,
      mediaKeyTimestamp: Math.floor(Date.now() / 1000).toString(),
      thumbnailHeight: favInfo.height,
      thumbnailWidth: favInfo.width,
    };
  }

  return {
    linkPreview: {
      'matched-text': targetUrl,
      title,
      description,
      jpegThumbnail: thumbBuffer || undefined,
      highQualityThumbnail: thumbInfo || undefined,
    },
    extendedTextMessage: linkPreviewPayload,
  };
}

export default withLinkPreview;
