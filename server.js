import express from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import {
  getStats,
  getAllLeads,
  addLead as dbAddLead,
  updateLead,
  getPriorityMix,
  getVerificationMix,
  getTodayCount,
  getCooldown,
  setCooldown,
  clearCooldown,
  unsubscribe
} from './db.js';
import {
  sendToLead,
  getPendingLeads,
  DAILY_LIMIT
} from './sender.js';
import { crawlSite } from './crawler.js';
import { ingestLeads, verificationProvider } from './ingest.js';
import {
  delayBounds,
  nextDelayMs,
  streakLimit,
  cooldownMs,
  classifyFailure,
  describePace,
  InvalidStreakGuard
} from './pacing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

/** In-memory discovery jobs (status polled by the UI). Several may run at once. */
const discoverJobs = new Map();

/** Send jobs are slow by design (30–180s between emails), so they run in the
 *  background and the UI polls them. Only one may be active at a time. */
const sendJobs = new Map();
let activeSendJob = null;

const DELAY_BOUNDS = delayBounds();
const STREAK_LIMIT = streakLimit();
const COOLDOWN_MS = cooldownMs();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function companyFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Origin only: https://www.foo.com:8443/path → https://www.foo.com:8443 */
function toSeedOrigin(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin; // keeps non-default ports (needed for local fixtures)
  } catch {
    return null;
  }
}

/**
 * Suggested addresses for people named on the site that were never actually
 * seen on it. They are reported for manual verification only — never imported
 * as leads, because a guessed address that bounces hurts reputation.
 */
function unverifiedGuesses(result) {
  const seen = new Set(result.emails.map((entry) => entry.email));
  return (result.guesses || []).filter((guess) => !seen.has(guess.email));
}

/**
 * Resolve unique site seeds via a licensed search API (SerpAPI or Google CSE).
 * Does not scrape Google HTML — that violates Google's ToS.
 */
async function searchDomains(query, { num = 10 } = {}) {
  const limit = Math.min(Math.max(Number(num) || 10, 1), 20);

  // Test / local override: comma-separated seed URLs (skips live search APIs)
  if (process.env.DISCOVER_MOCK_SEEDS) {
    const mocked = process.env.DISCOVER_MOCK_SEEDS.split(',')
      .map((s) => toSeedOrigin(s.trim()) || s.trim())
      .filter(Boolean);
    const seen = new Set();
    const unique = [];
    for (const seed of mocked) {
      try {
        const host = new URL(seed).hostname.replace(/^www\./, '');
        if (seen.has(host)) continue;
        seen.add(host);
        unique.push(seed);
      } catch {
        /* skip invalid */
      }
    }
    return unique.slice(0, limit);
  }

  const domains = [];

  if (process.env.SERPAPI_KEY) {
    const params = new URLSearchParams({
      engine: 'google',
      q: query,
      api_key: process.env.SERPAPI_KEY,
      num: String(limit)
    });
    const r = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!r.ok) throw new Error(`SerpAPI error: ${r.status}`);
    const data = await r.json();
    for (const item of data.organic_results || []) {
      const seed = toSeedOrigin(item.link);
      if (seed) domains.push(seed);
    }
  } else if (process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX) {
    const params = new URLSearchParams({
      key: process.env.GOOGLE_CSE_API_KEY,
      cx: process.env.GOOGLE_CSE_CX,
      q: query,
      num: String(Math.min(limit, 10)) // CSE max 10 per call
    });
    const r = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    if (!r.ok) throw new Error(`Google CSE error: ${r.status}`);
    const data = await r.json();
    for (const item of data.items || []) {
      const seed = toSeedOrigin(item.link);
      if (seed) domains.push(seed);
    }
  } else {
    throw new Error(
      'No search API configured. Set SERPAPI_KEY or GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX'
    );
  }

  const seen = new Set();
  const unique = [];
  for (const seed of domains) {
    const host = new URL(seed).hostname.replace(/^www\./, '');
    if (seen.has(host)) continue;
    seen.add(host);
    unique.push(seed);
  }
  return unique.slice(0, limit);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (_req, res) => {
  const s = getStats();
  res.json({
    ...s,
    dailyLimit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - s.sentToday),
    priorityMix: getPriorityMix(),
    verificationMix: getVerificationMix(),
    verificationProvider: verificationProvider(),
    cooldown: getCooldown(),
    delays: DELAY_BOUNDS,
    pace: describePace(DELAY_BOUNDS),
    streakLimit: STREAK_LIMIT,
    sending: Boolean(activeSendJob && activeSendJob.status === 'sending')
  });
});

