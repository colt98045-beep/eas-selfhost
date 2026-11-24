// eas-repository: Turnstile gate in front of the existing static-assets site.
//
// Every request without a valid clearance cookie gets a small challenge page.
// The page POSTs the Turnstile token to /__turnstile/verify, which calls
// siteverify server-side (fail closed), requires success + action "gate" +
// an allowed hostname, then sets a 12 h HMAC-signed cookie and redirects back.
// Requests with a valid cookie go to the original handler unchanged.
//
// Bindings / config:
//   env.ASSETS               assets binding (the site's existing static files)
//   env.TURNSTILE_SITEKEY    plain var, public sitekey
//   env.TURNSTILE_HOSTNAMES  plain var, comma-separated, e.g. "eas-repository.your-subdomain.workers.dev"
//   env.TURNSTILE_SECRET     Worker secret (siteverify secret)
//   env.GATE_COOKIE_SECRET   Worker secret (HMAC key for the clearance cookie, >= 32 random bytes)

import { logRequest, usGateOutcome } from "./access-log.js";
import { PRIVACY_HTML } from "./privacy.js";

const VERIFY_PATH = '/__turnstile/verify';
// Tab icon for the Worker-generated pages (challenge, failure). Inline data: URI,
// so no new path is exempted from the gate. Same mark as index.html and /privacy.
const ICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231e3a8a'/%3E%3Cpath d='M32 10 56 52H8Z' fill='%23dc2626'/%3E%3Crect x='29' y='24' width='6' height='15' rx='3' fill='%23fff'/%3E%3Ccircle cx='32' cy='45' r='3.4' fill='%23fff'/%3E%3C/svg%3E">`;
const EXPECTED_ACTION = 'gate';
const COOKIE_NAME = '__Host-eas_gate';
const COOKIE_TTL_SECONDS = 12 * 60 * 60;
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_FORM_BYTES = 8 * 1024;
// Public, non-sensitive files browsers fetch WITHOUT cookies (the web app manifest
// is requested with credentials "omit"), so they would otherwise get the challenge page.
const UNGATED_PATHS = new Set(['/manifest.json']);
// The privacy policy must be readable before the Turnstile check, because the
// gate logs challenged visitors. Exact pathnames only, no query string, served
// as a static string from src/privacy.js (never from ASSETS, no cookies, no API).
const PUBLIC_PRIVACY_PATHS = new Set(['/privacy', '/privacy/']);

// ---------------------------------------------------------------------------
// Original logic: the static assets, plus the API routes from eas_monitor.py
// (which the Python server provided locally and the Worker previously lacked).
async function originalHandler(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/')) return handleApi(request, path);
  return env.ASSETS.fetch(request);
}

// ------------------------------------------------------------------ api ---
// Port of the API routes in eas_monitor.py (same upstreams, User-Agent,
// headers, timeouts, fallback and response formats).

const API_BASE = 'https://alerts.globaleas.org';
const USER_AGENT = 'EASRepository/1.0 (https://github.com/your-github-user/eas-repository)';
const ACTIVE_CACHE_TTL_MS = 10_000; // CACHE_TTL = 10 in the Python
const PROXY_CACHE_TTL_MS = 30_000; // short cache for the large NOAA/NWS feeds
const EDGE_CACHE_TTL_S = 30;
const MAX_CACHED_BYTES = 8 * 1024 * 1024;

// In-isolate caches (like the Python module-level _cache).
const activeCache = { data: null, ts: 0 };
const proxyCache = new Map(); // url -> { body, ts }

// alerts.weather.gov (the legacy CAP/Atom feeds the Python uses) no longer
// resolves in DNS. The original URL is still tried first; on failure the same
// Atom + CAP feed from api.weather.gov is used, which the frontend parses the
// same way (entry / cap:event / cap:severity / summary / title).
const NOAA_NATIONAL = ['https://alerts.weather.gov/cap/us.php?x=1', 'https://api.weather.gov/alerts/active.atom'];
const noaaState = (st) => [
  `https://alerts.weather.gov/cap/wwaatmget.php?x=${encodeURIComponent(st)}`,
  `https://api.weather.gov/alerts/active.atom?area=${encodeURIComponent(st)}`,
];

