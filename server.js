import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import {
  getStats,
  getAllLeads,
  addLead as dbAddLead,
  unsubscribe
} from './db.js';
import {
  sendToLead,
  getPendingLeads,
  DAILY_LIMIT
} from './sender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (_req, res) => {
  const s = getStats();
  res.json({
    ...s,
    dailyLimit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - s.sentToday)
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

app.post('/api/send', async (req, res) => {
  const limit = Math.min(Number(req.body?.limit) || 5, 10);
  const pending = getPendingLeads(limit);

  if (pending.length === 0) {
    return res.json({ attempted: 0, message: 'No pending leads', results: [] });
  }

  const results = [];
  for (const lead of pending) {
    const result = await sendToLead(lead);
    results.push({ email: lead.email, ...result });
    // human delay
    await new Promise(r => setTimeout(r, 1800 + Math.random() * 1800));
  }

  const s = getStats();
  res.json({ attempted: pending.length, results, sentToday: s.sentToday });
});

app.get('/unsubscribe', (req, res) => {
  const email = (req.query.email || '').toString().toLowerCase().trim();
  if (!email) return res.status(400).send('Missing email');
  unsubscribe(email);
  res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
    <h2>Unsubscribed</h2><p>${email} has been removed.</p></body></html>`);
});

app.post('/unsubscribe', (req, res) => {
  const email = (req.body?.email || req.query?.email || '').toString().toLowerCase().trim();
  if (email) unsubscribe(email);
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`\n Cold Outreach running → http://localhost:${PORT}`);
  console.log(` Daily limit: ${DAILY_LIMIT}`);
  console.log(` From: ${process.env.FROM_EMAIL || 'NOT SET – edit .env'}\n`);
});
