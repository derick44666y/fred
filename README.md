# Cold Outreach (Resend)

Simple, low-volume cold email tool with a built-in lead scraper. 50 emails/day safe limit.

## Quick start

```bash
cd coldmail
cp .env.example .env
# edit .env → put your real Resend API key + verified From address + MAILING_ADDRESS
npm install
npm start
```

Then open: **http://localhost:3000**

## .env

```
RESEND_API_KEY=re_xxxxxxxxxxxx
FROM_EMAIL=Your Name <you@yourdomain.com>
REPLY_TO=you@yourdomain.com
DAILY_LIMIT=50
PORT=3000
UNSUBSCRIBE_BASE_URL=http://localhost:3000
MAILING_ADDRESS=Your Name, 123 Main St, City, ST 12345
# Sending pace + cool down (see the sections below)
SEND_DELAY_MIN_MS=30000
SEND_DELAY_MAX_MS=180000
INVALID_STREAK_LIMIT=3
COOLDOWN_MINUTES=60
# Email verification service (optional)
VERIFY_PROVIDER=none
```

Your domain **must** be verified in Resend (SPF + DKIM) or mail goes to spam.

## How to use

1. Open the web UI
2. **Find leads**: paste a business's website into "Scan a Website" — the crawler
   checks up to 10 pages (contact/about/team first, robots.txt respected) and
   adds any publicly listed business emails as pending leads. Each lead keeps a
   "Found on" source link.
3. **Personalize**: type a real observation in the lead's **Note** cell in the
   table (it saves when you click away). Generic mail gets marked as spam and
   burns your domain, so **Send next 5** skips any lead whose note is empty —
   it tells you how many it held back. Pass `{"force": true}` to `/api/send`
   if you ever deliberately want to override that gate.
4. Click **Send next 5** — that starts a background job which sends slowly
   (a random 30–180s between emails). Watch it in the log; if the queue hits
   three consecutive invalid addresses it pauses itself and a red banner appears
   with a **Clear cool down** button.

The tool tracks everything in `data.sqlite` (SQLite, WAL) and respects the daily limit.

## Extraction logic — decision makers first

The crawler does not value every address equally. Everything it actually finds is
scored, and that score sets the order you contact people in:

| Priority | Meaning | Examples |
|---|---|---|
| **high** | a person named on the site | `john.smith@` found next to "John Smith, Founder"; `jsmith@jsmithlaw.com` (the mailbox *is* the company name) |
| **normal** | plausible, unconfirmed | `weborders@`, two-token mailboxes with no name match |
| **low** | shared mailbox / dead end | `info@`, `support@`, `admin@`, `sales@`, `customersupport@`, `press@` |

- A name only counts when a title word sits next to it ("John Smith, Founder"),
  so nav labels like "Coffee Guide" never become people.
- The site's own mailbox style is detected (`first.last`, `first_last`, …); an
  address that follows it is reported as a convention match.
- **Low priority** addresses are filed separately (`lowPriority` in the API,
  `--skip-low` on the CLI) and are always queued *after* real people.
- Addresses **guessed** for a named person (`john@`, `jsmith@`, …) are
  suggestions only: they were never seen on the site, so they come back with
  `verified: false`, are **never imported as leads**, and must be verified by
  hand. Mailing a guess that bounces damages your domain.

## Sending pace — human delay jitter

Emails are never sent on a fixed interval. Between two sends the sender waits a
random **30–180 seconds** (`SEND_DELAY_MIN_MS` / `SEND_DELAY_MAX_MS`), so a batch
of five takes minutes rather than seconds.

Because of that, `POST /api/send` starts a **background job** and answers
`202 { jobId }` straight away; poll `GET /api/send/:jobId` for progress (the UI
does this for you):

```bash
curl -X POST localhost:3000/api/send -H 'content-type: application/json' -d '{"limit":5}'
curl localhost:3000/api/send/<jobId>
```

Only one send job runs at a time, and it stops early when the daily limit or a
cool down is reached.

