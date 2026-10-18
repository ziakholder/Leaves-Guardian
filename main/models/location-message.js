import ButtonMessage from './button-message.js';

/**
 * LocationMessage — Builder kartu lokasi interaktif WhatsApp (Native Flow).
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
   */
  setThumbnail(thumb) {
    this._locationHeader.thumbnail = thumb;
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
