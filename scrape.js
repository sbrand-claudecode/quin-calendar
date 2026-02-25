#!/usr/bin/env node
/**
 * Quin House Events → ICS Calendar Scraper
 *
 * Uses Playwright to log in via the member portal (handles Google/OAuth),
 * extracts the Peoplevine JWT from localStorage, fetches all events from
 * the JSON API, and writes a calendar.ics file for Google Calendar.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const he = require('he');

const BASE_URL = 'https://members.thequinhouse.com';
const EMAIL = process.env.QUIN_EMAIL;
const PASSWORD = process.env.QUIN_PASSWORD;
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'public');

if (!EMAIL || !PASSWORD) {
  console.error('Missing QUIN_EMAIL or QUIN_PASSWORD environment variables');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return '';
  return he.decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
  ).trim();
}

function toIcsDate(localDateStr) {
  // localDateStr is like "2026-02-27T17:00:00" (already in ET)
  // We'll output as floating local time (no Z) with TZID
  return localDateStr.replace(/[-:]/g, '').replace('T', 'T').split('.')[0];
}

function toIcsDateOnly(datePart) {
  // datePart is 'YYYY-MM-DD' → 'YYYYMMDD' (for all-day VALUE=DATE events)
  return datePart.replace(/-/g, '');
}

function nextDayIcs(datePart) {
  // Returns 'YYYYMMDD' for the calendar day after datePart (ICS exclusive-end for all-day events)
  const d = new Date(datePart + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function formatTime(timeStr) {
  // timeStr like "10:00:00" → "10:00 AM"  /  "18:30:00" → "6:30 PM"
  const [h, min] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  const minStr = min > 0 ? `:${String(min).padStart(2, '0')}` : '';
  return `${hour12}${minStr} ${ampm}`;
}

function getDurationHours(startTimeStr, endTimeStr) {
  // Both strings are 'HH:MM:SS'; returns decimal hours (end − start)
  const [sh, sm] = startTimeStr.split(':').map(Number);
  const [eh, em] = endTimeStr.split(':').map(Number);
  return (eh + em / 60) - (sh + sm / 60);
}

function escapeIcs(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function foldLine(line) {
  // ICS spec: lines max 75 octets, fold with CRLF + space
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line + '\r\n';
  const chunks = [];
  let start = 0;
  while (start < bytes.length) {
    const limit = start === 0 ? 75 : 74;
    chunks.push(bytes.slice(start, start + limit).toString('utf8'));
    start += limit;
  }
  return chunks.join('\r\n ') + '\r\n';
}

function buildDescription(event, timeNote) {
  // timeNote: optional string like "10:00 AM – 6:00 PM", shown for all-day (4 h+) events
  const parts = [];

  // Category
  if (event.categories && event.categories.length > 0) {
    parts.push(`Category: ${event.categories.map(c => c.name).join(', ')}`);
  }

  // Price / ticket info
  if (event.tickets && event.tickets.length > 0) {
    const ticket = event.tickets[0];
    if (ticket.pricing && ticket.pricing.base_price > 0) {
      parts.push(`Price: $${ticket.pricing.base_price.toFixed(2)} per person`);
    } else if (ticket.pricing && ticket.pricing.base_price === 0) {
      parts.push('Price: Free');
    } else {
      parts.push('Price: RSVP (see event page)');
    }
    if (ticket.available_quantity > 0) {
      parts.push(`Availability: ${ticket.available_quantity} spot${ticket.available_quantity !== 1 ? 's' : ''} left`);
    }
  } else {
    parts.push('Price: Free / Included');
  }

  // Personal registration status takes precedence over event-level status
  const isConfirmed  = event.registered === true;
  const isOnWaitlist = event.waitlist && event.waitlist.id;

  if (isConfirmed) {
    parts.push('Status: You are Confirmed');
  } else if (isOnWaitlist) {
    parts.push('Status: You are on Waitlist');
  } else {
    // Fall back to event-level availability status
    const avail = event.availability;
    if (avail === 'sold_out') {
      parts.push('Status: Sold Out');
    } else if (avail === 'waitlist') {
      parts.push('Status: Waitlist Only');
    } else if (avail === 'available') {
      parts.push('Status: Available');
    } else if (avail && avail.toLowerCase().includes('unavailable')) {
      parts.push('Status: Unavailable');
    } else if (avail) {
      parts.push(`Status: ${avail}`);
    }
  }

  // Time note (inserted for all-day events that span 4+ hours)
  if (timeNote) {
    parts.push(`Time: ${timeNote}`);
  }

  // Event URL
  parts.push(`Event URL: ${BASE_URL}/events/${event.id}`);

  // Separator
  parts.push('');

  // Full description
  const desc = stripHtml(event.description);
  if (desc) parts.push(desc);

  return parts.join('\n');
}

function buildIcs(events, calendarName = "The 'Quin House Events") {
  const lines = [];

  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//Quin House Calendar//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:${calendarName}`);
  lines.push('X-WR-TIMEZONE:America/New_York');
  lines.push('X-WR-CALDESC:Upcoming programming at The \'Quin House member club');

  for (const event of events) {
    const startLocal = event.start_date_local;
    const endLocal = event.end_date_local;

    if (!startLocal || !startLocal.date) continue;

    const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const title = event.title || 'Quin House Event';
    const venue = event.venue ? event.venue.trim() : '';

    // Split ISO-like strings into date and time parts
    const startDatePart = startLocal.date.split('T')[0];               // 'YYYY-MM-DD'
    const startTimePart = (startLocal.date.split('T')[1] || '00:00:00').split('.')[0]; // 'HH:MM:SS'
    const endDatePart   = endLocal && endLocal.date ? endLocal.date.split('T')[0] : startDatePart;
    const endTimePart   = endLocal && endLocal.date
      ? (endLocal.date.split('T')[1] || startTimePart).split('.')[0]
      : startTimePart;

    const isMultiDay    = startDatePart !== endDatePart;

    // For single-day events: all-day if the event runs 4+ hours
    const durationHours = getDurationHours(startTimePart, endTimePart);
    const isAllDay      = isMultiDay || durationHours >= 4;

    // Time note added to the description whenever the event has no clock times shown
    const timeNote = isAllDay
      ? `${formatTime(startTimePart)} \u2013 ${formatTime(endTimePart)}`
      : null;

    const uid         = `quin-event-${event.id}@thequinhouse.com`;
    const description = buildDescription(event, timeNote);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${now}`);

    if (isAllDay) {
      // All-day / multi-day: VALUE=DATE, no time component, no TZID.
      // For multi-day events DTEND is the day after the last day (ICS exclusive-end convention).
      lines.push(`DTSTART;VALUE=DATE:${toIcsDateOnly(startDatePart)}`);
      lines.push(`DTEND;VALUE=DATE:${nextDayIcs(endDatePart)}`);
    } else {
      // Short single-day event: keep the precise start/end times
      lines.push(`DTSTART;TZID=America/New_York:${toIcsDate(startLocal.date)}`);
      lines.push(`DTEND;TZID=America/New_York:${endLocal && endLocal.date ? toIcsDate(endLocal.date) : toIcsDate(startLocal.date)}`);
    }

    lines.push(`SUMMARY:${escapeIcs(title)}`);
    if (venue) lines.push(`LOCATION:${escapeIcs(venue)}`);
    lines.push(`DESCRIPTION:${escapeIcs(description)}`);
    lines.push(`URL:${BASE_URL}/events/${event.id}`);
    if (event.categories && event.categories.length > 0) {
      lines.push(`CATEGORIES:${event.categories.map(c => escapeIcs(c.name)).join(',')}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function getToken(page) {
  // Navigate to login page
  console.log('  Navigating to login page...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  console.log('  Current URL:', page.url());

  console.log('  Waiting for email field...');
  await page.waitForSelector('input[type="text"]', { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Step 1: Enter email and submit
  console.log('  Filling email...');
  await page.fill('input[type="text"]', EMAIL);
  await page.waitForTimeout(800);
  console.log('  Pressing Enter to submit email...');
  await page.keyboard.press('Enter');

  console.log('  Waiting for password field...');
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  console.log('  Password field appeared, current URL:', page.url());
  await page.waitForTimeout(800);

  // Step 2: Enter password and submit
  console.log('  Filling password...');
  await page.fill('input[type="password"]', PASSWORD);
  await page.waitForTimeout(800);
  console.log('  Pressing Enter to submit password...');
  await page.keyboard.press('Enter');

  // Wait for redirect away from login
  console.log('  Waiting for post-login redirect...');
  try {
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 45000 });
  } catch (err) {
    // Take a screenshot to see what the page looks like
    const screenshotPath = path.join(OUT_DIR, 'login-debug.png');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.error('  Login redirect timed out. Current URL:', page.url());
    console.error('  Page title:', await page.title());
    console.error('  Screenshot saved to:', screenshotPath);
    // Log visible text to help diagnose
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    console.error('  Page body text:', bodyText);
    // Log all input values and any error/alert elements
    const debug = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')].map(i => `${i.type}="${i.value}"`);
      const alerts = [...document.querySelectorAll('[class*="error"],[class*="alert"],[class*="message"],[role="alert"]')]
        .map(el => el.innerText);
      return { inputs, alerts };
    });
    console.error('  Input values:', JSON.stringify(debug.inputs));
    console.error('  Error/alert elements:', JSON.stringify(debug.alerts));
    throw err;
  }
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  console.log('  Redirected to:', page.url());

  // Extract token from localStorage
  const raw = await page.evaluate(() => localStorage.getItem('pv.token'));
  if (!raw) throw new Error('Could not find pv.token in localStorage after login');

  const parsed = JSON.parse(raw);
  const tokenB64 = parsed['\u0000'];
  return atob(tokenB64);
}

// atob polyfill for Node
function atob(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

async function fetchAllEvents(token) {
  const { default: fetch } = await import('node-fetch');

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  };

  // Fetch all events (API max is 100 per page)
  const listUrl = `${BASE_URL}/api/events?group=events&order_by=start_date&page_size=100&page_number=1`;
  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok) {
    const body = await listRes.text();
    throw new Error(`Events list failed: ${listRes.status} - ${body}`);
  }
  const events = await listRes.json();

  console.log(`Fetched ${events.length} events from listing`);

  // Fetch detail for each event (for full description + ticket pricing)
  const detailed = [];
  for (const event of events) {
    try {
      const detailRes = await fetch(`${BASE_URL}/api/events/${event.id}`, { headers });
      if (detailRes.ok) {
        const detail = await detailRes.json();
        // DIAGNOSTIC: log all personal-status-related fields for specific events
        if ([173774, 167495].includes(event.id)) {
          const keys = Object.keys(detail);
          console.log(`DIAG event ${event.id} keys: ${keys.join(', ')}`);
          console.log(`DIAG event ${event.id}: registered=${JSON.stringify(detail.registered)}`);
          console.log(`DIAG event ${event.id}: waitlist=${JSON.stringify(detail.waitlist)}`);
          // Log any field that might indicate personal enrollment
          const personalFields = ['my_order','my_waitlist','consumer_event','user_registered','user_waitlist','order','order_id','waitlist_order','waitlist_id','member_waitlist','personal'];
          for (const f of personalFields) {
            if (detail[f] !== undefined) console.log(`DIAG event ${event.id}: ${f}=${JSON.stringify(detail[f])}`);
          }
        }
        detailed.push(detail);
      } else {
        console.warn(`  Could not fetch detail for event ${event.id}: ${detailRes.status}`);
        detailed.push(event);
      }
    } catch (err) {
      console.warn(`  Error fetching event ${event.id}:`, err.message);
      detailed.push(event);
    }
  }

  return detailed;
}

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  let token;
  try {
    console.log('Logging in to Quin House member portal...');
    token = await getToken(page);
    console.log('Login successful, token acquired');
  } finally {
    await browser.close();
  }

  console.log('Fetching events from API...');
  const events = await fetchAllEvents(token);
  console.log(`Processing ${events.length} events`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const outPath = path.join(OUT_DIR, 'calendar.ics');
  fs.writeFileSync(outPath, buildIcs(events), 'utf8');
  console.log(`Written: ${outPath} (${events.length} events)`);

  // Personal calendar — only events the user is registered for or waitlisted on
  const personalEvents = events.filter(e =>
    e.registered === true || (e.waitlist && e.waitlist.id)
  );
  const personalPath = path.join(OUT_DIR, 'quin.ics');
  fs.writeFileSync(personalPath, buildIcs(personalEvents, 'Quin'), 'utf8');
  console.log(`Written: ${personalPath} (${personalEvents.length} personal events)`);

  // Also write a simple index.html for the GitHub Pages root
  const indexPath = path.join(OUT_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `<!DOCTYPE html>
<html>
<head><title>Quin House Calendar</title></head>
<body>
<h2>The 'Quin House Events Calendar</h2>
<p>Subscribe to this calendar in Google Calendar using the URL:</p>
<code id="url"></code>
<script>
  const u = window.location.href.replace('index.html','') + 'calendar.ics';
  document.getElementById('url').textContent = u;
</script>
</body>
</html>`, 'utf8');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