app.get('/api/leads', (_req, res) => {
  res.json(getAllLeads());
});

app.post('/api/leads', (req, res) => {
  const { email, name, company, notes } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const added = dbAddLead({ email, name, company, notes });
  res.json({ added, email });
});

app.post('/api/leads/bulk', (req, res) => {
  const leads = req.body?.leads;
  if (!Array.isArray(leads)) return res.status(400).json({ error: 'leads array required' });
  let added = 0;
  for (const l of leads) {
    if (l.email && dbAddLead(l)) added++;
  }
  res.json({ added, total: leads.length });
});

// Crawl a website for publicly listed business emails (robots.txt respected,
// capped at 10 pages per request — this is a lead finder, not a DDoS tool).
app.post('/api/scan', async (req, res) => {
  const url = (req.body?.url || '').toString().trim();
  if (!url) return res.status(400).json({ error: 'url required' });

  const maxPages = Math.min(Number(req.body?.maxPages) || 8, 10);
  const includeFree = Boolean(req.body?.includeFree);

  try {
    const result = await crawlSite(url, { maxPages, includeFree, delayMs: 1200 });

    // Verification happens here, before anything reaches the database.
    let ingest = { added: 0, duplicates: 0, rejected: 0, byStatus: { unverified: 0, valid: 0, invalid: 0, catchall: 0 } };
    if (req.body?.addToLeads) {
      ingest = await ingestLeads(result.emails, {
        company: companyFromUrl(result.startUrl),
        sourceUrl: result.startUrl
      });
    }

    res.json({
      startUrl: result.startUrl,
      pagesScanned: result.pagesScanned,
      found: result.emails.length,
      emails: result.emails,
      foundPriority: result.priority.length,
      foundLowPriority: result.lowPriority.length,
      lowPriority: result.lowPriority,
      names: result.names,
      convention: result.convention,
      guesses: unverifiedGuesses(result),
      errors: result.errors.length,
      added: ingest.added,
      duplicates: ingest.duplicates,
      rejected: ingest.rejected,
      verification: ingest.byStatus
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function runDiscoverJob(job) {
  const { query, maxSites, maxPages, includeFree, addToLeads } = job;
  try {
    job.status = 'searching';
    job.message = 'Searching for sites…';
    const seeds = await searchDomains(query, { num: maxSites });
    job.seeds = seeds;
    job.status = 'crawling';
    job.message = `Crawling ${seeds.length} site(s)…`;

    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      job.progress = { current: i + 1, total: seeds.length, url: seed };
      job.message = `Crawling ${i + 1}/${seeds.length}: ${seed}`;

      try {
        const result = await crawlSite(seed, {
          maxPages,
          includeFree,
          delayMs: 1200
        });

        const company = companyFromUrl(result.startUrl);
        let ingest = { added: 0, duplicates: 0, rejected: 0, byStatus: { unverified: 0, valid: 0, invalid: 0, catchall: 0 } };
        const leadOutcomes = [];

        if (addToLeads) {
          ingest = await ingestLeads(result.emails, {
            company,
            sourceUrl: result.startUrl,
            onLead: (found, outcome) => leadOutcomes.push({
              email: found.email,
              added: outcome.added,
              rejected: outcome.rejected,
              verification_status: outcome.verification_status
            })
          });
        }

        job.totalFound += result.emails.length;
        job.totalFoundLowPriority += result.lowPriority.length;
        job.totalAdded += ingest.added;
        job.totalRejected += ingest.rejected;
        job.sites.push({
          startUrl: result.startUrl,
          company,
          pagesScanned: result.pagesScanned,
          found: result.emails.length,
          foundLowPriority: result.lowPriority.length,
          emails: result.emails,
          lowPriority: result.lowPriority,
          names: result.names,
          convention: result.convention,
          guesses: unverifiedGuesses(result),
          errors: result.errors.length,
          added: ingest.added,
          duplicates: ingest.duplicates,
          rejected: ingest.rejected,
          verification: ingest.byStatus,
          leadOutcomes
        });
      } catch (err) {
        job.sites.push({
          startUrl: seed,
          company: companyFromUrl(seed),
          error: err.message,
          found: 0,
          added: 0
        });
      }

      await sleep(2000 + Math.random() * 1500);
    }

    job.status = 'done';
    job.message = `Done: ${job.sites.length} site(s), ${job.totalFound} email(s), ${job.totalAdded} added`;
    job.finishedAt = new Date().toISOString();
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.message = err.message;
    job.finishedAt = new Date().toISOString();
  }
}

// Start background discovery (poll GET /api/discover/:jobId for progress).
app.post('/api/discover', (req, res) => {
  const query = (req.body?.query || '').toString().trim();
  if (!query) return res.status(400).json({ error: 'query required' });

  const hasSearch =
    process.env.DISCOVER_MOCK_SEEDS ||
    process.env.SERPAPI_KEY ||
    (process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX);
  if (!hasSearch) {
    return res.status(400).json({
      error: 'No search API configured. Set SERPAPI_KEY or GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX'
    });
  }

  const jobId = randomUUID();
  const job = {
    id: jobId,
    status: 'queued',
    message: 'Queued',
    query,
    maxSites: Math.min(Number(req.body?.maxSites) || 5, 10),
    maxPages: Math.min(Number(req.body?.maxPages) || 8, 10),
    includeFree: Boolean(req.body?.includeFree),
    addToLeads: Boolean(req.body?.addToLeads),
    seeds: [],
    sites: [],
    totalFound: 0,
    totalFoundLowPriority: 0,
    totalAdded: 0,
    totalRejected: 0,
    progress: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null
  };
  discoverJobs.set(jobId, job);

  // Fire-and-forget; client polls for status
  setImmediate(() => {
    runDiscoverJob(job).catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.message = err.message;
      job.finishedAt = new Date().toISOString();
    });
  });

  res.status(202).json({ jobId, status: job.status, query: job.query });
});

app.get('/api/discover/:jobId', (req, res) => {
  const job = discoverJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    jobId: job.id,
    status: job.status,
    message: job.message,
    query: job.query,
    seeds: job.seeds,
    sites: job.sites,
    sitesCrawled: job.sites.length,
    totalFound: job.totalFound,
    totalFoundLowPriority: job.totalFoundLowPriority,
    totalAdded: job.totalAdded,
    totalRejected: job.totalRejected,
    progress: job.progress,
    error: job.error,
    addToLeads: job.addToLeads,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  });
});

