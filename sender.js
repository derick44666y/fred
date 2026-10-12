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

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_EMAIL || 'You <you@yourdomain.com>';
const REPLY_TO = process.env.REPLY_TO || 'you@yourdomain.com';
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 50);
const UNSUB_BASE = process.env.UNSUBSCRIBE_BASE_URL || 'http://localhost:3000';

export { DAILY_LIMIT };

export async function sendToLead(lead) {
  const count = getTodayCount();
  if (count >= DAILY_LIMIT) {
    return { success: false, error: `Daily limit of ${DAILY_LIMIT} reached` };
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
      return { success: false, error: error.message || JSON.stringify(error) };
    }

    markSent(lead.id, data?.id);
    incrementToday();
    return { success: true, resendId: data?.id };
  } catch (err) {
    return { success: false, error: err.message || 'Unknown error' };
  }
}

export function getPendingLeads(limit = 5) {
  return getPending(limit);
}

export function addLead(email, name, company, notes) {
  return dbAddLead({ email, name, company, notes });
}
