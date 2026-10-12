// crawler.js — polite same-domain website crawler that extracts publicly
// listed email addresses. No external dependencies (Node 18+ built-in fetch).
//
// Design rules:
//   - respects robots.txt Disallow rules
//   - one request at a time per host, with a random delay between requests
//   - stays on the start URL's domain (no open-web spidering)
//   - hard page cap so a scan can never turn into a runaway crawl

const USER_AGENT =
  'Mozilla/5.0 (compatible; LeadScraper/1.0; +https://github.com/yourname)';

// Core email pattern. Matches local@part@domain.tld with 2+ letter TLD.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;

// Regex alone produces junk: "user@site.com.png" (from image filenames),
// asset extensions, and placeholder/test addresses. Filter them out.
const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'css', 'js', 'map', 'woff', 'woff2', 'ttf', 'eot',
  'mp4', 'mp3', 'pdf', 'zip', 'gz', 'xml', 'json', 'txt'
]);

const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'domain.com',
  'email.com', 'yoursite.com', 'yourdomain.com', 'sentry.io',
  'wixpress.com', 'godaddy.com', 'schema.org', 'apple.com',
  'microsoft.com', 'google.com', 'localhost',
  // Store-builder defaults that live in page markup and are never a real
  // contact: "you@boutique.com" is the Shopify theme placeholder.
  'boutique.com', 'myshopify.com', 'shopify.com', 'wixsite.com', 'wix.com',
  'squarespace.com', 'weebly.com', 'webflow.io', 'bigcommerce.com'
]);

// Free consumer mail providers — usually not the business contact you want.
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com',
  'yandex.com', 'qq.com', '163.com', '126.com'
]);

// Role mailboxes: real addresses, but never the decision maker. They are
// reported as low priority so a real person is contacted first.
export const ROLE_PREFIXES = new Set([
  'info', 'support', 'admin', 'sales', 'contact', 'hello', 'help', 'office',
  'team', 'billing', 'accounts', 'accounting', 'customer', 'customercare',
  'enquiries', 'inquiries', 'enquiry', 'inquiry', 'mail', 'email', 'webmaster',
  'postmaster', 'press', 'media', 'marketing', 'hr', 'jobs', 'careers',
  'service', 'orders', 'shop', 'store', 'parts', 'reception', 'general', 'helpdesk',
  'feedback', 'referencing', 'reservations', 'booking', 'rentals', 'lettings',
  'abuse', 'security', 'privacy', 'legal', 'noreply', 'no-reply', 'donotreply'
]);

export function normalizeEmail(raw) {
  return raw.toLowerCase().replace(/^mailto:/i, '').split('?')[0].trim();
}

export function isValidEmail(email, { includeFree = false } = {}) {
  if (!email || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  if (!includeFree && FREE_MAIL_DOMAINS.has(domain)) return false;
  return true;
}

function isAssetLike(email) {
  const tld = email.split('.').pop();
  return ASSET_EXTENSIONS.has(tld);
}

function isPlaceholder(email) {
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1);

  // Blocked hosts also match their subdomains: o168728.ingest.sentry.io is
  // browser telemetry noise, not a contact address.
  for (const blocked of PLACEHOLDER_DOMAINS) {
    if (domain === blocked || domain.endsWith('.' + blocked)) return true;
  }

  if (/^(no-?reply|donotreply)@/i.test(email)) return true;

  const local = email.slice(0, at);

  // Unicode/JSON escape fragments. A page containing "\u003e@name" leaves
  // "u003e@sarah.dipity" behind, because the backslash that should have been
  // part of the match is rejected by the email pattern.
  if (/^u[0-9a-f]{4}$/i.test(local)) return true;

  // Long hex/uuid local parts are machine tokens (Sentry DSNs, tracking ids).
  if (local.length >= 24 && /^[0-9a-f]+$/i.test(local)) return true;

  return false;
}

