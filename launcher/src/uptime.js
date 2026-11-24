// Uptime history for /status. A */5 cron on this Worker runs the same checks
// as /api/status and folds each result into an hourly rollup row in D1
// (ACCESS_LOG binding, tables from schema/migrations/0003_uptime.sql).
// Down/up transitions open and close rows in uptime_incidents.
// Reads are cached because the data only changes every 5 minutes.
// Nothing here passes or weakens the US Turnstile gate: "gated" counts as up.
import { buildStatus, CHECKS, formatEt } from "./status.js";

export const UPTIME_CRON = "*/5 * * * *";
export const PRUNE_CRON = "15 9 * * *";
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const HOURLY_RETENTION_MS = 35 * DAY_MS;
export const INCIDENT_RETENTION_MS = 90 * DAY_MS;
export const UPTIME_CACHE_MS = 60 * 1000;
export const BAR_DAYS = 30;
export const SPARK_HOURS = 24;
export const MAX_INCIDENTS = 50;

const CHECK_IDS = new Set(CHECKS.map((c) => c.id));

export function hourFloor(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function countsAsUp(state) {
  return state === "up" || state === "gated";
}

export function etDateKey(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

export function etHourLabel(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const out = [];
  if (d) out.push(`${d}d`);
  if (h) out.push(`${h}h`);
  if (m || !out.length) out.push(`${m}m`);
  return out.join(" ");
}

// Flatten a /api/status payload into one row per check.
export function flattenStatus(payload) {
  const rows = [];
  for (const group of (payload && payload.groups) || []) {
    for (const check of group.checks || []) {
      if (!CHECK_IDS.has(check.id)) continue;
      rows.push({
        id: check.id,
        state: check.state,
        status: typeof check.status === "number" ? check.status : null,
        latency_ms: typeof check.latency_ms === "number" ? Math.max(0, Math.round(check.latency_ms)) : 0,
        label: check.label || null,
      });
    }
  }
  return rows;
}

// Build the D1 statements for one sample run. Exported for tests.
export function sampleStatements(db, rows, openIds, now) {
  const hour = hourFloor(now);
  const out = [];
  for (const row of rows) {
    const up = countsAsUp(row.state) ? 1 : 0;
    const gated = row.state === "gated" ? 1 : 0;
    const down = up ? 0 : 1;
    out.push(
      db
        .prepare(
          `INSERT INTO uptime_hourly (hour_ts, check_id, samples, up, gated, down, latency_sum, latency_max, last_state, last_status)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hour_ts, check_id) DO UPDATE SET
             samples = samples + 1,
             up = up + excluded.up,
             gated = gated + excluded.gated,
             down = down + excluded.down,
             latency_sum = latency_sum + excluded.latency_sum,
             latency_max = MAX(latency_max, excluded.latency_max),
             last_state = excluded.last_state,
             last_status = excluded.last_status`,
        )
        .bind(hour, row.id, up, gated, down, row.latency_ms, row.latency_ms, row.state, row.status),
    );
    const isOpen = openIds.has(row.id);
    if (down && !isOpen) {
      out.push(
        db
          .prepare("INSERT INTO uptime_incidents (check_id, started_at, ended_at, label, status, samples) VALUES (?, ?, NULL, ?, ?, 1)")
          .bind(row.id, now, row.label, row.status),
      );
    } else if (down && isOpen) {
      out.push(
        db
          .prepare("UPDATE uptime_incidents SET samples = samples + 1, label = ?, status = ? WHERE check_id = ? AND ended_at IS NULL")
          .bind(row.label, row.status, row.id),
      );
    } else if (!down && isOpen) {
      out.push(db.prepare("UPDATE uptime_incidents SET ended_at = ? WHERE check_id = ? AND ended_at IS NULL").bind(now, row.id));
    }
  }
  return out;
}

export async function openIncidentIds(db) {
  const res = await db.prepare("SELECT DISTINCT check_id FROM uptime_incidents WHERE ended_at IS NULL").all();
  return new Set(((res && res.results) || []).map((r) => r.check_id));
}

// Cron entry: run the checks once and record them. Never throws.
export async function recordUptime(env, { fetcher = fetch, now = Date.now() } = {}) {
  if (!env || !env.ACCESS_LOG) return { ok: false, reason: "no_binding" };
  try {
    const payload = await buildStatus({ fetcher, now: new Date(now) });
    const rows = flattenStatus(payload);
    const open = await openIncidentIds(env.ACCESS_LOG);
    const statements = sampleStatements(env.ACCESS_LOG, rows, open, now);
    if (statements.length) await env.ACCESS_LOG.batch(statements);
    resetUptimeCache();
    return { ok: true, samples: rows.length, overall: payload.overall };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 200) };
  }
}

export async function pruneUptime(env, { now = Date.now() } = {}) {
  if (!env || !env.ACCESS_LOG) return { ok: false, reason: "no_binding" };
  await env.ACCESS_LOG.prepare("DELETE FROM uptime_hourly WHERE hour_ts < ?").bind(now - HOURLY_RETENTION_MS).run();
  await env.ACCESS_LOG
    .prepare("DELETE FROM uptime_incidents WHERE ended_at IS NOT NULL AND ended_at < ?")
    .bind(now - INCIDENT_RETENTION_MS)
    .run();
  return { ok: true };
}

function pct(up, samples) {
  if (!samples) return null;
  return Math.round((up / samples) * 100000) / 1000;
}

