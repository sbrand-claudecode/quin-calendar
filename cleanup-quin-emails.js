#!/usr/bin/env node
/**
 * cleanup-quin-emails.js — Daily Gmail housekeeping for the "Quin" label.
 *
 * Deletes (moves to Trash) three categories of message under the Quin label:
 *
 *   1. "New event: <title> @ <date>" Google Calendar notifications whose
 *      event date is strictly before today (ET).
 *
 *   2. "[quin-monitor] Spots opened (<date>): <title>" — new subject format.
 *      Deletes when the date is strictly before today (ET).
 *
 *   3. "[quin-monitor] Spots opened: <title>" — legacy subject without date.
 *      Falls back to parsing the body's "When:" line.
 *
 *   4. "[quin-monitor] Spots opened for N events" — multi-event digest.
 *      Parses every "When:" line in the body; deletes only when ALL events
 *      are strictly before today.
 *
 * Plus a dedup pass: among single-event [quin-monitor] emails grouped by
 * normalized title, keeps the most recent and deletes older copies even
 * when the event hasn't passed.
 *
 * Auth: reuses QUIN_EMAIL + GMAIL_APP_PASSWORD via IMAP. No new secrets.
 * Set DRY_RUN=1 to log decisions without moving messages to Trash.
 */

const { ImapFlow } = require('imapflow');

const USER = (process.env.GMAIL_USER || '').trim();
const PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const LABEL = process.env.QUIN_LABEL || 'Quin';
const TRASH = '[Gmail]/Trash';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!USER || !PASS) {
  console.error('Missing GMAIL_USER or GMAIL_APP_PASSWORD');
  process.exit(1);
}

const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const DATE_RE = new RegExp(
  `(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\\s+)?(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})`,
  'i'
);

function extractDate(text) {
  if (!text) return null;
  const m = text.match(DATE_RE);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00:00 UTC`);
  return isNaN(d.getTime()) ? null : d;
}

function dateToYMD_ET(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function todayYMD_ET() {
  return dateToYMD_ET(new Date());
}

function parseSubject(subject) {
  if (!subject) return { kind: 'other' };
  let m;

  m = subject.match(/^\[quin-monitor\]\s+Spots opened\s+\(([^)]+)\):\s+(.+)$/);
  if (m) return { kind: 'monitor-single', date: extractDate(m[1]), title: m[2].trim() };

  m = subject.match(/^\[quin-monitor\]\s+Spots opened:\s+(.+)$/);
  if (m) return { kind: 'monitor-single', date: null, title: m[1].trim() };

  m = subject.match(/^\[quin-monitor\]\s+Spots opened for \d+ events?\b/);
  if (m) return { kind: 'monitor-multi' };

  m = subject.match(/^New event:\s+(.+?)\s+@\s+(.+)$/);
  if (m) return { kind: 'new-event', title: m[1].trim(), date: extractDate(m[2]) };

  return { kind: 'other' };
}

function parseWhenDates(rawSource) {
  const re = /When:\s+([^\r\n]+)/g;
  const dates = [];
  let m;
  while ((m = re.exec(rawSource)) !== null) {
    const d = extractDate(m[1]);
    if (d) dates.push(d);
  }
  return dates;
}

async function fetchSourceText(client, uid) {
  const msg = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!msg || !msg.source) return '';
  return Buffer.isBuffer(msg.source) ? msg.source.toString('utf8') : String(msg.source);
}

async function main() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: USER, pass: PASS },
    logger: false,
  });

  await client.connect();
  console.log(`Connected as ${USER}; opening label "${LABEL}"`);

  const lock = await client.getMailboxLock(LABEL);
  const today = todayYMD_ET();
  console.log(`Today (ET): ${today}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const toDelete = new Set();
  const singleEvents = [];
  const reasons = new Map();
  const titlesSeen = new Set();

  try {
    let total = 0;
    for await (const msg of client.fetch('1:*', {
      envelope: true,
      uid: true,
      internalDate: true,
    })) {
      total += 1;
      const subj = msg.envelope && msg.envelope.subject;
      const parsed = parseSubject(subj);

      if (parsed.kind === 'new-event') {
        if (parsed.date) {
          const ymd = dateToYMD_ET(parsed.date);
          if (ymd < today) {
            toDelete.add(msg.uid);
            reasons.set(msg.uid, `new-event past (${ymd}): ${parsed.title}`);
          }
        }
      } else if (parsed.kind === 'monitor-single') {
        let date = parsed.date;
        if (!date) {
          const src = await fetchSourceText(client, msg.uid);
          const dates = parseWhenDates(src);
          if (dates.length > 0) date = dates[0];
        }
        const title = parsed.title;
        titlesSeen.add(title);
        singleEvents.push({ uid: msg.uid, title, date, internalDate: msg.internalDate });
        if (date && dateToYMD_ET(date) < today) {
          toDelete.add(msg.uid);
          reasons.set(msg.uid, `monitor-single past (${dateToYMD_ET(date)}): ${title}`);
        }
      } else if (parsed.kind === 'monitor-multi') {
        const src = await fetchSourceText(client, msg.uid);
        const dates = parseWhenDates(src);
        if (dates.length > 0 && dates.every((d) => dateToYMD_ET(d) < today)) {
          toDelete.add(msg.uid);
          reasons.set(msg.uid, `monitor-multi all past (${dates.length} events)`);
        }
      }
    }
    console.log(`Scanned ${total} messages under "${LABEL}"`);

    // Dedup single-event [quin-monitor] emails: keep newest per title.
    const byTitle = new Map();
    for (const e of singleEvents) {
      if (!byTitle.has(e.title)) byTitle.set(e.title, []);
      byTitle.get(e.title).push(e);
    }
    for (const [title, list] of byTitle) {
      if (list.length < 2) continue;
      list.sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0));
      for (let i = 1; i < list.length; i++) {
        if (!toDelete.has(list[i].uid)) {
          toDelete.add(list[i].uid);
          reasons.set(list[i].uid, `superseded by newer [quin-monitor] for: ${title}`);
        }
      }
    }

    for (const uid of toDelete) {
      console.log(`  delete uid=${uid}  ${reasons.get(uid) || ''}`);
    }
    console.log(`Total to delete: ${toDelete.size}`);

    if (toDelete.size && !DRY_RUN) {
      const uids = [...toDelete];
      await client.messageMove(uids, TRASH, { uid: true });
      console.log(`Moved ${uids.length} message(s) to ${TRASH}`);
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

main().catch((e) => {
  console.error('cleanup-quin-emails.js error:', e && e.stack || e);
  process.exit(1);
});
