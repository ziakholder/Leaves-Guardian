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
    path.resolve('./session')
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

export default resolveLidToPn;
