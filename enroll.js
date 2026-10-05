// Quin House event auto-enrollment. Design: QUIN-ENROLLMENT-HANDOFF.md (one folder up).
//
//   node enroll.js check   Sheet only — no Quin token spent. Runs every 15 min and
//                          decides whether the `enroll` job should start ("arm").
//   node enroll.js run     Mints a Quin token, fills in "Opens (ET)", sleeps until each
//                          ticket's exact on_sale time, enrolls, writes the result back
//                          to the sheet, and notifies via ntfy + Gmail.
//
// THIS REPO IS PUBLIC — Actions logs are world-readable. Never log event names,
// event ids, ticket names or tokens; refer to sheet rows ("row 5") and counts only.
// Details go to the sheet, ntfy and email, which are private.

const fs = require('fs');
const path = require('path');
const { BASE_URL, createTokenMinter } = require('./quin-auth');
const { createSheetClient } = require('./google-sheets');

const TZ = 'America/New_York';
const MINUTE = 60 * 1000;
const ARM_WINDOW_MS = 75 * MINUTE;       // arm this far ahead of an opening
const LOOKAHEAD_SLACK_MS = 5 * MINUTE;   // the run job starts a few minutes after its check
const JOB_BUDGET_MS = 95 * MINUTE;       // stay under the workflow's timeout-minutes (110)
const PRE_OPEN_MS = 2 * MINUTE;          // fresh token + cart check this long before opening
const HEARTBEAT_MS = 10 * MINUTE;        // healthchecks.io ping interval while waiting
const ADD_RETRY_WINDOW_MS = 3 * MINUTE;  // keep retrying add-to-cart this long
const MONDAY_PING_START = '08:45';       // ET window in which check runs ping healthchecks
const MONDAY_PING_END = '10:15';
const MONDAY_NOTE_AFTER = '10:15';       // ET; "nothing opened today" note after this
const PAT_WARN_DAYS = 30;
const MARKER_FILE = path.join(__dirname, '.enroll-monday-note');
const WORKFLOW_FILE = 'enroll-quin-events.yml';

// Sheet layout mirrors quin_events.xlsx: header on row 3, data from row 4.
// Event rows are recognised by an /events/<id> URL in column B, so the title,
// instructions and "Status key" rows are ignored automatically.
// Column H "Max $ per ticket" is Steve's per-event spending authorization;
// blank means free events only.
const COL = { name: 0, url: 1, guests: 2, active: 3, status: 4, notes: 5, opens: 6, maxPerTicket: 7 };
const READ_RANGE = 'A1:H500';
const ON_SALE_NOW = 'on sale now';
const SHEET_STATUS = { enrolled: 'Enrolled', already: 'Enrolled', skipped: 'Skipped', failed: 'Failed' };
const OUTCOME_LABEL = {
  enrolled: '✅ Enrolled', already: '✅ Already registered', skipped: '⏭️ Skipped',
  failed: '❌ Failed', later: '🕒 Not yet', 'dry-run': '🔎 Dry run',
};

const env = process.env;
const DRY_RUN = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
// Master switch for paid checkout (repo variable). Off unless exactly "true";
// even when on, a row pays only if column H authorizes the price.
const PAID_ENABLED = (env.QUIN_ALLOW_PAID || '').trim().toLowerCase() === 'true';
const TARGET_ROW = parseInt(env.TARGET_ROW || '', 10) || null;
// cron-job.org starts runs through the workflow_dispatch API (GitHub's own
// scheduler ran ~4% of slots on 9/28–29) and marks them source=cron-job;
// a login-refused retry (see retryShortly) marks itself source=retry. Both
// must behave exactly like scheduled runs, not like manual ones.
const IS_RETRY = env.TRIGGER_SOURCE === 'retry';
const IS_MANUAL = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.TRIGGER_SOURCE !== 'cron-job' && !IS_RETRY;
const RETRY_DELAY_MS = 60 * 1000;
const JOB_START = Date.now();

// ---------- time (all human-facing times are America/New_York) ----------

function etParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return p;
}

