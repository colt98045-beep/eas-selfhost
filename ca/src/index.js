// eas-repository-ca: static dashboard plus the /api/* routes from eas_monitor.py.
// /api/canada and /api/active both return Environment Canada GeoMet weather alerts.
import { logRequest } from "./access-log.js";

const GEOMET_URL = "https://api.weather.gc.ca/collections/weather-alerts/items";
const DEFAULT_QUERY = "?f=json&limit=500";
const USER_AGENT = "EASRepositoryCA/1.0 (https://github.com/your-github-user/eas-repository-ca)";
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 20_000;
const MAX_CACHED_BYTES = 8 * 1024 * 1024;
const memCache = new Map();

const app = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/canada" || url.pathname === "/api/active") {
      if (request.method !== "GET" && request.method !== "HEAD") return plain("Unsupported method", 501);
      return geomet(url.search || DEFAULT_QUERY);
    }
    if (url.pathname.startsWith("/api/")) return plain("Not Found", 404);
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return plain("Not Found", 404);
  },
};

// Low-risk headers on every response. No CSP here yet: the dashboard uses
// inline scripts and third-party map/tile/font hosts.
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
};

export function withSecurityHeaders(response) {
  if (!response || response.status === 101) return response;
  let out;
  try {
    out = new Response(response.body, response);
  } catch {
    return response;
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const response = withSecurityHeaders(await app.fetch(request, env));
    try {
      logRequest(ctx, env, request, response, { site: "ca" });
    } catch {
      // logging must never change the response
    }
    return response;
  },
};

async function geomet(search) {
  const upstream = GEOMET_URL + search;
  const now = Date.now();
  const hit = memCache.get(upstream);
  if (hit && now - hit.ts < CACHE_TTL_MS) return json(hit.body);
  try {
    const r = await fetch(upstream, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.arrayBuffer();
    JSON.parse(new TextDecoder().decode(body));
    if (body.byteLength <= MAX_CACHED_BYTES) memCache.set(upstream, { body, ts: now });
    return json(body);
  } catch (e) {
    console.log(`Environment Canada fetch error: ${e}`);
    return plain("Upstream feed unavailable", 502);
  }
}

function json(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
  });
}

function plain(body, status) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
