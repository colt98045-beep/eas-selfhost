// Cloudflare Access JWT verification for /admin and /api/admin/*.
// Fail closed: missing or incomplete Access config, a missing token, a bad
// signature, a mismatched aud/iss/email, or a certs fetch failure all deny.
// Certs are loaded from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
// and matched by the JWT kid (current + previous keys after rotation).

import { allowedAdminEmails, PERMANENT_ADMIN } from "./admins.js";

const CERTS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const TEAM_HOST_SUFFIX = ".cloudflareaccess.com";

let certsCache = { key: "", expires: 0, jwks: null };

export function resetAccessCache() {
  certsCache = { key: "", expires: 0, jwks: null };
}

export function isAdminPath(pathname) {
  if (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin.html") return true;
  if (pathname.startsWith("/api/admin")) return true;
  return false;
}

export function normalizeTeamDomain(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(TEAM_HOST_SUFFIX) || host === TEAM_HOST_SUFFIX.slice(1)) return null;
  return `https://${host}`;
}

export function parseAllowedEmails(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getAccessConfig(env = {}) {
  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const aud = typeof env.CF_ACCESS_AUD === "string" ? env.CF_ACCESS_AUD.trim() : "";
  const emails = parseAllowedEmails(env.CF_ACCESS_ALLOWED_EMAILS);
  if (!emails.includes(PERMANENT_ADMIN)) emails.unshift(PERMANENT_ADMIN);
  // Team domain and AUD are required. The permanent admin is always in the
  // allow list, even when CF_ACCESS_ALLOWED_EMAILS is empty.
  const ok = Boolean(teamDomain && aud);
  return { ok, teamDomain, aud, emails };
}

function readToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion") || request.headers.get("cf-access-jwt-assertion");
  if (typeof header === "string" && header.trim()) return header.trim();
  return "";
}

function b64urlToBytes(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonPart(part) {
  const text = new TextDecoder().decode(b64urlToBytes(part));
  return JSON.parse(text);
}

function audienceMatches(claim, expected) {
  if (typeof claim === "string") return claim === expected;
  if (Array.isArray(claim)) return claim.includes(expected);
  return false;
}

function claimEmail(payload) {
  if (typeof payload.email === "string" && payload.email.trim()) return payload.email.trim().toLowerCase();
  const identity = payload.identity;
  if (identity && typeof identity.email === "string" && identity.email.trim()) {
    return identity.email.trim().toLowerCase();
  }
  return "";
}

async function loadJwks(teamDomain, fetcher, now) {
  if (certsCache.jwks && certsCache.key === teamDomain && now < certsCache.expires) {
    return certsCache.jwks;
  }
  const res = await fetcher(`${teamDomain}/cdn-cgi/access/certs`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`certs HTTP ${res.status}`);
  const jwks = await res.json();
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error("certs missing keys");
  certsCache = { key: teamDomain, expires: now + CERTS_TTL_MS, jwks };
  return jwks;
}

async function importRsaKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify the Access JWT on a request.
 * Returns { ok: true, email, payload } or { ok: false, status, code, reason }.
 */
export async function verifyAccessJwt(request, env, { fetcher = fetch, now = Date.now() } = {}) {
  const config = getAccessConfig(env);
  if (!config.ok) {
    return {
      ok: false,
      status: 403,
      code: "not_configured",
      reason: "Admin is not configured",
    };
  }

  const token = readToken(request);
  if (!token) {
    return { ok: false, status: 401, code: "missing_token", reason: "Access required" };
  }

  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, status: 403, code: "malformed", reason: "Forbidden" };
  }

  let header;
  let payload;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
  } catch {
    return { ok: false, status: 403, code: "malformed", reason: "Forbidden" };
  }

  if (header.alg !== "RS256") {
    return { ok: false, status: 403, code: "bad_alg", reason: "Forbidden" };
  }

  let jwks;
  try {
    jwks = await loadJwks(config.teamDomain, fetcher, now);
  } catch {
    return { ok: false, status: 403, code: "certs_unavailable", reason: "Forbidden" };
  }

  const jwk = jwks.keys.find((k) => k && k.kid === header.kid && k.kty === "RSA");
  if (!jwk || !jwk.n || !jwk.e) {
    return { ok: false, status: 403, code: "unknown_kid", reason: "Forbidden" };
  }

  let signatureOk = false;
  try {
    const key = await importRsaKey(jwk);
    const sig = b64urlToBytes(parts[2]);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    signatureOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { ok: false, status: 403, code: "bad_signature", reason: "Forbidden" };
  }

  if (payload.iss !== config.teamDomain) {
    return { ok: false, status: 403, code: "bad_iss", reason: "Forbidden" };
  }
  if (!audienceMatches(payload.aud, config.aud)) {
    return { ok: false, status: 403, code: "bad_aud", reason: "Forbidden" };
  }

  const nowS = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowS) {
    return { ok: false, status: 403, code: "expired", reason: "Forbidden" };
  }
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowS) {
    return { ok: false, status: 403, code: "not_yet_valid", reason: "Forbidden" };
  }

  const email = claimEmail(payload);
  let allowed;
  try {
    allowed = await allowedAdminEmails(env);
  } catch {
    allowed = config.emails;
  }
  if (!allowed.includes(PERMANENT_ADMIN)) allowed = [PERMANENT_ADMIN, ...allowed];
  if (!email || !allowed.includes(email)) {
    return { ok: false, status: 403, code: "email_not_allowed", reason: "Forbidden" };
  }

  return { ok: true, email, payload };
}

export function accessDeniedResponse(result, { asHtml = false } = {}) {
  const status = result.status || 403;
  const reason = result.reason || "Forbidden";
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (asHtml) {
    headers["content-type"] = "text/html; charset=utf-8";
    const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access required</title>
  <style>
    body { margin:0; min-height:100dvh; display:grid; place-items:center; background:#070b14; color:#f1f5f9; font-family:Inter,system-ui,sans-serif; }
    main { text-align:center; padding:24px; }
    h1 { margin:0 0 8px; font-size:1.2rem; }
    p { margin:0; color:#94a3b8; }
  </style>
</head>
<body>
  <main>
    <h1>${status === 401 ? "Access required" : "Forbidden"}</h1>
    <p>${reason}. This admin page is locked with Cloudflare Access.</p>
  </main>
</body>
</html>`;
    return new Response(body, { status, headers });
  }
  headers["content-type"] = "application/json; charset=utf-8";
  return new Response(JSON.stringify({ error: reason }), { status, headers });
}

export async function requireAccess(request, env, options = {}) {
  const result = await verifyAccessJwt(request, env, options);
  if (result.ok) return result;
  const url = new URL(request.url);
  const asHtml = !url.pathname.startsWith("/api/");
  return { ...result, response: accessDeniedResponse(result, { asHtml }) };
}
