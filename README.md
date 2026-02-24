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
