import ButtonMessage from './button-message.js';

/**
 * LocationMessage - Builder kartu lokasi interaktif WhatsApp (Native Flow).
 * Menghasilkan kartu bergaya Share Location dengan icon pin 📍, judul tebal,
 * deskripsi/alamat, thumbnail avatar/gambar di sebelah kanan, dan tombol interaktif di bawahnya.
 *
 * Contoh penggunaan:
 *   import { LocationMessage } from 'leaves-guardian';
 *
 *   await new LocationMessage(sock)
 *     .setName('Hai アランズ~ 👋')
 *     .setAddress('Tentu, Kak. Aku akan mencarikan lirik lagu "Dinda" dari Masdo untuk Kakak. 🌸')
 *     .setThumbnail('https://example.com/itsuki.jpg')
 *     .addReply('📋 Lihat Semua Menu', '.menu')
 *     .send(m.chat);
 */
class LocationMessage extends ButtonMessage {
  constructor(client) {
    super(client);
    this._locationHeader = {
      name: '',
      address: '',
      thumbnail: null,
      latitude: 0,
      longitude: 0,
      thumbWidth: 400,
      thumbHeight: 225,
      thumbQuality: 85,
    };
  }

  /**
   * Set nama / judul utama di sebelah icon pin 📍
   */
  setName(name) {
    this._locationHeader.name = name;
    return this;
  }

  /**
   * Set deskripsi / teks alamat di bawah judul
   */
  setAddress(address) {
    this._locationHeader.address = address;
    return this;
  }

  /**
   * Set thumbnail gambar persegi di sebelah kanan kartu (URL, Buffer, atau file path)
   * Otomatis dikompresi ke 300x300 JPEG berkualitas tinggi via multi-engine (sharp -> canvas -> jimp)
   * @param {string|Buffer} thumb - Sumber gambar
   * @param {Object} [opts] - Opsi kustom (width, height, quality)
   */
  setThumbnail(thumb, opts = {}) {
    this._locationHeader.thumbnail = thumb;
    if (opts.width) this._locationHeader.thumbWidth = opts.width;
    if (opts.height) this._locationHeader.thumbHeight = opts.height;
    if (opts.quality) this._locationHeader.thumbQuality = opts.quality;
    return this;
  }

  /**
   * Set koordinat peta (opsional, default 0, 0)
   */
  setCoordinates(latitude, longitude) {
    this._locationHeader.latitude = latitude;
    this._locationHeader.longitude = longitude;
    return this;
  }
}

export default LocationMessage;
