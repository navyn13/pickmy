import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import path from 'node:path';
import { ROOT } from './config.js';
import { emit } from './events.js';

const { Client, LocalAuth } = pkg;
export const wa = { state: 'starting', qr: null, me: null };
let client;
let onIncoming = async () => {};
let onOutgoingFromPhone = async () => {};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const setState = (state, extra = {}) => { Object.assign(wa, { state }, extra); emit('wa', publicStatus()); };
export const publicStatus = () => ({ state: wa.state, qr: wa.qr, me: wa.me });

async function phoneOf(chatId) {
  try {
    const c = await client.getContactById(chatId);
    if (c?.number) return c.number;
  } catch { /* fall through */ }
  return chatId.split('@')[0];
}

export function start({ incoming, outgoing }) {
  onIncoming = incoming; onOutgoingFromPhone = outgoing;
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(ROOT, '.wwebjs_auth') }), // session saved → scan QR once
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });
  client.on('qr', async (qr) => setState('qr', { qr: await QRCode.toDataURL(qr, { width: 320 }) }));
  client.on('authenticated', () => setState('authenticated', { qr: null }));
  client.on('ready', () => setState('ready', { qr: null, me: client.info?.wid?.user || null }));
  client.on('auth_failure', () => setState('auth_failure'));
  client.on('disconnected', (r) => { setState('disconnected'); console.error('WhatsApp disconnected:', r); });

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;
      await onIncoming({
        phone: await phoneOf(msg.from), chatId: msg.from, waId: msg.id._serialized,
        ts: (msg.timestamp || Date.now() / 1000) * 1000,
        body: msg.body || (msg.hasMedia ? `[${msg.type} received]` : `[${msg.type}]`),
      });
    } catch (e) { console.error('incoming handler failed', e); }
  });
  // Messages the owner types directly on the phone → record + pause bot
  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe || msg.to.endsWith('@g.us') || msg.to === 'status@broadcast') return;
      await sleep(1500); // let our own sends get recorded first
      await onOutgoingFromPhone({
        phone: await phoneOf(msg.to), chatId: msg.to, waId: msg.id._serialized,
        ts: (msg.timestamp || Date.now() / 1000) * 1000, body: msg.body,
      });
    } catch (e) { console.error('outgoing handler failed', e); }
  });
  client.initialize().catch((e) => { console.error('WhatsApp init failed', e); setState('error'); });
}

/** Resolve phone → chat id, null if not on WhatsApp. */
export async function resolveNumber(phone) {
  if (wa.state !== 'ready') throw new Error('WhatsApp is not connected yet — click the WhatsApp status in the top bar and scan the QR');
  const id = await client.getNumberId(phone);
  return id?._serialized || null;
}

// Serialize all sends so two never go out at the same instant
let chain = Promise.resolve();
export function sendText(chatId, text, { typing = true } = {}) {
  const job = chain.then(async () => {
    if (wa.state !== 'ready') throw new Error('WhatsApp is not connected');
    if (typing) {
      try {
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        await sleep(Math.min(1000 + text.length * 40, 6000));
      } catch { /* typing indicator is cosmetic */ }
    }
    const m = await client.sendMessage(chatId, text);
    return m.id._serialized;
  });
  chain = job.catch(() => {});
  return job;
}
