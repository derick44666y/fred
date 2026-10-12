import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(ROOT, 'test', 'tmp', 'server');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// A scratch SQLite database per run. The real database is never touched, and the
// old "rename data.json away" dance is gone.
const DB_PATH = path.join(TMP, 'server.sqlite');
process.env.DB_PATH = DB_PATH;
process.env.LEGACY_JSON_PATH = path.join(TMP, 'no-legacy.json');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
}

// Fixture site (same shape as crawler test)
const PAGES = {
  '/': `<html><body><a href="/contact">Contact</a><p>web@bluebird-plumbing.test</p></body></html>`,
  '/contact': `<html><body><p>info@bluebird-plumbing.test</p></body></html>`,
  '/robots.txt': 'User-agent: *\n'
};
const fixture = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const body = PAGES[path];
  if (body === undefined) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': path === '/robots.txt' ? 'text/plain' : 'text/html' });
  res.end(body);
}).listen(8932, '127.0.0.1');

// Boot a real app instance with dummy creds. Delays are squeezed to milliseconds
// and the "invalid email" verdict is simulated, so the pacing / cool-down path
// can be tested without waiting minutes or calling the provider.
function bootApp(port, extra = {}) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RESEND_API_KEY: 're_dummy_for_boot_test',
      FROM_EMAIL: 'Test <test@sender.test>',
      MAILING_ADDRESS: 'Test Dev, 1 Test St, Testville, TS 12345',
      PORT: String(port),
      DAILY_LIMIT: '50',
      SEND_DELAY_MIN_MS: '10',
      SEND_DELAY_MAX_MS: '25',
      // Bypass SerpAPI in CI/local tests — crawl the fixture site instead
      DISCOVER_MOCK_SEEDS: 'http://127.0.0.1:8932/',
      SERPAPI_KEY: '',
      GOOGLE_CSE_API_KEY: '',
      GOOGLE_CSE_CX: '',
      ...extra
    }
  });
}

const app = bootApp(3456, { INVALID_STREAK_LIMIT: '2', SEND_SIMULATE: 'invalid' });
let appSim = null;

/** Kill a child and wait for it to actually exit (Windows won't let go of the
 *  SQLite file while another process still has it open). */
function waitExit(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.on('close', () => resolve());
    proc.kill();
  });
}

let bootLog = '';
app.stdout.on('data', (d) => { bootLog += d; });
app.stderr.on('data', (d) => { bootLog += d; });

