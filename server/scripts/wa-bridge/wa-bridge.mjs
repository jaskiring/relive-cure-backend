#!/usr/bin/env node
/**
 * M4 WA Web bridge — run on founder Mac, NOT Railway.
 *
 * Usage:
 *   cd server/scripts/wa-bridge && npm install
 *   CRM_API_KEY=... BACKEND_URL=https://... node wa-bridge.mjs --line=rep_rahul
 *
 * Rep scans QR shown in CRM Settings → WhatsApp lines.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRM_KEY = process.env.CRM_API_KEY;
const BACKEND = (process.env.BACKEND_URL || process.env.VITE_CRM_API_URL || 'https://relive-cure-backend-production.up.railway.app').replace(/\/$/, '');

function parseArgs() {
  const lineArg = process.argv.find(a => a.startsWith('--line='));
  return { lineId: lineArg ? lineArg.split('=')[1] : null };
}

async function apiPost(pathname, body) {
  const res = await fetch(`${BACKEND}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-crm-key': CRM_KEY },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

function normPhone(jid) {
  const d = String(jid || '').split('@')[0].replace(/[^\d]/g, '');
  if (d.startsWith('91') && d.length === 12) return d.slice(2);
  if (d.length > 10) return d.slice(-10);
  return d;
}

async function ingest(lineId, payload) {
  try {
    await apiPost('/api/wa-bridge/ingest', { line_id: lineId, ...payload });
  } catch (e) {
    console.warn('[BRIDGE] ingest failed:', e.message);
  }
}

async function main() {
  const { lineId } = parseArgs();
  if (!lineId) {
    console.error('Usage: node wa-bridge.mjs --line=rep_rahul');
    process.exit(1);
  }
  if (!CRM_KEY) {
    console.error('Set CRM_API_KEY in env');
    process.exit(1);
  }

  const authDir = path.join(__dirname, 'sessions', lineId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const start = async () => {
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
        console.log('[BRIDGE] QR updated — also pushed to CRM');
        try {
          await apiPost('/api/wa-bridge/qr', { line_id: lineId, qr_data_url: dataUrl, status: 'qr_pending' });
        } catch (e) {
          console.warn('[BRIDGE] QR push failed:', e.message);
        }
      }

      if (connection === 'open') {
        const me = sock.user?.id || '';
        console.log('[BRIDGE] Connected as', me);
        try {
          await apiPost('/api/wa-bridge/status', {
            line_id: lineId,
            status: 'connected',
            phone_display: normPhone(me) || me.split('@')[0],
          });
        } catch (e) {
          console.warn('[BRIDGE] status push failed:', e.message);
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log('[BRIDGE] closed', code, shouldReconnect ? 'reconnecting…' : 'logged out');
        if (code === DisconnectReason.loggedOut) {
          await apiPost('/api/wa-bridge/status', { line_id: lineId, status: 'disconnected' }).catch(() => {});
        }
        if (shouldReconnect) setTimeout(start, 3000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe === undefined) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us')) continue;
        const phone = normPhone(jid);
        if (!phone) continue;
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          null;
        const direction = m.key.fromMe ? 'outbound' : 'inbound';
        const contactName = m.pushName || null;
        await ingest(lineId, {
          phone,
          direction,
          body: text,
          msg_type: text ? 'text' : 'media',
          wa_message_id: m.key.id ? `${lineId}:${m.key.id}` : null,
          contact_name: contactName,
          wa_timestamp: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toISOString() : null,
        });
        console.log(`[BRIDGE] ${direction} ${phone}: ${(text || '[media]').slice(0, 60)}`);
      }
    });
  };

  console.log(`[BRIDGE] Starting line=${lineId} → ${BACKEND}`);
  await start();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