/**
 * Extract unique, plausible contact emails from an HTML string.
 * @param {string} html
 * @param {{ includeFree?: boolean }} options
 * @returns {string[]} normalized lowercase emails
 */
export function extractEmails(html, options = {}) {
  const found = new Set();
  for (const match of html.matchAll(EMAIL_REGEX)) {
    const email = normalizeEmail(match[0]);
    if (isAssetLike(email) || isPlaceholder(email)) continue;
    if (!isValidEmail(email, options)) continue;
    found.add(email);
  }
  return [...found].sort();
}

// --- Prioritising decision makers --------------------------------------------
// A word that starts a nav label or a section heading is not a person's name.
const NAME_STOPWORDS = new Set([
  'Contact', 'Read', 'Learn', 'More', 'Home', 'About', 'Our', 'Your', 'The',
  'Privacy', 'Policy', 'Terms', 'Shop', 'Cart', 'Sign', 'Login', 'Log',
  'Follow', 'Copyright', 'All', 'Rights', 'New', 'York', 'Free', 'Shipping',
  'Add', 'Basket', 'View', 'Quick', 'Sale', 'Menu', 'Search', 'Subscribe',
  'Newsletter', 'Class', 'Gift', 'Press', 'Accessibility', 'Locations',
  'Policies', 'Wholesale', 'Brewing', 'Guides', 'Roasting', 'Buying', 'Guide',
  'Cold', 'Brew', 'Coffee', 'Story', 'Instant', 'Get', 'Started', 'Stay',
  'Keep', 'Touch', 'Take', 'Quiz', 'Order', 'Now', 'History', 'Sourcing',
  'Sustainability', 'Private', 'Tours', 'Tastings', 'Education', 'Process',
  'Color', 'Blog', 'Best', 'Sellers', 'Featured', 'Goods', 'Check', 'Out',
  'Skip', 'Content', 'Close', 'Open', 'Submit', 'Send', 'Call', 'Email',
  'Phone', 'Hours', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'Support', 'Careers', 'Account', 'My', 'Edit'
]);

// A name only counts when a title sits immediately after it. Two shapes, and
// nothing else:
//
//   "John Smith, Founder"   "Jane Doe | Realtor"   "Jane Doe - Broker"
//   "John Smith Founder"    (ownership titles only — tag-flattened markup)
//
// The old rule ("a job word somewhere in the next 25 characters") turned site
// navigation into people: LOFT's footer produced "Pants Versa", "Back With",
// "Texts From" and "Us Cookie" because "Cookie Manager" happened to follow.
//
// The name scan stays case-sensitive (so nav text never qualifies) while the
// title check is case-insensitive and anchored to the very next characters.
// (the candidate scan and the two title checks are built below, once the title
// lists themselves have been defined)
const TITLES_ANY = 'founder|co-?founder|owner|co-owner|ceo|cto|coo|cfo|cmo|cpo|president|vice\\s+president|managing\\s+director|director|manager|partner|principal|proprietor|chief|head\\s+of|attorney|lawyer|realtor|broker|dentist|accountant|architect|consultant';

// Ownership/leadership only: safe even when the separator was just a tag
// boundary ("<h3>John Smith</h3><p>Founder</p>" → "John Smith Founder").
const TITLES_STRONG = 'founder|co-?founder|owner|co-owner|ceo|cto|coo|cfo|president|proprietor|principal|managing\\s+director|sole\\s+trader';

// Overlapping scan (zero-width lookahead): "Meet Sam Lee - Director" must still
// find "Sam Lee", which a plain global scan would skip past. The name itself is
// still case-sensitive so nav text can never qualify.
const CANDIDATE_NAME = /(?=\b([A-Z][a-z]{1,19})\s+([A-Z][a-z]{1,19})\b)/g;
const AFTER_SEPARATOR = new RegExp(`^\\s{0,3}[,\\-–—|:/]\\s{0,3}(?:${TITLES_ANY})\\b`, 'i');
const AFTER_SPACE = new RegExp(`^\\s{1,2}(?:${TITLES_STRONG})\\b`, 'i');

