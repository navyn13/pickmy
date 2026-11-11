import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT, PORT } from './config.js';
import * as D from './db.js';
import * as W from './whatsapp.js';
import * as B from './bot.js';
import { exportWorkbook, contactFromFields, parsePaste } from './excel.js';
import { bus } from './events.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const emitState = () => bus.emit('event', { type: 'state' });
const emitContact = (id) => bus.emit('event', { type: 'contact', contact: D.getContact(id) });
const bizOr404 = (id) => { const b = D.getBusiness(Number(id)); if (!b) throw new Error('No such business'); return b; };
const state = () => ({
  wa: W.publicStatus(),
  settings: D.getSettings(),
  counts: D.counts(),
  businesses: D.listBusinesses().map((b) => ({ ...b, counts: D.counts(b.id) })),
});

app.get('/api/state', (_q, res) => res.json(state()));

// ---------- global settings (limits are per WhatsApp number) ----------
app.put('/api/settings', wrap((req, res) => {
  for (const [k, v] of Object.entries(req.body)) D.setSetting(k, v);
  emitState(); res.json(D.getSettings());
}));

// ---------- businesses ----------
app.post('/api/businesses', wrap((req, res) => { const b = D.createBusiness(req.body.name); emitState(); res.json(b); }));
app.get('/api/businesses/:id', wrap((req, res) => res.json(bizOr404(req.params.id))));
app.put('/api/businesses/:id', wrap((req, res) => {
  const b = bizOr404(req.params.id);
  const { campaign_running: _ignored, ...fields } = req.body;   // campaign only via /campaign
  if (fields.name !== undefined && !String(fields.name).trim()) throw new Error('Name cannot be empty');
  D.updateBusiness(b.id, fields); emitState(); res.json(D.getBusiness(b.id));
}));
app.delete('/api/businesses/:id', wrap((req, res) => { D.deleteBusiness(bizOr404(req.params.id).id); emitState(); res.json({ ok: true }); }));
app.post('/api/businesses/:id/campaign', wrap((req, res) => {
  B.setCampaign(bizOr404(req.params.id).id, !!req.body.running); res.json(state());
}));

/** Add people to a business: { contacts:[{name,phone,age,education,grades}] } or { text:"pasted lines" } */
app.post('/api/businesses/:id/contacts', wrap((req, res) => {
  const b = bizOr404(req.params.id);
  let rows = []; let errors = []; let duplicates = 0;
  if (typeof req.body.text === 'string') ({ rows, errors, duplicates } = parsePaste(req.body.text));
  for (const f of req.body.contacts || []) {
    try { rows.push(contactFromFields(f)); } catch (e) { errors.push(e.message); }
  }
  if (!rows.length && errors.length) throw new Error(errors.join('\n'));
  const r = D.upsertContacts(b.id, rows);
  emitState();
  res.json({ added: r.added, updated: r.updated, duplicatesInPaste: duplicates, errors, ids: r.ids });
}));

// ---------- contacts ----------
app.get('/api/contacts', (req, res) => res.json(D.listContacts({
  businessId: Number(req.query.business) || null, status: req.query.status, q: req.query.q,
})));
app.get('/api/contacts/:id', (req, res) => {
  const c = D.getContact(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.unread) { D.updateContact(c.id, { unread: 0 }); c.unread = 0; }
  res.json({ contact: c, messages: D.messagesFor(c.id) });
});
app.put('/api/contacts/:id/profile', wrap((req, res) => {
  const id = Number(req.params.id);
  const patch = {};
  for (const k of [...D.PROFILE_FIELDS, 'notes']) if (req.body[k] !== undefined) patch[k] = String(req.body[k]).slice(0, 5000);
  D.updateContact(id, patch); emitContact(id); res.json({ ok: true });
}));
app.delete('/api/contacts/:id', wrap((req, res) => { D.deleteContact(Number(req.params.id)); emitState(); res.json({ ok: true }); }));
app.post('/api/contacts/:id/send', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('Empty message');
  await B.humanSend(Number(req.params.id), text); res.json({ ok: true });
}));
app.post('/api/contacts/:id/pause', wrap((req, res) => {
  const id = Number(req.params.id); const paused = req.body.paused ? 1 : 0;
  const c = D.getContact(id);
  D.updateContact(id, { bot_paused: paused, ...(paused ? { next_check_at: null } : {}) });
  if (!paused && c.status === 'NEEDS_HUMAN') D.updateContact(id, { status: 'REPLIED' }); // hand back to bot
  emitContact(id); res.json({ ok: true });
}));
app.post('/api/contacts/:id/status', wrap((req, res) => {
  if (!D.STATUSES.includes(req.body.status)) throw new Error('Bad status');
  D.updateContact(Number(req.params.id), { status: req.body.status, next_check_at: null });
  emitContact(Number(req.params.id)); res.json({ ok: true });
}));
app.post('/api/contacts/:id/draft/approve', wrap(async (req, res) => { await B.approveDraft(Number(req.params.id), req.body.text); res.json({ ok: true }); }));
app.post('/api/contacts/:id/draft/discard', wrap((req, res) => { B.discardDraft(Number(req.params.id)); res.json({ ok: true }); }));

// Send a one-off message to anyone (added to the chosen business; bot stays paused for that chat)
app.post('/api/send-custom', wrap(async (req, res) => {
  const b = bizOr404(req.body.business_id);
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('Empty message');
  const f = contactFromFields(req.body);
  const existing = D.db.prepare('SELECT id FROM contacts WHERE business_id=? AND phone=?').get(b.id, f.phone);
  const { ids: [id] } = D.upsertContacts(b.id, [f]);
  if (!existing) D.updateContact(id, { bot_paused: 1 });
  try { await B.humanSend(id, text); }
  catch (e) { if (!existing) D.deleteContact(id); emitState(); throw e; }
  emitState(); res.json({ ok: true, contactId: id });
}));

app.get('/api/export', (req, res) => {
  const contacts = D.listContacts({ businessId: Number(req.query.business) || null });
  const msgs = D.db.prepare('SELECT * FROM messages ORDER BY contact_id, id').all();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="chats.xlsx"');
  res.send(exportWorkbook(contacts, msgs));
});

// ---------- WebSocket (live push) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
bus.on('event', (ev) => {
  const payload = JSON.stringify(ev.type === 'state' ? { type: 'state', ...state() } : ev);
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
});

W.start({ incoming: B.onIncoming, outgoing: B.onOutgoingFromPhone });
B.startScheduler();
server.listen(PORT, '127.0.0.1', () => console.log(`Dashboard: http://localhost:${PORT}`));
