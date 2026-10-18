import fs from 'node:fs';

/**
 * Normalizes and compresses an image source (URL, Buffer, or file path)
 * into a lightweight JPEG thumbnail buffer suitable for WhatsApp locationMessage
 * and interactive card payloads.
 *
 * Implements a dynamic multi-engine fallback:
 * 1. sharp (Lanczos3 + MozJPEG for maximum clarity and speed if installed)
 * 2. @napi-rs/canvas (Google Skia Rust engine bundled in leaves-guardian)
 * 3. jimp (pure JS fallback if installed)
 * 4. Raw buffer fallback if no image engine is available
 *
 * @param {Buffer|string} source - Image URL, local file path, or raw Buffer
 * @param {Object} [options]
 * @param {number} [options.width=300] - Target width in pixels (1:1 square recommended for WA avatar)
 * @param {number} [options.height=300] - Target height in pixels
 * @param {number} [options.quality=80] - JPEG compression quality (1-100)
 * @returns {Promise<Buffer|null>}
 */
export async function processThumbnailBuffer(source, { width = 300, height = 300, quality = 80 } = {}) {
  if (!source) return null;

  let buffer = null;

  try {
    if (Buffer.isBuffer(source)) {
      buffer = source;
    } else if (typeof source === 'string') {
      if (fs.existsSync(source)) {
        buffer = fs.readFileSync(source);
      } else if (/^https?:\/\//i.test(source)) {
        const res = await fetch(source);
        if (res.ok) {
          buffer = Buffer.from(await res.arrayBuffer());
        }
      }
    }
  } catch (_) {
    return null;
  }

  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }

  const targetW = Number(width) > 0 ? Number(width) : 300;
  const targetH = Number(height) > 0 ? Number(height) : 300;
  const targetQuality = Math.min(Math.max(Number(quality) || 80, 1), 100);

  // Engine 1: sharp (sharpest resampling with Lanczos3 + MozJPEG)
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default || sharpModule;
    const output = await sharp(buffer)
      .resize(targetW, targetH, { fit: 'cover', position: 'center' })
      .jpeg({ quality: targetQuality, mozjpeg: true })
      .toBuffer();
    if (output && output.length > 0) return output;
  } catch (_) {}

  // Engine 2: @napi-rs/canvas (Skia Rust engine)
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(buffer);
    const canvas = createCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const scale = Math.max(targetW / img.width, targetH / img.height);
    const x = (targetW - img.width * scale) / 2;
    const y = (targetH - img.height * scale) / 2;
    ctx.drawImage(img, x, y, img.width * scale, img.height * scale);

    const output = canvas.toBuffer('image/jpeg', targetQuality);
    if (output && output.length > 0) return output;
  } catch (_) {}

  // Engine 3: jimp (pure JS fallback)
  try {
    const jimpModule = await import('jimp');
    const Jimp = jimpModule.default || jimpModule;
    const img = await Jimp.read(buffer);
    img.cover(targetW, targetH).quality(targetQuality);
    const output = await img.getBufferAsync(Jimp.MIME_JPEG);
    if (output && output.length > 0) return output;
  } catch (_) {}

  // Engine 4: raw buffer fallback
  return buffer;
}

export default processThumbnailBuffer;
