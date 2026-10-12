// pacing.js — human-like sending pace.
//
// Two behaviours live here:
//   1. jittered delays between sends (default 30–180s, overridable for tests)
//   2. the consecutive-invalid-email guard that trips an automatic cool down
//
// Everything in this module is pure — no timers, no network — so the pacing
// rules can be unit tested without waiting minutes.

export const DEFAULT_MIN_DELAY_MS = 30_000;
export const DEFAULT_MAX_DELAY_MS = 180_000;
export const DEFAULT_INVALID_STREAK_LIMIT = 3;
export const DEFAULT_COOLDOWN_MINUTES = 60;

function intFrom(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Delay bounds in ms, from SEND_DELAY_MIN_MS / SEND_DELAY_MAX_MS. */
export function delayBounds(env = process.env) {
  const min = intFrom(env.SEND_DELAY_MIN_MS, DEFAULT_MIN_DELAY_MS);
  const max = intFrom(env.SEND_DELAY_MAX_MS, DEFAULT_MAX_DELAY_MS);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** Random delay in [min, max] ms — the actual variance between two emails. */
export function nextDelayMs(bounds = delayBounds(), rand = Math.random) {
  const { min, max } = bounds;
  if (max <= min) return min;
  return min + Math.floor(rand() * (max - min + 1));
}

export function streakLimit(env = process.env) {
  return Math.max(1, intFrom(env.INVALID_STREAK_LIMIT, DEFAULT_INVALID_STREAK_LIMIT));
}

export function cooldownMs(env = process.env) {
  return Math.max(1, intFrom(env.COOLDOWN_MINUTES, DEFAULT_COOLDOWN_MINUTES)) * 60_000;
}

/**
 * Classify a send failure. Only 'invalid_email' counts towards the cool down:
 * it means the harvested address itself was bad.
 */
export function classifyFailure(error) {
  const text = String(error || '').toLowerCase();
  if (!text) return 'other';

  // Account/provider problems are not the recipient's fault — an expired key
  // must never burn the streak or trip the cool down.
  if (/api key|unauthoriz|forbidden|permission|not verified|domain is not|quota|(^|\D)(401|403)(\D|$)/.test(text)) {
    return 'provider_error';
  }
  if (/rate.?limit|too many requests|(^|\D)429(\D|$)/.test(text)) return 'rate_limited';
  if (/invalid_email|invalid_to|validation_error|invalid_?recipient/.test(text)) return 'invalid_email';
  if (/\binvalid\b|not a valid|does not exist|no such user|undeliverable|malformed|bad recipient|validation failed/.test(text)) {
    return 'invalid_email';
  }
  return 'other';
}

/**
 * Counts consecutive invalid-email failures. Hitting the limit means the list
 * (or the sending domain) is in trouble, so we stop and cool down instead of
 * burning more reputation.
 */
export class InvalidStreakGuard {
  constructor(limit = streakLimit()) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.streak = 0;
  }

  /** @returns {boolean} true when the cool down must engage */
  record(kind) {
    if (kind === 'invalid_email') this.streak += 1;
    else this.streak = 0;
    return this.tripped;
  }

  get tripped() {
    return this.streak >= this.limit;
  }

  reset() {
    this.streak = 0;
  }
}

/** Short human-readable summary of the configured pace. */
export function describePace(bounds = delayBounds()) {
  return `${Math.round(bounds.min / 1000)}–${Math.round(bounds.max / 1000)}s between emails`;
}
