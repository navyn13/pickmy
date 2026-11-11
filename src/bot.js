import cron from 'node-cron';
import * as D from './db.js';
import * as W from './whatsapp.js';
import { generateReply } from './llm.js';
import { emit } from './events.js';

const S = () => D.getSettings();
const checkMs = () => Number(S().check_minutes) * 60_000;
/** {{name}} {{age}} {{education}} {{grades}} {{business}} */
export const render = (tpl, c, b) => String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
  k = k.toLowerCase();
  if (k === 'business') return b?.name || '';
  if (k === 'name') return c.name || 'there';
  return c[k] ?? '';
});
const STOP_RE = /^\s*(stop|unsubscribe|cancel|remove me|do not (message|contact)|don'?t (message|contact))\b/i;
const HUMAN_RE = /\b(human|real person|agent|representative|manager|talk to (someone|a person)|call me)\b/i;

const pushContact = (id) => emit('contact', { contact: D.getContact(id) });
const pushMessage = (contactId, message) => emit('message', { contactId, message });
const addNote = (c, text) => (c.notes ? c.notes + '\n' : '') + text;

function record(contact, direction, sender, body, waId, ts) {
  const m = D.addMessage(contact.id, direction, sender, body, waId, ts);
  if (m) pushMessage(contact.id, m);
  return m;
}

/** Send a text to a contact via WhatsApp and store it. */
export async function sendTo(contact, text, sender, opts) {
  const chatId = contact.chat_id || (await W.resolveNumber(contact.phone));
  if (!chatId) throw new Error('Number is not on WhatsApp');
  if (!contact.chat_id) D.updateContact(contact.id, { chat_id: chatId });
  const waId = await W.sendText(chatId, text, opts);
  return record(contact, 'out', sender, text, waId);
}

// ---------- first-message campaign (per business, one shared sending queue) ----------
let loopRunning = false;
const anyRunning = () => !!D.db.prepare('SELECT 1 FROM businesses WHERE campaign_running=1').get();

export function setCampaign(businessId, on) {
  D.updateBusiness(businessId, { campaign_running: on ? 1 : 0 });
  emit('state');
  if (on && !loopRunning) campaignLoop();
}

async function campaignLoop() {
  loopRunning = true;
  try {
    while (anyRunning()) {
      const s = S();
      if (W.wa.state !== 'ready') { await W.sleep(5000); continue; }
      if (D.counts().sentTodayAll >= Number(s.daily_limit)) { await W.sleep(60_000); continue; }
      // oldest NEW contact among businesses whose campaign is on
      const c = D.db.prepare(
        `SELECT c.* FROM contacts c JOIN businesses b ON b.id=c.business_id
         WHERE c.status='NEW' AND b.campaign_running=1 ORDER BY c.id LIMIT 1`).get();
      if (!c) { await W.sleep(10_000); continue; }
      const b = D.getBusiness(c.business_id);
      try {
        const chatId = await W.resolveNumber(c.phone);
        if (!chatId) {
          D.updateContact(c.id, { status: 'INVALID', notes: addNote(c, 'Not on WhatsApp') });
          pushContact(c.id); continue;
        }
        D.updateContact(c.id, { chat_id: chatId });
        await sendTo({ ...c, chat_id: chatId }, render(b.first_message, c, b), 'bot');
        const now = Date.now();
        D.updateContact(c.id, { status: 'SENT', first_sent_at: now, next_check_at: now + checkMs() });
        pushContact(c.id); emit('state');
      } catch (e) {
        console.error('first message failed for', c.phone, e.message);
        if (W.wa.state !== 'ready') continue;   // connection dropped — retry this contact later
        D.updateContact(c.id, { status: 'INVALID', notes: addNote(c, 'Send failed: ' + e.message) });
        pushContact(c.id);
      }
      await W.sleep(W.rand(Number(s.min_delay), Number(s.max_delay)) * 1000);
    }
  } finally { loopRunning = false; }
}

// ---------- incoming messages ----------
const timers = new Map(); const locks = new Set();

export async function onIncoming(ev) {
  // WhatsApp may identify the sender by a @lid id instead of their number → also match on chat id
  const contact = D.findContactForIncoming(ev.phone)
    || D.db.prepare('SELECT * FROM contacts WHERE chat_id=? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 1').get(ev.chatId);
  if (!contact) { console.log('incoming from unknown contact', ev.phone, ev.chatId); return; }
  if (D.messageByWaId(ev.waId)) return;
  if (contact.chat_id !== ev.chatId) D.updateContact(contact.id, { chat_id: ev.chatId });
  record(contact, 'in', 'customer', ev.body, ev.waId, ev.ts);

  const patch = { unread: contact.unread + 1, followups_sent: 0, next_check_at: null };
  if (['SENT', 'NO_RESPONSE', 'REPLIED', 'NEW'].includes(contact.status)) patch.status = 'REPLIED';
  D.updateContact(contact.id, patch);
  pushContact(contact.id);
  emit('incoming', { contactId: contact.id, needsHuman: false });

  if (['DONE', 'STOPPED'].includes(contact.status) || contact.bot_paused) return;

  // stop rules
  if (STOP_RE.test(ev.body)) {
    D.updateContact(contact.id, { status: 'STOPPED', bot_paused: 1, draft: null });
    return pushContact(contact.id);
  }
  if (HUMAN_RE.test(ev.body)) return handoff(contact.id, 'human_handoff_message');

  clearTimeout(timers.get(contact.id));       // wait a few seconds for burst messages
  timers.set(contact.id, setTimeout(() => processReply(contact.id), 2000));
}

async function handoff(id, messageKey) {
  const c = D.getContact(id);
  const b = D.getBusiness(c.business_id);
  D.updateContact(id, { status: 'NEEDS_HUMAN', bot_paused: 1, next_check_at: null, draft: null });
  const msg = render(b[messageKey], c, b);
  try { if (msg.trim()) await sendTo(c, msg, 'bot'); } catch (e) { console.error(e.message); }
  pushContact(id);
  emit('incoming', { contactId: id, needsHuman: true });
}

// ---------- generate + send reply ----------
async function processReply(id) {
  if (locks.has(id)) return;
  locks.add(id);
  try {
    let c = D.getContact(id);
    if (!c || c.bot_paused || c.draft || ['DONE', 'STOPPED', 'NEEDS_HUMAN'].includes(c.status)) return;
    const history = D.messagesFor(id, 15);
    if (history.at(-1)?.direction !== 'in') return;   // someone already answered
    const b = D.getBusiness(c.business_id);

    let r;
    try { r = await generateReply(history, c, b); }
    catch (e) {
      console.error('LLM failed:', e.message);
      D.updateContact(id, { status: 'NEEDS_HUMAN', bot_paused: 1, notes: addNote(c, 'Bot error: ' + e.message) });
      pushContact(id); return emit('incoming', { contactId: id, needsHuman: true });
    }
    if (r.needsHuman) return handoff(id, 'holding_message');   // never guess

    if (b.approval_mode) {                       // approval mode: park as draft
      D.updateContact(id, { draft: r.reply, status: 'NEEDS_HUMAN' });
      pushContact(id); return emit('incoming', { contactId: id, needsHuman: true });
    }
    await W.sleep(W.rand(1, 3) * 1000);          // look natural
    c = D.getContact(id);
    if (c.bot_paused || D.messagesFor(id, 1).at(-1)?.direction !== 'in') return; // human stepped in
    await sendTo(c, r.reply, 'bot');
    D.updateContact(id, { status: r.end ? 'DONE' : 'REPLIED', next_check_at: r.end ? null : Date.now() + checkMs() });
    pushContact(id);
  } catch (e) { console.error('processReply error', e); }
  finally { locks.delete(id); }
}

// ---------- the 10-minute check / follow-ups ----------
let ticking = false;
async function tick() {
  if (ticking || W.wa.state !== 'ready') return;
  ticking = true;
  try {
    const s = S();
    const due = D.db.prepare(
      `SELECT c.* FROM contacts c JOIN businesses b ON b.id=c.business_id
       WHERE c.next_check_at IS NOT NULL AND c.next_check_at<=? AND c.status IN ('SENT','REPLIED')
         AND c.bot_paused=0 AND b.campaign_running=1`).all(Date.now());
    for (const c of due) {
      const last = D.messagesFor(c.id, 1).at(-1);
      if (!last || last.direction === 'in') { D.updateContact(c.id, { next_check_at: null }); continue; }
      if (c.followups_sent >= Number(s.max_followups)) {
        D.updateContact(c.id, { status: 'NO_RESPONSE', next_check_at: null });
      } else {
        const b = D.getBusiness(c.business_id);
        try {
          await sendTo(c, render(b.follow_up_message, c, b), 'bot');
          D.updateContact(c.id, { followups_sent: c.followups_sent + 1, next_check_at: Date.now() + checkMs() });
        } catch (e) { console.error('follow-up failed', c.phone, e.message); D.updateContact(c.id, { next_check_at: Date.now() + 60_000 }); }
        await W.sleep(W.rand(10, 25) * 1000);
      }
      pushContact(c.id);
    }
  } finally { ticking = false; }
}
export const startScheduler = () => {
  cron.schedule('* * * * *', () => tick().catch(console.error));
  if (anyRunning()) campaignLoop();
};

// ---------- human actions from the dashboard ----------
export async function humanSend(id, text) {
  const c = D.getContact(id);
  if (!c) throw new Error('No such contact');
  await sendTo(c, text, 'human', { typing: false });
  const status = c.status === 'NEEDS_HUMAN' ? 'REPLIED' : c.status === 'NEW' ? 'SENT' : c.status; // NEW → don't send campaign msg too
  D.updateContact(id, { bot_paused: 1, draft: null, next_check_at: null, unread: 0, status });
  pushContact(id);
}
export async function approveDraft(id, text) {
  const c = D.getContact(id);
  if (!c?.draft && !text) throw new Error('No draft');
  await sendTo(c, text || c.draft, 'bot', { typing: false });
  D.updateContact(id, { draft: null, status: 'REPLIED', unread: 0, next_check_at: Date.now() + checkMs() });
  pushContact(id);
}
export function discardDraft(id) { D.updateContact(id, { draft: null, bot_paused: 1 }); pushContact(id); }

/** Owner typed on the phone itself → record it and pause the bot for that chat. */
export async function onOutgoingFromPhone(ev) {
  const c = D.findContactForIncoming(ev.phone)
    || D.db.prepare('SELECT * FROM contacts WHERE chat_id=? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 1').get(ev.chatId);
  if (!c || D.messageByWaId(ev.waId)) return;
  // our own send may have been recorded without a wa_id (lookup failed) — don't record it twice
  if (D.db.prepare("SELECT 1 FROM messages WHERE contact_id=? AND direction='out' AND body=? AND wa_id IS NULL AND created_at>?")
    .get(c.id, ev.body, Date.now() - 120_000)) return;
  record(c, 'out', 'human', ev.body, ev.waId, ev.ts);
  D.updateContact(c.id, { bot_paused: 1, next_check_at: null, ...(c.status === 'NEW' ? { status: 'SENT' } : {}) });
  pushContact(c.id);
}