// ET wall-clock minus UTC, in ms (-4h during EDT, -5h during EST).
function etOffsetMs(date) {
  const p = etParts(date);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-10-05 10:00:00 ET" — what the Opens column holds.
function formatOpens(date) {
  const p = etParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ET`;
}

function parseOpens(text) {
  const s = (text || '').trim();
  if (!s) return null;
  if (s.toLowerCase() === ON_SALE_NOW) return new Date(0);
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = wall - etOffsetMs(new Date(wall));
  t = wall - etOffsetMs(new Date(t)); // second pass settles DST-boundary days
  return new Date(t);
}

function human(date) {
  if (date.getTime() <= Date.now()) return 'now (already on sale)';
  return date.toLocaleString('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  }) + ' ET';
}

function stamp(date = new Date()) {
  return date.toLocaleString('en-US', {
    timeZone: TZ, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  }) + ' ET';
}

function etDate(date) {
  const p = etParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function etHHMM(date) {
  const p = etParts(date);
  return `${p.hour}:${p.minute}`;
}

const isMondayET = (date) => etParts(date).weekday === 'Mon';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function sleepUntil(ts, { heartbeat = false } = {}) {
  for (;;) {
    if (heartbeat && ts - Date.now() > 30 * 1000) await pingHealthcheck();
    const left = ts - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(left, HEARTBEAT_MS));
  }
}

// ---------- sheet ----------

function sheetClient() {
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_JSON', 'QUIN_SHEET_ID']) {
    if (!env[k] || !env[k].trim()) throw new Error(`${k} secret is not set`);
  }
  return createSheetClient({
    serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    spreadsheetId: env.QUIN_SHEET_ID.trim(),
    tab: (env.QUIN_SHEET_TAB || '').trim() || 'Events',
  });
}

function parseRows(values) {
  const rows = [];
  values.forEach((cells, i) => {
    const cell = (c) => String(cells[c] ?? '').trim();
    const m = /\/events\/(\d+)/.exec(cell(COL.url));
    if (!m) return;
    const requested = parseInt(cell(COL.guests), 10);
    // "$100", "100", "$1,250.00" → number; blank or unparseable → null (free only).
    const maxText = cell(COL.maxPerTicket).replace(/[$,\s]/g, '');
    const maxPerTicket = /^\d+(\.\d+)?$/.test(maxText) ? Number(maxText) : null;
    rows.push({
      row: i + 1,
      name: cell(COL.name) || `event ${m[1]}`,
      eventId: m[1],
      // "Number of Guests (incl. yourself)"; blank or nonsense means just you.
      requested: Number.isFinite(requested) && requested >= 1 ? requested : 1,
      maxPerTicket,
      active: /^y/i.test(cell(COL.active)),
      status: cell(COL.status),
      opensText: cell(COL.opens),
      opensAt: parseOpens(cell(COL.opens)),
    });
  });
  return rows;
}

const isPending = (r) => r.status === '' || /^pending$/i.test(r.status);

async function recordOutcome(sheet, r, o, alerts) {
  try {
    if (o.newOpens) await sheet.write(`G${r.row}`, [[formatOpens(o.newOpens)]]);
    const status = SHEET_STATUS[o.outcome];
    if (!status || o.keepPending) return;
    const retry = status === 'Enrolled' ? '' : ' Set Status back to Pending to retry.';
    await sheet.write(`E${r.row}:F${r.row}`, [[status, `${stamp()}: ${o.detail}.${retry}`]]);
  } catch (e) {
    alerts.push(`Couldn't update sheet row ${r.row}: ${e.message}`);
  }
}

function readMarker() {
  try {
    return fs.readFileSync(MARKER_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

// ---------- notifications ----------

async function ntfy(title, message, { priority = 3, tags = [] } = {}) {
  const topic = (env.NTFY_TOPIC || '').trim();
  if (!topic) {
    console.log('NTFY_TOPIC not set — push skipped.');
    return;
  }
  try {
    // JSON publishing keeps UTF-8 titles intact (header-based titles must be ASCII).
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message: message.slice(0, 3900), priority, tags }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.log(`ntfy push failed: HTTP ${res.status}`);
  } catch (e) {
    console.log(`ntfy push failed: ${e.name}`);
  }
}

async function email(subject, text) {
  const user = (env.GMAIL_USER || '').trim();
  const pass = (env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) {
    console.log('Gmail credentials not set — email skipped.');
    return;
  }
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    });
    await transport.sendMail({ from: `Quin Enrollment <${user}>`, to: user, subject, text });
  } catch (e) {
    console.log(`Email failed: ${e.code || e.name}`);
  }
}

async function notifyBoth(title, body, opts) {
  await Promise.all([ntfy(title, body, opts), email(title, body)]);
}

async function pingHealthcheck() {
  const url = (env.HC_PING_URL || '').trim();
  if (!url) return;
  try {
    await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch {
    // A missed ping only risks a false dead-man alert; never fail the run for it.
  }
}

function patExpiryWarning(patExpiresAt) {
  if (!patExpiresAt) return null;
  const expires = new Date(patExpiresAt.replace(' UTC', 'Z').replace(' ', 'T'));
  if (isNaN(expires)) return null;
  const days = Math.ceil((expires - Date.now()) / (24 * 60 * MINUTE));
  if (days > PAT_WARN_DAYS) return null;
  return `⚠️ REPO_SECRETS_PAT (quin-calendar-secrets) expires in ${days} day(s). ` +
    'Regenerate it on GitHub and update the secret, or Quin auth breaks for the calendar and enrollment.';
}

// ---------- Quin API ----------

async function quin(method, apiPath, token, body) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, status: 0, networkError: e.name || 'network error', data: null };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body; status code is enough
  }
  return { ok: res.ok, status: res.status, data };
}

// For notifications only (may contain Quin's error message) — not for logs.
function errText(r) {
  if (r.networkError) return `no response (${r.networkError})`;
  const d = r.data || {};
  const err = d.error && typeof d.error === 'object' ? (d.error.title || d.error.message || d.error.code) : d.error;
  const msg = d.message || d.error_description || err || d.title;
  return `HTTP ${r.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`;
}

