// Shared Peoplevine auth for scrape.js (calendar) and enroll.js (enrollment).
//
// Peoplevine refresh tokens are SINGLE-USE: every /api/token call rotates it.
// Both workflows spend the same QUIN_REFRESH_TOKEN secret, so they must share
// the `quin-auth` concurrency group and persist each rotated token immediately.

const BASE_URL = 'https://members.thequinhouse.com';

// Decode a token value stored by Peoplevine's frontend. localStorage entries
// like pv.token / pv.refresh are wrapped as {"\u0000": "<inner>", "ttl": ...}.
// The inner value is EITHER base64-encoded (pv.token stores the JWT that way)
// OR a raw string (pv.refresh appears to store "cu__..." tokens directly).
// This function accepts:
//   - the full JSON envelope ({"\u0000":"...","ttl":...})
//   - just the inner string
// and returns the token in the exact form the /api/token endpoint expects.
function decodeStoredToken(raw) {
  const trimmed = raw.trim();
  let inner;
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    inner = parsed['\u0000'];
    if (!inner) {
      throw new Error("Stored token JSON is missing the expected '\\u0000' key");
    }
  } else {
    inner = trimmed;
  }
  // Peoplevine refresh tokens are prefixed "cu__" and used raw by the server.
  // JWT access tokens are base64-wrapped in the envelope. Detect by prefix.
  if (inner.startsWith('cu__')) {
    return inner;
  }
  // Otherwise treat as base64-wrapped (matches pv.token behavior)
  return Buffer.from(inner, 'base64').toString('utf8');
}

// Write the rotated refresh token back into the QUIN_REFRESH_TOKEN repo secret
// so the next scheduled run starts with a valid token. Peoplevine rotates the
// refresh token on every /api/token call (single-use), so without this the
// second run after any successful refresh would fail with invalid_refresh_token.
//
// Returns { patExpiresAt } — GitHub's reported expiry for REPO_SECRETS_PAT
// (a string like "2027-04-01 00:00:00 UTC"), or null if unknown/not persisted.
async function persistRefreshToken(newRefreshToken) {
  const pat = process.env.REPO_SECRETS_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!pat) {
    console.log('  REPO_SECRETS_PAT not set — new refresh token NOT persisted.');
    console.log('  The next scheduled run will fail. Manually update QUIN_REFRESH_TOKEN,');
    console.log('  or add a PAT secret so this runs persist automatically.');
    return { patExpiresAt: null };
  }
  if (!repo) {
    console.log('  GITHUB_REPOSITORY not set — cannot persist refresh token.');
    return { patExpiresAt: null };
  }
  const { default: fetch } = await import('node-fetch');
  const sodium = require('libsodium-wrappers');
  await sodium.ready;

  const keyRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/secrets/public-key`,
    {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!keyRes.ok) {
    const body = await keyRes.text();
    throw new Error(`Fetch public key failed: HTTP ${keyRes.status} — ${body.substring(0, 300)}`);
  }
  const { key, key_id } = await keyRes.json();

  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binSecret = sodium.from_string(newRefreshToken);
  const encBytes = sodium.crypto_box_seal(binSecret, binKey);
  const encrypted_value = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

  const putRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/secrets/QUIN_REFRESH_TOKEN`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encrypted_value, key_id }),
    }
  );
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Update secret failed: HTTP ${putRes.status} — ${body.substring(0, 300)}`);
  }
  console.log('  QUIN_REFRESH_TOKEN secret updated for next run.');
  return { patExpiresAt: putRes.headers.get('github-authentication-token-expiration') };
}

// Exchange a long-lived refresh token for a fresh 30-minute access token
// via Peoplevine's OAuth 2.0 refresh endpoint.
async function refreshAccessToken(refreshToken) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${BASE_URL}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: HTTP ${res.status} — ${body.substring(0, 500)}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Refresh response missing access_token field');
  }
  return {
    accessToken: data.access_token,
    newRefreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

// For processes that mint more than once (enroll.js arms ~75 min early, then
// mints again right before tickets open). The secret is only read at job
// start, so the second mint must use the rotated token held in memory — the
// original env value has already been spent.
function createTokenMinter(rawStoredToken) {
  let currentRefreshToken = decodeStoredToken(rawStoredToken);
  return async function mint() {
    const { accessToken, newRefreshToken, expiresIn } = await refreshAccessToken(currentRefreshToken);
    let persistError = null;
    let patExpiresAt = null;
    if (newRefreshToken && newRefreshToken !== currentRefreshToken) {
      currentRefreshToken = newRefreshToken;
      try {
        ({ patExpiresAt } = await persistRefreshToken(newRefreshToken));
      } catch (e) {
        persistError = e.message;
      }
    }
    return { accessToken, expiresIn, persistError, patExpiresAt };
  };
}

module.exports = {
  BASE_URL,
  decodeStoredToken,
  persistRefreshToken,
  refreshAccessToken,
  createTokenMinter,
};
