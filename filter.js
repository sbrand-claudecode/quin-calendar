#!/usr/bin/env node
/**
 * filter.js — Generate a personal quin.ics from the published calendar.ics
 *
 * No credentials required. Fetches calendar.ics from GitHub Pages, keeps only
 * events where you are confirmed or on the waitlist, and writes quin.ics to the
 * current directory for import into Apple Calendar.
 *
 * Usage:
 *   npm run filter          (or: node filter.js)
 *
 * Then double-click quin.ics in Finder to import into Apple Calendar.
 */

const https = require('https');
const fs = require('fs');

const CALENDAR_URL = 'https://sbrand-claudecode.github.io/quin-calendar/calendar.ics';
const OUT_FILE = './quin.ics';

console.log(`Fetching ${CALENDAR_URL} ...`);

https.get(CALENDAR_URL, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Failed to fetch calendar: HTTP ${res.statusCode}`);
    process.exit(1);
  }

  let raw = '';
  res.on('data', chunk => { raw += chunk; });
  res.on('end', () => {
    // Unfold ICS line continuations (CRLF + space/tab → single line)
    const unfolded = raw.replace(/\r\n[ \t]/g, '');

    // Extract individual VEVENT blocks
    const eventBlocks = [...unfolded.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)]
      .map(m => m[0]);

    // Keep only events where the user is personally registered or waitlisted
    const personal = eventBlocks.filter(block =>
      block.includes('Status: You are Confirmed') ||
      block.includes('Status: You are on Waitlist')
    );

    if (personal.length === 0) {
      console.log('No confirmed or waitlisted events found in calendar.ics.');
      console.log('Make sure the GitHub Actions workflow has run recently.');
      process.exit(0);
    }

    // Wrap in a VCALENDAR envelope named "Quin"
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Quin House Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Quin',
      'X-WR-TIMEZONE:America/New_York',
      ...personal,
      'END:VCALENDAR',
    ];

    fs.writeFileSync(OUT_FILE, lines.join('\r\n') + '\r\n', 'utf8');
    console.log(`Written: ${OUT_FILE} (${personal.length} personal event${personal.length !== 1 ? 's' : ''})`);
    console.log('Double-click quin.ics in Finder to import into Apple Calendar.');
  });
}).on('error', (err) => {
  console.error('Network error:', err.message);
  process.exit(1);
});
