import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data.json');

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {}
  return { leads: [], sends: [], daily: {} };
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export function getDb() {
  return load();
}

export function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function getTodayCount() {
  const db = load();
  return db.daily[getTodayKey()] || 0;
}

export function incrementToday() {
  const db = load();
  const key = getTodayKey();
  db.daily[key] = (db.daily[key] || 0) + 1;
  save(db);
}

export function addLead({ email, name = '', company = '', notes = '' }) {
  const db = load();
  const exists = db.leads.find(l => l.email.toLowerCase() === email.toLowerCase());
  if (exists) return false;

  db.leads.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    email: email.toLowerCase().trim(),
    name: name.trim(),
    company: company.trim(),
    notes: notes.trim(),
    status: 'pending',
    sent_at: null,
    resend_id: null,
    created_at: new Date().toISOString()
  });
  save(db);
  return true;
}

export function getPending(limit = 10) {
  const db = load();
  return db.leads.filter(l => l.status === 'pending').slice(0, limit);
}

export function markSent(id, resendId) {
  const db = load();
  const lead = db.leads.find(l => l.id === id);
  if (lead) {
    lead.status = 'sent';
    lead.sent_at = new Date().toISOString();
    lead.resend_id = resendId || null;
    db.sends.push({
      lead_id: id,
      email: lead.email,
      resend_id: resendId,
      sent_at: lead.sent_at
    });
    save(db);
  }
}

export function unsubscribe(email) {
  const db = load();
  const lead = db.leads.find(l => l.email === email.toLowerCase());
  if (lead) {
    lead.status = 'unsubscribed';
    save(db);
    return true;
  }
  return false;
}

export function getAllLeads() {
  return load().leads.slice().reverse();
}

export function getStats() {
  const db = load();
  const sentToday = db.daily[getTodayKey()] || 0;
  return {
    sentToday,
    pending: db.leads.filter(l => l.status === 'pending').length,
    totalSent: db.leads.filter(l => l.status === 'sent').length,
    unsubscribed: db.leads.filter(l => l.status === 'unsubscribed').length
  };
}
