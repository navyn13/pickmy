import cron from 'node-cron';
import * as D from './db.js';
import * as W from './whatsapp.js';
import { generateReply } from './llm.js';
import { emit } from './events.js';

const S = () => D.getSettings();
const render = (tpl, c) => tpl.replace(/\{\{\s*name\s*\}\}/gi, c.name || 'there');
const STOP_RE = /^\s*(stop|unsubscribe|cancel|remove me|do not (message|contact)|don'?t (message|contact))\b/i;
const HUMAN_RE = /\b(human|real person|agent|representative|manager|talk to (someone|a person)|call me)\b/i;

const pushContact = (id) => emit('contact', { contact: D.getContact(id) });
const pushMessage = (contactId, message) => emit('message', { contactId, message });

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

// ---------- Step 3: first message campaign loop ----------
let loopRunning = false;
export function startCampaign() {
  D.setSetting('campaign_running', 1);
  emit('state');
  if (!loopRunning) campaignLoop();
}
export function stopCampaign() { D.setSetting('campaign_running', 0); emit('state'); }
const running = () => D.getSetting('campaign_running') === '1';

async function campaignLoop() {
  loopRunning = true;
  try {
    while (running()) {
      const s = S();
      if (W.wa.state !== 'ready') { await W.sleep(5000); continue; }
      if (D.counts().sentToday >= Number(s.daily_limit)) { await W.sleep(60_000); continue; }
      const c = D.db.prepare("SELECT * FROM contacts WHERE status='NEW' ORDER BY id LIMIT 1").get();
      if (!c) { await W.sleep(10_000); continue; }
      try {
        const chatId = await W.resolveNumber(c.phone);
        if (!chatId) {
          D.updateContact(c.id, { status: 'INVALID', notes: (c.notes ? c.notes + '\n' : '') + 'Not on WhatsApp' });
          pushContact(c.id); continue;
        }
        D.updateContact(c.id, { chat_id: chatId });
        await sendTo({ ...c, chat_id: chatId }, render(s.first_message, c), 'bot');
        const now = Date.now();
        D.updateContact(c.id, { status: 'SENT', first_sent_at: now, next_check_at: now + Number(s.check_minutes) * 60_000 });
        pushContact(c.id); emit('state');
      } catch (e) {
        console.error('first message failed for', c.phone, e.message);
        D.updateContact(c.id, { status: 'INVALID', notes: (c.notes ? c.notes + '\n' : '') + 'Send failed: ' + e.message });
        pushContact(c.id);
      }
      await W.sleep(W.rand(Number(s.min_delay), Number(s.max_delay)) * 1000); // random 20-60s
    }
  } finally { loopRunning = false; }
}

// ---------- Step 4: incoming messages ----------
const timers = new Map(); const locks = new Set();

export async function onIncoming(ev) {
  const contact = D.getContactByPhone(ev.phone);
  if (!contact) return;                       // only people from our sheet
  if (D.messageByWaId(ev.waId)) return;
  if (!contact.chat_id || contact.chat_id !== ev.chatId) D.updateContact(contact.id, { chat_id: ev.chatId });
  record(contact, 'in', 'customer', ev.body, ev.waId, ev.ts);

  const patch = { unread: contact.unread + 1, followups_sent: 0, next_check_at: null };
  if (['SENT', 'NO_RESPONSE', 'REPLIED'].includes(contact.status)) patch.status = 'REPLIED';
  D.updateContact(contact.id, patch);
  pushContact(contact.id);
  emit('incoming', { contactId: contact.id, needsHuman: false });

  if (['DONE', 'STOPPED'].includes(contact.status) || contact.bot_paused) return;

  // Step 9: stop rules
  if (STOP_RE.test(ev.body)) {
    D.updateContact(contact.id, { status: 'STOPPED', bot_paused: 1, draft: null });
    return pushContact(contact.id);
  }
  if (HUMAN_RE.test(ev.body)) return handoff(contact.id, S().human_handoff_message);

  clearTimeout(timers.get(contact.id));       // wait a few seconds for burst messages
  timers.set(contact.id, setTimeout(() => processReply(contact.id), 6000));
}

async function handoff(id, message) {
  const c = D.getContact(id);
  D.updateContact(id, { status: 'NEEDS_HUMAN', bot_paused: 1, next_check_at: null, draft: null });
  try { if (message) await sendTo(c, message, 'bot'); } catch (e) { console.error(e.message); }
  pushContact(id);
  emit('incoming', { contactId: id, needsHuman: true });
}

// ---------- Steps 6 & 7: generate + send reply ----------
async function processReply(id) {
  if (locks.has(id)) return;
  locks.add(id);
  try {
    let c = D.getContact(id);
    if (!c || c.bot_paused || c.draft || ['DONE', 'STOPPED', 'NEEDS_HUMAN'].includes(c.status)) return;
    const history = D.messagesFor(id, 15);
    if (history.at(-1)?.direction !== 'in') return;   // someone already answered

    let r;
    try { r = await generateReply(history, c.name); }
    catch (e) {
      console.error('LLM failed:', e.message);
      D.updateContact(id, { status: 'NEEDS_HUMAN', bot_paused: 1, notes: (c.notes ? c.notes + '\n' : '') + 'Bot error: ' + e.message });
      pushContact(id); return emit('incoming', { contactId: id, needsHuman: true });
    }
    if (r.needsHuman) return handoff(id, S().holding_message);   // never guess

    if (S().approval_mode === '1') {            // approval mode: park as draft
      D.updateContact(id, { draft: r.reply, status: 'NEEDS_HUMAN' });
      pushContact(id); return emit('incoming', { contactId: id, needsHuman: true });
    }
    await W.sleep(W.rand(3, 9) * 1000);          // look natural
    c = D.getContact(id);
    if (c.bot_paused || D.messagesFor(id, 1).at(-1)?.direction !== 'in') return; // human stepped in
    await sendTo(c, r.reply, 'bot');
    D.updateContact(id, {
      status: r.end ? 'DONE' : 'REPLIED',
      next_check_at: r.end ? null : Date.now() + Number(S().check_minutes) * 60_000,
    });
    pushContact(id);
  } catch (e) { console.error('processReply error', e); }
  finally { locks.delete(id); }
}

// ---------- Step 5: 10-minute check ----------
let ticking = false;
async function tick() {
  if (ticking || W.wa.state !== 'ready' || !running()) return;
  ticking = true;
  try {
    const s = S();
    const due = D.db.prepare(
      "SELECT * FROM contacts WHERE next_check_at IS NOT NULL AND next_check_at<=? AND status IN ('SENT','REPLIED') AND bot_paused=0"
    ).all(Date.now());
    for (const c of due) {
      const last = D.messagesFor(c.id, 1).at(-1);
      if (!last || last.direction === 'in') { D.updateContact(c.id, { next_check_at: null }); continue; } // they replied
      if (c.followups_sent >= Number(s.max_followups)) {
        D.updateContact(c.id, { status: 'NO_RESPONSE', next_check_at: null });
      } else {
        try {
          await sendTo(c, render(s.follow_up_message, c), 'bot');
          D.updateContact(c.id, { followups_sent: c.followups_sent + 1, next_check_at: Date.now() + Number(s.check_minutes) * 60_000 });
        } catch (e) { console.error('follow-up failed', c.phone, e.message); D.updateContact(c.id, { next_check_at: Date.now() + 60_000 }); }
        await W.sleep(W.rand(10, 25) * 1000);
      }
      pushContact(c.id);
    }
  } finally { ticking = false; }
}
export const startScheduler = () => {
  cron.schedule('* * * * *', () => tick().catch(console.error));
  if (running()) campaignLoop();
};

// ---------- Step 8: human actions from dashboard ----------
export async function humanSend(id, text) {
  const c = D.getContact(id);
  if (!c) throw new Error('No such contact');
  await sendTo(c, text, 'human', { typing: false });
  D.updateContact(id, { bot_paused: 1, draft: null, next_check_at: null, unread: 0, status: c.status === 'NEEDS_HUMAN' ? 'REPLIED' : c.status });
  pushContact(id);
}
export async function approveDraft(id, text) {
  const c = D.getContact(id);
  if (!c?.draft && !text) throw new Error('No draft');
  await sendTo(c, text || c.draft, 'bot', { typing: false });
  D.updateContact(id, { draft: null, status: 'REPLIED', unread: 0, next_check_at: Date.now() + Number(S().check_minutes) * 60_000 });
  pushContact(id);
}
export function discardDraft(id) { D.updateContact(id, { draft: null, bot_paused: 1 }); pushContact(id); }

/** Owner typed on the phone itself → record it and pause the bot for that chat. */
export async function onOutgoingFromPhone(ev) {
  const c = D.getContactByPhone(ev.phone);
  if (!c || D.messageByWaId(ev.waId)) return;
  record(c, 'out', 'human', ev.body, ev.waId, ev.ts);
  D.updateContact(c.id, { bot_paused: 1, next_check_at: null });
  pushContact(c.id);
}
