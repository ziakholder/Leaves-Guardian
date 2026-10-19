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
export async function processThumbnailBuffer(source, { width, height, quality = 85, banner = true } = {}) {
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
  const isBanner = banner !== false;
  let targetW = Number(width) > 0 ? Number(width) : (isBanner ? 400 : 300);
  let targetH = Number(height) > 0 ? Number(height) : (isBanner ? 225 : 300);
  let targetQuality = Math.min(Math.max(Number(quality) || 85, 1), 100);

  if (targetW > 400) targetW = 400;
  if (targetH > 300) targetH = 300;

  // Engine 1: sharp (Lanczos3 kernel + smart sharpen + MozJPEG with adaptive byte-budget)
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default || sharpModule;
    const meta = await sharp(buffer).metadata();
    const srcRatio = (meta.width && meta.height) ? (meta.width / meta.height) : 1;

    let curW = targetW;
    let curH = targetH;
    let curQ = targetQuality;
    let output = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      let basePipeline;
      if (isBanner && srcRatio < 1.35) {
        // Source is square or portrait: composite onto 16:9 banner with blurred ambient background
        // so the subject NEVER appears squished/gepeng on WhatsApp mobile
        const bg = await sharp(buffer)
          .resize(curW, curH, { fit: 'cover', position: 'center' })
          .blur(18)
          .modulate({ brightness: 0.75 })
          .toBuffer();

        const fgH = Math.max(curH - 12, 10);
        const fgW = Math.round(fgH * srcRatio);
        const fg = await sharp(buffer)
          .resize(fgW, fgH, { fit: 'contain' })
          .toBuffer();

        basePipeline = sharp(bg)
          .composite([{ input: fg, gravity: 'center' }]);
      } else {
        basePipeline = sharp(buffer)
          .resize(curW, curH, {
            fit: 'cover',
            position: 'center',
            kernel: 'lanczos3',
          });
      }

      output = await basePipeline
        .sharpen()
        .jpeg({
          quality: curQ,
          mozjpeg: true,
          chromaSubsampling: '4:2:0',
        })
        .toBuffer();

      if (output && output.length <= MAX_THUMB_BYTES) {
        return output;
      }

      if (curQ > 65) {
        curQ -= 5;
      } else if (curW > 300) {
        curW = 300;
        curH = isBanner ? 169 : 300;
        curQ = 80;
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
    const srcRatio = (img.width && img.height) ? (img.width / img.height) : 1;
    const canvasW = Math.min(targetW, 400);
    const canvasH = Math.min(targetH, 300);
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (isBanner && srcRatio < 1.35) {
      const scaleBg = Math.max(canvasW / img.width, canvasH / img.height);
      const bgW = img.width * scaleBg;
      const bgH = img.height * scaleBg;
      ctx.drawImage(img, (canvasW - bgW) / 2, (canvasH - bgH) / 2, bgW, bgH);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(0, 0, canvasW, canvasH);

      const fgH = canvasH - 12;
      const fgW = Math.round(fgH * srcRatio);
      ctx.drawImage(img, (canvasW - fgW) / 2, (canvasH - fgH) / 2, fgW, fgH);
    } else {
      const scale = Math.max(canvasW / img.width, canvasH / img.height);
      const x = (canvasW - img.width * scale) / 2;
      const y = (canvasH - img.height * scale) / 2;
      ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
    }

    const output = canvas.toBuffer('image/jpeg', Math.min(targetQuality, 82));
    if (output && output.length > 0 && output.length <= MAX_THUMB_BYTES) return output;
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
