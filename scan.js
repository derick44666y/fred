#!/usr/bin/env node
// scan.js — CLI crawler. Extracts publicly listed business emails from a site.
//
// Usage:
//   node scan.js https://plumber-in-dallas.com
//   node scan.js https://example.com --pages 15 --csv leads.csv
//   node scan.js https://example.com --add          (import into the tool's DB)
//   node scan.js seeds.txt --from-file              (one seed URL per line)
//
// NOTE: keep volume low and personalize every email. Resend's acceptable-use
// policy prohibits unsolicited bulk email; CAN-SPAM/GDPR still apply.

import fs from 'fs';
import { crawlSite } from './crawler.js';
import { ingestLead } from './ingest.js';
import { isConfigured, providerName } from './verifier.js';

function parseArgs(argv) {
  const args = { pages: 10, csv: null, add: false, includeFree: false, fromFile: false, guess: false, skipLow: false, noVerify: false, seeds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pages') args.pages = Number(argv[++i]) || 10;
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--add') args.add = true;
    else if (a === '--include-free') args.includeFree = true;
    else if (a === '--from-file') args.fromFile = true;
    else if (a === '--guess') args.guess = true;
    else if (a === '--skip-low') args.skipLow = true;
    else if (a === '--no-verify') args.noVerify = true;
    else args.seeds.push(a);
  }
  return args;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.seeds.length === 0) {
    console.log('Usage: node scan.js <url> [--pages N] [--csv out.csv] [--add] [--include-free]');
    console.log('       node scan.js <url> [--skip-low]   # ignore info@/support@/sales@...');
    console.log('       node scan.js <url> [--guess]      # also list UNVERIFIED name guesses');
    console.log('       node scan.js <url> [--no-verify]  # skip the verification provider');
    console.log('       node scan.js seeds.txt --from-file [--csv out.csv] [--add]');
    process.exit(1);
  }

  let seeds = args.seeds;
  if (args.fromFile) {
    const file = seeds[0];
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }
    seeds = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }

  const allEmails = new Map(); // email -> { foundOn, sources, priority, kind, score, reason }

  for (const seed of seeds) {
    console.log(`\n Scanning: ${seed}`);
    try {
      const result = await crawlSite(seed, {
        maxPages: args.pages,
        includeFree: args.includeFree
      });
      console.log(` Pages scanned: ${result.pagesScanned}`);
      if (result.names.length) console.log(` People on site: ${result.names.join(', ')}`);

      for (const found of result.emails) {
        const { email, foundOn, priority, kind, score, reason } = found;
        if (!allEmails.has(email)) {
          allEmails.set(email, { foundOn: new Set(), sources: new Set(), priority, kind, score, reason });
        }
        const entry = allEmails.get(email);
        foundOn.forEach((u) => entry.foundOn.add(u));
        entry.sources.add(new URL(seed).hostname);
        console.log(`   [${priority}] ${email}  (${reason})  found on: ${foundOn[0]}`);
      }

      const low = result.lowPriority;
      if (low.length) {
        console.log(` Low priority folder (${low.length}) — shared mailboxes, keep digging past these:`);
        low.forEach((x) => console.log(`   ${x.email}`));
      }
      if (args.guess && result.guesses.length) {
        console.log(' Suggested (UNVERIFIED — never seen on the site, verify before use):');
        result.guesses.forEach((g) => console.log(`   ${g.email}   [${g.pattern}] for ${g.for_name}`));
      }
      if (result.emails.length === 0) console.log('   no emails found');
      for (const e of result.errors) console.log(`   ! ${e.url}: ${e.error}`);
    } catch (err) {
      console.error(` Error: ${err.message}`);
    }
  }

  console.log(`\n Total unique emails: ${allEmails.size}`);

  if (args.csv && allEmails.size > 0) {
    const rows = ['email,priority,kind,score,found_on,source_site'];
    for (const [email, { foundOn, sources, priority, kind, score }] of allEmails) {
      rows.push([
        csvEscape(email), csvEscape(priority), csvEscape(kind), csvEscape(score),
        csvEscape([...foundOn].join(' ')), csvEscape([...sources].join(' '))
      ].join(','));
    }
    fs.writeFileSync(args.csv, rows.join('\n') + '\n');
    console.log(` CSV written: ${args.csv} (priority high = person named on the site)`);
  }

  if (args.add && allEmails.size > 0) {
    let added = 0;
    let skippedLow = 0;
    let rejected = 0;
    const addedByPriority = { high: 0, normal: 0, low: 0 };
    const byVerification = { unverified: 0, valid: 0, invalid: 0, catchall: 0 };

    for (const [email, { foundOn, sources, priority, kind, score, reason }] of allEmails) {
      if (args.skipLow && priority === 'low') {
        skippedLow++;
        continue;
      }
      const first = [...foundOn][0] || '';

      // Verification service runs here — before the address is stored.
      const outcome = await ingestLead(
        { email, foundOn, priority, kind, score, reason },
        { company: [...sources][0] || '', sourceUrl: first, verify: !args.noVerify }
      );

      byVerification[outcome.verification_status] = (byVerification[outcome.verification_status] || 0) + 1;
      if (outcome.rejected) {
        rejected++;
        console.log(`   rejected (${outcome.verification_status}): ${email} — ${outcome.detail}`);
        continue;
      }
      if (outcome.added) {
        added++;
        addedByPriority[priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'normal']++;
      }
    }

    console.log(` Added ${added} new leads (${allEmails.size - added - skippedLow - rejected} duplicates skipped)`);
    console.log(`   priority: ${addedByPriority.high} decision maker(s), ${addedByPriority.normal} unconfirmed, ${addedByPriority.low} role mailbox(es)`);
    console.log(`   verification: ${byVerification.valid} valid, ${byVerification.catchall} catch-all, ${byVerification.invalid} invalid, ${byVerification.unverified} unverified`);
    if (rejected) console.log(`   ${rejected} invalid address(es) never entered the database`);
    if (skippedLow) console.log(`   --skip-low dropped ${skippedLow} shared mailbox(es)`);
    console.log(' Reminder: personalize each lead before hitting send.');
  }
}

main();
