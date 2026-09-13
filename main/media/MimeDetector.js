import { MEDIA_TYPE } from './MediaConstants.js';

/**
 * Pure Node.js MIME & Magic-Byte Detector (Detector != Policy)
 */
export class MimeDetector {
  /**
   * Inspects a buffer chunk (at least 32-64 bytes recommended) to detect MIME type, extension, and WhatsApp media category.
   * @param {Buffer} buffer
   * @param {string} [filenameHint]
   * @returns {{ mimetype: string, extension: string, mediaType: string, unknown: boolean }}
   */
  static detect(buffer, filenameHint = '') {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return {
        mimetype: 'application/octet-stream',
        extension: 'bin',
        mediaType: MEDIA_TYPE.DOCUMENT,
        unknown: true
      };
    }

    // 1. JPEG: FF D8 FF
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return {
        mimetype: 'image/jpeg',
        extension: 'jpg',
        mediaType: MEDIA_TYPE.IMAGE,
        unknown: false
      };
    }

    // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return {
        mimetype: 'image/png',
        extension: 'png',
        mediaType: MEDIA_TYPE.IMAGE,
        unknown: false
      };
    }

    // 3. GIF: GIF87a or GIF89a
    if (
      buffer.length >= 6 &&
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) &&
      buffer[5] === 0x61
    ) {
      return {
        mimetype: 'image/gif',
        extension: 'gif',
        mediaType: MEDIA_TYPE.IMAGE,
        unknown: false
      };
    }

    // 4. WebP: RIFF .... WEBP
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return {
        mimetype: 'image/webp',
        extension: 'webp',
        mediaType: MEDIA_TYPE.STICKER,
        unknown: false
      };
    }

    // 5. MP4 / M4V / QuickTime: ....ftyp
    if (buffer.length >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.length >= 12 ? buffer.toString('ascii', 8, 12).trim().toLowerCase() : '';
      if (brand === 'qt') {
        return {
          mimetype: 'video/quicktime',
          extension: 'mov',
          mediaType: MEDIA_TYPE.VIDEO,
          unknown: false
        };
      }
      return {
        mimetype: 'video/mp4',
        extension: 'mp4',
        mediaType: MEDIA_TYPE.VIDEO,
        unknown: false
      };
    }

    // 6. WebM / MKV: 1A 45 DF A3
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3
    ) {
      return {
        mimetype: 'video/webm',
        extension: 'webm',
        mediaType: MEDIA_TYPE.VIDEO,
        unknown: false
      };
    }

    // 7. OGG: OggS
    if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') {
      return {
        mimetype: 'audio/ogg; codecs=opus',
        extension: 'ogg',
        mediaType: MEDIA_TYPE.AUDIO,
        unknown: false
      };
    }

    // 8. MP3: ID3 or sync frame (0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2)
    if (
      (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') ||
      (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    ) {
      return {
        mimetype: 'audio/mpeg',
        extension: 'mp3',
        mediaType: MEDIA_TYPE.AUDIO,
        unknown: false
      };
    }

    // 9. WAV: RIFF .... WAVE
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WAVE'
    ) {
      return {
        mimetype: 'audio/wav',
        extension: 'wav',
        mediaType: MEDIA_TYPE.AUDIO,
        unknown: false
      };
    }

    // 10. PDF: %PDF
    if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === '%PDF') {
      return {
        mimetype: 'application/pdf',
        extension: 'pdf',
        mediaType: MEDIA_TYPE.DOCUMENT,
        unknown: false
      };
    }

    // Fallback: filename hint if available
    if (filenameHint && typeof filenameHint === 'string') {
      const lower = filenameHint.toLowerCase();
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
        return { mimetype: 'image/jpeg', extension: 'jpg', mediaType: MEDIA_TYPE.IMAGE, unknown: false };
      }
      if (lower.endsWith('.png')) {
        return { mimetype: 'image/png', extension: 'png', mediaType: MEDIA_TYPE.IMAGE, unknown: false };
      }
      if (lower.endsWith('.webp')) {
        return { mimetype: 'image/webp', extension: 'webp', mediaType: MEDIA_TYPE.STICKER, unknown: false };
      }
      if (lower.endsWith('.mp4')) {
        return { mimetype: 'video/mp4', extension: 'mp4', mediaType: MEDIA_TYPE.VIDEO, unknown: false };
      }
      if (lower.endsWith('.mp3')) {
        return { mimetype: 'audio/mpeg', extension: 'mp3', mediaType: MEDIA_TYPE.AUDIO, unknown: false };
      }
      if (lower.endsWith('.ogg') || lower.endsWith('.opus')) {
        return { mimetype: 'audio/ogg; codecs=opus', extension: 'ogg', mediaType: MEDIA_TYPE.AUDIO, unknown: false };
      }
      if (lower.endsWith('.pdf')) {
        return { mimetype: 'application/pdf', extension: 'pdf', mediaType: MEDIA_TYPE.DOCUMENT, unknown: false };
      }
    }

    return {
      mimetype: 'application/octet-stream',
      extension: 'bin',
      mediaType: MEDIA_TYPE.DOCUMENT,
      unknown: true
    };
  }
}
