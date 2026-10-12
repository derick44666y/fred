// verifier.js — email verification service layer.
//
// Discovered addresses can be handed to an external verification API *before*
// they are written to the database, so the send queue never starts from an
// address that is already known to bounce.
//
//   VERIFY_PROVIDER=none         (default) → everything stays 'unverified', no network call
//   VERIFY_PROVIDER=neverbounce  → uses NEVERBOUNCE_API_KEY
//   VERIFY_PROVIDER=zerobounce   → uses ZEROBOUNCE_API_KEY
//   VERIFY_PROVIDER=mock         → deterministic local verdicts (tests and demos)
//
// Verification is fail-open: a timeout, a 500 or a missing key reports
// 'unverified' and the harvest carries on.

export const VERIFICATION_STATUSES = ['unverified', 'valid', 'invalid', 'catchall'];

const PROVIDERS = {
  neverbounce: {
    keyVar: 'NEVERBOUNCE_API_KEY',
    url: (email, key) =>
      `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`
  },
  zerobounce: {
    keyVar: 'ZEROBOUNCE_API_KEY',
    url: (email, key) =>
      `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`
  }
};

export function providerName(env = process.env) {
  const name = String(env.VERIFY_PROVIDER || 'none').toLowerCase().trim();
  if (name === 'mock' || PROVIDERS[name]) return name;
  return 'none';
}

export function isConfigured(env = process.env) {
  const name = providerName(env);
  if (name === 'mock') return true;
  if (name === 'none') return false;
  return Boolean(env[PROVIDERS[name].keyVar]);
}

/** Should an 'invalid' verdict keep the address out of the database? (default yes) */
export function shouldRejectInvalid(env = process.env) {
  return String(env.VERIFY_REJECT_INVALID ?? 'true').toLowerCase() !== 'false';
}

/** Map a provider verdict onto our four stored statuses. */
export function normalizeStatus(raw) {
  const value = String(raw || '').toLowerCase().trim();
  if (value === 'valid' || value === 'deliverable') return 'valid';
  if (['invalid', 'disposable', 'spamtrap', 'abuse', 'do_not_mail', 'undeliverable'].includes(value)) {
    return 'invalid';
  }
  if (['catchall', 'accept_all', 'accept-all'].includes(value)) return 'catchall';
  return 'unverified';
}

/** Deterministic verdicts so the whole pipeline can be exercised offline. */
function mockVerdict(email) {
  const hay = String(email).toLowerCase();
  if (/invalid|bounce|no-?reply|disposable/.test(hay)) return 'invalid';
  if (/catchall|acceptall/.test(hay)) return 'catchall';
  return 'valid';
}

/**
 * Verify one address.
 * @returns {Promise<{ email: string, verification_status: string,
 *   provider: string, detail: string, checked_at: string }>}
 */
export async function verifyEmail(email, { env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const provider = providerName(env);
  const checked_at = new Date().toISOString();
  const result = (verification_status, detail) => ({ email, verification_status, provider, detail, checked_at });

  if (provider === 'none') return result('unverified', 'no verification provider configured');
  if (provider === 'mock') return result(mockVerdict(email), 'mock verdict');

  const { keyVar, url } = PROVIDERS[provider];
  const key = env[keyVar];
  if (!key) return result('unverified', `${keyVar} is not set`);

  try {
    const res = await fetchImpl(url(email, key), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return result('unverified', `provider HTTP ${res.status}`);
    const data = await res.json();
    const raw = provider === 'neverbounce' ? data.result : data.status;
    return result(normalizeStatus(raw), `provider said "${raw ?? 'nothing'}"`);
  } catch (err) {
    return result('unverified', `verification failed: ${err.message}`);
  }
}

/** Sequential helper for a list of addresses (keeps provider rate limits happy). */
export async function verifyList(emails, options = {}) {
  const out = [];
  for (const email of emails) out.push(await verifyEmail(email, options));
  return out;
}