async function ensureToken(ctx, maxAgeMs) {
  if (ctx.token && Date.now() - ctx.tokenAt < maxAgeMs) return;
  if (!ctx.minter) {
    if (!env.QUIN_REFRESH_TOKEN || !env.QUIN_REFRESH_TOKEN.trim()) {
      throw new Error('QUIN_REFRESH_TOKEN secret is empty');
    }
    ctx.minter = createTokenMinter(env.QUIN_REFRESH_TOKEN);
  }
  const { accessToken, persistError, patExpiresAt } = await ctx.minter();
  ctx.token = accessToken;
  ctx.tokenAt = Date.now();
  console.log('Quin access token minted.');
  if (persistError) {
    console.log('WARNING: rotated refresh token was NOT persisted.');
    const msg = `The rotated Quin refresh token could NOT be saved (${persistError}). ` +
      "This run can continue, but the next calendar/enrollment run will fail until QUIN_REFRESH_TOKEN is re-seeded from Safari's localStorage 'pv.refresh'.";
    ctx.alerts.push(msg);
    await ntfy('Quin token NOT saved', msg, { priority: 5, tags: ['rotating_light'] });
  }
  const warn = patExpiryWarning(patExpiresAt);
  if (warn && !ctx.alerts.includes(warn)) ctx.alerts.push(warn);
}

function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const money = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

// GET /api/cart's shape hasn't been captured yet, so be conservative: any
// non-empty list or a non-zero total counts as "something is in the cart"
// (/api/checkout/process buys the WHOLE cart). The summary goes into the
// dry-run report so this can be tightened once we've seen a real empty cart.
function cartContents(cart) {
  const lists = [];
  if (cart && typeof cart === 'object') {
    for (const [k, v] of Object.entries(cart)) if (Array.isArray(v) && v.length) lists.push(`${k}(${v.length})`);
  }
  const total = money(findKey(cart, 'total_due')) ?? money(findKey(cart, 'total'));
  const keys = cart && typeof cart === 'object' ? Object.keys(cart).join(', ') : String(cart);
  return {
    nonEmpty: lists.length > 0 || (total !== null && total > 0),
    summary: `${lists.join(', ') || 'no items'}, total ${total ?? 'n/a'} [keys: ${keys}]`,
  };
}

// ---------- ticket selection ----------

const listTickets = (detail) => (Array.isArray(detail.tickets) ? detail.tickets : []).filter((t) => t && t.id != null);
const ticketName = (t) => String(t.name || t.title || t.ticket_name || `ticket ${t.id}`);
const isGuestTicket = (t) => /guest/i.test(ticketName(t));
const ticketPrice = (t) => money(t.pricing && t.pricing.base_price) ?? money(t.price) ?? 0;

function selectMemberTicket(tickets) {
  const main = tickets.filter((t) => !isGuestTicket(t));
  if (main.length === 1) return main[0];
  const memberNamed = main.filter((t) => /member/i.test(ticketName(t)) && !/non[\s-]?member/i.test(ticketName(t)));
  return memberNamed.length === 1 ? memberNamed[0] : null;
}

function saleOpensAt(detail) {
  const tickets = listTickets(detail);
  const t = selectMemberTicket(tickets) || tickets[0];
  const raw = (t && t.on_sale) || detail.on_sale;
  const d = raw ? new Date(raw) : null;
  return d && !isNaN(d) ? d : null;
}

// Before sales open, available_quantity may not mean anything yet, so only
// max_qty caps the plan; once open, availability counts too. max_qty 0/blank = no cap.
function ticketLimit(t, saleOpen) {
  const caps = [];
  const max = money(t.max_qty);
  if (max !== null && max > 0) caps.push(max);
  const avail = money(t.available_quantity);
  if (saleOpen && avail !== null) caps.push(avail);
  return caps.length ? Math.min(...caps) : Infinity;
}

// Why a paid ticket can't be bought automatically, or null if it can:
// the master switch must be on AND the price must be within column H.
function paidBlocker(price, maxPerTicket) {
  if (!PAID_ENABLED) return 'paid checkout is switched off (repo variable QUIN_ALLOW_PAID)';
  if (maxPerTicket === null || maxPerTicket === undefined) return 'no spending limit in column H ("Max $ per ticket")';
  if (price > maxPerTicket) return `that's above your $${maxPerTicket} per-ticket limit in column H`;
  return null;
}

