import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(ROOT, 'test', 'tmp', 'scan-cli');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// Every run gets its own SQLite file — the real database is never touched.
const DB = path.join(TMP, 'scan-cli.sqlite');
const MOCK_DB = path.join(TMP, 'scan-cli-mock.sqlite');
const CSV_PATH = path.join(TMP, 'out.csv');
const SEEDS_PATH = path.join(TMP, 'seeds.txt');
process.env.DB_PATH = DB;
process.env.LEGACY_JSON_PATH = path.join(TMP, 'no-legacy.json');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
}

const PAGES = {
  '/': `<html><body><a href="/contact">Contact</a><p>web@bluebird-plumbing.test</p></body></html>`,
  '/contact': `<html><body><p>info@bluebird-plumbing.test</p><p>Deliveries: bounce@bluebird-plumbing.test</p></body></html>`,
  '/robots.txt': 'User-agent: *\n'
};
const fixture = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const body = PAGES[path];
  if (body === undefined) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': path === '/robots.txt' ? 'text/plain' : 'text/html' });
  res.end(body);
}).listen(8933, '127.0.0.1');

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scan.js', ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

const query = (file, sql, ...params) => {
  const conn = new DatabaseSync(file);
  const rows = conn.prepare(sql).all(...params);
  conn.close();
  return rows;
};

try {
  // Direct URL + CSV export
  let r = await runCli(['http://127.0.0.1:8933/', '--pages', '5', '--csv', CSV_PATH]);
  check('CLI exits 0', r.code === 0, r.out);
  check('CLI finds every listed address',
    r.out.includes('info@bluebird-plumbing.test') &&
    r.out.includes('web@bluebird-plumbing.test') &&
    r.out.includes('bounce@bluebird-plumbing.test'), r.out);
  check('CLI tags addresses with their priority',
    /\[high\]|\[normal\]|\[low\]/.test(r.out), r.out);
  const csv = fs.existsSync(CSV_PATH) ? fs.readFileSync(CSV_PATH, 'utf8') : '';
  check('CSV written with header + rows',
    csv.startsWith('email,priority,kind,score,found_on,source_site') &&
    csv.split('\n').filter(Boolean).length === 4, csv);

  // Seed-file mode + import into the SQLite database
  fs.writeFileSync(SEEDS_PATH, '# comment line\nhttp://127.0.0.1:8933/\n');
  r = await runCli([SEEDS_PATH, '--from-file', '--add']);
  check('CLI --from-file works and imports', r.code === 0 && r.out.includes('Added 3 new leads'), r.out);
  check('CLI reports the verification mix',
    /verification: .*unverified/.test(r.out), r.out);

  const leads = query(DB, 'SELECT email, source_url, priority, verification_status, notes FROM leads');
  check('leads are in SQLite with their source URL',
    leads.length === 3 && leads.every((l) => l.source_url.includes('8933')), JSON.stringify(leads));
  check('leads keep priority and a verification status',
    leads.every((l) => l.priority && l.verification_status === 'unverified'), JSON.stringify(leads));
  check('notes start empty (personalize before sending)',
    leads.every((l) => l.notes === ''), JSON.stringify(leads));

  // Second import dedupes
  r = await runCli(['http://127.0.0.1:8933/', '--add']);
  check('CLI --add dedupes', r.out.includes('Added 0 new leads'), r.out);

  // Verification runs *before* the database: with the mock provider the
  // deliberately-bad address must never be stored.
  process.env.DB_PATH = MOCK_DB;
  r = await runCli(['http://127.0.0.1:8933/', '--add'], { VERIFY_PROVIDER: 'mock' });
  check('verified import reports the rejected address',
    r.out.includes('rejected (invalid): bounce@bluebird-plumbing.test'), r.out);
  check('mock verification counts the good addresses',
    /verification: 2 valid/.test(r.out), r.out);

  const mockLeads = query(MOCK_DB, 'SELECT email, verification_status FROM leads');
  check('the invalid address never reached the database',
    !mockLeads.some((l) => l.email.includes('bounce')), JSON.stringify(mockLeads));
  check('stored leads carry their verification status',
    mockLeads.length === 2 && mockLeads.every((l) => l.verification_status === 'valid'),
    JSON.stringify(mockLeads));
  check('verdicts are cached so an address is never paid for twice',
    query(MOCK_DB, 'SELECT email FROM verifications').length === 3,
    JSON.stringify(query(MOCK_DB, 'SELECT email FROM verifications')));

  // Usage message without args
  r = await runCli([]);
  check('CLI prints usage', r.code === 1 && r.out.includes('Usage:'), r.out);
} catch (err) {
  check('test run without exceptions', false, err.message);
} finally {
  fixture.close();
  for (const f of [DB, MOCK_DB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.rmSync(f + suffix);
    }
  }
  for (const f of [CSV_PATH, SEEDS_PATH]) if (fs.existsSync(f)) fs.rmSync(f);
}

process.exit(failures === 0 ? 0 : 1);
