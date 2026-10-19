import path from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';
import fs from 'fs/promises';
import { MediaError } from '../errors/LeavesError.js';

/**
 * Mengonversi buffer audio (MP3, WAV, dll) menjadi format Ogg Opus
 * yang kompatibel penuh dengan WhatsApp Voice Note (PTT / Audio Message).
 *
 * @param {Buffer} audioBuffer Buffer audio input
 * @param {Object} [options]
 * @param {number} [options.bitrate=128] Bitrate dalam kbps
 * @returns {Promise<Buffer>} Buffer audio dalam format Ogg Opus
 */
export async function audioToOpus(audioBuffer, options = {}) {
  if (!Buffer.isBuffer(audioBuffer)) {
    throw new MediaError('Input audio harus berupa Buffer');
  }

  let ffmpeg;
  try {
    const imported = await import('fluent-ffmpeg');
    ffmpeg = imported.default || imported;
  } catch (_) {
    throw new MediaError('Modul fluent-ffmpeg tidak ditemukan. Silakan pasang dengan: npm i fluent-ffmpeg');
  }

  const tmpIn = path.join(tmpdir(), `audio_in_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`);
  const tmpOut = path.join(tmpdir(), `audio_out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.opus`);

  try {
    await fs.writeFile(tmpIn, audioBuffer);

    const bitrate = options.bitrate || 128;

    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .audioCodec('libopus')
        .audioBitrate(bitrate)
        .format('opus')
        .save(tmpOut)
        .on('end', resolve)
        .on('error', (err) => reject(new MediaError(`Gagal transcode audio ke Opus: ${err.message}`, { cause: err })));
    });

    const result = await fs.readFile(tmpOut);
    return result;
  } finally {
    try { await fs.unlink(tmpIn); } catch (_) {}
    try { await fs.unlink(tmpOut); } catch (_) {}
  }
}

export const AudioToOpus = audioToOpus;
export default audioToOpus;
