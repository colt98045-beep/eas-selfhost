// Request access logger. Never throws to the caller. Writes are scheduled
// with ctx.waitUntil when a context is provided, and are no-ops if D1 is
// missing or the write fails.
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_EXCLUDE = [
  "/api/status",
  "/sw.js",
  "/banner.js",
  "/manifest.json",
  "/api/maintenance",
  "/api/uptime",
  "/api/badge",
  "/icon.svg",
  "/favicon.ico",
];
// Static script files under these prefixes are never logged.
export const EXCLUDE_PREFIXES = ["/js/"];
// The launcher's own status checker (status.js probe User-Agent). Its requests
// ARE logged: a User-Agent is client-controlled, so skipping on it would let
// anyone hide from the log. The Insights queries filter it out instead.
export const MONITOR_UA_PREFIX = "EAS-Launcher-Status";

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
  if (EXCLUDE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
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

import { formatEt } from "./status.js";

const SITES = new Set(["us", "ca", "launcher"]);

export async function pruneAccessLogs(env, { now = Date.now() } = {}) {
  if (!env || !env.ACCESS_LOG) return { ok: false, reason: "no_binding" };
  const cutoff = now - RETENTION_MS;
  const logs = await env.ACCESS_LOG.prepare("DELETE FROM access_logs WHERE ts < ?").bind(cutoff).run();
  const audit = await env.ACCESS_LOG.prepare("DELETE FROM admin_audit WHERE ts < ?").bind(cutoff).run();
  return { ok: true, cutoff, logs, audit };
}

export async function writeAdminAudit(env, { actor, action, email, now = Date.now() }) {
  if (!env || !env.ACCESS_LOG) return false;
  await env.ACCESS_LOG.prepare("INSERT INTO admin_audit (ts, actor, action, email) VALUES (?, ?, ?, ?)")
    .bind(now, actor, action, email)
    .run();
  return true;
}

function likeEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function parseLogFilters(url, { now = Date.now() } = {}) {
  const site = (url.searchParams.get("site") || "").toLowerCase().trim();
  const path = (url.searchParams.get("path") || "").trim();
  const ip = (url.searchParams.get("ip") || "").trim().slice(0, 45);
  const statusRaw = url.searchParams.get("status");
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  let page = Number(url.searchParams.get("page") || 1);
  let limit = Number(url.searchParams.get("limit") || 50);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;
  const status = statusRaw === null || statusRaw === "" ? null : Number(statusRaw);
  if (status !== null && (!Number.isFinite(status) || status < 0)) {
    return { error: "status must be a number" };
  }
  if (site && !SITES.has(site)) return { error: "site must be us, ca, or launcher" };
  const from = parseBound(fromRaw, now - 24 * 60 * 60 * 1000);
  const to = parseBound(toRaw, now);
  if (from === undefined || to === undefined) return { error: "from and to must be ISO timestamps or epoch milliseconds" };
  return { site: site || null, path: path || null, ip: ip || null, status, from, to, page, limit };
}

function parseBound(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (/^\d+$/.test(String(raw))) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

export function publicLogView(row) {
  return {
    id: row.id,
    ts: row.ts,
    ts_et: formatEt(new Date(row.ts)),
    site: row.site,
    method: row.method,
    path: row.path,
    status: row.status,
    country: row.country,
    ip_hash: row.ip_hash,
    ip: row.ip || null,
    user_agent: row.user_agent,
    gate: row.gate,
  };
}

const MISSING_IP_COLUMN = /no such column:?\s*ip\b|has no column named ip\b/i;

export async function queryAccessLogs(env, filters) {
  if (!env || !env.ACCESS_LOG) return { error: "Access log storage is not bound", status: 503 };
  try {
    return await runAccessLogQuery(env, filters, true);
  } catch (err) {
    // Before schema/migrations/0002_add_ip.sql is applied the ip column does not
    // exist; keep the log readable (IPs show as empty) instead of failing.
    if (!MISSING_IP_COLUMN.test(String((err && err.message) || err))) throw err;
    const payload = await runAccessLogQuery(env, filters, false);
    payload.ip_column_missing = true;
    return payload;
  }
}

async function runAccessLogQuery(env, filters, withIp) {
  const clauses = ["ts >= ?", "ts <= ?"];
  const args = [filters.from, filters.to];
  if (filters.site) {
    clauses.push("site = ?");
    args.push(filters.site);
  }
  if (filters.path) {
    clauses.push("path LIKE ? ESCAPE '\\'");
    args.push("%" + likeEscape(filters.path) + "%");
  }
  if (filters.ip && withIp) {
    // Prefix match so "203.0.113." or "2001:db8:" finds a whole range.
    clauses.push("ip LIKE ? ESCAPE '\\'");
    args.push(likeEscape(filters.ip) + "%");
  }
  if (filters.status !== null && filters.status !== undefined) {
    clauses.push("status = ?");
    args.push(filters.status);
  }
  const where = clauses.join(" AND ");
  const offset = (filters.page - 1) * filters.limit;
  const totalRow = await env.ACCESS_LOG.prepare(`SELECT COUNT(*) AS n FROM access_logs WHERE ${where}`)
    .bind(...args)
    .first();
  const total = Number(totalRow && totalRow.n) || 0;
  const listed = await env.ACCESS_LOG.prepare(
    `SELECT id, ts, site, method, path, status, country, ip_hash, ${withIp ? "ip" : "NULL AS ip"}, user_agent, gate
     FROM access_logs WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...args, filters.limit, offset)
    .all();
  const dayFrom = filters.to - 24 * 60 * 60 * 1000;
  const summaryRows = await env.ACCESS_LOG.prepare(
    `SELECT site, COUNT(*) AS n FROM access_logs WHERE ts >= ? AND ts <= ? GROUP BY site`,
  )
    .bind(dayFrom, filters.to)
    .all();
  const summary = { us: 0, ca: 0, launcher: 0 };
  for (const row of (summaryRows && summaryRows.results) || []) {
    if (summary[row.site] !== undefined) summary[row.site] = Number(row.n) || 0;
  }
  summary.total = summary.us + summary.ca + summary.launcher;
  summary.from_et = formatEt(new Date(dayFrom));
  summary.to_et = formatEt(new Date(filters.to));
  return {
    filters: {
      site: filters.site,
      path: filters.path,
      ip: filters.ip || null,
      status: filters.status,
      from: filters.from,
      to: filters.to,
      from_et: formatEt(new Date(filters.from)),
      to_et: formatEt(new Date(filters.to)),
    },
    summary,
    page: filters.page,
    limit: filters.limit,
    total,
    pages: Math.max(1, Math.ceil(total / filters.limit)),
    logs: ((listed && listed.results) || []).map(publicLogView),
  };
}

export async function handleAdminLogs(request, env, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  if (path !== "/api/admin/logs") {
    return json({ error: "Not Found" }, 404);
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", "cache-control": "no-store" } });
  }
  const filters = parseLogFilters(url, { now });
  if (filters.error) return json({ error: filters.error }, 400);
  const payload = await queryAccessLogs(env, filters);
  if (payload.error) return json({ error: payload.error }, payload.status || 503, method);
  return json(payload, 200, method);
}

function json(payload, status = 200, method = "GET") {
  return new Response(method === "HEAD" ? null : JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
