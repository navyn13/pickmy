import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'bot.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'NEW',
  bot_paused INTEGER NOT NULL DEFAULT 0,
  followups_sent INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER,
  first_sent_at INTEGER,
  last_message_at INTEGER,
  last_message_text TEXT DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  draft TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_check ON contacts(next_check_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  direction TEXT NOT NULL,      -- 'in' | 'out'
  sender TEXT NOT NULL,         -- 'customer' | 'bot' | 'human'
  body TEXT NOT NULL,
  wa_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const STATUSES = ['NEW', 'SENT', 'REPLIED', 'NEEDS_HUMAN', 'NO_RESPONSE', 'DONE', 'STOPPED', 'INVALID'];

const DEFAULTS = {
  campaign_running: '0',
  daily_limit: '30',
  min_delay: '20',
  max_delay: '60',
  check_minutes: '10',
  max_followups: '2',
  approval_mode: '0',
  first_message: 'Hi {{name}}, this is Pickmy. Thanks for being in touch with us — can I help you with anything today?',
  follow_up_message: 'Hi {{name}}, just checking in — happy to answer any questions you have.',
  holding_message: 'Let me check and get back to you shortly.',
  human_handoff_message: 'Sure, I am connecting you with our team. They will reply here shortly.',
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
}

export const getSettings = () =>
  Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
export const setSetting = (k, v) => {
  if (!(k in DEFAULTS)) return;
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
};

export const getContact = (id) => db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
export const getContactByPhone = (p) => db.prepare('SELECT * FROM contacts WHERE phone=?').get(p);

const COLS = new Set([
  'name', 'chat_id', 'status', 'bot_paused', 'followups_sent', 'next_check_at', 'first_sent_at',
  'last_message_at', 'last_message_text', 'unread', 'notes', 'draft',
]);
export function updateContact(id, fields) {
  const keys = Object.keys(fields).filter((k) => COLS.has(k));
  if (!keys.length) return;
  db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(
    ...keys.map((k) => fields[k]), id);
}

export function addMessage(contactId, direction, sender, body, waId = null, ts = Date.now()) {
  const r = db.prepare(
    'INSERT OR IGNORE INTO messages(contact_id,direction,sender,body,wa_id,created_at) VALUES(?,?,?,?,?,?)'
  ).run(contactId, direction, sender, body, waId, ts);
  if (!r.changes) return null;
  updateContact(contactId, { last_message_at: ts, last_message_text: body.slice(0, 200) });
  return db.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid);
}
export const messagesFor = (contactId, limit = 500) =>
  db.prepare('SELECT * FROM (SELECT * FROM messages WHERE contact_id=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(contactId, limit);
export const messageByWaId = (w) => db.prepare('SELECT * FROM messages WHERE wa_id=?').get(w);

export function insertContacts(rows) {
  const ins = db.prepare('INSERT OR IGNORE INTO contacts(phone,name,created_at) VALUES(?,?,?)');
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) added += ins.run(r.phone, r.name || '', Date.now()).changes;
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return added;
}

export function counts() {
  const by = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM contacts GROUP BY status').all().map((r) => [r.status, r.n]));
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const sentToday = db.prepare('SELECT COUNT(*) n FROM contacts WHERE first_sent_at>=?').get(start.getTime()).n;
  const total = db.prepare('SELECT COUNT(*) n FROM contacts').get().n;
  const sent = db.prepare('SELECT COUNT(*) n FROM contacts WHERE first_sent_at IS NOT NULL').get().n;
  const replied = db.prepare("SELECT COUNT(DISTINCT contact_id) n FROM messages WHERE direction='in'").get().n;
  return { total, sent, replied, sentToday, needsHuman: by.NEEDS_HUMAN || 0, by };
}

export function listContacts({ status, q } = {}) {
  const where = []; const args = [];
  if (status && status !== 'ALL') {
    if (status === 'DONE') where.push("status IN ('DONE','STOPPED')");
    else { where.push('status=?'); args.push(status); }
  }
  if (q) {
    where.push('(phone LIKE ? OR name LIKE ? OR notes LIKE ? OR id IN (SELECT contact_id FROM messages WHERE body LIKE ?))');
    const like = `%${q}%`; args.push(like, like, like, like);
  }
  return db.prepare(
    `SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (status='NEEDS_HUMAN') DESC, COALESCE(last_message_at, created_at) DESC LIMIT 1000`
  ).all(...args);
}