const hasNote = (lead) => (lead.notes || '').trim().length > 0;

// Curate a lead: the UI writes the personalization note here before sending.
app.patch('/api/leads/:id', (req, res) => {
  const { notes, name, company } = req.body || {};
  const lead = updateLead(req.params.id, { notes, name, company });
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json({ updated: true, lead });
});

// Sends are slow on purpose (a human-ish 30–180s between emails), so they run as
// a background job the UI polls. A lead with no personalization note is skipped,
// and consecutive invalid-address responses freeze sending entirely.
app.post('/api/send', async (req, res) => {
  const limit = Math.min(Number(req.body?.limit) || 5, 10);
  const force = Boolean(req.body?.force);

  const cooldown = getCooldown();
  if (cooldown.active) {
    return res.status(409).json({
      attempted: 0,
      paused: true,
      cooldown,
      message: `Sending is paused: ${cooldown.reason}. Clear the cool down to continue.`
    });
  }

  if (activeSendJob && activeSendJob.status === 'sending') {
    return res.status(409).json({
      attempted: 0,
      paused: true,
      jobId: activeSendJob.id,
      message: 'A send job is already running — poll it instead of starting a second one'
    });
  }

  const pool = getPendingLeads(100);
  const skippedNoNote = force ? 0 : pool.filter((l) => !hasNote(l)).length;
  const queue = (force ? pool : pool.filter(hasNote)).slice(0, limit);

  if (queue.length === 0) {
    return res.json({
      attempted: 0,
      skippedNoNote,
      queuedByPriority: getPriorityMix(),
      message: skippedNoNote
        ? `${skippedNoNote} pending lead(s) have no personalization note — write one first`
        : 'No pending leads',
      results: []
    });
  }

  const job = {
    id: randomUUID(),
    status: 'queued',
    message: `Queued ${queue.length} email(s), ${describePace(DELAY_BOUNDS)}`,
    queue,
    results: [],
    progress: null,
    streak: 0,
    nextDelayMs: 0,
    cooldown: null,
    skippedNoNote,
    queuedByPriority: getPriorityMix(),
    bounds: DELAY_BOUNDS,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null
  };
  sendJobs.set(job.id, job);
  activeSendJob = job;
  setImmediate(() => runSendJob(job));

  res.status(202).json({
    jobId: job.id,
    status: job.status,
    queued: queue.length,
    skippedNoNote,
    delaySeconds: [Math.round(DELAY_BOUNDS.min / 1000), Math.round(DELAY_BOUNDS.max / 1000)],
    message: job.message
  });
});