// Party size rule (Steve): blank = 1; if the site allows fewer than asked,
// take the largest number it does allow.
function planTickets(detail, requested, maxPerTicket = null) {
  const tickets = listTickets(detail);
  if (!tickets.length) return { error: 'the event lists no tickets' };
  const member = selectMemberTicket(tickets);
  if (!member) {
    return { error: `couldn't tell which ticket is yours: ${tickets.map((t) => `"${ticketName(t)}"`).join(', ')}` };
  }
  const opensAt = saleOpensAt(detail);
  const saleOpen = !opensAt || opensAt.getTime() <= Date.now();
  const offSale = member.off_sale ? new Date(member.off_sale) : null;
  if (offSale && !isNaN(offSale) && offSale.getTime() < Date.now()) return { error: 'ticket sales have closed' };
  const memberBlocker = ticketPrice(member) > 0 ? paidBlocker(ticketPrice(member), maxPerTicket) : null;
  if (memberBlocker) {
    return { skip: `your ticket costs $${ticketPrice(member)} and ${memberBlocker} — register manually` };
  }
  const memberLimit = ticketLimit(member, saleOpen);
  if (memberLimit < 1) return { error: 'sold out (waitlist not supported yet)' };

  const guest = tickets.find(isGuestTicket);
  const notes = [];
  const lines = [];
  let allowed;
  if (!guest) {
    // One ticket type: the party is several of the same ticket, if max_qty allows.
    allowed = Math.min(requested, memberLimit);
    lines.push({ ticket: member, qty: allowed });
  } else {
    const guestQty = Math.max(0, Math.min(requested - 1, ticketLimit(guest, saleOpen)));
    allowed = 1 + guestQty;
    lines.push({ ticket: member, qty: 1 });
    const guestBlocker = ticketPrice(guest) > 0 ? paidBlocker(ticketPrice(guest), maxPerTicket) : null;
    if (guestQty > 0 && guestBlocker) {
      notes.push(`guest tickets cost $${ticketPrice(guest)} each and ${guestBlocker} — add ${guestQty} guest(s) manually`);
    } else if (guestQty > 0) {
      lines.push({ ticket: guest, qty: guestQty });
    }
  }
  if (allowed < requested) notes.push(`you asked for ${requested}, the site allows ${allowed}`);
  for (const line of lines) {
    const min = money(line.ticket.min_qty);
    if (min !== null && min > line.qty) {
      return { error: `"${ticketName(line.ticket)}" needs at least ${min} tickets; you asked for ${line.qty}` };
    }
  }
  const party = lines.reduce((n, l) => n + l.qty, 0);
  const expectedTotal = lines.reduce((sum, l) => sum + ticketPrice(l.ticket) * l.qty, 0);
  // Spending limit = column H × tickets actually booked (Steve: no tax or fees on events).
  const limit = expectedTotal > 0 ? maxPerTicket * party : 0;
  return { lines, party, notes, opensAt, expectedTotal, limit };
}

// ---------- payment (saved default card) ----------
//
// Shape taken from Quin's own checkout code (Checkout / CreditCardSelect /
// usePaymentEndpoint chunks, read 2026-09-29): saved cards come from
// GET /api/account/wallet ({cards: [...], banks: [...]}), and a card payment is
// POST /api/checkout/process {billing: [{id, type: "creditcard", amount,
// billing_details}]}. If the bank demands 3-D Secure the response carries
// action.code "3ds_auth_required"; that needs a browser, so we stop there.
//
// The site's code uses camelCase, but its API client converts every request
// body to snake_case and every response to camelCase (snakecase-keys /
// camelcase-keys in the main bundle). The server itself speaks snake_case, so
// raw wallet cards carry last_four / exp_month / exp_year / billing_details.

function normalizeCard(c) {
  return {
    id: c.id,
    isDefault: c.default === true || c.is_default === true,
    status: c.status || 'active',
    paymentType: c.payment_type || c.paymentType || 'creditcard',
    brand: c.brand,
    lastFour: c.last_four ?? c.lastFour ?? c.last4,
    expMonth: c.exp_month ?? c.expMonth,
    expYear: c.exp_year ?? c.expYear,
    billingDetails: c.billing_details ?? c.billingDetails ?? {},
    fieldNames: Object.keys(c).join(', '), // names only — for the dry-run report if a field is missing
  };
}

function cardExpired(card) {
  const month = Number(card.expMonth);
  const year = Number(card.expYear);
  if (!month || !year) return false;
  const fullYear = year < 100 ? 2000 + year : year;
  return Date.UTC(fullYear, month, 1) <= Date.now(); // valid through the end of its expiry month
}

const cardLabel = (card) => `${card.brand || 'card'} •••• ${card.lastFour || '????'}` +
  (card.expMonth && card.expYear ? ` exp ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` : '');
const cardRole = (card) => (card.isDefault ? 'default card' : 'your only saved card');

async function defaultCard(ctx) {
  const res = await quin('GET', '/api/account/wallet', ctx.token);
  if (!res.ok || !res.data) return { error: `couldn't load your saved cards (${errText(res)})` };
  const all = (Array.isArray(res.data.cards) ? res.data.cards : []).filter((c) => c && c.id != null).map(normalizeCard);
  const usable = all.filter((c) => c.status === 'active' && c.paymentType === 'creditcard' && !cardExpired(c));
  // Never silently switch cards: if a default exists but can't be used, stop.
  const marked = all.find((c) => c.isDefault);
  if (marked && !usable.includes(marked)) {
    return { error: `your default card (${cardLabel(marked)}) ${cardExpired(marked) ? 'has expired' : 'is not active'} — update it in the Quin app` };
  }
  const card = marked || (usable.length === 1 ? usable[0] : null);
  if (card) return { card };
  if (!usable.length) {
    const expired = all.filter(cardExpired).map(cardLabel);
    return { error: expired.length ? `your saved card has expired (${expired.join(', ')}) — update it in the Quin app` : 'no saved card on file' };
  }
  return { error: `you have ${usable.length} saved cards and none is marked default — set a default in the Quin app` };
}

// The site sends the card id as a number (Number.parseInt); keep it as-is if it isn't numeric.
function cardIdForBilling(card) {
  const n = Number.parseInt(`${card.id}`, 10);
  return Number.isFinite(n) && String(n) === String(card.id).trim() ? n : card.id;
}

