import fs from 'fs';
import path from 'path';

/**
 * Normalizes and decodes a WhatsApp JID:
 * 1. Strips companion device suffixes (e.g. '6282329716670:49@s.whatsapp.net' -> '6282329716670@s.whatsapp.net')
 * 2. Resolves LID ('35120501268714:0@lid' or '35120501268714@lid') to Phone Number JID ('628xxxx@s.whatsapp.net')
 *
 * @param {string} jid
 * @param {string} [sessionDir='./session']
 * @returns {string}
 */
export function resolveLidToPn(jid, sessionDir = './session') {
  if (!jid || typeof jid !== 'string') {
    return jid;
  }

  // 1. Strip device index (e.g. :49@s.whatsapp.net or :0@lid)
  let cleanJid = jid;
  if (/:\d+@/gi.test(cleanJid)) {
    const [userWithDev, server] = cleanJid.split('@');
    const user = userWithDev.split(':')[0];
    cleanJid = `${user}@${server}`;
  }

  if (!cleanJid.includes('@lid')) {
    return cleanJid;
  }

  const rawLid = cleanJid.split('@')[0];
  const candidateDirs = [
    sessionDir,
    './session',
    'session',
    path.resolve(process.cwd(), 'session'),
    path.resolve(process.cwd(), './session'),
    path.resolve('./session'),
  ];

  for (const dir of candidateDirs) {
    if (!dir) continue;
    try {
      const filePath = path.join(dir, `lid-mapping-${rawLid}_reverse.json`);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const pn = JSON.parse(content);
        if (pn && typeof pn === 'string') {
          const cleanPn = pn.split('@')[0].split(':')[0];
          return `${cleanPn}@s.whatsapp.net`;
        }
      }
    } catch (_) {}
  }

  return cleanJid;
}

/**
 * Mengambil Phone Number (@s.whatsapp.net) dari LID dengan memanfaatkan
 * konteks pesan (group participant metadata atau private chat key pair).
 *
 * @param {Object} m Konteks pesan WhatsApp
 * @param {string} lidInput JID LID yang ingin diterjemahkan
 * @param {Object} [socket] Socket Baileys
 * @returns {Promise<string>}
 */
export async function getPNFromLid(m, lidInput, socket) {
  if (!lidInput) return lidInput;
  try {
    const chat = m?.chat || m?.key?.remoteJid || '';
    if (chat.endsWith('@g.us') && socket && typeof socket.groupMetadata === 'function') {
      const metadata = await socket.groupMetadata(chat);
      if (metadata && Array.isArray(metadata.participants)) {
        const found = metadata.participants.find((entry) => entry.id === lidInput || entry.lid === lidInput);
        if (found) {
          const pn = found.phoneNumber || found.id;
          if (pn && !pn.endsWith('@lid')) {
            const clean = pn.split('@')[0].split(':')[0];
            return `${clean}@s.whatsapp.net`;
          }
        }
      }
    } else if (m && m.key) {
      const { remoteJid, remoteJidAlt } = m.key;
      if (remoteJid === lidInput && remoteJidAlt && remoteJidAlt.endsWith('@s.whatsapp.net')) {
        const clean = remoteJidAlt.split('@')[0].split(':')[0];
        return `${clean}@s.whatsapp.net`;
      }
    }
  } catch (_) {}

  return resolveLidToPn(lidInput);
}

/**
 * Mengambil LID (@lid) dari Phone Number JID (@s.whatsapp.net).
 *
 * @param {Object} m Konteks pesan WhatsApp
 * @param {string} jidInput JID nomor telepon
 * @param {Object} [socket] Socket Baileys
 * @returns {Promise<string>}
 */
export async function getLidFromPN(m, jidInput, socket) {
  if (!jidInput) return jidInput;
  try {
    const chat = m?.chat || m?.key?.remoteJid || '';
    if (chat.endsWith('@g.us') && socket && typeof socket.groupMetadata === 'function') {
      const metadata = await socket.groupMetadata(chat);
      if (metadata && Array.isArray(metadata.participants)) {
        const found = metadata.participants.find((entry) => (
          entry.phoneNumber === jidInput ||
          entry.id === jidInput ||
          entry.id?.split('@')[0] === jidInput.split('@')[0]
        ));
        if (found && (found.lid || found.id?.endsWith('@lid'))) {
          return found.lid || found.id;
        }
      }
    } else if (m && m.key) {
      const { remoteJid, remoteJidAlt } = m.key;
      if (remoteJidAlt === jidInput && remoteJid && remoteJid.endsWith('@lid')) {
        return remoteJid;
      }
    }
  } catch (_) {}

  return jidInput;
}

export default resolveLidToPn;
