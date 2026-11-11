import express from 'express';
import multer from 'multer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT, PORT, BUSINESS_FILE } from './config.js';
import * as D from './db.js';
import * as W from './whatsapp.js';
import * as B from './bot.js';
import { parseSheet, exportWorkbook } from './excel.js';
import { bus } from './events.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const state = () => ({ wa: W.publicStatus(), counts: D.counts(), settings: D.getSettings() });

app.get('/api/state', (_q, res) => res.json(state()));
app.get('/api/contacts', (req, res) => res.json(D.listContacts({ status: req.query.status, q: req.query.q })));
app.get('/api/contacts/:id', (req, res) => {
  const c = D.getContact(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.unread) { D.updateContact(c.id, { unread: 0 }); c.unread = 0; }
  res.json({ contact: c, messages: D.messagesFor(c.id) });
});
app.post('/api/contacts/:id/send', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('Empty message');
  await B.humanSend(Number(req.params.id), text); res.json({ ok: true });
}));
app.post('/api/contacts/:id/pause', wrap((req, res) => {
  const id = Number(req.params.id); const paused = req.body.paused ? 1 : 0;
  const c = D.getContact(id);
  D.updateContact(id, { bot_paused: paused, ...(paused ? { next_check_at: null } : {}) });
  // resuming a "needs human" chat hands it back to the bot
  if (!paused && c.status === 'NEEDS_HUMAN') D.updateContact(id, { status: 'REPLIED' });
  emitContact(id); res.json({ ok: true });
}));
app.post('/api/contacts/:id/status', wrap((req, res) => {
  if (!D.STATUSES.includes(req.body.status)) throw new Error('Bad status');
  D.updateContact(Number(req.params.id), { status: req.body.status, next_check_at: null });
  emitContact(Number(req.params.id)); res.json({ ok: true });
}));
app.post('/api/contacts/:id/notes', wrap((req, res) => {
  D.updateContact(Number(req.params.id), { notes: String(req.body.notes || '').slice(0, 5000) });
  res.json({ ok: true });
}));
app.post('/api/contacts/:id/draft/approve', wrap(async (req, res) => { await B.approveDraft(Number(req.params.id), req.body.text); res.json({ ok: true }); }));
app.post('/api/contacts/:id/draft/discard', wrap((req, res) => { B.discardDraft(Number(req.params.id)); res.json({ ok: true }); }));

app.post('/api/upload', upload.single('file'), wrap((req, res) => {
  if (!req.file) throw new Error('No file');
  const { rows, duplicates, invalid } = parseSheet(req.file.buffer);
  const added = D.insertContacts(rows);
  bus.emit('event', { type: 'state' });
  res.json({ found: rows.length, added, alreadyInDb: rows.length - added, duplicatesInSheet: duplicates, invalid });
}));

app.post('/api/campaign', wrap((req, res) => {
  req.body.running ? B.startCampaign() : B.stopCampaign();
  res.json(state());
}));
app.get('/api/settings', (_q, res) => res.json(D.getSettings()));
app.put('/api/settings', wrap((req, res) => {
  for (const [k, v] of Object.entries(req.body)) if (k !== 'campaign_running') D.setSetting(k, v);
  bus.emit('event', { type: 'state' }); res.json(D.getSettings());
}));
app.get('/api/business', (_q, res) => res.json({ text: fs.existsSync(BUSINESS_FILE) ? fs.readFileSync(BUSINESS_FILE, 'utf8') : '' }));
app.put('/api/business', wrap((req, res) => { fs.writeFileSync(BUSINESS_FILE, String(req.body.text ?? '')); res.json({ ok: true }); }));
app.get('/api/export', (_q, res) => {
  const contacts = D.listContacts();
  const msgs = D.db.prepare('SELECT * FROM messages ORDER BY contact_id, id').all();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="chats.xlsx"');
  res.send(exportWorkbook(contacts, msgs));
});

const emitContact = (id) => bus.emit('event', { type: 'contact', contact: D.getContact(id) });

// ---- WebSocket (live push) ----
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