// Turn hourly rows + incidents into the /api/uptime payload. Pure; exported for tests.
export function summarize(hourly, incidents, now = Date.now()) {
  const byCheck = new Map(CHECKS.map((c) => [c.id, []]));
  for (const row of hourly) {
    if (byCheck.has(row.check_id)) byCheck.get(row.check_id).push(row);
  }
  const windows = { "24h": now - DAY_MS, "7d": now - 7 * DAY_MS, "30d": now - 30 * DAY_MS };
  const dayKeys = [];
  for (let i = BAR_DAYS - 1; i >= 0; i--) {
    const key = etDateKey(now - i * DAY_MS);
    if (!dayKeys.includes(key)) dayKeys.push(key);
  }
  const sparkHours = [];
  for (let i = SPARK_HOURS - 1; i >= 0; i--) sparkHours.push(hourFloor(now) - i * HOUR_MS);

  const totals = { "24h": [0, 0], "7d": [0, 0], "30d": [0, 0] };
  const checks = CHECKS.map((check) => {
    const rows = byCheck.get(check.id);
    const uptime = {};
    for (const [name, from] of Object.entries(windows)) {
      let up = 0;
      let samples = 0;
      for (const r of rows) {
        // An hour row counts if any part of it is inside the window.
        if (r.hour_ts + HOUR_MS > from) {
          up += Number(r.up) || 0;
          samples += Number(r.samples) || 0;
        }
      }
      uptime[name] = pct(up, samples);
      totals[name][0] += up;
      totals[name][1] += samples;
    }
    const days = new Map(dayKeys.map((k) => [k, { date: k, samples: 0, up: 0, down: 0 }]));
    for (const r of rows) {
      const day = days.get(etDateKey(r.hour_ts));
      if (!day) continue;
      day.samples += Number(r.samples) || 0;
      day.up += Number(r.up) || 0;
      day.down += Number(r.down) || 0;
    }
    const bars = [...days.values()].map((d) => ({ ...d, uptime: pct(d.up, d.samples) }));
    const byHour = new Map(rows.map((r) => [r.hour_ts, r]));
    const spark = sparkHours.map((h) => {
      const r = byHour.get(h);
      const samples = r ? Number(r.samples) || 0 : 0;
      return {
        hour: etHourLabel(h),
        avg_ms: samples ? Math.round((Number(r.latency_sum) || 0) / samples) : null,
        max_ms: r ? Number(r.latency_max) || 0 : null,
      };
    });
    const latest = rows.reduce((a, b) => (!a || b.hour_ts > a.hour_ts ? b : a), null);
    return {
      id: check.id,
      group: check.group,
      group_name: check.groupName,
      name: check.name,
      uptime,
      bars,
      spark,
      last_state: latest ? latest.last_state : null,
    };
  });

  const overall = {};
  for (const [name, [up, samples]] of Object.entries(totals)) overall[name] = pct(up, samples);

  const names = new Map(CHECKS.map((c) => [c.id, `${c.groupName} · ${c.name}`]));
  const incidentList = incidents.map((row) => {
    const end = row.ended_at == null ? null : Number(row.ended_at);
    const start = Number(row.started_at);
    return {
      id: row.id,
      check_id: row.check_id,
      check: names.get(row.check_id) || row.check_id,
      ongoing: end == null,
      started_at: formatEt(new Date(start)),
      ended_at: end == null ? null : formatEt(new Date(end)),
      duration: formatDuration((end == null ? now : end) - start),
      label: row.label || "Down",
      status: row.status == null ? null : Number(row.status),
      samples: Number(row.samples) || 1,
    };
  });

  return {
    generated_at: formatEt(new Date(now)),
    generated_at_iso: new Date(now).toISOString(),
    sample_interval_min: 5,
    has_data: hourly.length > 0,
    overall,
    days: dayKeys,
    checks,
    incidents: incidentList,
    open_incidents: incidentList.filter((i) => i.ongoing).length,
  };
}

let cache = { expires: 0, payload: null };

export function resetUptimeCache() {
  cache = { expires: 0, payload: null };
}

export async function getUptime(env, { now = Date.now(), useCache = true } = {}) {
  if (useCache && cache.payload && now < cache.expires) return cache.payload;
  if (!env || !env.ACCESS_LOG) return { error: "Uptime storage is not bound", status: 503 };
  const from = hourFloor(now - (BAR_DAYS + 1) * DAY_MS);
  const hourly = await env.ACCESS_LOG.prepare(
    `SELECT hour_ts, check_id, samples, up, gated, down, latency_sum, latency_max, last_state
     FROM uptime_hourly WHERE hour_ts >= ? ORDER BY hour_ts`,
  )
    .bind(from)
    .all();
  const incidents = await env.ACCESS_LOG.prepare(
    `SELECT id, check_id, started_at, ended_at, label, status, samples
     FROM uptime_incidents WHERE ended_at IS NULL OR started_at >= ?
     ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(now - 30 * DAY_MS, MAX_INCIDENTS)
    .all();
  const payload = summarize((hourly && hourly.results) || [], (incidents && incidents.results) || [], now);
  cache = { expires: now + UPTIME_CACHE_MS, payload };
  return payload;
}

function publicJson(payload, { status = 200, method = "GET", maxAge = 60 } = {}) {
  return new Response(method === "HEAD" ? null : JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handlePublicUptime(request, env, { now = Date.now() } = {}) {
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS" } });
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS", "cache-control": "no-store" } });
  }
  let payload;
  try {
    payload = await getUptime(env, { now });
  } catch (err) {
    // Most likely the migration has not been applied yet.
    return publicJson({ error: "Uptime history is not available yet", detail: String((err && err.message) || err).slice(0, 200) }, { status: 503, method });
  }
  if (payload.error) return publicJson({ error: payload.error }, { status: payload.status || 503, method });
  return publicJson(payload, { method });
}
