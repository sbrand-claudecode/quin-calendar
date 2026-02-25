# Quin House Events Calendar

Automatically scrapes The 'Quin House member portal every 6 hours and publishes an ICS calendar feed to GitHub Pages, which you can subscribe to in Google Calendar.

## What it captures per event

Each calendar entry includes:
1. **Event name** — full title
2. **Date & time** — start and end in Eastern Time
3. **Location/venue** — e.g. The Living Room, Café Q, Bondo
4. **Description** — full event description
5. **Category** — e.g. Food & Beverage, The Arts, Sports & Games
6. **Price** — e.g. $35.00, Free, RSVP
7. **Availability** — spots remaining, sold out, or waitlist
8. **Event URL** — direct link back to the member portal

---

## Setup (one-time, ~10 minutes)

### 1. Create a GitHub repository

1. Go to [github.com/new](https://github.com/new)
2. Name it `quin-calendar` (or anything you like)
3. Set it to **Private** — your credentials are stored as Secrets, not in code
4. Click **Create repository**

### 2. Upload these files

Upload the contents of this folder to the repository root:
- `scrape.js`
- `package.json`
- `.github/workflows/update-calendar.yml`

You can drag-and-drop them on the GitHub repository page, or use the GitHub CLI / GitHub Desktop.

### 3. Add your credentials as GitHub Secrets

In your repo on GitHub:
1. Go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret** and add:
   - Name: `QUIN_EMAIL` — Value: `brand.steve@gmail.com`
   - Name: `QUIN_PASSWORD` — Value: your Quin House portal password

These are encrypted — they're never visible in logs or code.

### 4. Enable GitHub Pages

1. Go to **Settings → Pages**
2. Under **Source**, select **Deploy from a branch**
3. Choose branch: `gh-pages`, folder: `/ (root)`
4. Click **Save**

### 5. Run it for the first time

1. Go to **Actions** tab in your repo
2. Click **Update Quin House Calendar**
3. Click **Run workflow** → **Run workflow**

It will take about 2–3 minutes. When done, your calendar will be published at:

```
https://<your-github-username>.github.io/quin-calendar/calendar.ics
```

### 6. Subscribe in Google Calendar

1. Open [Google Calendar](https://calendar.google.com)
2. Click the **+** next to "Other calendars" → **From URL**
3. Paste your `.ics` URL above
4. Click **Add calendar**

Google Calendar typically refreshes subscribed calendars every 12–24 hours. The GitHub Action runs every 6 hours to keep the feed current.

---

## How it works

1. GitHub Actions spins up a Linux runner on a schedule
2. `scrape.js` launches a headless Chromium browser via Playwright
3. It logs in to `members.thequinhouse.com` with your credentials
4. It extracts the session token from the browser's localStorage
5. It calls the Peoplevine JSON API to fetch all upcoming events + detail for each
6. It generates a standards-compliant `.ics` file
7. The file is published to GitHub Pages via the `gh-pages` branch

Your credentials exist only as encrypted GitHub Secrets and are used only inside the GitHub Actions runner — they're never stored in any file.

---

## Manual refresh

Go to **Actions → Update Quin House Calendar → Run workflow** to trigger an immediate update.

---

## Changelog

### 2026-02-25 — Multi-day and long event handling

**Problem:** Multi-day events (e.g. *Ken Fulk Purveyor Pop-Up*) were being interpreted as a single block running from `startDate + startTime` through `endDate + endTime`, rather than a recurring daily window. Additionally, long events had precise timed start/end fields that cluttered the calendar.

**Changes made to `scrape.js`:**

- **Multi-day events** now produce a single all-day VEVENT spanning the full date range (`DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE`), rather than one timed block or one entry per day. The actual daily hours are preserved in the event notes as `Time: H AM – H PM`.

- **Single-day events running 4 or more hours** are also emitted as all-day entries (no clock times shown on the calendar), again with the hours captured in the notes as `Time: H AM – H PM`.

- **Single-day events under 4 hours** are unchanged — they continue to show precise start and end times.

The `Time:` note is inserted in the event description between the `Status:` and `Event URL:` lines.

### 2026-02-25 — Bug fixes: unavailable status + HTML entity decoding

**Fix 1 — Missing "Status: Unavailable" line**

Events whose `availability` field contains `"unavailable"` (e.g. *"Event Unavailable — Tickets for this event are no longer available"*) were producing no Status line at all. Added an explicit branch for this case, plus a catch-all that surfaces any other unrecognised status values rather than silently dropping them.

**Fix 2 — HTML entities in event descriptions**

Event descriptions containing named HTML entities (`&ndash;`, `&eacute;`, `&rsquo;`, `&ldquo;`, etc.) were being passed through as raw text. Replaced the small set of hardcoded entity substitutions with the `he` library, which decodes all HTML5 named and numeric entities. Example: `"Condé Nast&rsquo;s"` now renders as `"Condé Nast's"`.

### 2026-02-25 — Personal registration status

**Problem:** The `Status:` line showed the generic event-level availability (e.g. "Waitlist Only") even for events where the user had a personal registration state — a confirmed ticket or a waitlist position.

**Fix:** The API response includes two personal-status fields (discovered via a diagnostic log run):
- `event.registered` — `true` when the user holds a confirmed ticket
- `survey.has_submitted` — `true` when the user has personally joined the waitlist (fetched from `event.waitlist.endpoint`)

Personal status now takes precedence over event-level status:
- `event.registered === true` → `Status: You are Confirmed`
- `survey.has_submitted === true` → `Status: You are on Waitlist`
- Otherwise → falls back to the event-level status as before (Sold Out, Available, Unavailable, etc.)

### 2026-02-25 — Fix: waitlist detection was matching all events

**Problem:** `event.waitlist.id` (used as the personal waitlist indicator) turned out to be a global template ID (15310) present on every event with a waitlist form — not a per-user enrollment field. This caused "Status: You are on Waitlist" to appear on ~26 of 44 events regardless of actual enrollment.

**Root cause discovery:** Multi-step diagnostic logging revealed that the correct field is `has_submitted` from the waitlist survey endpoint (`event.waitlist.endpoint`). This survey returns `has_submitted: true` only when the authenticated user has personally submitted their name to the waitlist.

**Fix:** Each event detail fetch now makes one additional call to `event.waitlist.endpoint` and stores the result as `_waitlistSubmitted`. Personal status checks now use `_waitlistSubmitted === true` instead of `waitlist.id`. Result: `quin.ics` now correctly contains only the 2–3 events the user is actually confirmed or waitlisted for.

### 2026-02-25 — Personal calendar (quin.ics) + local filter script

**New feature:** Two ways to get a personal calendar containing only events you are confirmed or waitlisted for.

**Part 1 — `scrape.js` now writes `quin.ics` alongside `calendar.ics`**

During the GitHub Actions run, after writing the full `calendar.ics`, the scraper filters events to those where `event.registered === true` or `event.waitlist.id` is set, and writes a second file `public/quin.ics` (calendar name "Quin") to GitHub Pages. No extra login or API calls required.

**Part 2 — New `filter.js` local script (no credentials required)**

Run `npm run filter` on your Mac to produce `quin.ics` locally. The script:
1. Fetches the published `calendar.ics` from GitHub Pages (public URL, no login)
2. Splits it into individual VEVENT blocks (unfolding ICS line continuations first)
3. Keeps only events whose description contains `Status: You are Confirmed` or `Status: You are on Waitlist`
4. Wraps them in a VCALENDAR envelope named "Quin" and writes `./quin.ics`

**Local workflow:**
1. `npm run filter`
2. Double-click `quin.ics` in Finder → Apple Calendar import dialog
3. Assign to a "Quin" calendar (create it on first import)
4. Repeat whenever you want a refresh (events are editable after import, unlike a subscription)
