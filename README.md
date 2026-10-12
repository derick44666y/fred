# Cold Outreach (Resend)

Simple, low-volume cold email tool. 50 emails/day safe limit.

## Quick start

```bash
cd coldmail
cp .env.example .env
# edit .env → put your real Resend API key + verified From address
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
```

Your domain **must** be verified in Resend (SPF + DKIM) or mail goes to spam.

## How to use

1. Open the web UI
2. Add leads (email + name + company + a real note)
3. Click **Send next 5**

The tool tracks everything in `data.json` and respects the daily limit.
