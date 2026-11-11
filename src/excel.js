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

const clean = (v) => String(v ?? '').trim().slice(0, 500);

/** One person from form fields → {phone,name,age,education,grades} or throws. */
export function contactFromFields(f) {
  const phone = normalizePhone(f.phone);
  if (!phone) throw new Error(`Invalid phone number: "${clean(f.phone)}"`);
  return { phone, name: clean(f.name), age: clean(f.age), education: clean(f.education), grades: clean(f.grades) };
}

/**
 * Pasted block, one person per line:
 *   name, number, age, education, grades
 * Separators: comma, tab, | or ;  — grades may contain more commas (everything after the 4th field).
 * Lines where the number comes first are also accepted. A header line is skipped.
 */
export function parsePaste(text) {
  const rows = []; const errors = []; const seen = new Set(); let duplicates = 0;
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const sep = line.includes('\t') ? '\t' : line.includes('|') ? '|' : line.includes(';') ? ';' : ',';
    let parts = line.split(sep).map((s) => s.trim());
    if (i === 0 && /name/i.test(parts[0] || '') && /(phone|number|mobile)/i.test(parts.join(' '))) return; // header
    if (normalizePhone(parts[0]) && !normalizePhone(parts[1])) parts = [parts[1] || '', parts[0], ...parts.slice(2)];
    const [name, phone, age, education, ...rest] = parts;
    try {
      const c = contactFromFields({ name, phone, age, education, grades: rest.join(sep === ',' ? ', ' : ` ${sep} `) });
      if (seen.has(c.phone)) { duplicates++; return; }
      seen.add(c.phone); rows.push(c);
    } catch (e) { errors.push(`Line ${i + 1}: ${e.message}`); }
  });
  return { rows, errors, duplicates };
}

export function exportWorkbook(contacts, messages) {
  const wb = XLSX.utils.book_new();
  const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(contacts.map((c) => ({
    Business: c.business_name, Phone: c.phone, Name: c.name, Age: c.age, Education: c.education, Grades: c.grades,
    Status: c.status, 'Bot paused': c.bot_paused ? 'yes' : 'no', 'Follow-ups sent': c.followups_sent,
    'Last message': c.last_message_text, 'Last activity': fmt(c.last_message_at), Notes: c.notes,
  }))), 'Contacts');
  const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(messages.filter((m) => byId[m.contact_id]).map((m) => ({
    Business: byId[m.contact_id].business_name, Phone: byId[m.contact_id].phone,
    Time: fmt(m.created_at), From: m.sender, Message: m.body,
  }))), 'Chats');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
