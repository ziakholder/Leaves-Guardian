import fs from 'fs';
import path from 'path';

/**
 * Resolves a WhatsApp LID (e.g., '35120501268714:0@lid' or '35120501268714@lid')
 * to its corresponding phone number JID ('6282329716670@s.whatsapp.net')
 * using Baileys local session mapping files.
 *
 * @param {string} lid
 * @param {string} [sessionDir='./session']
 * @returns {string}
 */
export function resolveLidToPn(lid, sessionDir = './session') {
  if (!lid || typeof lid !== 'string' || !lid.includes('@lid')) {
    return lid;
  }

  const rawLid = lid.split('@')[0].split(':')[0];
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
          return pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
        }
      }
    } catch (_) {}
  }

  return lid;
}

export default resolveLidToPn;
