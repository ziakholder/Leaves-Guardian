import { MediaError } from '../errors/LeavesError.js';
import { MEDIA_ERROR_CODES } from './MediaConstants.js';

/**
 * Built-in pure Node.js WebP EXIF Metadata Injector for WhatsApp Stickers.
 */
export class WebpExifTransformer {
  constructor() {
    this.name = 'builtin-webp-exif';
  }

  /**
   * Checks if transformation is supported (WebP image with sticker options).
   * @param {Object} metadata
   * @param {Object} [transformOptions]
   * @returns {boolean}
   */
  supports(metadata, transformOptions) {
    if (!transformOptions || !transformOptions.sticker) return false;
    return metadata && (metadata.mimetype === 'image/webp' || metadata.extension === 'webp');
  }

  /**
   * Injects WhatsApp sticker metadata into WebP buffer.
   * @param {{ buffer?: Buffer, filePath?: string }} input
   * @param {Object} transformOptions
   * @param {Object} context
   * @returns {Promise<{ buffer: Buffer }>}
   */
  async transform(input, transformOptions, context) {
    if (context && context.signal && context.signal.aborted) {
      throw new MediaError('Transformation cancelled by signal', MEDIA_ERROR_CODES.PIPELINE_ABORTED);
    }

    let buffer = input.buffer;
    if (!buffer && input.filePath) {
      const fs = await import('fs');
      buffer = await fs.promises.readFile(input.filePath);
    }

    if (!Buffer.isBuffer(buffer)) {
      throw new MediaError('Invalid WebP input for EXIF injection', MEDIA_ERROR_CODES.TRANSFORM_FAILED);
    }

    const stickerMeta = {
      'sticker-pack-id': transformOptions.packId || 'leaves-guardian-sticker',
      'sticker-pack-name': transformOptions.packname || transformOptions.packName || 'Leaves Guardian',
      'sticker-pack-publisher': transformOptions.author || transformOptions.publisher || 'Leaves Bot',
      'android-app-store-link': transformOptions.androidLink || '',
      'ios-app-store-link': transformOptions.iosLink || '',
      'emojis': Array.isArray(transformOptions.categories) ? transformOptions.categories : ['✨']
    };

    const exifBuffer = this.createExifPayload(stickerMeta);
    const patchedBuffer = this.injectExifChunk(buffer, exifBuffer);

    return {
      buffer: patchedBuffer
    };
  }

  /**
   * Creates an EXIF chunk payload containing WhatsApp sticker metadata JSON.
   * @param {Object} jsonMetadata
   * @returns {Buffer}
   */
  createExifPayload(jsonMetadata) {
    const jsonString = JSON.stringify(jsonMetadata);
    const jsonBytes = Buffer.from(jsonString, 'utf8');

    // EXIF header: Exif\0\0 + TIFF Header (Little Endian 'II*\0') + IFD structure
    const exifHeader = Buffer.from([
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
      0x49, 0x49, 0x2a, 0x00,             // II*\0 (TIFF header, Little Endian)
      0x08, 0x00, 0x00, 0x00              // Offset to 0th IFD (8 bytes from TIFF header)
    ]);

    // IFD: 1 entry (Tag 0x5357 = "SW" / WhatsApp sticker metadata), Type 7 (UNDEFINED), Count, Offset
    const ifdCount = Buffer.from([0x01, 0x00]); // 1 field
    const tag = 0x5357; // WhatsApp metadata tag
    const type = 7;     // UNDEFINED (byte array)
    const count = jsonBytes.length;
    const offset = 0x1a; // 26 bytes from TIFF header start (header 8 + ifdCount 2 + entry 12 + nextIfd 4 = 26)

    const entry = Buffer.alloc(12);
    entry.writeUInt16LE(tag, 0);
    entry.writeUInt16LE(type, 2);
    entry.writeUInt32LE(count, 4);
    entry.writeUInt32LE(offset, 8);

    const nextIfdOffset = Buffer.from([0x00, 0x00, 0x00, 0x00]); // 4 bytes 0

    return Buffer.concat([exifHeader, ifdCount, entry, nextIfdOffset, jsonBytes]);
  }

