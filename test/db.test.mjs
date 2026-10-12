import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(ROOT, 'test', 'tmp', 'db');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const DB = path.join(TMP, 'leads.sqlite');
const LEGACY = path.join(TMP, 'data.json');

// Point the store at a scratch database *before* importing it.
process.env.DB_PATH = DB;
process.env.LEGACY_JSON_PATH = LEGACY;

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
}

// Helper scripts the concurrency checks spawn. The import is an absolute
// file: URL so it cannot drift if the scratch directory moves.
const DB_URL = new URL('../db.js', import.meta.url).href;

const WRITER = `
import * as db from '${DB_URL}';
const tag = process.env.TAG || 'w';
for (let i = 0; i < Number(process.env.N || 50); i++) {
  db.addLead({ email: tag + '-' + i + '@conc.test', priority: 'normal', score: 50 });
}
for (let i = 0; i < Number(process.env.INC || 25); i++) db.incrementToday();
console.log(JSON.stringify({ tag, count: db.countLeads(), today: db.getTodayCount() }));
`;
const PROBE = `
import * as db from '${DB_URL}';
console.log(JSON.stringify({ count: db.countLeads(), cooldown: db.getCooldown(), mix: db.getVerificationMix() }));
`;
const FOREVER = `
import * as db from '${DB_URL}';
let i = 0;
for (;;) db.addLead({ email: 'forever-' + (i++) + '@conc.test' });
`;

fs.writeFileSync(path.join(TMP, 'writer.mjs'), WRITER);
fs.writeFileSync(path.join(TMP, 'probe.mjs'), PROBE);
fs.writeFileSync(path.join(TMP, 'forever.mjs'), FOREVER);

