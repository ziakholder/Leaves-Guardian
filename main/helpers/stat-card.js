import { createCanvas } from '@napi-rs/canvas';

/**
 * generateStatCard — contoh dasar bikin gambar card statistik
 * (mirip card "System Pulse" / "Dino Runner" di screenshot kamu).
 *
 * PENTING: ini BUKAN model message WhatsApp. Ini generate file gambar (Buffer PNG)
 * yang nantinya dikirim sebagai imageMessage BIASA lewat sock.sendMessage.
 * Card visual kayak gitu selalu jalan lewat 2 langkah:
 *   1. Generate gambar pakai canvas (fungsi ini)
 *   2. Kirim gambar itu sebagai imageMessage biasa (bukan proto khusus)
 *
 * Contoh pakai:
 *   import { generateStatCard } from 'leaves-guardian';
 *
 *   const buffer = await generateStatCard({
 *     title: 'System Pulse',
 *     stats: [
 *       { label: 'Uptime', value: '1h 31m 29s' },
 *       { label: 'RAM', value: '63.2%' },
 *       { label: 'Latency', value: '0.0ms' },
 *     ],
 *   });
 *
 *   await sock.sendMessage(jid, { image: buffer, caption: 'Status bot' });
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {{label: string, value: string}[]} opts.stats
 * @param {number} [opts.width=600]
 * @param {number} [opts.height]  - auto-hitung dari jumlah stats kalau tidak diisi
 * @returns {Promise<Buffer>} PNG buffer, siap dikirim langsung sebagai imageMessage
 */
async function generateStatCard({ title, stats = [], width = 600, height }) {
  if (!title) throw new Error('title wajib diisi');
  if (!Array.isArray(stats) || stats.length === 0) {
    throw new Error('stats harus array minimal 1 item');
  }

  const rowHeight = 50;
  const headerHeight = 90;
  const finalHeight = height || headerHeight + stats.length * rowHeight + 30;

  const canvas = createCanvas(width, finalHeight);
  const ctx = canvas.getContext('2d');

  // Background gradient — silakan custom warnanya sesuai branding Royal Bot
  const gradient = ctx.createLinearGradient(0, 0, width, finalHeight);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(1, '#16213e');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, finalHeight);

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(title, 24, 55);

  // Garis pembatas
  ctx.strokeStyle = '#4a4a6a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(24, headerHeight - 20);
  ctx.lineTo(width - 24, headerHeight - 20);
  ctx.stroke();

  // Rows
  stats.forEach((stat, i) => {
    const y = headerHeight + i * rowHeight + 30;

    ctx.fillStyle = '#a0a0c0';
    ctx.font = '20px sans-serif';
    ctx.fillText(stat.label, 24, y);

    ctx.fillStyle = '#00e0a0';
    ctx.font = 'bold 20px sans-serif';
    const valueWidth = ctx.measureText(stat.value).width;
    ctx.fillText(stat.value, width - 24 - valueWidth, y);
  });

  return canvas.toBuffer('image/png');
}

export default generateStatCard;