// ---------- enrollment ----------

async function addToCart(ctx, r, plan) {
  const deadline = Date.now() + ADD_RETRY_WINDOW_MS;
  let current = plan;
  for (let i = 0; i < current.lines.length; i++) {
    let attempt = 0;
    for (;;) {
      const line = current.lines[i];
      if (!line) break; // a re-plan dropped this line (e.g. no guest spots left)
      attempt++;
      const res = await quin('POST', '/api/cart/tickets', ctx.token, {
        id: String(line.ticket.id), quantity: line.qty, update_quantity: false,
      });
      if (res.ok) {
        console.log(`  row ${r.row}: ticket line ${i + 1} added (attempt ${attempt})`);
        break;
      }
      if (res.networkError) {
        // No answer — the add may still have landed. Look before re-adding,
        // or a retry could double the quantity.
        const cart = await quin('GET', '/api/cart', ctx.token);
        if (cart.ok && JSON.stringify(cart.data || '').includes(String(line.ticket.id))) break;
      }
      if (res.status === 401) return { error: `adding to cart was refused (${errText(res)})`, partial: i > 0 };
      if (Date.now() > deadline) {
        return { error: `couldn't add tickets after ${attempt} tries over 3 minutes (${errText(res)})`, partial: i > 0 };
      }
      if (attempt % 10 === 0) {
        // Still refused: availability may have changed (sold out, fewer guest spots).
        const ev = await quin('GET', `/api/events/${r.eventId}`, ctx.token);
        if (ev.ok && ev.data) {
          const replanned = planTickets(ev.data, r.requested, r.maxPerTicket);
          if (replanned.error || replanned.skip) return { error: replanned.error || replanned.skip, partial: i > 0 };
          current = replanned;
        }
      }
      await sleep(attempt < 60 ? 500 : 1000);
    }
  }
  return { plan: current };
}

async function dryRunReport(ctx, r, detail) {
  const plan = planTickets(detail, r.requested, r.maxPerTicket);
  const opensAt = saleOpensAt(detail); // plan.opensAt is unset when the plan is a skip/error
  const cart = await quin('GET', '/api/cart', ctx.token);
  const co = await quin('GET', '/api/checkout', ctx.token);
  const tickets = listTickets(detail).map((t) =>
    `"${ticketName(t)}" $${ticketPrice(t)} (max ${t.max_qty ?? '—'}, available ${t.available_quantity ?? '—'}, ` +
    `on sale ${t.on_sale ? formatOpens(new Date(t.on_sale)) : '—'})`);
  let planText;
  if (plan.error || plan.skip) planText = plan.error || plan.skip;
  else planText = plan.lines.map((l) => `${l.qty} × "${ticketName(l.ticket)}"`).join(' + ') +
    (plan.notes.length ? ` (${plan.notes.join('; ')})` : '');
  let payText = `no charge planned; column H limit: ${r.maxPerTicket === null ? 'blank' : `$${r.maxPerTicket}`} per ticket; paid checkout switch: ${PAID_ENABLED ? 'ON' : 'off'}`;
  if (!plan.error && !plan.skip && plan.expectedTotal > 0) {
    const w = await defaultCard(ctx);
    payText = w.error
      ? `would NOT pay: ${w.error}`
      : `would pay $${plan.expectedTotal} of your $${plan.limit} limit with ${cardLabel(w.card)} (${cardRole(w.card)})` +
        (w.card.lastFour && w.card.expMonth ? '' : ` [card field names: ${w.card.fieldNames}]`);
  }
  return [
    `registered already: ${detail.registered === true ? 'yes' : 'no'}; you asked for ${r.requested}`,
    `opens: ${opensAt ? formatOpens(opensAt) : 'no on_sale time'}`,
    `tickets: ${tickets.join(' | ') || 'none'}`,
    `would add: ${planText}`,
    `payment: ${payText}`,
    `cart: ${cart.ok ? cartContents(cart.data).summary : errText(cart)}`,
    `checkout: ${co.ok ? `total_due ${money(findKey(co.data, 'total_due')) ?? 'n/a'}` : errText(co)}`,
  ].join('\n    ');
}

