# 🍃 Panduan Lengkap Leaves Guardian (Berdasarkan Model & Handler)

Dokumen ini berisi panduan teknis pemanggilan seluruh model pesan di **Leaves Guardian**, disusun rapi berdasarkan **Nama Model Message** (seperti pada skenario testing) serta contoh penerapannya di dalam command handler bot.

---

## 📑 Daftar Isi

1. [Daftar & Penjelasan Model Message](#-daftar--penjelasan-model-message)
   - [1. `TextMessage`](#1-textmessage)
   - [2. `MediaMessage`](#2-mediamessage)
   - [3. `ButtonMessage`](#3-buttonmessage)
   - [4. `ListMessage`](#4-listmessage)
   - [5. `ProductMessage`](#5-productmessage)
   - [6. `PollMessage`](#6-pollmessage)
   - [7. `CarouselMessage`](#7-carouselmessage)
   - [8. `RichMessage`](#8-richmessage)
   - [9. `AIRichMessage`](#9-airichmessage)
   - [10. `CanvasMessage`](#10-canvasmessage)
   - [11. `EventMessage`](#11-eventmessage)
   - [12. `StickerMessage`](#12-stickermessage)
2. [Helper & Modifier Ekstra](#-helper--modifier-ekstra)
   - [`withAdReply` / `.setAdReply()`](#withadreply---setadreply)
   - [`withChannelForward` / `.setChannelForward()`](#withchannelforward---setchannelforward)
   - [`generateStatCard`](#generatestatcard)
3. [Implementasi di Command Handler Bot](#-implementasi-di-command-handler-bot)
4. [Menangkap Respon Klik Tombol & Menu](#-menangkap-respon-klik-tombol--menu)

---

## 📦 Daftar & Penjelasan Model Message

### 1. `TextMessage`
Model pesan teks standar dengan dukungan reply/quote, mention, text templating `{{var}}`, link preview, dan preview card (`externalAdReply`).

```javascript
import { TextMessage } from 'leaves-guardian';

// Contoh 1: Teks biasa dengan variabel & reply pesan
await new TextMessage(sock)
  .setBody('Halo {{nama}}, pesananmu dengan ID *{{id}}* sudah selesai! ✅')
  .setVars({ nama: 'Rafa', id: 'TRX-992' })
  .mention(['6281234567890@s.whatsapp.net'])
  .quote(msg) // Reply pesan asli
  .send(jid);

// Contoh 2: Teks dengan Kartu Profil / Preview Link (externalAdReply)
await new TextMessage(sock)
  .setBody('Berikut link website official kami:')
  .setAdReply({
    title: 'Royal Bot Official',
    body: 'Solusi Bot WhatsApp Terbaik',
    thumbnailUrl: 'https://picsum.photos/300/300',
    sourceUrl: 'https://royalbot.id',
  })
  .quote(msg)
  .send(jid);
```

---

### 2. `MediaMessage`
Model terpadu untuk mengirim gambar, video, audio (Voice Note / PTT), dokumen, dan stiker.

```javascript
import { MediaMessage } from 'leaves-guardian';

// Contoh 1: Kirim Gambar + Caption & Variabel
await new MediaMessage(sock, 'image')
  .setSource('https://picsum.photos/600/400') // Bisa URL, Buffer, atau Path Lokal
  .setBody('Halo {{nama}}, ini foto bukti transaksimu:')
  .setVars({ nama: 'Rafa' })
  .quote(msg)
  .send(jid);

// Contoh 2: Kirim Voice Note (PTT)
await new MediaMessage(sock, 'audio')
  .setSource(audioBuffer)
  .asVoiceNote() // Render sebagai VN bulat hijau
  .send(jid);

// Contoh 3: Kirim Dokumen PDF
await new MediaMessage(sock, 'document')
  .setSource('https://example.com/ebook.pdf')
  .setFileName('Ebook_Panduan_Bot.pdf')
  .setMimetype('application/pdf')
  .setBody('Silakan download ebook panduan berikut.')
  .send(jid);
```

---

### 3. `ButtonMessage`
Model pesan tombol interaktif **Native Flow** modern. Mendukung:
- Quick Reply (`.addReply`)
- Tombol Link URL (`.addUrl`)
- Tombol Salin Kode/Link (`.addCopy`)
- Banner Promo Kedaluwarsa / LTO (`.setBanner` / `.addLimitedOffer`)
- Header Media (Gambar, Video, atau Dokumen)

```javascript
import { ButtonMessage } from 'leaves-guardian';

// Contoh 1: Tombol Lengkap + Header Gambar + Banner Promo
await new ButtonMessage(sock)
  .setImage('https://picsum.photos/600/350')
  .setBanner('Promo Terbatas', { days: 7 }) // Menampilkan tag badge ber-timer
  .setBody('Pilih salah satu menu di bawah:')
  .setFooter('Royal Engine Studio')
  .addReply('📋 Menu Fitur', '.list')
  .addCopy('Salin Kode Promo', 'DISKON50')
  .addUrl('Buka Web Official', 'https://royalbot.id')
  .quote(msg)
  .send(jid);

// Contoh 2: Tombol dengan Header Lampiran Dokumen File
await new ButtonMessage(sock)
  .setDocument('https://picsum.photos/400/300', {
    fileName: 'Hasil_Generate.jpg',
    mimetype: 'image/jpeg',
  })
  .setBody('✨ Gambar berhasil di-generate! Klik tombol di bawah untuk menyalin link:')
  .addCopy('Salin Link Download', 'https://cdn.example.com/img.jpg')
  .send(jid);
```

---

### 4. `ListMessage`
Model menu dropdown interaktif (*Single Select*) dengan pembagian kategori (*Sections*) yang dijamin kompatibel dengan WhatsApp Android, iOS, dan Web.

```javascript
import { ListMessage } from 'leaves-guardian';

await new ListMessage(sock)
  .setTitle('Katalog Menu {{namaToko}}')
  .setBody('Halo {{nama}}, silakan tentukan pesananmu:')
  .setButtonText('Buka Pilihan Menu')
  .setFooter('Klik tombol di atas untuk melihat menu')
  .setVars({ namaToko: 'Royal Cafe', nama: 'Rafa' })
  .addSection('Kategori Makanan', [
    { title: 'Nasi Goreng Spesial', description: 'Rp 15.000', id: '.order nasgor' },
    { title: 'Mie Ayam Pangsit', description: 'Rp 13.000', id: '.order mieayam' },
  ])
  .addSection('Kategori Minuman', [
    { title: 'Es Teh Manis Segar', description: 'Rp 5.000', id: '.order esteh' },
    { title: 'Kopi Susu Gula Aren', description: 'Rp 10.000', id: '.order kopi' },
  ])
  .quote(msg)
  .send(jid);
```

---

### 5. `ProductMessage`
Model kartu produk interaktif universal. Bekerja di **semua akun WhatsApp (Personal maupun Business)** tanpa memerlukan integrasi Meta Commerce Manager.

```javascript
import { ProductMessage } from 'leaves-guardian';

await new ProductMessage(sock)
  .setTitle('Nasi Goreng Spesial Jumbo')
  .setDescription('Porsi kenyang dengan sosis, bakso, dan telur mata sapi.')
  .setPrice(15000, 'IDR') // Otomatis berformat "Rp 15.000"
  .setImage('https://picsum.photos/500/350')
  .setRetailerId('menu_nasgor_01')
  .setButtonText('Pesan Sekarang')
  .quote(msg)
  .send(jid);
```

---

### 6. `PollMessage`
Model voting/polling resmi WhatsApp (mendukung *single choice* atau *multiple choice*).

```javascript
import { PollMessage } from 'leaves-guardian';

await new PollMessage(sock)
  .setTitle('📊 Jam berapa jadwal mabar malam ini?')
  .addOption('19.30 WIB')
  .addOption('20.30 WIB')
  .addOption('21.30 WIB')
  .allowMultipleAnswers(false) // false = pilih salah satu
  .send(jid);
```

---

### 7. `CarouselMessage`
Model kartu horizontal multi-card yang dapat digeser ke samping (*Swipe Carousel*). Bekerja lancar di HP Android, iPhone, dan WhatsApp Web.

```javascript
import { CarouselMessage } from 'leaves-guardian';

const carousel = new CarouselMessage(sock)
  .setBody('🛍️ *Daftar Paket Bot Premium*\nGeser kartu ke samping untuk melihat opsi:');

// Kartu 1
carousel.newCard('vip1')
  .setTitle('Paket VIP 1 Bulan')
  .setImage('https://picsum.photos/400/300')
  .setBody('Akses semua fitur tanpa batas harian.\nHarga: *Rp 25.000*')
  .addReply('Beli Paket 1', '.buy vip1');

// Kartu 2
carousel.newCard('vip2')
  .setTitle('Sewa Bot Grup 1 Bulan')
  .setImage('https://picsum.photos/400/301')
  .setBody('Bot stand by 24 jam untuk kelola grup.\nHarga: *Rp 50.000*')
  .addReply('Beli Paket 2', '.buy vip2');

await carousel.send(jid);
```

---

### 8. `RichMessage`
Model pesan berformat teks terstruktur yang bersih dan 100% aman di semua jenis font HP (tabel rapi sejajar, blok kode berlabel, dan tips quote).

```javascript
import { RichMessage } from 'leaves-guardian';

await new RichMessage(sock)
  .setTitle('System Health Report')
  .addText('Berikut statistik performa server hari ini:')
  .addTable([
    ['Metric', 'Value'],
    ['Server Uptime', '24h 12m'],
    ['RAM Usage', '45.2%'],
    ['CPU Load', '8%'],
    ['Status Bot', 'ONLINE ✅'],
  ])
  .addCode('javascript', 'console.log("System operational");')
  .addTip('Gunakan command .ping untuk cek latensi bot')
  .quote(msg)
  .send(jid);
```

---

### 9. `AIRichMessage`
Model canggih berformat **Meta AI Rich Response** (protokol Zaileys & Nixel). Mendukung:
- Inline Clickable Hyperlink `[Nama Link](https://...)`
- Suggestion Chips (`.addSuggest`)
- Syntax Highlighting Meta AI
- Interactive HTML / Canvas Mini Game (`.addHtml`)
- Auto fast-edit bypass untuk WhatsApp Android

```javascript
import { AIRichMessage } from 'leaves-guardian';

// Contoh 1: Chat AI dengan Inline Link & Suggestion Chips
await new AIRichMessage(sock)
  .setTitle('Royal AI Assistant') // Teks header badge AI di bagian atas
  .addText(
    'Halo! Kunjungi [Website Kami](https://royalbot.id) untuk melihat panduan lengkap.'
  )
  .addTable([
    ['Command', 'Deskripsi'],
    ['.menu', 'Menu utama bot'],
    ['.status', 'Cek performa server'],
  ])
  .addCode('javascript', 'const bot = new RoyalBot();\nbot.start();')
  .addSuggest([
    'Tampilkan Menu',
    'Cara Beli VIP',
    'Hubungi Developer',
  ])
  .addTip('Klik tombol suggestion di bawah untuk pertanyaan instan')
  .send(jid);

// Contoh 2: Chat AI dengan Code Highlight & Suggestion
await new AIRichMessage(sock)
  .setTitle('Code Generator')
  .addText('Berikut skrip yang kamu minta:')
  .addCode('javascript', 'const bot = new RoyalBot();\nbot.start();')
  .addSuggest(['Jalankan Kode', 'Jelaskan Baris 1', 'Ubah ke Python'])
  .send(jid);
```

---

### 10. `CanvasMessage`
Model pesan untuk mengirim **Mini App / Interactive HTML5 Game (Canvas)** langsung di dalam WhatsApp (seperti Dino Runner, Tic Tac Toe, Flappy Bird, dll).

```javascript
import { CanvasMessage } from 'leaves-guardian';

const dinoHtml = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>body{margin:0;background:#111;color:#fff;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;touch-action:manipulation}canvas{background:#222;border:2px solid #444}#info{margin-top:10px;font-size:16px}</style></head><body><canvas id="game" width="320" height="150"></canvas><div id="info">Tap to Jump | Score: <span id="score">0</span></div><script>let c=document.getElementById("game"),x=c.getContext("2d"),d={x:30,y:100,w:20,h:20,vy:0,g:0.8,j:-10,ground:100},o={x:320,y:100,w:15,h:20,s:4},score=0,over=!1;function jump(){if(d.y>=d.ground)d.vy=d.j}window.addEventListener("touchstart",jump);window.addEventListener("click",jump);function loop(){if(over)return;d.vy+=d.g;d.y+=d.vy;if(d.y>d.ground){d.y=d.ground;d.vy=0}o.x-=o.s;if(o.x<-20){o.x=320;score++}if(d.x<o.x+o.w&&d.x+d.w>o.x&&d.y<o.y+o.h&&d.y+d.h>o.y){over=!0;alert("Game Over! Score: "+score);location.reload()}x.clearRect(0,0,c.width,c.height);x.fillStyle="#555";x.fillRect(0,120,c.width,2);x.fillStyle="#0f0";x.fillRect(d.x,d.y,d.w,d.h);x.fillStyle="#f00";x.fillRect(o.x,o.y,o.w,o.h);document.getElementById("score").innerText=score;requestAnimationFrame(loop)}loop();<\/script></body></html>`;

// Kirim Game Dino Runner Interaktif
await new CanvasMessage(sock)
  .setTitle('Dino Runner 🦖')
  .setHtml(dinoHtml)
  .send(jid);
```

---

### 11. `EventMessage`
Model pesan untuk membuat **Undangan Acara / Jadwal Resmi Grup WhatsApp** (Group Event). Mendukung RSVP, lokasi, dan link call otomatis.

```javascript
import { EventMessage } from 'leaves-guardian';

await new EventMessage(sock)
  .setName('Meeting Bulanan Komunitas')
  .setDescription('Pembahasan roadmap dan update fitur bot WhatsApp')
  .setStartTime(new Date(Date.now() + 86400000)) // Waktu mulai (besok)
  .setEndTime(new Date(Date.now() + 90000000))   // Waktu selesai (opsional)
  .setLocation('Online via WhatsApp Call')
  .setCallLink('https://call.whatsapp.com/video/12345')
  .send(groupJid);
```

---

### 12. `StickerMessage`
Model pengiriman stiker WebP yang otomatis menyematkan **Metadata EXIF (Nama Pack & Nama Author / Pembuat)** secara instan. Otomatis mengonversi gambar (JPG, PNG, atau URL) ke format WebP 512x512.

```javascript
import { StickerMessage } from 'leaves-guardian';

await new StickerMessage(sock)
  .setSource('https://picsum.photos/512/512') // Bisa URL, Buffer WebP/PNG, atau File Path
  .setPackName('Royal Bot Stickers')
  .setAuthor('Rafa Dito')
  .send(jid);
```

---

## 🛠️ Helper & Modifier Ekstra

### `withAdReply` / `.setAdReply()`
Membuat kartu preview profil / link kecil di atas pesan:
```javascript
.setAdReply({
  title: 'Luna✧ Official Profile',
  body: 'Royal Bot Network',
  thumbnailUrl: 'https://picsum.photos/300/300',
  sourceUrl: 'https://api.ryuu-dev.my.id',
  renderLargerThumbnail: false, // true jika ingin foto thumbnail besar
})
```

### `withChannelForward` / `.setChannelForward()`
Menjadikan pesan seolah diteruskan dari Channel / Saluran resmi WhatsApp (tanda centang biru):
```javascript
.setChannelForward({
  channelJid: '120363000000000000@newsletter',
  channelName: 'WhatsApp', // Nama channel resmi
})
```

---

## ⚡ Implementasi di Command Handler Bot

Contoh pemanggilan di file handler bot Baileys Anda:

```javascript
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return;
  const msg = messages[0];
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  const name = msg.pushName || 'Kak';

  const body =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    '';

  if (!body.startsWith('.')) return;
  const [cmd, ...args] = body.slice(1).trim().split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'menu':
      await new ButtonMessage(sock)
        .setImage('https://picsum.photos/600/350')
        .setBanner('Royal Engine Menu', { days: 7 })
        .setBody(`👋 Halo *${name}*, silakan pilih menu:`)
        .addReply('List Layanan', '.list')
        .addCopy('Salin Website', 'https://royalbot.id')
        .quote(msg)
        .send(jid);
      break;

    case 'list':
      await new ListMessage(sock)
        .setTitle('Menu Layanan')
        .setBody('Pilih kategori yang ingin kamu lihat:')
        .setButtonText('Lihat Kategori')
        .addSection('Layanan Utama', [
          { title: 'Chat AI', description: 'Tanya jawab kecerdasan buatan', id: '.ai' },
          { title: 'Katalog Produk', description: 'Daftar produk & harga', id: '.katalog' },
        ])
        .quote(msg)
        .send(jid);
      break;

    case 'ai':
      await new AIRichMessage(sock)
        .setTitle('Royal AI')
        .addText('Halo! Ada yang bisa saya bantu hari ini?')
        .addSuggest(['Cara penggunaan', 'Daftar harga'])
        .send(jid);
      break;
  }
});
```

---

## 🎯 Menangkap Respon Klik Tombol & Menu

```javascript
let selectedId = '';

if (msg.message.buttonsResponseMessage) {
  selectedId = msg.message.buttonsResponseMessage.selectedButtonId;
} else if (msg.message.listResponseMessage) {
  selectedId = msg.message.listResponseMessage.singleSelectReply?.selectedRowId;
} else if (msg.message.interactiveResponseMessage?.nativeFlowResponseMessage) {
  try {
    const params = JSON.parse(
      msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson
    );
    selectedId = params.id;
  } catch {}
}

if (selectedId) {
  console.log('User mengklik ID:', selectedId);
  // Teruskan ID ke logic command router bot kamu...
}
```

---

## ⚡ Layer 4: Developer Utilities

### 1. `MessageCollector` & `client.awaitMessage()`
Menunggu respon pesan dari pengguna secara event-driven tanpa menyentuh socket Baileys secara langsung.

```javascript
import { LeavesClient } from 'leaves-guardian';

const client = new LeavesClient({ auth: { directory: './session' } });

client.on('message', async (message) => {
  if (message.text === '!tanya') {
    await client.sendText(message.chat.id, 'Halo! Berapa umurmu? (Jawab dalam 30 detik)');

    try {
      const response = await client.awaitMessage({
        chatId: message.chat.id,
        senderId: message.sender.id,
        timeout: 30000,
        filter: (msg) => /^\d+$/.test(msg.text)
      });

      await client.sendText(message.chat.id, `Umurmu ${response.text} tahun!`);
    } catch (err) {
      if (err.code === 'COLLECTOR_TIMEOUT') {
        await client.sendText(message.chat.id, '⏱️ Waktu habis! Kamu tidak menjawab.');
      }
    }
  }
});
```

---

### 2. `Prompt` (Multi-Step Conversational Wizard)
Membangun alur formulir percakapan interaktif langkah-demi-langkah dengan validasi otomatis, retry loop, konfirmasi, dan pembatalan instan.

```javascript
import { Prompt, TextMessage } from 'leaves-guardian';

// A. Multi-Step Form Wizard
const wizard = client.createPrompt({
  stepTimeout: 60000,
  retries: 2,
  cancelKeywords: ['batal', 'cancel', 'exit']
});

wizard
  .addStep({
    id: 'name',
    question: 'Siapa nama lengkap Anda?'
  })
  .addStep({
    id: 'age',
    question: ({ context }) => `Halo ${context.name}, berapa umur Anda?`,
    validate: (val) => (!isNaN(Number(val)) && Number(val) > 0) || 'Umur harus berupa angka',
    transform: (val) => Number(val)
  })
  .addStep({
    id: 'confirmed',
    question: ({ context }) => `Konfirmasi: Nama ${context.name}, Umur ${context.age}. Apakah data benar? (Ya/Tidak)`,
    validate: (val) => ['ya', 'tidak', 'y', 'n'].includes(val.trim().toLowerCase()) || 'Jawab Ya atau Tidak',
    transform: (val) => ['ya', 'y'].includes(val.trim().toLowerCase())
  });

try {
  const result = await wizard.run(chatId, senderId);
  console.log('Hasil data pendaftaran:', result);
  // Output: { name: 'Rafa', age: 20, confirmed: true }
} catch (err) {
  if (err.code === 'PROMPT_CANCELLED') {
    console.log('Pengguna membatalkan wizard');
  } else if (err.code === 'PROMPT_MAX_RETRIES') {
    console.log('Pengguna gagal validasi melewati batas retry');
  }
}

// B. Quick Confirm Shortcut
const isAgreed = await Prompt.confirm(client, chatId, 'Apakah Anda setuju dengan syarat & ketentuan?');
if (isAgreed) {
  await client.sendText(chatId, 'Terima kasih atas persetujuannya! ✅');
}

// C. Quick Selection Shortcut
const selectedFruit = await Prompt.select(client, chatId, 'Pilih buah favoritmu:', [
  { label: 'Apel Malang', value: 'apel' },
  { label: 'Mangga Harum Manis', value: 'mangga' },
  { label: 'Jeruk Bali', value: 'jeruk' }
]);
console.log('Buah dipilih:', selectedFruit); // e.g. 'mangga'
```

