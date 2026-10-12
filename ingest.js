// ingest.js — the pipeline between the crawler and the database.
//
// One place decides what happens to an address that was just discovered:
//   1. ask the verification service (verifier.js) what it is
//   2. remember the verdict, so the same address is never paid for twice
//   3. only then write it to the database
//
// With VERIFY_PROVIDER unset this is a pass-through: status 'unverified', no
// network call, and the previous behaviour is preserved exactly.

import { addLead, getVerification, recordVerification } from './db.js';
import { isConfigured, providerName, shouldRejectInvalid, verifyEmail } from './verifier.js';

/**
 * Verify (when a provider is configured) and then store one discovered address.
 * @returns {Promise<{added: boolean, rejected: boolean, duplicate: boolean,
 *   verification_status: string, detail: string}>}
 */
export async function ingestLead(found, { company = '', sourceUrl = '', verify = true, options = {} } = {}) {
  const email = String(found?.email || '').trim();
  if (!email) {
    return { added: false, rejected: true, duplicate: false, verification_status: 'unverified', detail: 'no email' };
  }

  const source_url = (Array.isArray(found.foundOn) && found.foundOn[0]) || sourceUrl || '';
  let verification_status = 'unverified';
  let detail = 'verification disabled';

  if (verify && isConfigured()) {
    const cached = getVerification(email);
    if (cached) {
      verification_status = cached.status;
      detail = `${cached.provider}: ${cached.detail} (cached ${cached.checked_at})`;
    } else {
      const verdict = await verifyEmail(email, options);
      verification_status = verdict.verification_status;
      detail = `${verdict.provider}: ${verdict.detail}`;
      recordVerification(email, verification_status, verdict.provider, verdict.detail);
    }

    // A known-bad address never reaches the database unless explicitly allowed.
    if (verification_status === 'invalid' && shouldRejectInvalid()) {
      return { added: false, rejected: true, duplicate: false, verification_status, detail };
    }
  }

  const added = addLead({
    email,
    company,
    source_url,
    priority: found.priority,
    kind: found.kind,
    score: found.score,
    reason: found.reason,
    verification_status,
    verification_detail: detail
  });

  return {
    added,
    rejected: false,
    duplicate: !added,
    verification_status,
    detail: added ? 'new lead' : 'already in the database'
  };
}

/**
 * Ingest every address from one crawled site, in priority order.
 * @returns {Promise<{added: number, duplicates: number, rejected: number, byStatus: object}>}
 */
export async function ingestLeads(entries, { company = '', sourceUrl = '', verify = true, options = {}, onLead } = {}) {
  const summary = {
    added: 0,
    duplicates: 0,
    rejected: 0,
    byStatus: { unverified: 0, valid: 0, invalid: 0, catchall: 0 }
  };

  for (const found of entries || []) {
    const result = await ingestLead(found, { company, sourceUrl, verify, options });
    summary.byStatus[result.verification_status] = (summary.byStatus[result.verification_status] || 0) + 1;
    if (result.rejected) summary.rejected++;
    else if (result.added) summary.added++;
    else summary.duplicates++;
    if (onLead) onLead(found, result);
  }

  return summary;
}

export function verificationProvider() {
  return providerName();
}
