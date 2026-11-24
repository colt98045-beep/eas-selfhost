// Request access logger. Never throws to the caller. Writes are scheduled
// with ctx.waitUntil when a context is provided, and are no-ops if D1 is
// missing or the write fails.
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_EXCLUDE = ["/api/status", "/sw.js", "/banner.js", "/manifest.json", "/api/maintenance"];

export function excludedPaths(env = {}) {
  if (typeof env.ACCESS_LOG_EXCLUDE === "string" && env.ACCESS_LOG_EXCLUDE.trim()) {
    return env.ACCESS_LOG_EXCLUDE.split(",").map((s) => normalizePath(s.trim())).filter(Boolean);
  }
  return DEFAULT_EXCLUDE.slice();
}

export function normalizePath(pathname) {
  const raw = String(pathname || "/").split("?")[0];
  if (!raw) return "/";
  if (raw.length > 1 && raw.endsWith("/")) return raw.replace(/\/+$/, "") || "/";
  return raw;
}

export function shouldLogPath(pathname, env = {}) {
  const path = normalizePath(pathname);
  return !excludedPaths(env).includes(path);
}

export function requestIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    ""
  );
}

export async function hashIp(ip, salt) {
  if (!ip || !salt) return null;
  const data = new TextEncoder().encode(String(salt) + String(ip));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex.slice(0, 12);
}

// Full client IP as Cloudflare saw it (CF-Connecting-IP only; never a
// client-supplied X-Forwarded-For). At most 45 chars (IPv6 max), else null.
export function clientIp(request) {
  const ip = (request.headers.get("CF-Connecting-IP") || "").trim();
  if (!ip || ip.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(ip)) return null;
  return ip;
}

export function truncateUa(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, 200);
}

export function scheduleAccessLog(ctx, work) {
  try {
    const pending = Promise.resolve()
      .then(work)
      .catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") {
      try {
        ctx.waitUntil(pending);
      } catch {
        // ignore
      }
    }
  } catch {
    // never affect the response
  }
}

export function usGateOutcome(request, response) {
  const path = normalizePath(new URL(request.url).pathname);
  const ctype = (response.headers.get("content-type") || "").toLowerCase();
  if ((response.status === 403 || response.status === 503) && ctype.includes("text/html")) return "challenged";
  if (path.startsWith("/api/") || path === "/__turnstile/verify") return "api";
  return "passed";
}

export async function writeAccessLog(env, request, response, { site, gate = null, now = Date.now() } = {}) {
  if (!env || !env.ACCESS_LOG) return false;
  if (!request || !response) return false;
  const url = new URL(request.url);
  if (!shouldLogPath(url.pathname, env)) return false;
  const ipHash = await hashIp(requestIp(request), env.ACCESS_LOG_SALT);
  const ua = truncateUa(request.headers.get("user-agent") || "");
  const country = (request.cf && request.cf.country) || request.headers.get("CF-IPCountry") || null;
  const base = [now, site, request.method || "GET", normalizePath(url.pathname), response.status, country, ipHash];
  const tail = [ua || null, gate];
  try {
    await env.ACCESS_LOG.prepare(
      `INSERT INTO access_logs (ts, site, method, path, status, country, ip_hash, ip, user_agent, gate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(...base, clientIp(request), ...tail)
      .run();
  } catch (err) {
    // Before migration 0002_add_ip.sql is applied the ip column does not
    // exist yet; keep logging without it so deploy order does not matter.
    if (!/no column named ip|has no column|no such column/i.test(String((err && err.message) || err))) throw err;
    await env.ACCESS_LOG.prepare(
      `INSERT INTO access_logs (ts, site, method, path, status, country, ip_hash, user_agent, gate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(...base, ...tail)
      .run();
  }
  return true;
}

export function logRequest(ctx, env, request, response, options) {
  scheduleAccessLog(ctx, () => writeAccessLog(env, request, response, options));
}
