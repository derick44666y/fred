import { Resend } from 'resend';
import 'dotenv/config';
import {
  getTodayCount,
  incrementToday,
  getPending,
  markSent,
  addLead as dbAddLead
} from './db.js';
import { buildEmail } from './templates.js';
import { classifyFailure } from './pacing.js';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_EMAIL || 'You <you@yourdomain.com>';
const REPLY_TO = process.env.REPLY_TO || 'you@yourdomain.com';
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 50);
const UNSUB_BASE = process.env.UNSUBSCRIBE_BASE_URL || 'http://localhost:3000';

export { DAILY_LIMIT };

export async function sendToLead(lead) {
  const count = getTodayCount();
  if (count >= DAILY_LIMIT) {
    return { success: false, error: `Daily limit of ${DAILY_LIMIT} reached`, failure: 'daily_limit' };
  }

  // Test / dry-run hook: exercise pacing and the cool down without touching the
  // provider. Never set this in normal use.
  const simulate = String(process.env.SEND_SIMULATE || '').toLowerCase();
  if (simulate === 'invalid') {
    return { success: false, error: 'Invalid email address (simulated)', failure: 'invalid_email', simulated: true };
  }
  if (simulate === 'ok') {
    const id = `sim_${Date.now().toString(36)}`;
    markSent(lead.id, id);
    incrementToday();
    return { success: true, resendId: id, simulated: true };
  }

  const unsubscribeUrl = `${UNSUB_BASE}/unsubscribe?email=${encodeURIComponent(lead.email)}`;
  const { subject, html, text } = buildEmail({
    name: lead.name,
    company: lead.company,
    notes: lead.notes,
    email: lead.email,
    unsubscribeUrl
  });

  try {
    const { data, error } = await resend.emails.send({
      from: FROM,
      to: [lead.email],
      replyTo: REPLY_TO,
      subject,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    });

    if (error) {
      const message = error.message || JSON.stringify(error);
      return { success: false, error: message, failure: classifyFailure(message) };
    }

    markSent(lead.id, data?.id);
    incrementToday();
    return { success: true, resendId: data?.id };
  } catch (err) {
    const message = err.message || 'Unknown error';
    return { success: false, error: message, failure: classifyFailure(message) };
  }
}

export function getPendingLeads(limit = 5) {
  return getPending(limit);
}

export function addLead(email, name, company, notes) {
  return dbAddLead({ email, name, company, notes });
}