## Automatic cool down

Three consecutive `invalid email` responses (`INVALID_STREAK_LIMIT`) mean the list
is bad, so sending freezes for an hour (`COOLDOWN_MINUTES`) instead of burning the
domain. The pause is stored in the database, so it survives a restart, and every
further send is refused with `409` until it expires:

```bash
curl -X POST localhost:3000/api/cooldown/clear   # release it manually
```

A successful send resets the streak. Provider/account errors ("API key is
invalid", 429s) are **not** counted as invalid addresses — that distinction is
what stops a dead API key from freezing the whole queue.

## Email verification (before the database)

`verifier.js` is a service layer that can check each discovered address against
NeverBounce or ZeroBounce **before it is written to the database**:

```
VERIFY_PROVIDER=neverbounce      # or zerobounce | mock | none (default)
NEVERBOUNCE_API_KEY=...
VERIFY_REJECT_INVALID=true       # an invalid verdict never becomes a lead
```

Every address is stored with a `verification_status` of `unverified`, `valid`,
`invalid` or `catchall` (badge in the UI, filterable in the send queue). Verdicts
are cached in the `verifications` table so the same address is never paid for
twice, and `invalid` leads are excluded from sending.

With `VERIFY_PROVIDER` unset this is a pass-through: `unverified`, no network
call, exactly the old behaviour. Verification never blocks a harvest — a timeout
or a 5xx reports `unverified` and the crawl carries on.

## Storage: SQLite

Leads live in `data.sqlite` (WAL mode), not JSON. That buys atomic writes, real
`UNIQUE(email)` deduplication and safe concurrent writers. On first run an
existing `data.json` is imported automatically and then **archived**, never
deleted:

```
[db] imported 12 lead(s) from the old JSON database into data.sqlite
[db] archived data.json → data.json.migrated
```

The import is idempotent (`INSERT OR IGNORE`), so re-running it cannot duplicate
anything or resurrect deleted leads. Set `DB_PATH` to use a different file, and
`LEGACY_JSON_PATH` to import from somewhere else.

## Running several jobs at once

Search jobs are independent: start several discoveries (`POST /api/discover`) or
scans at the same time and they run in parallel. SQLite serialises the writes
through a 5s busy timeout, and deduplication happens *inside* the database
(`INSERT ... ON CONFLICT DO NOTHING`), so two jobs can no longer read-modify-write
over each other and lose leads. The CLI can import while the server is running:

```bash
node scan.js https://example.com --add      # safe next to a live harvest
```

## CLI scraper

```bash
node scan.js https://plumber-in-dallas.com --pages 15
node scan.js https://example.com --csv leads.csv        # export (priority,kind,score,found_on)
node scan.js https://example.com --add                  # import into the UI
node scan.js https://example.com --skip-low --add        # drop info@/support@/sales@...
node scan.js https://example.com --guess                # list UNVERIFIED name guesses
node scan.js seeds.txt --from-file --add                # one seed URL per line
```

To get seed URLs at scale, use a search API (Brave Search API, SerpAPI, Google
Custom Search JSON API) — scraping Google directly violates their ToS and gets
your IP blocked.

## Compliance (read this before sending)

- **CAN-SPAM (US)**: every email needs a valid physical postal address
  (`MAILING_ADDRESS`), a working opt-out (built in — don't remove it), and
  honest header info. No deceptive subject lines.
- **GDPR / ePrivacy (EU)**: cold email to individuals in the EU without consent
  is illegal. Target business addresses (info@, owner@company.com) and skip EU
  leads unless you have a lawful basis.
- **Resend AUP**: their acceptable-use policy prohibits unsolicited bulk email.
  Keep volume low, personalize everything, honor unsubscribes instantly, and
  never send to purchased or leaked lists — that gets your account (and domain)
  banned, and using breached data is a crime in most jurisdictions.
- **robots.txt + rate limits**: the crawler respects both by design. Don't
  disable them.

