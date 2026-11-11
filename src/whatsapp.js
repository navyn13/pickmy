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

// newer WhatsApp Web builds may leave id._serialized empty
const msgId = (m) => { const i = m?.id; if (!i) return null; return i._serialized || (i.remote && i.id ? `${i.fromMe}_${i.remote._serialized || i.remote}_${i.id}` : null); };

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
        phone: await phoneOf(msg.from), chatId: msg.from, waId: msgId(msg),
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
        phone: await phoneOf(msg.to), chatId: msg.to, waId: msgId(msg),
        ts: (msg.timestamp || Date.now() / 1000) * 1000, body: msg.body,
      });
    } catch (e) { console.error('outgoing handler failed', e); }
  });
  initWithRetry();
}

// whatsapp-web.js sometimes injects before WhatsApp Web has loaded ("reading 'Socket'") — just retry.
async function initWithRetry(attempt = 1) {
  try {
    await client.initialize();
  } catch (e) {
    console.error(`WhatsApp init failed (attempt ${attempt}):`, e.message);
    setState('starting');
    try { await client.destroy(); } catch { /* ignore */ }
    if (attempt >= 5) return setState('error');
    await sleep(5000 * attempt);
    return initWithRetry(attempt + 1);
  }
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
    if (m?.id?._serialized) return m.id._serialized;
    // whatsapp-web.js sometimes sends fine but can't look the new message up afterwards
    // (returns undefined). Find it in the chat instead of failing a send that went out.
    // Newer WhatsApp Web builds renamed the id field, so read the chat's in-memory messages directly.
    await sleep(1000);
    try {
      const id = await client.pupPage.evaluate((chatId, text, since) => {
        const wid = window.require('WAWebWidFactory').createWid(chatId);
        const chat = window.require('WAWebCollections').Chat.get(wid);
        const hit = chat?.msgs.getModelsArray().reverse().find((x) => x.id?.fromMe && x.body === text && x.t >= since);
        if (!hit) return null;
        const i = hit.id;
        return i._serialized || (i.remote && i.id ? `true_${i.remote._serialized || i.remote}_${i.id}` : String(i));
      }, chatId, text, Math.floor(Date.now() / 1000) - 120);
      if (id) return id;
    } catch (e) { console.error('send lookup failed:', e.message); }
    // sendMessage didn't throw, so WhatsApp accepted it; we just couldn't read back its id.
    return null;
  });
  chain = job.catch(() => {});
  return job;
}