  /**
   * Injects an EXIF chunk into a WebP buffer.
   * @param {Buffer} webpBuffer
   * @param {Buffer} exifPayload
   * @returns {Buffer}
   */
  injectExifChunk(webpBuffer, exifPayload) {
    if (webpBuffer.length < 12 || webpBuffer.toString('ascii', 0, 4) !== 'RIFF' || webpBuffer.toString('ascii', 8, 12) !== 'WEBP') {
      throw new MediaError('Invalid WebP signature', MEDIA_ERROR_CODES.UNSUPPORTED_TYPE);
    }

    // Prepare EXIF chunk: 'EXIF' + uint32LE length + payload (+ padding byte if length is odd)
    const chunkLen = exifPayload.length;
    const isOdd = chunkLen % 2 !== 0;
    const header = Buffer.alloc(8);
    header.write('EXIF', 0, 4, 'ascii');
    header.writeUInt32LE(chunkLen, 4);

    const exifChunk = Buffer.concat([
      header,
      exifPayload,
      isOdd ? Buffer.from([0x00]) : Buffer.alloc(0)
    ]);

    // Check existing chunks
    let offset = 12;
    const chunks = [];
    let hasVp8x = false;

    while (offset < webpBuffer.length) {
      if (offset + 8 > webpBuffer.length) break;
      const fourcc = webpBuffer.toString('ascii', offset, offset + 4);
      const size = webpBuffer.readUInt32LE(offset + 4);
      const totalChunkSize = 8 + size + (size % 2);

      if (fourcc === 'EXIF') {
        // Skip existing EXIF chunk to replace it
        offset += totalChunkSize;
        continue;
      }

      if (fourcc === 'VP8X') {
        hasVp8x = true;
      }

      chunks.push({
        fourcc,
        data: webpBuffer.subarray(offset, Math.min(offset + totalChunkSize, webpBuffer.length))
      });

      offset += totalChunkSize;
    }

    // Assemble new WebP
    const assembledBody = [];

    // If VP8X is present, we must ensure the EXIF flag (bit 3, 0x08) is set at flags byte (offset 8 in VP8X chunk)
    for (const chunk of chunks) {
      if (chunk.fourcc === 'VP8X') {
        const vp8xData = Buffer.from(chunk.data);
        if (vp8xData.length >= 9) {
          vp8xData[8] = vp8xData[8] | 0x08; // Set EXIF flag
        }
        assembledBody.push(vp8xData);
      } else {
        assembledBody.push(chunk.data);
      }
    }

    // Append our EXIF chunk
    assembledBody.push(exifChunk);

    const bodyBuffer = Buffer.concat(assembledBody);
    const newRiffHeader = Buffer.alloc(12);
    newRiffHeader.write('RIFF', 0, 4, 'ascii');
    newRiffHeader.writeUInt32LE(4 + bodyBuffer.length, 4);
    newRiffHeader.write('WEBP', 8, 4, 'ascii');

    return Buffer.concat([newRiffHeader, bodyBuffer]);
  }
}

/**
 * Registry for pluggable and built-in media transformers.
 */
export class TransformerRegistry {
  constructor() {
    this.transformers = [];
    // Register built-in pure Node.js WebP EXIF transformer
    this.register(new WebpExifTransformer());
  }

  /**
   * Registers a transformer.
   * @param {Object} transformer
   */
  register(transformer) {
    if (!transformer || typeof transformer.supports !== 'function' || typeof transformer.transform !== 'function') {
      throw new TypeError('Transformer must implement supports(metadata, options) and transform(input, options, context)');
    }
    this.transformers.push(transformer);
  }

  /**
   * Finds matching transformer for given metadata and transform options.
   * @param {Object} metadata
   * @param {Object} [transformOptions]
   * @returns {Object|null}
   */
  findTransformer(metadata, transformOptions) {
    if (!transformOptions || Object.keys(transformOptions).length === 0) return null;
    for (const t of this.transformers) {
      try {
        if (t.supports(metadata, transformOptions)) {
          return t;
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  /**
   * Executes appropriate transformer.
   * @param {{ buffer?: Buffer, filePath?: string }} input
   * @param {Object} metadata
   * @param {Object} transformOptions
   * @param {Object} context
   * @returns {Promise<{ buffer?: Buffer, filePath?: string }>}
   */
  async execute(input, metadata, transformOptions, context) {
    if (!transformOptions || Object.keys(transformOptions).length === 0) {
      return input;
    }

    const transformer = this.findTransformer(metadata, transformOptions);
    if (!transformer) {
      throw new MediaError(
        'No registered transformer supports the requested transformation options',
        MEDIA_ERROR_CODES.TRANSFORM_FAILED,
        { transformOptions }
      );
    }

    try {
      return await transformer.transform(input, transformOptions, context);
    } catch (err) {
      if (err instanceof MediaError) throw err;
      throw new MediaError(
        `Transformer "${transformer.name || 'unknown'}" failed: ${err.message}`,
        MEDIA_ERROR_CODES.TRANSFORM_FAILED,
        { cause: err, transformer: transformer.name }
      );
    }
  }
}
