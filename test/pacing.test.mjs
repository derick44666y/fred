import {
  delayBounds,
  nextDelayMs,
  classifyFailure,
  InvalidStreakGuard,
  streakLimit,
  cooldownMs,
  describePace
} from '../pacing.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
}

// --- the requested 30–180s window -------------------------------------------
const bounds = delayBounds({});
check('default window is 30–180s', bounds.min === 30000 && bounds.max === 180000, JSON.stringify(bounds));
check('pace description', describePace(bounds) === '30–180s between emails', describePace(bounds));

const fast = delayBounds({ SEND_DELAY_MIN_MS: '5', SEND_DELAY_MAX_MS: '20' });
check('env overrides the window (tests stay fast)', fast.min === 5 && fast.max === 20, JSON.stringify(fast));
check('reversed bounds are normalised',
  JSON.stringify(delayBounds({ SEND_DELAY_MIN_MS: '900', SEND_DELAY_MAX_MS: '100' })) === '{"min":100,"max":900}',
  JSON.stringify(delayBounds({ SEND_DELAY_MIN_MS: '900', SEND_DELAY_MAX_MS: '100' })));

const draws = Array.from({ length: 500 }, () => nextDelayMs(bounds));
check('every delay lands inside 30–180s',
  draws.every((d) => d >= 30000 && d <= 180000), JSON.stringify([Math.min(...draws), Math.max(...draws)]));
check('delays actually vary (not fixed intervals)', new Set(draws).size > 100, String(new Set(draws).size));
check('rand=0 returns the minimum', nextDelayMs(bounds, () => 0) === 30000);
check('rand→1 returns the maximum', nextDelayMs(bounds, () => 0.9999999) === 180000);
check('degenerate window returns min', nextDelayMs({ min: 50, max: 50 }) === 50);

// --- failure classification --------------------------------------------------
check('invalid-email wordings are recognised',
  [
    'Invalid email address',
    'validation_error',
    'invalid_to',
    'The recipient address does not exist',
    'INVALID_EMAIL',
    'mailbox undeliverable'
  ].every((m) => classifyFailure(m) === 'invalid_email'),
  JSON.stringify(['Invalid email address', 'validation_error', 'invalid_to'].map(classifyFailure)));
check('an API-key error is NOT an invalid email',
  classifyFailure('API key is invalid') === 'provider_error' &&
  classifyFailure('unauthorized') === 'provider_error' &&
  classifyFailure('domain is not verified') === 'provider_error',
  classifyFailure('API key is invalid'));
check('rate limits are their own class',
  ['rate limit exceeded', '429 Too Many Requests', 'too many requests'].every((m) => classifyFailure(m) === 'rate_limited'));
check('unknown errors are neutral', classifyFailure('') === 'other' && classifyFailure('boom') === 'other');

// --- consecutive-invalid guard + cool down ----------------------------------
check('streak limit defaults to three', streakLimit({}) === 3);
check('cooldown default is 60 minutes', cooldownMs({}) === 3_600_000);
check('cooldown is configurable', cooldownMs({ COOLDOWN_MINUTES: '15' }) === 900_000);

const guard = new InvalidStreakGuard(3);
check('one invalid does not trip', guard.record('invalid_email') === false);
check('two invalids do not trip', guard.record('invalid_email') === false);
check('the third consecutive invalid trips the cool down', guard.record('invalid_email') === true);

const recovering = new InvalidStreakGuard(3);
recovering.record('invalid_email');
recovering.record('invalid_email');
check('a good send resets the streak', recovering.record('other') === false && recovering.streak === 0);
check('a provider error also breaks the run',
  recovering.record('invalid_email') === false && recovering.record('provider_error') === false && recovering.streak === 0);

process.exit(failures === 0 ? 0 : 1);