const NAME_PATTERNS = [AFTER_SEPARATOR, AFTER_SPACE];

/** Tags/scripts stripped down to readable text. */
export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/** People named on the site, e.g. "John Smith, Founder" → "John Smith". */
export function extractPersonNames(html) {
  const text = stripHtml(html);
  const names = new Set();
  for (const match of text.matchAll(CANDIDATE_NAME)) {
    const first = match[1];
    const last = match[2];
    if (NAME_STOPWORDS.has(first) || NAME_STOPWORDS.has(last)) continue;

    const lastAt = text.indexOf(last, match.index + first.length);
    if (lastAt === -1) continue;
    const from = lastAt + last.length;
    const rest = text.slice(from, from + 40);
    if (!NAME_PATTERNS.some((pattern) => pattern.test(rest))) continue;
    names.add(`${first} ${last}`);
  }
  return [...names];
}

/** Mailbox shapes a name plausibly uses: john.smith, jsmith, john, smith … */
export function nameVariants(fullName) {
  const parts = String(fullName).toLowerCase().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return [];
  const last = parts[parts.length - 1];
  if (!last || last === first) return [first];
  return [
    `${first}.${last}`, `${first}${last}`, `${first}_${last}`, `${first}-${last}`,
    `${first[0]}${last}`, first, last
  ];
}

function localOf(email) {
  return String(email).slice(0, String(email).lastIndexOf('@')).toLowerCase();
}

/** The role word inside a mailbox ("customersupport" → "customer"), or ''. */
export function roleWordIn(local) {
  const lower = localOf(local.includes('@') ? local : `${local}@x`);
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  const byToken = tokens.find((token) => ROLE_PREFIXES.has(token));
  if (byToken) return byToken;
  return [...ROLE_PREFIXES].find((role) => role.length >= 4 && lower.startsWith(role)) || '';
}

/** The company's own name from its host: "smithlaw" for smithlaw.com */
export function domainLabel(host) {
  try {
    const url = new URL(String(host).includes('://') ? host : `https://${host}`);
    return url.hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return String(host).split('.')[0];
  }
}

/** Dominant mailbox style on a site: first.last / first_last / first-last. */
export function detectConvention(emails) {
  const tally = new Map();
  for (const email of emails) {
    const local = localOf(email);
    if (roleWordIn(local)) continue;
    const style = local.includes('.') ? 'first.last'
      : local.includes('_') ? 'first_last'
        : local.includes('-') ? 'first-last'
          : null;
    if (!style) continue;
    tally.set(style, (tally.get(style) || 0) + 1);
  }
  let best = null;
  for (const [style, count] of tally) {
    if (!best || count > best.count) best = { style, count };
  }
  return best;
}

/**
 * Score one address that was actually seen on the site.
 * kind: person (named on the page) · role (shared mailbox) · company · generic
 */
export function classifyEmail(email, { names = [], convention = null, label = '' } = {}) {
  const local = localOf(email);

  const role = roleWordIn(local);
  if (role) {
    return { email, kind: 'role', priority: 'low', score: 10, reason: `shared ${role}@ mailbox` };
  }

  const matched = names.find((name) => nameVariants(name).includes(local));
  if (matched) {
    const follows = convention && convention.style === 'first.last' && local.includes('.');
    return {
      email,
      kind: 'person',
      priority: 'high',
      score: 95,
      reason: `name match "${matched}"${follows ? ' · follows site convention' : ' (named on the site)'}`
    };
  }

  // jsmith@jsmithlaw.com — the mailbox is the company's own name: the owner.
  if (label && local.length >= 3 && /^[a-z]+$/.test(local) && label.includes(local)) {
    return { email, kind: 'person', priority: 'high', score: 80, reason: `matches company name "${label}"` };
  }

  const tokens = local.split(/[._-]/).filter(Boolean);
  const personShaped =
    (tokens.length === 2 && tokens.every((token) => token.length >= 2)) || /^[a-z][a-z]{3,}$/.test(local);

  return personShaped
    ? { email, kind: 'generic', priority: 'normal', score: 60, reason: 'person-shaped mailbox, no name confirmable' }
    : { email, kind: 'company', priority: 'normal', score: 45, reason: 'company mailbox' };
}

