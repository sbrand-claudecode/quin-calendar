// Minimal Google Sheets client authenticated as a service account.
// Built-ins only (Node 20 global fetch + crypto), so the lightweight 15-minute
// check job can use it without an `npm install`.

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getServiceAccountToken(sa) {
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: sa.client_email,
    scope: SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google service-account auth failed: HTTP ${res.status} — ${await googleReason(res)}`);
  }
  const data = await res.json();
  return { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
}

// Google's own error text (e.g. "Google Sheets API has not been used in project
// ... or it is disabled", "This operation is not supported for this document").
async function googleReason(res) {
  try {
    const data = await res.json();
    return (data.error && (data.error.message || data.error.status)) || data.error_description || '';
  } catch {
    return '';
  }
}

function createSheetClient({ serviceAccountJson, spreadsheetId: idOrUrl, tab }) {
  // Accept either the bare ID or the full docs.google.com URL.
  const idMatch = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(idOrUrl);
  const spreadsheetId = idMatch ? idMatch[1] : idOrUrl;
  let sa;
  try {
    sa = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file).');
  }
  let cached = null;

  async function authHeaders() {
    // The enrollment job can run 90+ minutes; Google tokens last 60.
    if (!cached || Date.now() > cached.expiresAt - 5 * 60 * 1000) {
      cached = await getServiceAccountToken(sa);
    }
    return { Authorization: `Bearer ${cached.token}` };
  }

  function rangeUrl(a1) {
    return `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`'${tab}'!${a1}`)}`;
  }

  async function read(a1) {
    const res = await fetch(`${rangeUrl(a1)}?valueRenderOption=FORMATTED_VALUE`, {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Sheet read failed: HTTP ${res.status} — ${await googleReason(res)} ` +
        `(is the sheet a native Google Sheet shared with ${sa.client_email}, with a tab named '${tab}'?)`);
    }
    const data = await res.json();
    return data.values || [];
  }

  // RAW so Sheets stores exactly what we write (no date auto-parsing of the Opens column).
  async function write(a1, values) {
    const res = await fetch(`${rangeUrl(a1)}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (!res.ok) {
      throw new Error(`Sheet write failed: HTTP ${res.status} — ${await googleReason(res)} (does ${sa.client_email} have Editor access?)`);
    }
  }

  return { read, write, serviceAccountEmail: sa.client_email };
}

module.exports = { createSheetClient };