let earlyExit = null;
app.on('close', (code) => { earlyExit = code; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until the app is listening (max ~10s), aborting early if it crashes
let ready = false;
for (let i = 0; i < 40; i++) {
  if (earlyExit !== null) break;
  try {
    const r = await fetch('http://127.0.0.1:3456/api/stats');
    if (r.ok) { ready = true; break; }
  } catch { /* not up yet */ }
  await sleep(250);
}
if (!ready) {
  console.log(`FAIL app did not boot (exit=${earlyExit})\nboot log:\n${bootLog}`);
  app.kill();
  fixture.close();
  if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
  if (dbExisted) fs.renameSync(DB_BACKUP, DB_PATH);
  process.exit(1);
}

try {
  // UI serves
  const home = await fetch('http://127.0.0.1:3456/');
  const homeHtml = await home.text();
  check(
    'UI serves',
    home.ok && homeHtml.includes('Discover Niche') && homeHtml.includes('Scan Site')
  );

  // Stats endpoint
  const stats = await fetch('http://127.0.0.1:3456/api/stats').then((r) => r.json());
  check('stats endpoint', typeof stats.sentToday === 'number' && stats.dailyLimit === 50);

  // Scan API: crawl fixture and import leads
  const scan = await fetch('http://127.0.0.1:3456/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:8932/', addToLeads: true })
  }).then((r) => r.json());
  check('scan finds emails', scan.found === 2, JSON.stringify(scan));
  check('scan adds leads', scan.added === 2, JSON.stringify(scan));

  // Leads carry source_url
  const leads = await fetch('http://127.0.0.1:3456/api/leads').then((r) => r.json());
  check('leads have source_url',
    leads.length === 2 && leads.every((l) => l.source_url && l.source_url.includes('127.0.0.1:8932')),
    JSON.stringify(leads));

  // Extraction logic: named people are high priority, role mailboxes are not
  check('scan splits out the low priority folder',
    scan.foundLowPriority === 1 && scan.foundPriority === 1 &&
    scan.lowPriority[0].email === 'info@bluebird-plumbing.test',
    JSON.stringify({ foundPriority: scan.foundPriority, foundLowPriority: scan.foundLowPriority, lowPriority: scan.lowPriority }));
  check('leads carry priority + reason',
    leads.find((l) => l.email === 'info@bluebird-plumbing.test')?.priority === 'low' &&
    leads.every((l) => typeof l.reason === 'string'),
    JSON.stringify(leads));
  check('stats expose the priority mix',
    stats.priorityMix && typeof stats.priorityMix.low === 'number',
    JSON.stringify(stats.priorityMix));

  // The send queue puts decision makers ahead of role mailboxes
  const { getPending } = await import('../db.js');
  const queued = getPending(10).map((l) => l.priority);
  check('send queue orders decision makers first',
    queued.length === 2 && queued[queued.length - 1] === 'low',
    JSON.stringify(queued));

  // Duplicate protection: rescanning adds nothing
  const rescan = await fetch('http://127.0.0.1:3456/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:8932/', addToLeads: true })
  }).then((r) => r.json());
  check('rescan dedupes', rescan.added === 0, JSON.stringify(rescan));

  // Background discover → crawl → company + source_url on leads
  const discoverStart = await fetch('http://127.0.0.1:3456/api/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'fixture niche',
      maxSites: 1,
      maxPages: 4,
      addToLeads: true
    })
  });
  const discoverQueued = await discoverStart.json();
  check(
    'discover queues job',
    discoverStart.status === 202 && Boolean(discoverQueued.jobId),
    JSON.stringify(discoverQueued)
  );

  let discoverJob = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    discoverJob = await fetch(
      `http://127.0.0.1:3456/api/discover/${discoverQueued.jobId}`
    ).then((r) => r.json());
    if (discoverJob.status === 'done' || discoverJob.status === 'error') break;
  }
  check(
    'discover job completes',
    discoverJob && discoverJob.status === 'done' && discoverJob.sitesCrawled >= 1,
    JSON.stringify(discoverJob)
  );
  check(
    'discover finds emails',
    discoverJob && discoverJob.totalFound >= 2,
    JSON.stringify(discoverJob)
  );

  const leadsAfterDiscover = await fetch('http://127.0.0.1:3456/api/leads').then((r) =>
    r.json()
  );
  check(
    'discover leads have company + source_url',
    leadsAfterDiscover.length >= 2 &&
      leadsAfterDiscover.every((l) => l.company && l.source_url),
    JSON.stringify(leadsAfterDiscover)
  );

  // Curate gate: a lead with no personalization note is never emailed
  const blockedSend = await fetch('http://127.0.0.1:3456/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 5 })
  }).then((r) => r.json());
  check(
    'send skips leads with no note',
    blockedSend.attempted === 0 && blockedSend.skippedNoNote === 2,
    JSON.stringify(blockedSend)
  );

  // PATCH /api/leads/:id persists the note written in the table
  const targetId = leadsAfterDiscover[0].id;
  const patched = await fetch(`http://127.0.0.1:3456/api/leads/${targetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'Saw your site was slow on mobile' })
  }).then((r) => r.json());
  const leadsAfterPatch = await fetch('http://127.0.0.1:3456/api/leads').then((r) => r.json());
  const savedNote = leadsAfterPatch.find((l) => l.id === targetId)?.notes;
  check(
    'PATCH saves lead note',
    patched.updated === true && savedNote === 'Saw your site was slow on mobile',
    JSON.stringify(leadsAfterPatch)
  );

  const missingPatch = await fetch('http://127.0.0.1:3456/api/leads/nope', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'x' })
  });
  check('PATCH unknown lead returns 404', missingPatch.status === 404);

  // --- Human delay jitter engine + automatic cool down -------------------------
  // Both fixture leads need a note before anything may be sent.
  const secondLead = leadsAfterPatch.find((l) => !l.notes);
  await fetch(`http://127.0.0.1:3456/api/leads/${secondLead.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'your booking form is broken on mobile' })
  });

  const started = await fetch('http://127.0.0.1:3456/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 5 })
  });
  const job = await started.json();
  check('send returns a background job (a 30–180s delay cannot hold an HTTP request open)',
    started.status === 202 && Boolean(job.jobId) && job.queued === 2 && Array.isArray(job.delaySeconds),
    JSON.stringify(job));

  let sendJob = null;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    sendJob = await fetch(`http://127.0.0.1:3456/api/send/${job.jobId}`).then((r) => r.json());
    if (['done', 'error', 'cooldown', 'paused'].includes(sendJob.status)) break;
  }
  check('consecutive invalid responses engage the cool down',
    sendJob.status === 'cooldown' && sendJob.results.length === 2 &&
    sendJob.results.every((r) => r.failure === 'invalid_email'),
    JSON.stringify(sendJob));
  check('the cool down is global, persisted and explained',
    sendJob.cooldown.active === true && /consecutive invalid/i.test(sendJob.cooldown.reason),
    JSON.stringify(sendJob.cooldown));

  const blockedResponse = await fetch('http://127.0.0.1:3456/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 5 })
  });
  const blockedBody = await blockedResponse.json();
  check('sending is refused while the cool down is active',
    blockedResponse.status === 409 && blockedBody.paused === true, JSON.stringify(blockedBody));

  const cleared = await fetch('http://127.0.0.1:3456/api/cooldown/clear', { method: 'POST' })
    .then((r) => r.json());
  check('clearing the cool down releases sending', cleared.cooldown.active === false);

  const statsAfter = await fetch('http://127.0.0.1:3456/api/stats').then((r) => r.json());
  check('stats expose the pace, verification provider and cool down',
    /s between emails/.test(statsAfter.pace) && statsAfter.verificationProvider === 'none' &&
    statsAfter.delays.min === 10 && statsAfter.delays.max === 25 && statsAfter.cooldown.active === false,
    JSON.stringify({ pace: statsAfter.pace, delays: statsAfter.delays, provider: statsAfter.verificationProvider }));
  check('the cool down did not touch the daily counter',
    statsAfter.sentToday === 0, String(statsAfter.sentToday));

  // A second, independent instance working against the same SQLite file.
  appSim = bootApp(3457, { SEND_SIMULATE: 'ok' });
  let simReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3457/api/stats');
      if (r.ok) { simReady = true; break; }
    } catch { /* still booting */ }
    await sleep(250);
  }
  check('a second instance boots against the same SQLite database', simReady);

  const simStart = await fetch('http://127.0.0.1:3457/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 5 })
  });
  const simJob = await simStart.json();
  let simDone = null;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    simDone = await fetch(`http://127.0.0.1:3457/api/send/${simJob.jobId}`).then((r) => r.json());
    if (['done', 'error', 'cooldown', 'paused'].includes(simDone.status)) break;
  }
  check('a healthy batch completes and sends every queued email',
    simDone.status === 'done' && simDone.results.length === 2 && simDone.results.every((r) => r.success),
    JSON.stringify(simDone));
  check('the daily counter counted both sends',
    simDone.sentToday === 2, String(simDone.sentToday));

  const sentLeads = await fetch('http://127.0.0.1:3456/api/leads').then((r) => r.json());
  check('leads were marked sent in the shared database',
    sentLeads.filter((l) => l.status === 'sent').length === 2 &&
    sentLeads.every((l) => l.resend_id && l.resend_id.startsWith('sim_')),
    JSON.stringify(sentLeads.map((l) => [l.email, l.status, l.resend_id])));

  const badDiscover = await fetch('http://127.0.0.1:3456/api/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '' })
  });
  check('empty discover query returns 400', badDiscover.status === 400);

  // XSS fix on unsubscribe page
  const unsub = await fetch('http://127.0.0.1:3456/unsubscribe?email=' +
    encodeURIComponent('<script>alert(1)</script>'));
  const unsubBody = await unsub.text();
  check('unsubscribe escapes HTML',
    !unsubBody.includes('<script>') && unsubBody.includes('&lt;script&gt;'), unsubBody);

  // Bad URL rejected
  const bad = await fetch('http://127.0.0.1:3456/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'not a url' })
  });
  check('invalid url returns 400', bad.status === 400);

  // Mailing address warning absent when set
  check('no mailing warning when configured', !bootLog.includes('MAILING_ADDRESS is not set'));
} catch (err) {
  check('test run without exceptions', false, err.message);
  console.log('boot log:\n' + bootLog);
} finally {
  fixture.close();
  await waitExit(app);
  if (appSim) await waitExit(appSim);
  await sleep(150);
  // Discard the scratch database (WAL leaves two sidecar files behind)
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) {
      try { fs.rmSync(file); } catch { /* still held on Windows — harmless */ }
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
