'use strict';

// Vercel Serverless Function: keeps the Metered TURN Credential API Key
// outside the public HTML bundle. The browser receives only ICE server data.

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 24;
const STORE_KEY = Symbol.for('mult.final.turn.rateLimit');

function getRateStore() {
  if (!globalThis[STORE_KEY]) globalThis[STORE_KEY] = new Map();
  return globalThis[STORE_KEY];
}

function allowRequest(ip) {
  const now = Date.now();
  const store = getRateStore();
  const record = store.get(ip);
  if (!record || now - record.startedAt >= WINDOW_MS) {
    store.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (record.count >= MAX_REQUESTS_PER_WINDOW) return false;
  record.count += 1;
  return true;
}

function isIceServer(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const urls = entry.urls || entry.url;
  if (typeof urls === 'string') return /^(stun|stuns|turn|turns):/i.test(urls);
  return Array.isArray(urls) && urls.length > 0 && urls.every((url) =>
    typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url)
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const forwardedFor = String(req.headers['x-forwarded-for'] || '');
  const clientIp = forwardedFor.split(',')[0].trim() || 'unknown';
  if (!allowRequest(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please retry in a minute.' });
  }

  const rawDomain = String(process.env.METERED_APP_DOMAIN || '').trim();
  const apiKey = String(process.env.METERED_TURN_API_KEY || '').trim();
  const domain = rawDomain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  if (!/^[a-z0-9.-]+\.metered\.live$/i.test(domain) || !apiKey) {
    return res.status(503).json({
      error: 'TURN service is not configured. Set METERED_APP_DOMAIN and METERED_TURN_API_KEY in Vercel.'
    });
  }

  // Do not log this URL: it contains the credential-scoped API key.
  const upstreamUrl = new URL(`https://${domain}/api/v1/turn/credentials`);
  upstreamUrl.searchParams.set('apiKey', apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal
    });

    if (!upstream.ok) {
      // Do not forward upstream response bodies; they may contain diagnostics
      // that should not be exposed to public clients.
      const status = upstream.status === 401 ? 502 : upstream.status;
      return res.status(status).json({
        error: 'Metered TURN credentials request failed.',
        upstreamStatus: upstream.status
      });
    }

    const payload = await upstream.json();
    const entries = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload.iceServers)
          ? payload.iceServers
          : (Array.isArray(payload.ice_servers) ? payload.ice_servers : []));
    const iceServers = entries.filter(isIceServer).map((entry) => {
      const clean = { urls: entry.urls || entry.url };
      if (entry.username) clean.username = entry.username;
      if (entry.credential) clean.credential = entry.credential;
      if (entry.credentialType) clean.credentialType = entry.credentialType;
      return clean;
    });

    const hasTurn = iceServers.some((entry) => {
      const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
      return urls.some((url) => /^turns?:/i.test(url));
    });

    if (!hasTurn) {
      return res.status(502).json({ error: 'Metered response did not contain TURN servers.' });
    }

    return res.status(200).json(iceServers);
  } catch (error) {
    // Log only the error class, never the API key or upstream URL.
    const name = error && error.name === 'AbortError' ? 'timeout' : 'request_error';
    return res.status(502).json({ error: 'Could not retrieve TURN credentials.', code: name });
  } finally {
    clearTimeout(timeout);
  }
};
