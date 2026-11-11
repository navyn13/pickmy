import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'bot.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  info TEXT NOT NULL DEFAULT '',          -- everything the bot may say: services, prices, timings, FAQs...
  first_message TEXT NOT NULL DEFAULT '',
  follow_up_message TEXT NOT NULL DEFAULT '',
  holding_message TEXT NOT NULL DEFAULT '',
  human_handoff_message TEXT NOT NULL DEFAULT '',
  approval_mode INTEGER NOT NULL DEFAULT 0,
  campaign_running INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  phone TEXT NOT NULL,
  name TEXT DEFAULT '',
  age TEXT DEFAULT '',
  education TEXT DEFAULT '',
  grades TEXT DEFAULT '',
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
  created_at INTEGER NOT NULL,
  UNIQUE(business_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(business_id, status);
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

// ---------- global settings (shared by all businesses — one WhatsApp number) ----------
const DEFAULTS = { daily_limit: '30', min_delay: '20', max_delay: '60', check_minutes: '10', max_followups: '2' };
for (const [k, v] of Object.entries(DEFAULTS)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
export const getSettings = () =>
  Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
export const setSetting = (k, v) => {
  if (!(k in DEFAULTS)) return;
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
};

// ---------- businesses ----------
export const BUSINESS_DEFAULTS = {
  info: `## About
<what the business does, 2-3 lines>

## Services / courses & prices
- ...

## Timings
...

## Location
...

## Policies (fees, refunds, admission rules)
...

## FAQs
Q: ...
A: ...
`,
  first_message: 'Hi {{name}}, this is {{business}}. Can I help you with anything today?',
  follow_up_message: 'Hi {{name}}, just checking in — happy to answer any questions you have.',
  holding_message: 'Let me check and get back to you shortly.',
  human_handoff_message: 'Sure, I am connecting you with our team. They will reply here shortly.',
};
const BIZ_COLS = ['name', 'info', 'first_message', 'follow_up_message', 'holding_message', 'human_handoff_message', 'approval_mode', 'campaign_running'];

export const listBusinesses = () => db.prepare('SELECT * FROM businesses ORDER BY name').all();
export const getBusiness = (id) => db.prepare('SELECT * FROM businesses WHERE id=?').get(id);
export function createBusiness(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Business name is required');
  if (db.prepare('SELECT 1 FROM businesses WHERE name=?').get(name)) throw new Error('A business with this name already exists');
  const d = BUSINESS_DEFAULTS;
  const r = db.prepare(
    'INSERT INTO businesses(name,info,first_message,follow_up_message,holding_message,human_handoff_message,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(name, d.info, d.first_message, d.follow_up_message, d.holding_message, d.human_handoff_message, Date.now());
  return getBusiness(r.lastInsertRowid);
}
export function updateBusiness(id, fields) {
  const keys = Object.keys(fields).filter((k) => BIZ_COLS.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE businesses SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(
    ...keys.map((k) => (k === 'approval_mode' || k === 'campaign_running' ? (Number(fields[k]) ? 1 : 0) : String(fields[k]))), id);
}
export function deleteBusiness(id) {
  if (db.prepare('SELECT 1 FROM contacts WHERE business_id=? LIMIT 1').get(id)) throw new Error('Business still has contacts');
  db.prepare('DELETE FROM businesses WHERE id=?').run(id);
}

// ---------- contacts ----------
export const PROFILE_FIELDS = ['name', 'age', 'education', 'grades'];
export const getContact = (id) => db.prepare(
  'SELECT c.*, b.name AS business_name FROM contacts c JOIN businesses b ON b.id=c.business_id WHERE c.id=?').get(id);

/** The conversation an incoming message from `phone` belongs to: the most recently active one. */
export const findContactForIncoming = (phone) => db.prepare(
  `SELECT * FROM contacts WHERE phone=? AND status NOT IN ('NEW','INVALID')
   ORDER BY COALESCE(last_message_at, first_sent_at, created_at) DESC LIMIT 1`).get(phone)
  || db.prepare('SELECT * FROM contacts WHERE phone=? ORDER BY created_at DESC LIMIT 1').get(phone);

const COLS = new Set([
  ...PROFILE_FIELDS, 'chat_id', 'status', 'bot_paused', 'followups_sent', 'next_check_at', 'first_sent_at',
  'last_message_at', 'last_message_text', 'unread', 'notes', 'draft',
]);
export function updateContact(id, fields) {
  const keys = Object.keys(fields).filter((k) => COLS.has(k));
  if (!keys.length) return;
  db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(
    ...keys.map((k) => fields[k]), id);
}

/** Insert new people, or update the profile of people already in this business. */
export function upsertContacts(businessId, rows) {
  const find = db.prepare('SELECT id FROM contacts WHERE business_id=? AND phone=?');
  const ins = db.prepare('INSERT INTO contacts(business_id,phone,name,age,education,grades,created_at) VALUES(?,?,?,?,?,?,?)');
  let added = 0; let updated = 0; const ids = [];
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const ex = find.get(businessId, r.phone);
      if (ex) {
        const patch = Object.fromEntries(PROFILE_FIELDS.filter((f) => r[f]).map((f) => [f, r[f]]));
        updateContact(ex.id, patch); updated++; ids.push(ex.id);
      } else {
        const res = ins.run(businessId, r.phone, r.name || '', r.age || '', r.education || '', r.grades || '', Date.now());
        added++; ids.push(Number(res.lastInsertRowid));
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, updated, ids };
}
export const deleteContact = (id) => {
  db.prepare('DELETE FROM messages WHERE contact_id=?').run(id);
  db.prepare('DELETE FROM contacts WHERE id=?').run(id);
};

export function listContacts({ businessId, status, q } = {}) {
  const where = []; const args = [];
  if (businessId) { where.push('c.business_id=?'); args.push(businessId); }
  if (status && status !== 'ALL') {
    if (status === 'DONE') where.push("c.status IN ('DONE','STOPPED')");
    else { where.push('c.status=?'); args.push(status); }
  }
  if (q) {
    where.push(`(c.phone LIKE ? OR c.name LIKE ? OR c.notes LIKE ? OR c.education LIKE ?
      OR c.id IN (SELECT contact_id FROM messages WHERE body LIKE ?))`);
    const like = `%${q}%`; args.push(like, like, like, like, like);
  }
  return db.prepare(
    `SELECT c.*, b.name AS business_name FROM contacts c JOIN businesses b ON b.id=c.business_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (c.status='NEEDS_HUMAN') DESC, COALESCE(c.last_message_at, c.created_at) DESC LIMIT 2000`
  ).all(...args);
}

// ---------- messages ----------
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

// ---------- counts ----------
export function counts(businessId) {
  const f = businessId ? ' AND business_id=?' : ''; const a = businessId ? [businessId] : [];
  const one = (sql, ...x) => db.prepare(sql).get(...x).n;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return {
    total: one(`SELECT COUNT(*) n FROM contacts WHERE 1=1${f}`, ...a),
    newCount: one(`SELECT COUNT(*) n FROM contacts WHERE status='NEW'${f}`, ...a),
    sent: one(`SELECT COUNT(*) n FROM contacts WHERE first_sent_at IS NOT NULL${f}`, ...a),
    replied: one(`SELECT COUNT(*) n FROM contacts WHERE id IN (SELECT contact_id FROM messages WHERE direction='in')${f}`, ...a),
    needsHuman: one(`SELECT COUNT(*) n FROM contacts WHERE status='NEEDS_HUMAN'${f}`, ...a),
    // daily limit is per WhatsApp number → always counted across all businesses
    sentTodayAll: one('SELECT COUNT(*) n FROM contacts WHERE first_sent_at>=?', start.getTime()),
  };
}