/**
 * The Human Delay Jitter Engine:
 *   - waits a random 30–180s between two emails (never a fixed interval)
 *   - counts consecutive invalid-address responses and, on the limit, stores a
 *     global cool down so nothing else goes out either
 */
async function runSendJob(job) {
  const guard = new InvalidStreakGuard(STREAK_LIMIT);
  job.status = 'sending';

  try {
    for (let i = 0; i < job.queue.length; i++) {
      const lead = job.queue[i];

      const cooldown = getCooldown();
      if (cooldown.active) {
        job.status = 'paused';
        job.cooldown = cooldown;
        job.message = `Paused: ${cooldown.reason}`;
        break;
      }
      if (getTodayCount() >= DAILY_LIMIT) {
        job.status = 'done';
        job.message = `Daily limit of ${DAILY_LIMIT} reached`;
        break;
      }

      job.progress = { current: i + 1, total: job.queue.length, email: lead.email };
      job.message = `Sending ${i + 1}/${job.queue.length}: ${lead.email}`;

      const result = await sendToLead(lead);
      const failure = result.success ? 'ok' : (result.failure || classifyFailure(result.error));
      const tripped = guard.record(failure);
      job.streak = guard.streak;
      job.results.push({
        email: lead.email,
        success: result.success,
        failure,
        error: result.error || null,
        streak: guard.streak
      });

      if (tripped) {
        const until = new Date(Date.now() + COOLDOWN_MS).toISOString();
        job.cooldown = setCooldown(until, `${guard.streak} consecutive invalid email responses`);
        job.status = 'cooldown';
        job.message = `Cool down engaged after ${guard.streak} consecutive invalid addresses — sending paused until ${until}`;
        break;
      }

      if (i < job.queue.length - 1) {
        job.nextDelayMs = nextDelayMs(job.bounds);
        job.message = `Waiting ${Math.round(job.nextDelayMs / 1000)}s before the next email`;
        await sleep(job.nextDelayMs);
        job.nextDelayMs = 0;
      }
    }

    if (job.status === 'sending') {
      const sent = job.results.filter((r) => r.success).length;
      job.status = 'done';
      job.message = `Done: ${sent}/${job.results.length} sent`;
    }
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.message = err.message;
  } finally {
    job.finishedAt = new Date().toISOString();
    job.sentToday = getTodayCount();
    job.progress = null;
    activeSendJob = null;
  }
}

app.get('/api/send/:jobId', (req, res) => {
  const job = sendJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    jobId: job.id,
    status: job.status,
    message: job.message,
    progress: job.progress,
    results: job.results,
    remaining: Math.max(0, job.queue.length - job.results.length),
    streak: job.streak,
    streakLimit: STREAK_LIMIT,
    nextDelayMs: job.nextDelayMs,
    cooldown: job.cooldown || getCooldown(),
    skippedNoNote: job.skippedNoNote,
    queuedByPriority: job.queuedByPriority,
    sentToday: job.sentToday === undefined ? getTodayCount() : job.sentToday,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  });
});

// Release the cool down — after fixing the list, or when the pause was a mistake.
app.post('/api/cooldown/clear', (_req, res) => {
  res.json({ cleared: true, cooldown: clearCooldown() });
});

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/unsubscribe', (req, res) => {
  const email = (req.query.email || '').toString().toLowerCase().trim();
  if (!email) return res.status(400).send('Missing email');
  unsubscribe(email);
  res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
    <h2>Unsubscribed</h2><p>${escapeHtml(email)} has been removed.</p></body></html>`);
});

app.post('/unsubscribe', (req, res) => {
  const email = (req.body?.email || req.query?.email || '').toString().toLowerCase().trim();
  if (email) unsubscribe(email);
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`\n Cold Outreach running → http://localhost:${PORT}`);
  console.log(` Daily limit: ${DAILY_LIMIT}`);
  console.log(` From: ${process.env.FROM_EMAIL || 'NOT SET – edit .env'}`);
  if (!process.env.MAILING_ADDRESS) {
    console.log(' Warning: MAILING_ADDRESS is not set. US CAN-SPAM law requires a');
    console.log(' physical postal address in every commercial email you send.');
  }
  console.log('');
});
