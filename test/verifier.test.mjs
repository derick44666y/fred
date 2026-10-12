import {
  verifyEmail,
  normalizeStatus,
  providerName,
  isConfigured,
  shouldRejectInvalid,
  VERIFICATION_STATUSES
} from '../verifier.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
}

// --- no provider = no network, nothing changes -------------------------------
const off = await verifyEmail('owner@shop.test', { env: {} });
check('no provider configured → unverified',
  off.verification_status === 'unverified' && off.provider === 'none', JSON.stringify(off));
check('provider names fall back to none',
  providerName({}) === 'none' && providerName({ VERIFY_PROVIDER: 'bogus' }) === 'none' &&
  providerName({ VERIFY_PROVIDER: 'NeverBounce' }) === 'neverbounce');
check('isConfigured needs a key',
  isConfigured({}) === false &&
  isConfigured({ VERIFY_PROVIDER: 'mock' }) === true &&
  isConfigured({ VERIFY_PROVIDER: 'neverbounce' }) === false &&
  isConfigured({ VERIFY_PROVIDER: 'neverbounce', NEVERBOUNCE_API_KEY: 'k' }) === true);
check('statuses match the schema',
  VERIFICATION_STATUSES.join(',') === 'unverified,valid,invalid,catchall', VERIFICATION_STATUSES.join(','));
check('invalid addresses are rejected by default (and can be kept)',
  shouldRejectInvalid({}) === true && shouldRejectInvalid({ VERIFY_REJECT_INVALID: 'false' }) === false);

// --- mock provider ----------------------------------------------------------
const mock = { VERIFY_PROVIDER: 'mock' };
check('mock: good address is valid', (await verifyEmail('owner@shop.test', { env: mock })).verification_status === 'valid');
check('mock: bad address is invalid', (await verifyEmail('bounce@shop.test', { env: mock })).verification_status === 'invalid');
check('mock: catch-all is catchall', (await verifyEmail('hi@catchall.test', { env: mock })).verification_status === 'catchall');

// --- provider verdict mapping ------------------------------------------------
check('verdicts map onto the four statuses',
  normalizeStatus('valid') === 'valid' && normalizeStatus('deliverable') === 'valid' &&
  normalizeStatus('catchall') === 'catchall' && normalizeStatus('accept_all') === 'catchall' &&
  normalizeStatus('spamtrap') === 'invalid' && normalizeStatus('disposable') === 'invalid' &&
  normalizeStatus('do_not_mail') === 'invalid' && normalizeStatus('unknown') === 'unverified' &&
  normalizeStatus(undefined) === 'unverified');

// --- real provider shapes, exercised through a fake fetch --------------------
const nb = await verifyEmail('info@shop.test', {
  env: { VERIFY_PROVIDER: 'neverbounce', NEVERBOUNCE_API_KEY: 'k' },
  fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'success', result: 'catchall' }) })
});
check('neverbounce response is mapped',
  nb.verification_status === 'catchall' && nb.provider === 'neverbounce', JSON.stringify(nb));

const zb = await verifyEmail('info@shop.test', {
  env: { VERIFY_PROVIDER: 'zerobounce', ZEROBOUNCE_API_KEY: 'k' },
  fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'invalid' }) })
});
check('zerobounce response is mapped', zb.verification_status === 'invalid', JSON.stringify(zb));

// --- the hook must never block a harvest -------------------------------------
const broken = await verifyEmail('info@shop.test', {
  env: { VERIFY_PROVIDER: 'neverbounce', NEVERBOUNCE_API_KEY: 'k' },
  fetchImpl: async () => { throw new Error('socket hang up'); }
});
check('network failure is fail-open (unverified)',
  broken.verification_status === 'unverified' && /socket hang up/.test(broken.detail), JSON.stringify(broken));

const httpErr = await verifyEmail('info@shop.test', {
  env: { VERIFY_PROVIDER: 'zerobounce', ZEROBOUNCE_API_KEY: 'k' },
  fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
});
check('provider 5xx is fail-open', httpErr.verification_status === 'unverified' && /503/.test(httpErr.detail));

const noKey = await verifyEmail('info@shop.test', { env: { VERIFY_PROVIDER: 'zerobounce' } });
check('missing key is reported, not thrown',
  noKey.verification_status === 'unverified' && /ZEROBOUNCE_API_KEY/.test(noKey.detail), JSON.stringify(noKey));

process.exit(failures === 0 ? 0 : 1);