async function enrollRow(ctx, r) {
  if (!DRY_RUN) {
    await sleepUntil(r.opensAt.getTime() - PRE_OPEN_MS, { heartbeat: true });
    await ensureToken(ctx, 15 * MINUTE); // must stay valid through opening + 3 min of retries
  }
  const ev = await quin('GET', `/api/events/${r.eventId}`, ctx.token);
  if (!ev.ok || !ev.data) {
    return { outcome: 'failed', keepPending: true, detail: `couldn't load the event (${errText(ev)}); will retry at the next check` };
  }
  if (DRY_RUN) return { outcome: 'dry-run', detail: await dryRunReport(ctx, r, ev.data) };
  if (ev.data.registered === true) return { outcome: 'already', detail: 'you were already registered' };

  let plan = planTickets(ev.data, r.requested, r.maxPerTicket);
  if (plan.error) return { outcome: 'failed', detail: plan.error };
  if (plan.skip) return { outcome: 'skipped', detail: plan.skip };
  if (plan.opensAt && plan.opensAt.getTime() - Date.now() > PRE_OPEN_MS + MINUTE) {
    return { outcome: 'later', keepPending: true, newOpens: plan.opensAt, detail: `the open time moved to ${human(plan.opensAt)}; I'll re-arm for it` };
  }

  // Paid: find the card now (before opening) so 10:00:00 isn't spent on it.
  let card = null;
  if (plan.expectedTotal > 0) {
    const w = await defaultCard(ctx);
    if (w.error) return { outcome: 'failed', detail: `this event costs $${plan.expectedTotal} but ${w.error} — register manually` };
    card = w.card;
  }

  const cart = await quin('GET', '/api/cart', ctx.token);
  if (!cart.ok) {
    return { outcome: 'failed', keepPending: true, detail: `couldn't read your cart (${errText(cart)}); will retry at the next check` };
  }
  const contents = cartContents(cart.data);
  if (contents.nonEmpty) {
    return {
      outcome: 'failed', keepPending: true,
      abort: 'your Quin cart already had something in it',
      detail: `your Quin cart isn't empty (${contents.summary}) and checkout buys the whole cart — empty it in the Quin app; I'll retry at the next check`,
    };
  }

  if (plan.opensAt && plan.opensAt.getTime() > Date.now()) {
    console.log(`  row ${r.row}: waiting for tickets to open`);
    await sleepUntil(plan.opensAt.getTime());
  }
  const added = await addToCart(ctx, r, plan);
  if (added.error) {
    return { outcome: 'failed', detail: added.error + (added.partial ? ' — some tickets may be sitting in your cart' : '') };
  }
  plan = added.plan;

  const co = await quin('GET', '/api/checkout', ctx.token);
  let totalDue = co.ok ? money(findKey(co.data, 'total_due')) : null;
  if (totalDue === null) {
    // /api/checkout returned no total_due on an empty cart (dry run 9/28);
    // the cart itself carries one, so fall back to it.
    const cartNow = await quin('GET', '/api/cart', ctx.token);
    if (cartNow.ok) totalDue = money(findKey(cartNow.data, 'total_due'));
  }
  if (totalDue === null) {
    return { outcome: 'failed', detail: `couldn't read the checkout total (${errText(co)}) — tickets are in your cart; finish in the Quin app NOW` };
  }
  if (totalDue > 0 && !card) {
    return { outcome: 'failed', detail: `checkout total is $${totalDue} but these tickets looked free — didn't pay; the tickets are in your cart, so pay in the Quin app NOW if you still want them` };
  }
  // Steve's authorization: never pay more than column H × tickets booked.
  if (totalDue > 0 && totalDue > plan.limit + 0.005) {
    return { outcome: 'failed', detail: `checkout total is $${totalDue}, over your $${plan.limit} limit — didn't pay; the tickets are in your cart, so pay in the Quin app NOW if you still want them` };
  }
  const billing = totalDue > 0
    ? [{ id: cardIdForBilling(card), type: 'creditcard', amount: Math.round(totalDue * 100) / 100, billing_details: card.billingDetails }]
    : [];

  // NEVER retry this call: after a lost response a retry could buy (and charge) twice.
  // Whatever happens, re-check `registered` instead.
  const proc = await quin('POST', '/api/checkout/process', ctx.token, { billing });
  const order = proc.ok ? findKey(proc.data, 'order') : null;
  const action = proc.data && proc.data.action;
  const verify = await quin('GET', `/api/events/${r.eventId}`, ctx.token);
  const registered = verify.ok && verify.data && verify.data.registered === true;
  const orderText = order && order.id ? `order #${order.id}` : 'no order # returned';
  const paidText = totalDue > 0 ? `paid $${totalDue} with ${cardLabel(card)}` : null;
  const summary = [orderText, `${plan.party} ticket${plan.party === 1 ? '' : 's'}`, paidText, ...plan.notes].filter(Boolean).join('; ');
  if (registered) return { outcome: 'enrolled', detail: summary };
  if (order && order.status === 'completed') {
    return { outcome: 'enrolled', detail: `${summary} (Quin hasn't shown the registration yet — double-check the app)` };
  }
  if (action && action.code === '3ds_auth_required') {
    return { outcome: 'failed', detail: 'your bank asked to verify the card (3-D Secure), which only works in the app — nothing was charged by me; the tickets are in your cart, so pay in the Quin app NOW' };
  }
  return {
    outcome: 'failed',
    // A decline comes back as HTTP 200 with success:false, so check both.
    detail: `checkout ${proc.ok && !(proc.data && proc.data.success === false) ? 'returned OK' : `failed (${errText(proc)})`} but Quin doesn't show you registered — check the app NOW`,
  };
}

