import crypto from 'crypto';

/**
 * Membangun binary stanza nodes (biz, quality_control, interactive, bot)
 * untuk pengiriman InteractiveMessage / NativeFlowMessage / Meta Bloks / A2UI
 * dengan kompatibilitas penuh multi-device WhatsApp sesuai standar Starcore/Baileys.
 *
 * @param {string} targetJid JID penerima pesan
 * @returns {Array<object>} Daftar stanza node tambahan untuk relayMessage
 */
export function buildInteractiveNodes(targetJid) {
  const isGroup = typeof targetJid === 'string' && targetJid.endsWith('@g.us');
  const nodes = [
    {
      tag: 'biz',
      attrs: {
        actual_actors: '2',
        host_storage: '2',
        privacy_mode_ts: String(Math.floor(Date.now() / 1e3)),
      },
      content: [
        {
          tag: 'interactive',
          attrs: {
            type: 'native_flow',
            v: '1',
          },
          content: [
            {
              tag: 'native_flow',
              attrs: {
                v: '9',
                name: 'mixed',
              },
            },
          ],
        },
        {
          tag: 'quality_control',
          attrs: {
            decision_id: crypto.randomUUID().replace(/-/g, ''),
            source_type: 'third_party',
          },
          content: [
            {
              tag: 'decision_source',
              attrs: {
                value: 'df',
              },
            },
          ],
        },
      ],
    },
  ];

  if (!isGroup) {
    nodes.push({
      tag: 'bot',
      attrs: {
        biz_bot: '1',
      },
    });
  }

  return nodes;
}

export default buildInteractiveNodes;
