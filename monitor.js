#!/usr/bin/env node
/**
 * monitor.js — Detect availability transitions between calendar runs.
 *
 * Compares the currently-published calendar.ics on GitHub Pages (the "before"
 * state from the prior run) against the freshly-scraped ./public/calendar.ics
 * (the "after" state). Flags events where:
 *
 *   old Status was "Sold Out" or "Waitlist Only"
 *   AND new description contains "Availability: N spot(s) left" with N >= 1
 *
 * When any transitions are found, writes email_subject.txt and email_body.txt
 * for the workflow's email-sending step to consume. When none are found, no
 * files are written (the workflow skips the email step).
 */

const fs = require('fs');
const https = require('https');

const PREVIOUS_URL = 'https://sbrand-claudecode.github.io/quin-calendar/calendar.ics';
const NEW_FILE = process.env.NEW_ICS || './public/calendar.ics';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function unescapeIcsText(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function extractField(block, field) {
  const regex = new RegExp(`^${field}(?:;[^:\\r\\n]*)?:(.*)$`, 'm');
  const m = block.match(regex);
  return m ? m[1].trim() : null;
}

function extractDescLine(desc, label) {
  const regex = new RegExp(`^${label}:\\s*(.+)$`, 'm');
  const m = desc.match(regex);
  return m ? m[1].trim() : null;
}

function parseEvents(icsText) {
  const unfolded = icsText.replace(/\r\n[ \t]/g, '');
  const blocks = [...unfolded.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)].map((m) => m[0]);
  const events = {};
  for (const block of blocks) {
    const uid = extractField(block, 'UID');
    if (!uid) continue;
    const summary = extractField(block, 'SUMMARY') || '(untitled)';
    const dtstart = extractField(block, 'DTSTART');
    const descRaw = extractField(block, 'DESCRIPTION') || '';
    const desc = unescapeIcsText(descRaw);
    events[uid] = {
      uid,
      summary: unescapeIcsText(summary),
      dtstart,
      status: extractDescLine(desc, 'Status'),
      availability: extractDescLine(desc, 'Availability'),
      url: extractDescLine(desc, 'Event URL'),
    };
  }
  return events;
}

function parseSpots(availability) {
  if (!availability) return 0;
  const m = availability.match(/(\d+)\s+spot/);
  return m ? parseInt(m[1], 10) : 0;
}

function formatDtstart(dtstart) {
  if (!dtstart) return '';
  const m = dtstart.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!m) return dtstart;
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +(hh || 12), +(mm || 0)));
  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York',
  });
  if (hh) {
    const timeStr = date.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    });
    return `${dateStr} at ${timeStr}`;
  }
  return dateStr;
}

// Short date for inclusion in the email subject. Matches the format the
// cleanup workflow parses out of the subject ("Mon DD, YYYY").
function formatDateForSubject(dtstart) {
  if (!dtstart) return null;
  const m = dtstart.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, 12));
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York',
  });
}

async function main() {
  let oldIcs;
  try {
    oldIcs = await fetchUrl(PREVIOUS_URL);
  } catch (e) {
    console.log(`Could not fetch previous calendar (${e.message}) — skipping transition check (likely first run or Pages not yet live).`);
    return;
  }

  if (!fs.existsSync(NEW_FILE)) {
    console.log(`New calendar not found at ${NEW_FILE} — scraper may have failed. Skipping.`);
    return;
  }
  const newIcs = fs.readFileSync(NEW_FILE, 'utf8');

  const oldEvents = parseEvents(oldIcs);
  const newEvents = parseEvents(newIcs);

  const transitions = [];
  for (const uid of Object.keys(newEvents)) {
    const oldEv = oldEvents[uid];
    if (!oldEv) continue;
    const newEv = newEvents[uid];

    const wasClosed =
      oldEv.status === 'Sold Out' || oldEv.status === 'Waitlist Only';
    const nowSpots = parseSpots(newEv.availability);

    if (wasClosed && nowSpots > 0) {
      transitions.push({
        summary: newEv.summary,
        dtstart: formatDtstart(newEv.dtstart),
        dtstartRaw: newEv.dtstart,
        spots: nowSpots,
        priorStatus: oldEv.status,
        url: newEv.url,
      });
    }
  }

  if (transitions.length === 0) {
    console.log('No availability transitions detected.');
    return;
  }

  console.log(`Detected ${transitions.length} transition(s):`);
  for (const t of transitions) {
    console.log(`  - ${t.summary} (${t.priorStatus} -> ${t.spots} spot(s) left)`);
  }

  const bodyLines = [];
  const header = transitions.length === 1
    ? `A Quin House event just opened up:`
    : `${transitions.length} Quin House events just opened up:`;
  bodyLines.push(header);
  bodyLines.push('');
  for (const t of transitions) {
    bodyLines.push(`• ${t.summary}`);
    bodyLines.push(`  When: ${t.dtstart}`);
    bodyLines.push(`  Was: ${t.priorStatus}  →  Now: ${t.spots} spot${t.spots !== 1 ? 's' : ''} left`);
    if (t.url) bodyLines.push(`  ${t.url}`);
    bodyLines.push('');
  }
  bodyLines.push('—');
  bodyLines.push('Automated notification from quin-calendar monitor.');

  let subject;
  if (transitions.length === 1) {
    const dateStr = formatDateForSubject(transitions[0].dtstartRaw);
    subject = dateStr
      ? `[quin-monitor] Spots opened (${dateStr}): ${transitions[0].summary}`
      : `[quin-monitor] Spots opened: ${transitions[0].summary}`;
  } else {
    subject = `[quin-monitor] Spots opened for ${transitions.length} events`;
  }

  // Append a trailing newline to both files so the workflow's heredoc-style
  // $GITHUB_OUTPUT blocks have the closing delimiter on its own line.
  // Without it, cat + echo concatenates delimiter onto the last content line
  // and GitHub Actions rejects the output with "Matching delimiter not found".
  fs.writeFileSync('email_subject.txt', subject + '\n', 'utf8');
  fs.writeFileSync('email_body.txt', bodyLines.join('\n') + '\n', 'utf8');
}

main().catch((e) => {
  console.error('monitor.js error:', e.message);
  process.exit(1);
});