/**
 * Suggestions only — these addresses were NEVER seen on the site. They are the
 * shapes the site's own convention implies for a named person, so they must be
 * verified by hand before anything is sent to them.
 */
export function suggestGuesses(names, host, convention = null) {
  const domain = String(host).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain.includes('.')) return [];

  const order = convention?.style === 'first_last' ? ['first_last', 'first.last']
    : convention?.style === 'first-last' ? ['first-last', 'first.last']
      : ['first.last', 'firstlast', 'flast', 'first'];

  const out = [];
  for (const name of names) {
    const parts = name.toLowerCase().split(/\s+/).filter(Boolean);
    const first = parts[0];
    const last = parts[parts.length - 1] || '';
    if (!first || !last || first === last) continue;

    for (const pattern of order) {
      const local = pattern === 'first.last' ? `${first}.${last}`
        : pattern === 'firstlast' ? `${first}${last}`
          : pattern === 'flast' ? `${first[0]}${last}`
            : pattern === 'first_last' ? `${first}_${last}`
              : pattern === 'first-last' ? `${first}-${last}`
                : first;
      out.push({
        email: `${local}@${domain}`,
        pattern,
        for_name: name,
        verified: false,
        note: 'suggested from the site convention — never seen on the site, verify before use'
      });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/**
 * Rank every address found on a site, split out the low-priority mailboxes and
 * list unverified suggestions for the people named on it.
 */
export function analyzeEmails(entries, { html = '', url = '' } = {}) {
  const list = entries.map((entry) => (typeof entry === 'string' ? entry : entry.email));
  const names = extractPersonNames(html);
  const convention = detectConvention(list);
  const label = domainLabel(url);

  const ranked = entries
    .map((entry) => {
      const email = typeof entry === 'string' ? entry : entry.email;
      const foundOn = typeof entry === 'string' ? [] : entry.foundOn || [];
      return { ...classifyEmail(email, { names, convention, label }), foundOn };
    })
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));

  return {
    names,
    convention: convention ? convention.style : null,
    emails: ranked,
    priority: ranked.filter((entry) => entry.priority !== 'low'),
    lowPriority: ranked.filter((entry) => entry.priority === 'low'),
    guesses: suggestGuesses(names, url, convention)
  };
}

/** Pull http(s) links out of a page, resolved and same-host filtered later. */
function extractLinks(html, baseUrl) {
  const links = [];
  const hrefRegex = /href\s*=\s*["']([^"'#]+)["']/gi;
  for (const match of html.matchAll(hrefRegex)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      links.push(url.href);
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return links;
}

/** Pages where businesses hide contact info — crawl these first. */
const PRIORITY_PATH = /(contact|about|team|staff|people|impressum|imprint|support|connect|who-we-are)/i;

/** Files we should never try to parse as HTML. */
const SKIP_PATH = /\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|mp4|mp3|zip|gz|css|js|woff2?|ttf|eot)$/i;

function sameHost(a, b) {
  const strip = (h) => h.replace(/^www\./, '');
  return strip(a) === strip(b);
}

