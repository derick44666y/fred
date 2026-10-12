// db.js — SQLite lead store.
//
// This replaces the old single-file JSON database. SQLite gives us the three
// things the JSON file could not:
//   1. atomic writes — a crash or a killed process can no longer truncate the DB
//   2. `INSERT ... ON CONFLICT(email) DO NOTHING`, so two concurrent harvest
//      jobs cannot read-modify-write over each other and lose leads
//   3. WAL + busy_timeout, so several search jobs (or the CLI next to the
//      running server) can write at the same time instead of fighting for a lock
//
// Backed by the built-in node:sqlite module (Node 22+), so there is no native
// dependency to compile. An existing data.json is imported once on first open
// and then archived — it is never deleted.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** DB_PATH lets a test run, a CLI import or a second instance use its own file. */
export const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data.sqlite');

/** Previous JSON database — imported automatically, then renamed to *.migrated.
 *  Derived from the DB's own folder, so a scratch/test DB never imports the
 *  production data.json. */
const LEGACY_JSON = process.env.LEGACY_JSON_PATH || path.join(path.dirname(dbPath), 'data.json');

const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                TEXT NOT NULL DEFAULT '',
    company             TEXT NOT NULL DEFAULT '',
    notes               TEXT NOT NULL DEFAULT '',
    source_url          TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'pending',
    priority            TEXT NOT NULL DEFAULT 'normal',
    kind                TEXT NOT NULL DEFAULT 'generic',
    score               INTEGER NOT NULL DEFAULT 0,
    reason              TEXT NOT NULL DEFAULT '',
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    verification_detail TEXT NOT NULL DEFAULT '',
    sent_at             TEXT,
    resend_id           TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, priority);
  CREATE INDEX IF NOT EXISTS idx_leads_verification ON leads(verification_status);

  CREATE TABLE IF NOT EXISTS sends (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id   TEXT,
    email     TEXT NOT NULL,
    resend_id TEXT,
    sent_at   TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_unique ON sends(lead_id, sent_at);

  CREATE TABLE IF NOT EXISTS daily (
    day   TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS verifications (
    email      TEXT PRIMARY KEY COLLATE NOCASE,
    status     TEXT NOT NULL,
    provider   TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/** BEGIN IMMEDIATE + COMMIT — one atomic write, rolled back on any error. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw err;
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

// --- leads ------------------------------------------------------------------

export const VERIFICATION_STATUSES = ['unverified', 'valid', 'invalid', 'catchall'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

const insertLeadStmt = db.prepare(`
  INSERT INTO leads (
    id, email, name, company, notes, source_url, status, priority, kind, score,
    reason, verification_status, verification_detail, sent_at, resend_id,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO NOTHING
`);

/**
 * Store one lead. Deduplication happens inside SQLite (UNIQUE email +
 * ON CONFLICT DO NOTHING), so two concurrent jobs can never both "not find it"
 * and then overwrite each other's work.
 * @returns {boolean} true when a new row was written
 */
export function addLead(lead = {}) {
  const email = String(lead.email || '').trim().toLowerCase();
  if (!email) return false;

  const info = insertLeadStmt.run(
    lead.id || newId(),
    email,
    lead.name || '',
    lead.company || '',
    lead.notes || '',
    lead.source_url || '',
    lead.status || 'pending',
    ['high', 'normal', 'low'].includes(lead.priority) ? lead.priority : 'normal',
    lead.kind || 'generic',
    Number(lead.score) || 0,
    lead.reason || '',
    VERIFICATION_STATUSES.includes(lead.verification_status) ? lead.verification_status : 'unverified',
    lead.verification_detail || '',
    lead.sent_at || null,
    lead.resend_id || null,
    lead.created_at || new Date().toISOString(),
    lead.updated_at || null
  );
  return info.changes > 0;
}

/** Many leads in a single atomic transaction (bulk imports). */
export function addLeads(leads = []) {
  return tx(() => leads.reduce((added, lead) => added + (addLead(lead) ? 1 : 0), 0));
}

export function getLeadById(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;
}

export function countLeads() {
  return db.prepare('SELECT COUNT(*) c FROM leads').get().c;
}

const UPDATABLE = {
  notes: 'notes',
  name: 'name',
  company: 'company',
  status: 'status',
  priority: 'priority',
  verification_status: 'verification_status',
  verification_detail: 'verification_detail'
};

/** Curate a lead in place (the UI uses this for the personalization note). */
export function updateLead(id, fields = {}) {
  const sets = [];
  const values = [];
  for (const key of Object.keys(UPDATABLE)) {
    if (typeof fields[key] !== 'string') continue;
    sets.push(`${UPDATABLE[key]} = ?`);
    values.push(fields[key].trim());
  }
  if (sets.length === 0) return getLeadById(id);

  sets.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  tx(() => db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...values));
  return getLeadById(id);
}

/** Pending leads, decision makers first, known-bad addresses excluded. */
export function getPending(limit = 10) {
  return db.prepare(`
    SELECT * FROM leads
    WHERE status = 'pending' AND verification_status <> 'invalid'
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, rowid
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 10));
}

/** How many pending leads sit in each priority bucket. */
export function getPriorityMix() {
  const mix = { high: 0, normal: 0, low: 0 };
  for (const row of db.prepare(
    "SELECT priority, COUNT(*) c FROM leads WHERE status = 'pending' GROUP BY priority"
  ).all()) {
    mix[PRIORITY_RANK[row.priority] === undefined ? 'normal' : row.priority] += row.c;
  }
  return mix;
}

/** How many leads sit at each verification status. */
export function getVerificationMix() {
  const mix = { unverified: 0, valid: 0, invalid: 0, catchall: 0 };
  for (const row of db.prepare('SELECT verification_status s, COUNT(*) c FROM leads GROUP BY s').all()) {
    mix[VERIFICATION_STATUSES.includes(row.s) ? row.s : 'unverified'] += row.c;
  }
  return mix;
}

export function markSent(id, resendId) {
  return tx(() => {
    const sentAt = new Date().toISOString();
    const info = db.prepare(
      "UPDATE leads SET status = 'sent', sent_at = ?, resend_id = ?, updated_at = ? WHERE id = ?"
    ).run(sentAt, resendId || null, sentAt, id);
    if (!info.changes) return false;

    const lead = getLeadById(id);
    db.prepare('INSERT OR IGNORE INTO sends (lead_id, email, resend_id, sent_at) VALUES (?, ?, ?, ?)')
      .run(id, lead ? lead.email : '', resendId || null, sentAt);
    return true;
  });
}

export function unsubscribe(email) {
  const info = db.prepare(
    "UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE email = ?"
  ).run(new Date().toISOString(), String(email || '').trim().toLowerCase());
  return info.changes > 0;
}

/** Newest first, matching the old JSON behaviour. */
export function getAllLeads() {
  return db.prepare('SELECT * FROM leads ORDER BY rowid DESC').all();
}

// --- send counter -----------------------------------------------------------

export function getDayCount(day) {
  const row = db.prepare('SELECT count FROM daily WHERE day = ?').get(String(day));
  return row ? row.count : 0;
}

export function getTodayCount() {
  return getDayCount(getTodayKey());
}

/** Atomic increment: two concurrent sends can never lose a count. */
export function incrementToday() {
  db.prepare(`
    INSERT INTO daily (day, count) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET count = count + 1
  `).run(getTodayKey());
  return getTodayCount();
}

export function getStats() {
  const one = (sql) => db.prepare(sql).get().c;
  return {
    sentToday: getTodayCount(),
    pending: one("SELECT COUNT(*) c FROM leads WHERE status = 'pending'"),
    totalSent: one("SELECT COUNT(*) c FROM leads WHERE status = 'sent'"),
    unsubscribed: one("SELECT COUNT(*) c FROM leads WHERE status = 'unsubscribed'"),
    leads: one('SELECT COUNT(*) c FROM leads')
  };
}

// --- verification cache -----------------------------------------------------

/** Remember a verification verdict so the same address is never paid for twice. */
export function recordVerification(email, status, provider = '', detail = '') {
  db.prepare(`
    INSERT INTO verifications (email, status, provider, detail, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      status = excluded.status, provider = excluded.provider,
      detail = excluded.detail, checked_at = excluded.checked_at
  `).run(String(email).trim().toLowerCase(), status, provider, detail, new Date().toISOString());
}

export function getVerification(email) {
  return db.prepare('SELECT * FROM verifications WHERE email = ?')
    .get(String(email || '').trim().toLowerCase()) || null;
}

// --- global cool down -------------------------------------------------------

const META_COOLDOWN_UNTIL = 'cooldown_until';
const META_COOLDOWN_REASON = 'cooldown_reason';

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(key), String(value));
}

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key));
  return row ? row.value : null;
}

/**
 * Pause all sending until `untilIso`. Persisted in the DB, so a restart does not
 * forget that the list is in trouble.
 */
export function setCooldown(untilIso, reason = '') {
  tx(() => {
    setMeta(META_COOLDOWN_UNTIL, untilIso);
    setMeta(META_COOLDOWN_REASON, reason);
  });
  return getCooldown();
}

export function clearCooldown() {
  tx(() => {
    setMeta(META_COOLDOWN_UNTIL, '');
    setMeta(META_COOLDOWN_REASON, '');
  });
  return getCooldown();
}

export function getCooldown(now = Date.now()) {
  const until = getMeta(META_COOLDOWN_UNTIL) || '';
  const reason = getMeta(META_COOLDOWN_REASON) || '';
  const untilMs = until ? Date.parse(until) : 0;
  const remainingMs = Number.isFinite(untilMs) ? Math.max(0, untilMs - now) : 0;
  return { active: remainingMs > 0, until: until || null, reason, remainingMs };
}

// --- one-time import of the old JSON database -------------------------------

/**
 * Import the previous data.json into SQLite.
 * Idempotent: INSERT OR IGNORE + UNIQUE(email) means re-running it (for example
 * because an old instance recreated the file) cannot duplicate anything, and the
 * JSON file is archived rather than deleted.
 */
export function migrateFromJson({ jsonPath = LEGACY_JSON, archive = true } = {}) {
  if (!fs.existsSync(jsonPath)) return { migrated: false, imported: 0, archivedTo: null };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    return { migrated: false, imported: 0, error: `could not parse ${jsonPath}: ${err.message}` };
  }

  const leads = Array.isArray(data.leads) ? data.leads : [];
  const sends = Array.isArray(data.sends) ? data.sends : [];
  const daily = data.daily && typeof data.daily === 'object' ? data.daily : {};

  const counts = tx(() => {
    let imported = 0;
    for (const lead of leads) {
      if (lead && lead.email && addLead(lead)) imported++;
    }
    for (const send of sends) {
      if (!send || !send.sent_at) continue;
      db.prepare('INSERT OR IGNORE INTO sends (lead_id, email, resend_id, sent_at) VALUES (?, ?, ?, ?)')
        .run(send.lead_id || null, send.email || '', send.resend_id || null, send.sent_at);
    }
    for (const [day, count] of Object.entries(daily)) {
      db.prepare(`
        INSERT INTO daily (day, count) VALUES (?, ?)
        ON CONFLICT(day) DO UPDATE SET count = MAX(count, excluded.count)
      `).run(day, Number(count) || 0);
    }
    return { imported, sends: sends.length, days: Object.keys(daily).length };
  });

  let archivedTo = null;
  if (archive) {
    archivedTo = `${jsonPath}.migrated`;
    if (fs.existsSync(archivedTo)) archivedTo = `${jsonPath}.migrated.${Date.now()}`;
    try {
      fs.renameSync(jsonPath, archivedTo);
    } catch {
      archivedTo = null; // leave the file alone rather than lose it
    }
  }

  return { migrated: true, ...counts, archivedTo };
}

export function closeDb() {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

// --- boot -------------------------------------------------------------------

const migration = migrateFromJson();
if (migration.migrated && !migration.error) {
  console.log(
    `[db] imported ${migration.imported} lead(s) from the old JSON database into ${path.basename(dbPath)}`
  );
  if (migration.archivedTo) {
    console.log(`[db] archived ${path.basename(LEGACY_JSON)} → ${path.basename(migration.archivedTo)}`);
  }
} else if (migration.error) {
  console.warn(`[db] migration skipped: ${migration.error}`);
}



