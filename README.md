# Leaves Guardian 🍃

**Enterprise Baileys Wrapper & Infrastructure Library for WhatsApp Bots**

Leaves Guardian adalah wrapper library modern di atas `@whiskeysockets/baileys` yang mengabstraksi kompleksitas koneksi, reconnect backoff, manajemen session, parsing pesan berjenjang, dan terminal logging ke dalam satu API yang bersih, modular, dan teruji.

📚 **Dokumentasi Lengkap:** [https://leavesguardian.enginelabs.my.id/](https://leavesguardian.enginelabs.my.id/)

---

## 🚀 Quick Start

```javascript
import { LeavesClient } from 'leaves-guardian';

const client = new LeavesClient({
  auth: {
    directory: './session',
    method: 'pairing', // 'pairing' atau 'qr'
    phoneNumber: '628123456789' // otomatis minta pairing code jika belum terdaftar
  },
  terminal: {
    privacy: true // Otomatis sensor nomor telepon di terminal
  }
});

client.on('ready', ({ user }) => {
  console.log('Bot WhatsApp siap digunakan!');
});

client.on('message', async (msg) => {
  if (msg.text === '.ping') {
    await client.sendText(msg.chat.id, 'Pong!');
  }
});

await client.connect();
```

---

## 🏛️ Arsitektur Modular

```text
                    LEAVES GUARDIAN
                 Baileys Wrapper Layer
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   LeavesClient     LeavesSession    LeavesTerminal
        │                │                │
        │                │                └── Logger / Privacy Scrubber
        │                │
        │                └── Auth / Lock / Persistence
        │
        ├── ConnectionManager
        ├── ReconnectManager (Deterministic Backoff & Jitter)
        ├── EventManager
        ├── MessageNormalizer (Safe Defensif Pipeline)
        └── Outbound API (sendText, sendMessage)
                         │
                         ▼
                      BAILEYS
```

---

## 🌟 Fitur Utama Wrapper

### 1. Connection Lifecycle & Auto-Recovery
Menangani reconnect otomatis dengan exponential backoff dan jitter untuk error jaringan (503, 428, connection closed). **Tidak melakukan reconnect membabi buta** saat `401 / LOGGED_OUT` atau saat proses sedang dimatikan (`SHUTDOWN`).

### 2. OPEN ≠ READY Distinction
- `OPEN` (`connection_open`): Socket koneksi WhatsApp sudah terbuka.
- `READY` (`ready`): Seluruh inisialisasi wrapper selesai dan aman untuk memproses pesan.

### 3. First-Class Pairing Code
Mendukung login tanpa scan QR menggunakan nomor telepon:
```javascript
const client = new LeavesClient({
  auth: { method: 'pairing', phoneNumber: '628123456789' }
});

client.on('pairing_code', ({ code, phoneNumber }) => {
  console.log(`Kode Pairing: ${code}`);
});
```

### 4. Normalized Message Model
Pesan masuk dari WhatsApp secara defensif di-unwrap (termasuk `ephemeralMessage`, `viewOnceMessageV2`, `editedMessage`) menjadi objek standar:
```javascript
client.on('message', (msg) => {
  console.log(msg.id);           // ID pesan
  console.log(msg.chat.id);      // JID Chat / Grup
  console.log(msg.chat.isGroup); // true/false
  console.log(msg.sender.id);    // JID Pengirim
  console.log(msg.type);         // 'text', 'image', 'sticker', dll.
  console.log(msg.text);         // Isi pesan / caption
  console.log(msg.mentions);     // Array nomor yang di-mention
  console.log(msg.quoted);       // Info pesan yang di-reply (jika ada)
});
```

### 5. Beautiful Terminal & Privacy Scrubber
Menghilangkan log JSON mentah dari Pino bawaan Baileys dan menggantinya dengan UI konsol berwarna yang rapi, ber-timestamp, dan otomatis menyamarkan nomor HP (`62812******89`).

---

## 🎨 Interactive Message Builders (Layer 1)

Leaves Guardian tetap 100% kompatibel dengan semua Message Builders interaktif modern berarsitektur direct native flow (`additionalNodes: mixed`):

| Builder | Fungsi |
|---|---|
| `TextMessage` | Teks dengan template variabel, reply, mention, dan adReply |
| `ButtonMessage` | Tombol interaktif (Quick Reply, Copy Code, Open URL, Galaxy Flow, LTO Banner) |
| `ListMessage` | Menu pilihan single-select interaktif (Native Flow) dengan dukungan Media Header (`setImage`) |
| `CarouselMessage` | Multi-kartu horizontal yang bisa digeser (Cards Carousel) |
| `AIRichMessage` | Tampilan kartu Meta AI dengan Suggestion Chips dan Citations |
| `CanvasMessage` | Mini App / Game HTML5 interaktif di dalam chat WhatsApp |
| `MediaMessage` | Mengirim gambar, video, dokumen, stiker, atau voice note |
| `ProductMessage` | Kartu katalog produk dengan info harga interaktif |
| `PollMessage` | Polling voting single/multi opsi |
| `RichMessage` | Tabel ASCII dan teks terstruktur mobile-friendly |
| `EventMessage` | Undangan acara resmi WhatsApp (Group Event) dengan waktu, lokasi, & call link |
| `StickerMessage` | Stiker WebP dengan custom metadata EXIF Pack Name & Author otomatis |

### Contoh Penggunaan ListMessage dengan Header Gambar:

```javascript
import { LeavesClient, ListMessage } from 'leaves-guardian';

const client = new LeavesClient();

client.on('ready', async () => {
  const sock = client.getRawSocket();

  await new ListMessage(sock)
    .setImage('https://example.com/banner.jpg')
    .setTitle('🍃 Menu Utama Bot')
    .setBody('Halo! Silakan pilih kategori perintah yang ingin kamu gunakan:')
    .setButtonText('📋 Buka Menu')
    .setFooter('Leaves Guardian Framework v0.3.0')
    .addSection('Fitur Utama', [
      { id: '.ai Halo', title: '🤖 Tanya AI', description: 'Tanya asisten AI cerdas' },
      { id: '.menu', title: '📋 Semua Menu', description: 'Daftar semua modul bot' }
    ])
    .addSection('Informasi', [
      { id: '.ping', title: '⚡ Cek Status', description: 'Cek kecepatan respon bot' },
      { id: '.profile', title: '👤 Profil Saya', description: 'Lihat status akun & limit' }
    ])
    .send('628123456789@s.whatsapp.net');
});
```

### Contoh Penggunaan ButtonMessage dengan Copy & Galaxy Flow:

```javascript
import { LeavesClient, ButtonMessage } from 'leaves-guardian';

const client = new LeavesClient();

client.on('ready', async () => {
  const sock = client.getRawSocket();

  await new ButtonMessage(sock)
    .setImage('https://picsum.photos/400/250')
    .setBody('Halo! Pilih aksi di bawah:')
    .addGalaxy('╭━─ ⌜ PILIH MENU 」─━╮')
    .addReply('Buka Menu', '.menu')
    .addCopy('Salin Rekening DANA', '081234567890')
    .addUrl('Website Resmi', 'https://leavesguardian.enginelabs.my.id/')
    .send('628123456789@s.whatsapp.net');
});
```

---

## 🛠️ Developer Utilities (Layer 4)

### `MessageCollector` & `awaitMessage`
Tanya jawab dan pengumpulan pesan interaktif berbasis filter, timeout, dan limits tanpa menyentuh internal Baileys:

```javascript
import { LeavesClient } from 'leaves-guardian';

const client = new LeavesClient();

client.on('message', async (msg) => {
  if (msg.text === '.daftar') {
    await client.sendText(msg.chat.id, 'Siapa nama lengkap Anda? (Jawab dalam 30 detik)');

    try {
      const response = await client.awaitMessage({
        chatId: msg.chat.id,
        senderId: msg.sender.id,
        timeout: 30000,
        filter: (m) => m.text?.length > 0
      });

      await client.sendText(msg.chat.id, `Selamat datang, ${response.text}! Pendaftaran berhasil ✅`);
    } catch (err) {
      if (err.code === 'COLLECTOR_TIMEOUT') {
        await client.sendText(msg.chat.id, 'Waktu pendaftaran habis. Silakan ketik .daftar kembali.');
      }
    }
  }
});
```

---

## 🧪 Testing

Jalankan automated test suite bawaan:
```bash
npm test
```
*Menguji FakeSocket connection lifecycle, exponential backoff, defensive payload normalization, dan privacy masking tanpa memerlukan koneksi WhatsApp asli.*

---

## 📄 Lisensi
MIT © Rafa Dito / Royal Engine Studio