/** Minimal robots.txt parser: returns false when a path is disallowed for us. */
export async function isPathAllowed(origin, pathname, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return true;
    const text = await res.text();
    let applies = false;
    const disallows = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      const [rawKey, ...rest] = line.split(':');
      if (!rawKey || rest.length === 0) continue;
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') {
        applies = value === '*' || USER_AGENT.toLowerCase().includes(value.toLowerCase());
      } else if (key === 'disallow' && applies) {
        if (value) disallows.push(value);
      }
    }
    return !disallows.some((rule) => pathname.startsWith(rule));
  } catch {
    // robots.txt unreachable — treat as allowed (standard behavior)
    return true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/**
 * Crawl a single website and collect emails with the page each was found on.
 *
 * @param {string} startUrl
 * @param {{
 *   maxPages?: number,      // hard cap on fetched pages (default 10, max 50)
 *   delayMs?: number,       // base delay between requests (default 1500)
 *   includeFree?: boolean,  // keep gmail/yahoo/etc (default false)
 *   respectRobots?: boolean // default true
 * }} options
 * @returns {Promise<{
 *   startUrl: string,
 *   pagesScanned: number,
 *   pages: string[],
 *   emails: { email: string, foundOn: string[], kind: string,
 *             priority: 'high'|'normal'|'low', score: number, reason: string }[],
 *   priority: object[],     // same shape, without low-priority mailboxes
 *   lowPriority: object[],  // info@/support@/admin@/sales@ ... (dead ends)
 *   names: string[],        // people named on the site ("John Smith")
 *   convention: string|null,// dominant mailbox style, e.g. 'first.last'
 *   guesses: { email: string, pattern: string, verified: false }[],
 *   errors: { url: string, error: string }[]
 * }>}
 */
export async function crawlSite(startUrl, options = {}) {
  const {
    maxPages = 10,
    delayMs = 1500,
    includeFree = false,
    respectRobots = true
  } = options;

  const cap = Math.min(Math.max(1, Number(maxPages) || 10), 50);

  let start;
  try {
    start = new URL(startUrl.includes('://') ? startUrl : `https://${startUrl}`);
  } catch {
    throw new Error(`Invalid URL: ${startUrl}`);
  }

  const visited = new Set();
  const queue = [start.href];
  const pages = [];
  const errors = [];
  const emailMap = new Map(); // email -> Set(foundOn urls)
  let pageText = ''; // stripped copy of the site, used to find person names

  while (queue.length > 0 && pages.length < cap) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const parsed = new URL(url);
    if (SKIP_PATH.test(parsed.pathname)) continue;
    if (respectRobots && !(await isPathAllowed(parsed.origin, parsed.pathname))) continue;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('text/html')) continue;

      const html = await res.text();
      pages.push(url);

      if (pageText.length < 300000) {
        pageText += stripHtml(html).slice(0, 60000);
      }

      for (const email of extractEmails(html, { includeFree })) {
        if (!emailMap.has(email)) emailMap.set(email, new Set());
        emailMap.get(email).add(url);
      }

      // Enqueue same-host links, priority pages (contact/about/team) first
      const links = extractLinks(html, url).filter((href) => {
        if (visited.has(href)) return false;
        const u = new URL(href);
        if (!sameHost(u.hostname, start.hostname)) return false;
        if (SKIP_PATH.test(u.pathname)) return false;
        return true;
      });
      links.sort((a, b) => {
        const score = (u) => (PRIORITY_PATH.test(new URL(u).pathname) ? 0 : 1);
        return score(a) - score(b);
      });
      queue.push(...links);

      // Polite delay with jitter so we don't hammer the site
      await sleep(delayMs + Math.random() * 800);
    } catch (err) {
      errors.push({ url, error: err.name === 'TimeoutError' ? 'timeout' : err.message });
    }
  }

  const found = [...emailMap.entries()]
    .map(([email, foundOn]) => ({ email, foundOn: [...foundOn] }))
    .sort((a, b) => a.email.localeCompare(b.email));

  const analysis = analyzeEmails(found, { html: pageText, url: start.href });

  return {
    startUrl: start.href,
    pagesScanned: pages.length,
    pages,
    emails: analysis.emails,           // every address, best first
    priority: analysis.priority,       // decision makers + generic mailboxes
    lowPriority: analysis.lowPriority, // info@/support@/sales@... keep digging past these
    names: analysis.names,
    convention: analysis.convention,
    guesses: analysis.guesses,         // suggestions only: never seen on the site
    errors
  };
}
