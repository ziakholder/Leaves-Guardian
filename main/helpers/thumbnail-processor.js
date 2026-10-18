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
export async function processThumbnailBuffer(source, { width = 500, height = 500, quality = 88 } = {}) {
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

  const MAX_THUMB_BYTES = 30000;
  let targetW = Number(width) > 0 ? Number(width) : 400;
  let targetH = Number(height) > 0 ? Number(height) : 400;
  let targetQuality = Math.min(Math.max(Number(quality) || 82, 1), 100);

  // If user requested oversized dimensions that exceed WhatsApp's 32KB client threshold,
  // cap initial dimensions to 420x420 for safety
  if (targetW > 420 || targetH > 420) {
    targetW = 420;
    targetH = 420;
  }

  // Engine 1: sharp (Lanczos3 kernel + smart sharpen + MozJPEG with adaptive byte-budget)
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default || sharpModule;
    let curW = targetW;
    let curH = targetH;
    let curQ = targetQuality;
    let output = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      let pipeline = sharp(buffer).resize(curW, curH, {
        fit: 'cover',
        position: 'center',
        kernel: 'lanczos3',
      });

      pipeline = pipeline.sharpen();

      output = await pipeline
        .jpeg({
          quality: curQ,
          mozjpeg: true,
          chromaSubsampling: '4:2:0',
        })
        .toBuffer();

      if (output && output.length <= MAX_THUMB_BYTES) {
        return output;
      }

      if (curQ > 70) {
        curQ -= 4;
      } else if (curW > 300) {
        curW -= 40;
        curH -= 40;
        curQ = 80;
      } else if (curQ > 55) {
        curQ -= 5;
      } else {
        break;
      }
    }

    if (output && output.length > 0) return output;
  } catch (_) {}

  // Engine 2: @napi-rs/canvas (Skia Rust engine)
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(buffer);
    const canvasW = Math.min(targetW, 400);
    const canvasH = Math.min(targetH, 400);
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const scale = Math.max(canvasW / img.width, canvasH / img.height);
    const x = (canvasW - img.width * scale) / 2;
    const y = (canvasH - img.height * scale) / 2;
    ctx.drawImage(img, x, y, img.width * scale, img.height * scale);

    const output = canvas.toBuffer('image/jpeg', Math.min(targetQuality, 80));
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