async function handleApi(request, path) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('Unsupported method', 501); // BaseHTTPRequestHandler has only do_GET
  }

  if (path === '/api/active') {
    const alerts = await fetchActiveAlerts();
    return apiResponse(JSON.stringify(alerts), 'application/json');
  }

  if (path === '/api/noaa') {
    return proxy(NOAA_NATIONAL, 'application/xml');
  }

  if (path.startsWith('/api/noaa/')) {
    const state = path.split('/').pop().toUpperCase();
    if (state.length === 2) {
      return proxy(noaaState(state), 'application/xml');
    }
  }

  if (path === '/api/nws') {
    return proxy(['https://api.weather.gov/alerts/active'], 'application/json', { Accept: 'application/geo+json' });
  }

  return text('Not Found', 404);
}

async function upstreamFetch(url, extraHeaders, timeoutMs) {
  const r = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...(extraHeaders || {}) },
    signal: AbortSignal.timeout(timeoutMs),
    cf: { cacheTtl: EDGE_CACHE_TTL_S, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); // urlopen raises on 4xx/5xx
  return r;
}

async function fetchActiveAlerts() {
  const now = Date.now();
  if (activeCache.data !== null && now - activeCache.ts < ACTIVE_CACHE_TTL_MS) return activeCache.data;
  try {
    const r = await upstreamFetch(`${API_BASE}/api/v2/alerts/active`, null, 15_000);
    const data = JSON.parse(await r.text());
    activeCache.data = data;
    activeCache.ts = now;
    return data;
  } catch (e) {
    console.log(`GlobalEAS fetch error: ${e}`);
    return activeCache.data || [];
  }
}

async function proxy(urls, contentType, extraHeaders) {
  const now = Date.now();
  const key = urls.join(' ') + JSON.stringify(extraHeaders || {});
  const hit = proxyCache.get(key);
  if (hit && now - hit.ts < PROXY_CACHE_TTL_MS) return apiResponse(hit.body, contentType);
  for (const url of urls) {
    try {
      const r = await upstreamFetch(url, extraHeaders, 20_000);
      const body = await r.arrayBuffer();
      if (body.byteLength <= MAX_CACHED_BYTES) proxyCache.set(key, { body, ts: now });
      return apiResponse(body, contentType);
    } catch (e) {
      console.log(`Proxy error (${url}): ${e}`);
    }
  }
  return text('Upstream feed unavailable', 502);
}

function apiResponse(body, contentType) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' },
  });
}
// ---------------------------------------------------------------------------

const gateWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === VERIFY_PATH) {
      if (request.method !== 'POST') {
        return text('Method Not Allowed', 405, { Allow: 'POST' });
      }
      return handleVerify(request, env, url);
    }

    if (PUBLIC_PRIVACY_PATHS.has(url.pathname) && url.search === '') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return text('Method Not Allowed', 405, { Allow: 'GET, HEAD' });
      }
      return privacyPage(request.method);
    }

    if (UNGATED_PATHS.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return originalHandler(request, env, ctx);
    }

    if (await hasValidClearance(request, env, url.hostname)) {
      return originalHandler(request, env, ctx);
    }

    // No clearance. Only navigations can be challenged; anything else fails closed.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Forbidden: Turnstile clearance required', 403);
    }
    return challengePage(env, url.pathname + url.search);
  },
};

export default {
  async fetch(request, env, ctx) {
    const response = await gateWorker.fetch(request, env, ctx);
    try {
      logRequest(ctx, env, request, response, { site: 'us', gate: usGateOutcome(request, response) });
    } catch {
      // logging must never change the gate or the response
    }
    return response;
  },
};

// ---------------------------------------------------------------- verify ---