// Fetch each candidate's event: note already-registered rows, keep the Opens
// column current, and return the rows opening soon enough for this run.
async function lookUpOpenings(ctx, sheet, candidates, results, handled) {
  const horizon = Math.min(Date.now() + ARM_WINDOW_MS + LOOKAHEAD_SLACK_MS, JOB_START + JOB_BUDGET_MS);
  const due = [];
  for (const r of candidates) {
    const needsFetch = DRY_RUN || TARGET_ROW || !r.opensAt || r.opensAt.getTime() <= horizon;
    if (!needsFetch) continue;
    const res = await quin('GET', `/api/events/${r.eventId}`, ctx.token);
    if (!res.ok || !res.data) {
      handled.add(r.row);
      const notFound = res.status === 404;
      const o = { outcome: 'failed', keepPending: !notFound, detail: `couldn't load the event (${errText(res)})` };
      results.push({ r, ...o });
      if (!DRY_RUN) await recordOutcome(sheet, r, o, ctx.alerts);
      continue;
    }
    if (res.data.registered === true && !DRY_RUN) {
      handled.add(r.row);
      const o = { outcome: 'already', detail: 'you were already registered' };
      results.push({ r, ...o });
      await recordOutcome(sheet, r, o, ctx.alerts);
      continue;
    }
    const opensAt = saleOpensAt(res.data);
    const opensText = opensAt ? formatOpens(opensAt) : ON_SALE_NOW;
    if (opensText !== r.opensText) {
      try {
        await sheet.write(`G${r.row}`, [[opensText]]);
      } catch (e) {
        ctx.alerts.push(`Couldn't write the Opens time for row ${r.row}: ${e.message}`);
      }
    }
    r.opensAt = opensAt || new Date(0);
    if (DRY_RUN || r.opensAt.getTime() <= horizon) {
      due.push(r);
    } else if (TARGET_ROW) {
      handled.add(r.row);
      results.push({ r, outcome: 'later', detail: `opens ${human(r.opensAt)} — too far off for this run; the scheduled checks will arm for it` });
    }
  }
  return due.sort((a, b) => a.opensAt - b.opensAt || a.row - b.row);
}

async function announceArmed(due) {
  const upcoming = due.filter((r) => r.opensAt.getTime() > Date.now() + MINUTE);
  if (!upcoming.length) return;
  await pingHealthcheck();
  console.log(`Armed for ${upcoming.length} row(s).`);
  await ntfy(
    `Quin: armed for ${upcoming.length} event${upcoming.length === 1 ? '' : 's'}`,
    upcoming.map((r) => `• ${r.name} — opens ${human(r.opensAt)} (asked for ${r.requested})`).join('\n'),
    { priority: 2, tags: ['alarm_clock'] }
  );
}

async function sendMondayNote(sheet) {
  const rows = parseRows(await sheet.read(READ_RANGE));
  const pending = rows.filter((r) => r.active && isPending(r));
  const next = pending.filter((r) => r.opensAt && r.opensAt.getTime() > Date.now()).sort((a, b) => a.opensAt - b.opensAt)[0];
  const body = 'No Quin events opened for you today.\n' +
    `Pending in the sheet: ${pending.length}` +
    (next ? `\nNext opening: ${next.name} — ${human(next.opensAt)}` : '');
  await notifyBoth('Quin: nothing pending this Monday', body, { priority: 2, tags: ['calendar'] });
}

async function sendSummary(sheet, results, ctx) {
  const now = new Date();
  const alertsText = ctx.alerts.length ? `\n\n${ctx.alerts.join('\n')}` : '';
  if (!results.length) {
    if (env.MONDAY_NOTE === 'true') {
      await sendMondayNote(sheet);
      fs.writeFileSync(MARKER_FILE, `${etDate(now)}\n`);
    } else if (IS_MANUAL) {
      await notifyBoth('Quin enrollment: nothing to do', `No pending rows open within the next 75 minutes.${alertsText}`, { priority: 2 });
    } else if (ctx.alerts.length) {
      await notifyBoth('Quin enrollment: attention needed', ctx.alerts.join('\n'), { priority: 4, tags: ['warning'] });
    }
    return;
  }
  const count = (o) => results.filter((x) => x.outcome === o).length;
  const failed = count('failed');
  const parts = [];
  for (const o of ['enrolled', 'already', 'skipped', 'failed', 'later']) {
    if (count(o)) parts.push(`${count(o)} ${o === 'already' ? 'already registered' : o === 'later' ? 'not yet' : o}`);
  }
  const title = DRY_RUN ? `Quin dry run: ${results.length} row(s) checked` : `Quin: ${parts.join(', ')}`;
  const body = results.map((x) => `${OUTCOME_LABEL[x.outcome]} — ${x.r.name} (row ${x.r.row})\n    ${x.detail}`).join('\n\n') + alertsText;
  await notifyBoth(title, body, failed ? { priority: 5, tags: ['rotating_light'] } : { priority: 3, tags: ['white_check_mark'] });
  if (isMondayET(now) && !DRY_RUN) fs.writeFileSync(MARKER_FILE, `${etDate(now)}\n`);
  console.log(`Summary: ${DRY_RUN ? `${results.length} dry-run row(s)` : parts.join(', ')}.`);
  if (failed && !DRY_RUN) process.exitCode = 1;
}

