import XLSX from 'xlsx';
import { COUNTRY_CODE } from './config.js';

/** Clean a raw phone value → digits with country code, or null. */
export function normalizePhone(raw, cc = COUNTRY_CODE) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = cc + d.slice(1);
  else if (d.length === 10) d = cc + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/** Parse xlsx/csv buffer → { rows:[{phone,name}], duplicates, invalid } */
export function parseSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (!data.length) return { rows: [], duplicates: 0, invalid: 0 };

  const header = data[0].map((h) => String(h).toLowerCase());
  let phoneCol = header.findIndex((h) => /phone|mobile|number|whatsapp|contact|cell/.test(h));
  const nameCol = header.findIndex((h) => /name/.test(h));
  let start = 1;
  if (phoneCol === -1) { // no header row — first column that looks like a phone number
    start = 0;
    phoneCol = Math.max(0, data[0].findIndex((c) => normalizePhone(c)));
  }

  const seen = new Set(); const rows = []; let duplicates = 0; let invalid = 0;
  for (const r of data.slice(start)) {
    if (r.every((c) => String(c).trim() === '')) continue;
    const phone = normalizePhone(r[phoneCol]);
    if (!phone) { invalid++; continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    rows.push({ phone, name: nameCol >= 0 ? String(r[nameCol]).trim() : '' });
  }
  return { rows, duplicates, invalid };
}

export function exportWorkbook(contacts, messages) {
  const wb = XLSX.utils.book_new();
  const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(contacts.map((c) => ({
    Phone: c.phone, Name: c.name, Status: c.status, 'Bot paused': c.bot_paused ? 'yes' : 'no',
    'Follow-ups sent': c.followups_sent, 'Last message': c.last_message_text,
    'Last activity': fmt(c.last_message_at), Notes: c.notes,
  }))), 'Contacts');
  const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(messages.map((m) => ({
    Phone: byId[m.contact_id]?.phone, Time: fmt(m.created_at), From: m.sender, Message: m.body,
  }))), 'Chats');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