async function handleVerify(request, env, url) {
  const expectedHostnames = parseHostnames(env.TURNSTILE_HOSTNAMES);
  if (!env.TURNSTILE_SECRET || !env.GATE_COOKIE_SECRET || expectedHostnames.size === 0) {
    console.error('turnstile gate misconfigured: missing secret or TURNSTILE_HOSTNAMES');
    return failPage(503, '/');
  }

  // Same-origin form posts only.
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return failPage(403, '/');

  const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ctype.startsWith('application/x-www-form-urlencoded')) return failPage(403, '/');
  const len = Number(request.headers.get('Content-Length') || '0');
  if (len > MAX_FORM_BYTES) return failPage(413, '/');

  let form;
  try {
    const body = await request.text();
    if (body.length > MAX_FORM_BYTES) return failPage(413, '/');
    form = new URLSearchParams(body);
  } catch {
    return failPage(400, '/');
  }

  const returnTo = safeReturnPath(form.get('return'));
  const token = form.get('cf-turnstile-response');
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    return failPage(403, returnTo);
  }

  let result;
  try {
    const params = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) params.set('remoteip', ip);
    const r = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    result = await r.json();
  } catch (err) {
    console.error('siteverify failed', String(err)); // fail closed
    return failPage(403, returnTo);
  }

  if (
    !result ||
    result.success !== true ||
    result.action !== EXPECTED_ACTION ||
    !expectedHostnames.has(result.hostname)
  ) {
    console.log('turnstile rejected', JSON.stringify({
      success: result && result.success,
      action: result && result.action,
      hostname: result && result.hostname,
      errors: result && result['error-codes'],
    }));
    return failPage(403, returnTo);
  }

  const cookie = await makeClearanceCookie(env.GATE_COOKIE_SECRET, url.hostname);
  return new Response(null, {
    status: 303,
    headers: {
      Location: returnTo,
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    },
  });
}

// --------------------------------------------------------------- cookies ---

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function payloadFor(exp, hostname) {
  return `v1|${exp}|${hostname}`;
}

async function makeClearanceCookie(secret, hostname) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadFor(exp, hostname)));
  const value = `${exp}.${b64url(new Uint8Array(sig))}`;
  return `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function hasValidClearance(request, env, hostname) {
  if (!env.GATE_COOKIE_SECRET) return false; // fail closed
  const raw = getCookie(request.headers.get('Cookie'), COOKIE_NAME);
  if (!raw) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!m) return false;
  const exp = Number(m[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!(exp > now) || exp > now + COOKIE_TTL_SECONDS + 60) return false;
  let sig;
  try {
    sig = unb64url(m[2]);
  } catch {
    return false;
  }
  const key = await hmacKey(env.GATE_COOKIE_SECRET);
  // crypto.subtle.verify is constant-time.
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(payloadFor(exp, hostname)));
}

function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ----------------------------------------------------------------- pages ---

function parseHostnames(value) {
  return new Set(String(value ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

// Only same-site relative paths; never the verify endpoint; never "//host" or "/\host".
function safeReturnPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const u = new URL(value, 'https://gate.invalid');
    if (u.origin !== 'https://gate.invalid' || u.pathname === VERIFY_PATH) return '/';
    return u.pathname + u.search;
  } catch {
    return '/';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function securityHeaders(nonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`,
      'frame-src https://challenges.cloudflare.com',
      "connect-src https://challenges.cloudflare.com",
      "style-src 'unsafe-inline'",
      'img-src data:',
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}

function challengePage(env, returnTo) {
  if (!env.TURNSTILE_SITEKEY) {
    console.error('turnstile gate misconfigured: missing TURNSTILE_SITEKEY');
    return text('Service temporarily unavailable', 503);
  }
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checking your browser…</title>
${ICON_LINK}
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f7f9;color:#222}
main{background:#fff;padding:2rem 2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:420px}
button{margin-top:1rem;padding:.5rem 1.25rem;font-size:1rem;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}</style>
<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head><body><main>
<h1 style="font-size:1.25rem">Quick check before you continue</h1>
<p>Please confirm you're human to open this site.</p>
<form id="gate" method="POST" action="${VERIFY_PATH}">
<input type="hidden" name="return" value="${escapeHtml(returnTo)}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITEKEY)}" data-action="${EXPECTED_ACTION}" data-callback="gateDone"></div>
<noscript><p>JavaScript is required to complete this check.</p></noscript>
<button type="submit">Continue</button>
</form>
<script nonce="${nonce}">function gateDone(){document.getElementById('gate').submit();}</script>
<p style="font-size:.8rem;margin:1.25rem 0 0"><a href="/privacy">Privacy policy</a></p>
</main></body></html>`;
  return new Response(html, { status: 403, headers: securityHeaders(nonce) });
}

function privacyPage(method) {
  return new Response(method === 'HEAD' ? null : PRIVACY_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

function failPage(status, returnTo) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Verification failed</title>${ICON_LINK}</head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:15vh">
<h1 style="font-size:1.25rem">Verification failed</h1>
<p><a href="${escapeHtml(returnTo)}">Try again</a></p></body></html>`;
  return new Response(html, { status, headers: securityHeaders(nonce) });
}

function text(body, status, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