function runHelper(file, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { cwd: TMP, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// --- legacy JSON migration ---------------------------------------------------
const legacyLeads = [
  {
    id: 'old1', email: 'Old@Bluebird.test', name: 'Old Lead', company: 'bluebird',
    notes: 'saw your site was slow', source_url: 'https://bluebird.test/contact',
    status: 'pending', priority: 'high', kind: 'person', score: 95,
    reason: 'name match "John Smith"', sent_at: null, resend_id: null,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'old2', email: 'info@bluebird.test', name: '', company: 'bluebird',
    notes: '', source_url: 'https://bluebird.test/', status: 'sent',
    priority: 'low', kind: 'role', score: 10, reason: 'shared info@ mailbox',
    sent_at: '2026-01-02T10:00:00.000Z', resend_id: 're_migrated',
    created_at: '2026-01-01T00:00:00.000Z'
  }
];
fs.writeFileSync(LEGACY, JSON.stringify({
  leads: legacyLeads,
  sends: [{ lead_id: 'old2', email: 'info@bluebird.test', resend_id: 're_migrated', sent_at: '2026-01-02T10:00:00.000Z' }],
  daily: { '2026-01-02': 3 }
}));

const db = await import('../db.js');
const { DatabaseSync } = await import('node:sqlite');
const byEmail = (email) => db.getAllLeads().find((l) => l.email === email);

check('legacy data.json is imported on first open', db.countLeads() === 2, String(db.countLeads()));
const migrated = byEmail('old@bluebird.test');
check('migrated lead keeps priority, score and status',
  Boolean(migrated) && migrated.priority === 'high' && migrated.score === 95 && migrated.status === 'pending',
  JSON.stringify(migrated));
check('migrated lead is marked unverified by default',
  Boolean(migrated) && migrated.verification_status === 'unverified', migrated && migrated.verification_status);
check('migrated sent lead keeps its timestamp',
  byEmail('info@bluebird.test')?.sent_at === '2026-01-02T10:00:00.000Z');
check('migrated daily counter is preserved', db.getDayCount('2026-01-02') === 3, String(db.getDayCount('2026-01-02')));
check('the JSON file is archived, never deleted',
  !fs.existsSync(LEGACY) && fs.existsSync(`${LEGACY}.migrated`));

fs.writeFileSync(LEGACY, JSON.stringify({ leads: legacyLeads, sends: [], daily: { '2026-01-02': 3 } }));
const again = db.migrateFromJson();
check('re-importing is idempotent (an old instance may recreate data.json)',
  again.migrated === true && again.imported === 0 && db.countLeads() === 2,
  JSON.stringify({ ...again, count: db.countLeads() }));
check('daily counter is merged with MAX, never doubled', db.getDayCount('2026-01-02') === 3);

// --- dedupe / verification_status / curation ---------------------------------
check('new lead is stored',
  db.addLead({ email: 'Owner@Shop.test', priority: 'high', verification_status: 'valid' }) === true);
check('dedupe is case-insensitive and atomic (no read-modify-write race)',
  db.addLead({ email: 'owner@shop.test' }) === false && db.countLeads() === 3, String(db.countLeads()));
check('verification_status is stored', byEmail('owner@shop.test').verification_status === 'valid');

db.addLead({ email: 'weird@shop.test', verification_status: 'nonsense' });
check('unknown verification status falls back to unverified',
  byEmail('weird@shop.test').verification_status === 'unverified');

db.addLead({ email: 'bad@shop.test', priority: 'high', verification_status: 'invalid' });
check('known-invalid addresses never enter the send queue',
  !db.getPending(50).some((l) => l.email === 'bad@shop.test'),
  JSON.stringify(db.getPending(50).map((l) => l.email)));
check('verification mix is reported',
  JSON.stringify(db.getVerificationMix()) === '{"unverified":3,"valid":1,"invalid":1,"catchall":0}',
  JSON.stringify(db.getVerificationMix()));

db.addLead({ email: 'catch@shop.test', verification_status: 'catchall' });
db.addLead({ email: 'low@shop.test', priority: 'low' });
const queued = db.getPending(50).map((l) => l.priority);
check('send queue is ordered decision makers first',
  queued[0] === 'high' && queued[queued.length - 1] === 'low', JSON.stringify(queued));

const updated = db.updateLead(byEmail('owner@shop.test').id, { notes: 'mobile site is slow' });
check('updateLead persists the personalization note',
  updated.notes === 'mobile site is slow' && Boolean(updated.updated_at), JSON.stringify(updated));

const target = byEmail('catch@shop.test');
check('markSent moves the lead and records the send',
  db.markSent(target.id, 're_test') === true &&
  db.getLeadById(target.id).status === 'sent' &&
  db.getLeadById(target.id).resend_id === 're_test');
check('unsubscribe flips the status',
  db.unsubscribe('LOW@shop.test') === true && byEmail('low@shop.test').status === 'unsubscribed');

const raw = new DatabaseSync(DB);
const sendRows = raw.prepare('SELECT lead_id, email, resend_id FROM sends').all();
check('send history holds both the migrated row and the new one',
  sendRows.length === 2 &&
  sendRows.some((r) => r.resend_id === 're_migrated') &&
  sendRows.some((r) => r.resend_id === 're_test'),
  JSON.stringify(sendRows));
check('WAL journaling is on',
  raw.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase() === 'wal');

// --- cool down is a persisted, global switch ---------------------------------
const until = new Date(Date.now() + 90 * 60 * 1000).toISOString();
const set = db.setCooldown(until, '3 consecutive invalid emails');
check('cool down can be engaged', set.active === true && set.reason.includes('3 consecutive'), JSON.stringify(set));
check('cool down expires by clock', db.getCooldown(Date.parse(until) + 1000).active === false);

const probe = await runHelper('probe.mjs');
const probed = JSON.parse(probe.out);
check('cool down survives a process restart',
  probed.cooldown.active === true && probed.cooldown.until === until, probe.out + probe.err);
check('clearCooldown releases sending', db.clearCooldown().active === false);

// --- concurrent jobs: no lost updates, atomic counters -----------------------
const before = db.countLeads();
const beforeToday = db.getTodayCount();

const writers = await Promise.all([
  runHelper('writer.mjs', { TAG: 'A', N: '60', INC: '25' }),
  runHelper('writer.mjs', { TAG: 'B', N: '60', INC: '25' }),
  runHelper('writer.mjs', { TAG: 'C', N: '60', INC: '25' })
]);

check('three parallel writers all exit cleanly',
  writers.every((w) => w.code === 0 && w.err === ''),
  JSON.stringify(writers.map((w) => ({ code: w.code, err: w.err, out: w.out }))));
check('no lead is lost when three jobs write at once',
  db.countLeads() === before + 180, `${before} + 180 != ${db.countLeads()}`);
check('daily counter is atomic under concurrency',
  db.getTodayCount() === beforeToday + 75, `${beforeToday} + 75 != ${db.getTodayCount()}`);
const all = db.getAllLeads();
check('email uniqueness held under concurrent inserts',
  new Set(all.map((l) => l.email)).size === all.length, `${all.length} rows`);
check('the database is still healthy after concurrent writes',
  raw.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');

// --- a killed writer must not corrupt or truncate the store ------------------
const forever = spawn(process.execPath, ['forever.mjs'], { cwd: TMP, env: { ...process.env } });
await new Promise((r) => setTimeout(r, 600));
forever.kill('SIGKILL');
const killed = await new Promise((r) => forever.on('close', (code) => r(code)));

const afterKill = new DatabaseSync(DB);
check('a hard-killed writer is really gone', killed !== 0, String(killed));
check('the store still opens after a kill',
  afterKill.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
check('leads committed before the kill are intact', db.countLeads() > before + 180, String(db.countLeads()));
check('the store is still writable after a kill',
  db.addLead({ email: 'after-kill@conc.test' }) === true);

afterKill.close();
raw.close();
db.closeDb();

if (failures === 0) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

