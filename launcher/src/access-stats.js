// Aggregates for the admin Insights charts. Admin-only (behind the Access JWT).
// Reads access_logs in the shared eas-access-log D1. Requests from the
// launcher's own status checker (User-Agent EAS-Launcher-Status/*) are
// excluded so the uptime probes do not drown out real visitors.
import { formatEt } from "./status.js";
import { etDateKey, etHourLabel, hourFloor, HOUR_MS, DAY_MS } from "./uptime.js";

export const RANGES = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };
export const SITES = ["us", "ca", "launcher"];
export const TOP_N = 10;
export const MONITOR_UA = "EAS-Launcher-Status%";

export function parseStatsQuery(url) {
  const range = (url.searchParams.get("range") || "24h").toLowerCase();
  if (!RANGES[range]) return { error: "range must be 24h, 7d or 30d" };
  const site = (url.searchParams.get("site") || "").toLowerCase().trim();
  if (site && !SITES.includes(site)) return { error: "site must be us, ca, or launcher" };
  return { range, site: site || null };
}

// Build empty buckets: hourly for 24h, ET days for 7d/30d.
export function buckets(range, now) {
  if (range === "24h") {
    const out = [];
    for (let i = 23; i >= 0; i--) {
      const h = hourFloor(now) - i * HOUR_MS;
      out.push({ key: String(h), label: etHourLabel(h) });
    }
    return out;
  }
  const days = range === "7d" ? 7 : 30;
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = etDateKey(now - i * DAY_MS);
    if (!out.some((b) => b.key === key)) out.push({ key, label: key.slice(0, 5) });
  }
  return out;
}

export function foldSeries(range, hourlyRows, now) {
  const list = buckets(range, now);
  const index = new Map(list.map((b, i) => [b.key, i]));
  const series = {};
  for (const site of SITES) series[site] = list.map(() => 0);
  for (const row of hourlyRows) {
    const key = range === "24h" ? String(Number(row.hour_ts)) : etDateKey(Number(row.hour_ts));
    const i = index.get(key);
    if (i === undefined || !series[row.site]) continue;
    series[row.site][i] += Number(row.n) || 0;
  }
  return { labels: list.map((b) => b.label), keys: list.map((b) => b.key), series };
}

export function statusClasses(rows) {
  const out = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };
  for (const r of rows) {
    const s = Number(r.status);
    const n = Number(r.n) || 0;
    if (s >= 200 && s < 300) out["2xx"] += n;
    else if (s >= 300 && s < 400) out["3xx"] += n;
    else if (s >= 400 && s < 500) out["4xx"] += n;
    else if (s >= 500 && s < 600) out["5xx"] += n;
    else out.other += n;
  }
  return out;
}

export async function queryStats(db, { range, site }, { now = Date.now() } = {}) {
  const from = now - RANGES[range];
  const where = ["ts >= ?", "ts <= ?", "(user_agent IS NULL OR user_agent NOT LIKE ?)"];
  const args = [from, now, MONITOR_UA];
  if (site) {
    where.push("site = ?");
    args.push(site);
  }
  const w = where.join(" AND ");
  const q = (sql, extra = []) => db.prepare(sql).bind(...args, ...extra);
  const [hourly, paths, countries, statuses, gates, totals, ips] = await db.batch([
    q(`SELECT (ts / ${HOUR_MS}) * ${HOUR_MS} AS hour_ts, site, COUNT(*) AS n FROM access_logs WHERE ${w} GROUP BY hour_ts, site`),
    q(`SELECT site, path, COUNT(*) AS n FROM access_logs WHERE ${w} GROUP BY site, path ORDER BY n DESC LIMIT ?`, [TOP_N]),
    q(`SELECT COALESCE(country, '??') AS country, COUNT(*) AS n FROM access_logs WHERE ${w} GROUP BY country ORDER BY n DESC LIMIT ?`, [TOP_N]),
    q(`SELECT status, COUNT(*) AS n FROM access_logs WHERE ${w} GROUP BY status ORDER BY n DESC`),
    q(`SELECT COALESCE(gate, 'none') AS gate, COUNT(*) AS n FROM access_logs WHERE ${w} AND site = 'us' GROUP BY gate ORDER BY n DESC`),
    q(`SELECT COUNT(*) AS n, COUNT(DISTINCT ip_hash) AS visitors FROM access_logs WHERE ${w}`),
    q(`SELECT ip, COUNT(*) AS n, MAX(country) AS country FROM access_logs WHERE ${w} AND ip IS NOT NULL GROUP BY ip ORDER BY n DESC LIMIT ?`, [TOP_N]),
  ]);
  const rows = (r) => (r && r.results) || [];
  const total = rows(totals)[0] || { n: 0, visitors: 0 };
  const statusRows = rows(statuses);
  return {
    range,
    site,
    from_et: formatEt(new Date(from)),
    to_et: formatEt(new Date(now)),
    bucket: range === "24h" ? "hour" : "day",
    total: Number(total.n) || 0,
    unique_visitors: Number(total.visitors) || 0,
    ...foldSeries(range, rows(hourly), now),
    top_paths: rows(paths).map((r) => ({ site: r.site, path: r.path, n: Number(r.n) || 0 })),
    countries: rows(countries).map((r) => ({ country: r.country, n: Number(r.n) || 0 })),
    statuses: statusRows.slice(0, 12).map((r) => ({ status: Number(r.status), n: Number(r.n) || 0 })),
    status_classes: statusClasses(statusRows),
    top_ips: rows(ips).map((r) => ({ ip: r.ip, country: r.country || null, n: Number(r.n) || 0 })),
    us_gate: rows(gates).map((r) => ({ gate: r.gate, n: Number(r.n) || 0 })),
  };
}

export async function handleAdminStats(request, env, { now = Date.now() } = {}) {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", "cache-control": "no-store" } });
  }
  const parsed = parseStatsQuery(new URL(request.url));
  if (parsed.error) return json({ error: parsed.error }, 400, method);
  if (!env || !env.ACCESS_LOG) return json({ error: "Access log storage is not bound" }, 503, method);
  const payload = await queryStats(env.ACCESS_LOG, parsed, { now });
  return json(payload, 200, method);
}

function json(payload, status = 200, method = "GET") {
  return new Response(method === "HEAD" ? null : JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
