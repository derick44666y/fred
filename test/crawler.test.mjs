import {
  extractEmails,
  isValidEmail,
  crawlSite,
  classifyEmail,
  extractPersonNames
} from '../crawler.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
}

// --- extractEmails ---
const html = `
  <a href="mailto:info@bluebird-plumbing.test?subject=hi">mail us</a>
  <img src="/assets/logo@2x.png">
  <span>admin@bluebird-plumbing.test.png</span>
  <span>noreply@bluebird-plumbing.test</span>
  <span>test@gmail.com</span>
  <span>sales@hardware-store.biz</span>
  <span>example.com</span>
  <span>staff@city-law.test</span>
  <span>0b1d2f3a4c5e6f708192a3b4c5d6e7f8@o168728.ingest.sentry.io</span>
  <span>hello@sentry.io</span>
  <span>u003e@sarah.dipity</span>
  <span>you@boutique.com</span>
  <span>hello@mystore.myshopify.com</span>
`;
const got = extractEmails(html);
check('extractEmails basics',
  JSON.stringify(got) === JSON.stringify([
    'info@bluebird-plumbing.test',
    'sales@hardware-store.biz',
    'staff@city-law.test'
  ]),
  JSON.stringify(got));

// Blocked hosts must also cover their subdomains + machine-generated tokens.
check('blocks blocked-host subdomains (sentry ingest)',
  !got.includes('0b1d2f3a4c5e6f708192a3b4c5d6e7f8@o168728.ingest.sentry.io'), JSON.stringify(got));
check('blocks exact blocked hosts (sentry.io)', !got.includes('hello@sentry.io'), JSON.stringify(got));
check('drops unicode-escape fragments and store-builder placeholders',
  !got.includes('u003e@sarah.dipity') &&
  !got.includes('you@boutique.com') &&
  !got.includes('hello@mystore.myshopify.com'), JSON.stringify(got));

const withFree = extractEmails(html, { includeFree: true });
check('includeFree keeps gmail', withFree.includes('test@gmail.com'), JSON.stringify(withFree));

check('rejects bad emails', !isValidEmail('foo@') && !isValidEmail('@bar.com') && !isValidEmail(''));

// --- end-to-end crawl against a local fixture site ---
const PAGES = {
  '/': `<html><body>
      <a href="/contact">Contact us</a>
      <a href="/about">About</a>
      <a href="/private">Staff only</a>
      <a href="https://external-site.test/page">External</a>
      <p>Welcome to Bluebird Plumbing, email web@bluebird-plumbing.test</p>
    </body></html>`,
  '/contact': `<html><body>
      <p>Reach us: info@bluebird-plumbing.test or parts@bluebird-supplies.test</p>
      <img src="/img/logo@2x.png">
    </body></html>`,
  '/about': `<html><body><p>Founded 1998. John Smith, Founder — john.smith@bluebird-plumbing.test
      admin@bluebird-plumbing.test.png</p></body></html>`,
  '/private': `<html><body><p>secret@bluebird-plumbing.test</p></body></html>`,
  '/robots.txt': null // set below
};
PAGES['/robots.txt'] = 'User-agent: *\nDisallow: /private\n';

const server = await import('node:http').then((http) =>
  http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const body = PAGES[path];
    if (body === undefined) { res.writeHead(404); return res.end('not found'); }
    const type = path === '/robots.txt' ? 'text/plain' : 'text/html';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  }).listen(8931, '127.0.0.1')
);

const result = await crawlSite('http://127.0.0.1:8931/', {
  maxPages: 10,
  delayMs: 10,
  respectRobots: true
});

const emails = result.emails.map((e) => e.email);
check('crawled multiple pages', result.pagesScanned >= 3, `pages=${result.pagesScanned}`);
check('found homepage + contact emails',
  emails.includes('web@bluebird-plumbing.test') &&
  emails.includes('info@bluebird-plumbing.test') &&
  emails.includes('parts@bluebird-supplies.test'),
  JSON.stringify(emails));
check('robots.txt blocked /private', !emails.includes('secret@bluebird-plumbing.test'), JSON.stringify(emails));
check('filtered .png false positive', !emails.some((e) => e.endsWith('.png')), JSON.stringify(emails));
check('foundOn recorded', result.emails.every((e) => e.foundOn.length > 0));
check('no external domain crawl', !result.pages.some((p) => p.includes('external-site.test')));

// --- decision-maker prioritisation ---
const byEmail = new Map(result.emails.map((e) => [e.email, e]));
const person = byEmail.get('john.smith@bluebird-plumbing.test');
check('person named on the page is high priority',
  Boolean(person) && person.priority === 'high' && person.kind === 'person',
  JSON.stringify([...byEmail]));
check('info@ is filed in the low priority folder',
  byEmail.get('info@bluebird-plumbing.test')?.priority === 'low' &&
  result.lowPriority.some((e) => e.email === 'info@bluebird-plumbing.test'),
  JSON.stringify(result.lowPriority));
check('low priority mailboxes stay out of the priority list',
  result.priority.length === result.emails.length - result.lowPriority.length &&
  !result.priority.some((e) => e.priority === 'low'));
check('person name extracted from the page copy',
  result.names.includes('John Smith'), JSON.stringify(result.names));

const guessed = new Set(result.guesses.map((g) => g.email));
check('guesses are flagged unverified and never reported as found',
  result.guesses.length > 0 &&
  result.guesses.every((g) => g.verified === false) &&
  result.emails.every((e) => !guessed.has(e.email)),
  JSON.stringify(result.guesses));

// classifier rules (no network)
check('company-name mailbox counts as the owner',
  classifyEmail('jsmith@jsmithlaw.com', { label: 'jsmithlaw' }).priority === 'high');
check('role mailboxes are low priority',
  ['sales@acme.test', 'customersupport@acme.test', 'info@infotech.test']
    .every((e) => classifyEmail(e).priority === 'low'));
check('nav labels are not mistaken for people',
  extractPersonNames('<p>Coffee Guide</p><p>Read More</p>').length === 0 &&
  extractPersonNames('<p>John Smith, Founder</p>').includes('John Smith'));
check('title must sit next to the name (separator form still works)',
  extractPersonNames('<p>Jane Doe | Realtor</p><p>Jane Doe - Broker</p>')
    .filter((n) => n === 'Jane Doe').length === 1);
// Regression: LOFT's footer navigation was read as four "people", and the
// guesses built from them (pantsversa@loft.com …) were pure noise.
const loftNav = '<a>Shop All Versa Jackets &amp; Blazers</a><a>Versa Pants</a><a>Versa Tops &amp; Sweaters</a>'
  + '<a>Careers</a><a>LOFT Outlet</a><a>Ann Taylor</a><a>Give Back With Us</a><a>Get Texts From Us</a><a>Cookie Manager</a>'
  + '<a>Store Locator</a><p>Social Media Manager</p>';
check('navigation runs and role phrases are not people',
  extractPersonNames(loftNav).length === 0, JSON.stringify(extractPersonNames(loftNav)));
// Regression: real Shopify product titles used to become "people".
check('product titles are not mistaken for people',
  extractPersonNames('<p>Quick Add Brc Comic Book Issue #1 And #2 $3.00 to $5.00 --> Quick Add Roaster\u2019s Pick $24.00</p>').length === 0,
  JSON.stringify(extractPersonNames('<p>Quick Add Brc Comic Book Issue #1 And #2 $3.00 to $5.00 --> Quick Add Roaster\u2019s Pick $24.00</p>')));

server.close();
process.exit(failures === 0 ? 0 : 1);