async function runMode() {
  const sheet = sheetClient();
  const ctx = { minter: null, token: null, tokenAt: 0, alerts: [] };
  const results = [];
  const handled = new Set();
  let abortReason = null;

  for (let pass = 1; ; pass++) {
    const rows = parseRows(await sheet.read(READ_RANGE));
    const candidates = rows.filter((r) => !handled.has(r.row) &&
      (TARGET_ROW ? r.row === TARGET_ROW : r.active && isPending(r)));
    if (pass === 1 && TARGET_ROW && !candidates.length) {
      results.push({ r: { row: TARGET_ROW, name: `Row ${TARGET_ROW}` }, outcome: 'failed', detail: 'no event URL (…/events/<id>) in column B' });
      break;
    }
    if (!candidates.length) break;
    console.log(`Pass ${pass}: ${candidates.length} candidate row(s).`);
    await ensureToken(ctx, 20 * MINUTE);
    const due = await lookUpOpenings(ctx, sheet, candidates, results, handled);
    if (!due.length) break;
    if (!DRY_RUN) await announceArmed(due);
    for (const r of due) {
      handled.add(r.row);
      if (abortReason) {
        results.push({ r, outcome: 'failed', detail: `not attempted — ${abortReason}` });
        continue;
      }
      const o = await enrollRow(ctx, r);
      if (o.abort) abortReason = o.abort;
      console.log(`  row ${r.row}: ${o.outcome}`);
      results.push({ r, ...o });
      if (!DRY_RUN) await recordOutcome(sheet, r, o, ctx.alerts);
    }
    if (DRY_RUN || TARGET_ROW || abortReason) break;
  }
  await sendSummary(sheet, results, ctx);
}

// ---------- check mode ----------

async function anotherRunActive() {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=20`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return false;
    const { workflow_runs: runs = [] } = await res.json();
    return runs.some((run) => String(run.id) !== String(env.GITHUB_RUN_ID) && run.status !== 'completed');
  } catch {
    return false;
  }
}

function setOutput(key, value) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function checkMode() {
  const now = new Date();
  const hhmm = etHHMM(now);
  const monday = isMondayET(now);
  const today = etDate(now);

  // A check landing in the Monday window proves GitHub's scheduler is alive;
  // the healthchecks.io dead-man alert fires if none (and no armed run) pings.
  if (monday && hhmm >= MONDAY_PING_START && hhmm <= MONDAY_PING_END) await pingHealthcheck();

  const rows = parseRows(await sheetClient().read(READ_RANGE));
  const work = rows.filter((r) => r.active && isPending(r));
  const needLookup = work.filter((r) => !r.opensAt);
  const due = work.filter((r) => r.opensAt && r.opensAt.getTime() - now.getTime() <= ARM_WINDOW_MS);
  const openedToday = rows.some((r) => r.active && r.opensAt && r.opensAt.getTime() > 0 && etDate(r.opensAt) === today);
  const mondayNote = monday && hhmm >= MONDAY_NOTE_AFTER && readMarker() !== today && !openedToday;
  // A retry is started by the failing run just before it exits, so that run
  // may still show as in progress — don't let it block its own retry.
  const armed = (needLookup.length || due.length) && !IS_RETRY ? await anotherRunActive() : false;
  const go = IS_MANUAL || mondayNote || ((needLookup.length > 0 || due.length > 0) && !armed);

  console.log(`check: ${work.length} pending row(s); ${needLookup.length} need an open-time lookup; ` +
    `${due.length} open within 75 min${armed ? '; another run is already armed' : ''}` +
    `${mondayNote ? '; Monday note due' : ''} → ${go ? 'GO' : 'nothing to do'}`);
  setOutput('go', go);
  setOutput('monday_note', mondayNote);
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'check') return checkMode();
  if (mode === 'run') return runMode();
  throw new Error('usage: node enroll.js check|run');
}

// The calendar and this job share one single-use refresh token. On 2026-10-05
// an enroll job that started 11s after the calendar saved a new token was still
// handed the old, spent one by GitHub. A fresh run a minute later reads the
// new value, so retry once (never from a retry, never for manual runs).
async function retryShortly() {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY not available');
  await ntfy('Quin login refused — retrying',
    'The saved Quin login was refused (most likely the calendar had just refreshed it). ' +
    "A fresh run starts in a minute. You only need to act if an urgent 'crashed' alert follows.",
    { priority: 2, tags: ['repeat'] });
  await sleep(RETRY_DELAY_MS);
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF_NAME || 'main', inputs: { source: 'retry', dry_run: 'false' } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`starting the retry run failed: HTTP ${res.status}`);
  console.log('Quin login refused; started one retry run.');
}

main().catch(async (e) => {
  const mode = process.argv[2] || '';
  console.error(`enroll.js ${mode} failed: ${e.message}`);
  if (mode !== 'run') {
    process.exitCode = 1;
    return;
  }
  const loginRefused = /^Token refresh failed: HTTP 4\d\d/.test(e.message);
  if (loginRefused && !IS_MANUAL && !IS_RETRY) {
    try {
      await retryShortly();
      return; // the retry run takes over; exit cleanly
    } catch (err) {
      console.error(`Retry not started: ${err.message}`);
    }
  }
  const hint = loginRefused
    ? "\n\nQuin refused the saved login" + (IS_RETRY ? ' twice' : '') +
      ". If it keeps happening, re-seed QUIN_REFRESH_TOKEN from Safari's localStorage 'pv.refresh'."
    : '';
  await ntfy('Quin enrollment crashed', `${e.message}${hint}\n\nIf an event is opening soon, register manually.`, {
    priority: 5, tags: ['rotating_light'],
  });
  process.exitCode = 1;
});
