// Statuspage-style incidents: one list built from uptime_incidents (health-check,
// lockout:<site> and manual rows) plus incident_meta and incident_updates (0004).
//   GET  /api/incidents                                  public: active + last 30 days, with updates
//   GET  /api/admin/incidents                            admin view (same data, update authors)
//   POST /api/admin/incidents                            create a manual incident
//   POST /api/admin/incidents/:id/updates                post an update (Resolved closes it)
//   PATCH|DELETE /api/admin/incidents/:id/updates/:uid   edit/delete your own update
// Admin routes sit under /api/admin, so Cloudflare Access + the Worker JWT check apply.
import { SITES } from "./announcements.js";
import { writeAdminAudit } from "./access-log.js";
import { CHECKS, formatEt } from "./status.js";
import { decodeLockoutLabel, isLockoutCheckId, SITE_NAMES } from "./lockout.js";
import { formatDuration } from "./uptime.js";

export const STATUSES = ["investigating", "identified", "monitoring", "resolved"];
export const STATUS_LABELS = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
export const SEVERITIES = ["minor", "major", "critical"];
export const CATEGORIES = ["security", "outage", "degraded", "maintenance", "other"];
export const CATEGORY_LABELS = {
  security: "Security incident",
  outage: "Outage",
  degraded: "Degraded performance",
  maintenance: "Maintenance",
  other: "Other",
};
export const MAX_TITLE = 120;
export const MAX_BODY = 1000;
export const LIST_DAYS = 30;
export const MAX_LIST = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

function clean(value, max) {
  if (typeof value !== "string") return null;
  const v = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!v || v.length > max) return null;
  return v;
}

export function validateUpdate(input) {
  if (!input || typeof input !== "object") return { error: "Expected a JSON object" };
  const status = typeof input.status === "string" ? input.status.toLowerCase() : "";
  if (!STATUSES.includes(status)) return { error: "status must be investigating, identified, monitoring or resolved" };
  const body = clean(input.body, MAX_BODY);
  if (!body) return { error: `body is required (at most ${MAX_BODY} characters)` };
  return { value: { status, body } };
}

export function validateManual(input) {
  if (!input || typeof input !== "object") return { error: "Expected a JSON object" };
  const title = clean(input.title, MAX_TITLE);
  if (!title) return { error: `title is required (at most ${MAX_TITLE} characters)` };
  const sites = [...new Set((Array.isArray(input.sites) ? input.sites : []).map((s) => String(s).toLowerCase()))];
  if (!sites.length || sites.some((s) => !SITES.includes(s))) return { error: "sites must be a non-empty subset of us, ca, launcher" };
  const severity = typeof input.severity === "string" ? input.severity.toLowerCase() : "";
  if (!SEVERITIES.includes(severity)) return { error: "severity must be minor, major or critical" };
  const category = typeof input.category === "string" ? input.category.toLowerCase() : "";
  if (!CATEGORIES.includes(category)) return { error: "category must be security, outage, degraded, maintenance or other" };
  const update = validateUpdate({ status: input.status || "investigating", body: input.body });
  if (update.error) return update;
  if (update.value.status === "resolved") return { error: "a new incident cannot start as resolved" };
  return { value: { title, sites: SITES.filter((s) => sites.includes(s)), severity, category, ...update.value } };
}

// Shape one incident for the API. Pure; exported for tests.
export function shapeIncident(row, meta, updates, now = Date.now(), { admin = false } = {}) {
  const end = row.ended_at == null ? null : Number(row.ended_at);
  const start = Number(row.started_at);
  const base = {
    id: Number(row.id),
    ongoing: end == null,
    started_at: formatEt(new Date(start)),
    started_at_iso: new Date(start).toISOString(),
    ended_at: end == null ? null : formatEt(new Date(end)),
    duration: formatDuration((end == null ? now : end) - start),
  };
  let shaped;
  if (isLockoutCheckId(row.check_id)) {
    const site = row.check_id.slice("lockout:".length);
    const lock = decodeLockoutLabel(row.label);
    shaped = {
      kind: "lockout",
      title: `${SITE_NAMES[site] || site} locked: ${lock.reason_label}`,
      sites: [site],
      severity: lock.reason === "outage" ? "critical" : "maintenance",
      category: lock.reason === "outage" ? "outage" : lock.reason === "other" ? "other" : "maintenance",
      reason: lock.reason,
      reason_label: lock.reason_label,
      icon: lock.icon,
      color: lock.color,
      message: lock.message,
      scheduled: lock.scheduled,
    };
  } else if (row.check_id === "manual") {
    shaped = {
      kind: "manual",
      title: meta ? meta.title : row.label || "Incident",
      sites: meta && meta.sites ? meta.sites.split(",").filter(Boolean) : [],
      severity: meta && SEVERITIES.includes(meta.severity) ? meta.severity : "minor",
      category: meta && CATEGORIES.includes(meta.category) ? meta.category : "other",
    };
  } else {
    const check = CHECK_BY_ID.get(row.check_id);
    shaped = {
      kind: "outage",
      title: check ? `${check.groupName} · ${check.name} down` : `${row.check_id} down`,
      sites: check ? [check.group] : [],
      severity: "major",
      category: "outage",
      label: row.label || "Down",
      status: row.status == null ? null : Number(row.status),
    };
  }
  if (meta && shaped.kind !== "manual") {
    if (meta.title) shaped.title = meta.title;
    if (SEVERITIES.includes(meta.severity)) shaped.severity = meta.severity;
    if (shaped.kind === "outage" && CATEGORIES.includes(meta.category) && meta.category !== "other") shaped.category = meta.category;
  }
  const list = (updates || [])
    .slice()
    .sort((a, b) => Number(b.created_at) - Number(a.created_at) || Number(b.id) - Number(a.id))
    .map((u) => ({
      id: Number(u.id),
      status: u.status,
      status_label: STATUS_LABELS[u.status] || u.status,
      body: u.body,
      at: formatEt(new Date(Number(u.created_at))),
      edited: u.updated_at ? formatEt(new Date(Number(u.updated_at))) : null,
      ...(admin ? { author: u.author } : {}),
    }));
  const latest = list[0] || null;
  return {
    ...base,
    ...shaped,
    category_label: CATEGORY_LABELS[shaped.category] || CATEGORY_LABELS.other,
    sites_label: shaped.sites.map((s) => SITE_NAMES[s] || s).join(", "),
    current_status: latest ? latest.status : base.ongoing ? "investigating" : "resolved",
    latest_update: latest,
    updates: list,
  };
}

async function safeAll(db, sql, args = []) {
  try {
    const res = await db.prepare(sql).bind(...args).all();
    return (res && res.results) || [];
  } catch {
    return null; // table missing (migration 0004 not applied yet)
  }
}

export async function listIncidents(env, { now = Date.now(), admin = false } = {}) {
  const db = env.ACCESS_LOG;
  const rows = await db
    .prepare(
      `SELECT id, check_id, started_at, ended_at, label, status, samples FROM uptime_incidents
       WHERE ended_at IS NULL OR started_at >= ? ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT ?`,
    )
    .bind(now - LIST_DAYS * DAY_MS, MAX_LIST)
    .all();
  const incidents = (rows && rows.results) || [];
  const ids = incidents.map((r) => Number(r.id));
  let metas = [];
  let updates = [];
  let ready = true;
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const m = await safeAll(db, `SELECT * FROM incident_meta WHERE incident_id IN (${marks})`, ids);
    const u = await safeAll(db, `SELECT * FROM incident_updates WHERE incident_id IN (${marks}) ORDER BY created_at DESC`, ids);
    if (m === null || u === null) ready = false;
    metas = m || [];
    updates = u || [];
  }
  const metaBy = new Map(metas.map((m) => [Number(m.incident_id), m]));
  const updBy = new Map();
  for (const u of updates) {
    const k = Number(u.incident_id);
    if (!updBy.has(k)) updBy.set(k, []);
    updBy.get(k).push(u);
  }
  const list = incidents.map((r) => shapeIncident(r, metaBy.get(Number(r.id)), updBy.get(Number(r.id)), now, { admin }));
  return {
    generated_at: formatEt(new Date(now)),
    updates_enabled: ready,
    active: list.filter((i) => i.ongoing),
    recent: list.filter((i) => !i.ongoing),
  };
}

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

export async function handlePublicIncidents(request, env, { now = Date.now() } = {}) {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return json({ error: "Method Not Allowed" }, 405, { Allow: "GET, HEAD" });
  if (!env || !env.ACCESS_LOG) return json({ error: "Incident storage is not bound" }, 503);
  try {
    const payload = await listIncidents(env, { now });
    return new Response(method === "HEAD" ? null : JSON.stringify(payload, null, 2), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=30", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
    });
  } catch (err) {
    return json({ error: "Incidents are not available yet", detail: String((err && err.message) || err).slice(0, 200) }, 503);
  }
}

async function readBody(request) {
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("application/json")) return { error: "Content-Type must be application/json" };
  try {
    const text = await request.text();
    if (text.length > 16 * 1024) return { error: "Request body is too large" };
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "Expected a JSON object" };
    return { value: v };
  } catch {
    return { error: "Invalid JSON" };
  }
}

async function audit(env, actor, action, target, now) {
  try {
    await writeAdminAudit(env, { actor: actor || "unknown", action, email: target, now });
  } catch {
    // best-effort
  }
}

export async function handleAdminIncidents(request, env, identity, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const email = (identity && identity.email) || "";
  if (!env || !env.ACCESS_LOG) return json({ error: "Incident storage is not bound" }, 503);
  const db = env.ACCESS_LOG;

  if (path === "/api/admin/incidents") {
    if (method === "GET" || method === "HEAD") return json({ ...(await listIncidents(env, { now, admin: true })), me: email });
    if (method !== "POST") return json({ error: "Method Not Allowed" }, 405, { Allow: "GET, POST" });
    const body = await readBody(request);
    if (body.error) return json({ error: body.error }, 400);
    const v = validateManual(body.value);
    if (v.error) return json({ error: v.error }, 400);
    const ins = await db
      .prepare("INSERT INTO uptime_incidents (check_id, started_at, ended_at, label, status, samples) VALUES ('manual', ?, NULL, ?, NULL, 1)")
      .bind(now, v.value.title)
      .run();
    const id = Number(ins && ins.meta && ins.meta.last_row_id);
    await db.batch([
      db.prepare("INSERT INTO incident_meta (incident_id, title, severity, category, sites, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, v.value.title, v.value.severity, v.value.category, v.value.sites.join(","), email, now),
      db.prepare("INSERT INTO incident_updates (incident_id, status, body, author, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, v.value.status, v.value.body, email, now),
    ]);
    await audit(env, email, "incident_create", `#${id} ${CATEGORY_LABELS[v.value.category]} ${v.value.severity}: ${v.value.title}`.slice(0, 200), now);
    return json({ ok: true, id, ...(await listIncidents(env, { now, admin: true })) }, 201);
  }

  const m = path.match(/^\/api\/admin\/incidents\/(\d{1,12})\/updates(?:\/(\d{1,12}))?$/);
  if (!m) return json({ error: "Not Found" }, 404);
  const incidentId = Number(m[1]);
  const updateId = m[2] ? Number(m[2]) : null;
  const incident = await db.prepare("SELECT id, check_id, ended_at FROM uptime_incidents WHERE id = ?").bind(incidentId).first();
  if (!incident) return json({ error: "Incident not found" }, 404);

  if (updateId === null) {
    if (method !== "POST") return json({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
    const body = await readBody(request);
    if (body.error) return json({ error: body.error }, 400);
    const v = validateUpdate(body.value);
    if (v.error) return json({ error: v.error }, 400);
    const resolving = v.value.status === "resolved" && incident.ended_at == null;
    if (resolving && isLockoutCheckId(incident.check_id)) {
      return json({ error: "A lockout incident resolves when the site is unlocked. Turn the lockout off in the Maintenance card." }, 409);
    }
    const stmts = [
      db.prepare("INSERT INTO incident_updates (incident_id, status, body, author, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(incidentId, v.value.status, v.value.body, email, now),
    ];
    if (resolving) stmts.push(db.prepare("UPDATE uptime_incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL").bind(now, incidentId));
    await db.batch(stmts);
    await audit(env, email, resolving ? "incident_resolve" : "incident_update_add", `#${incidentId} ${STATUS_LABELS[v.value.status]}`, now);
    return json({ ok: true, resolved: resolving, ...(await listIncidents(env, { now, admin: true })) }, 201);
  }

  const upd = await db.prepare("SELECT id, author FROM incident_updates WHERE id = ? AND incident_id = ?").bind(updateId, incidentId).first();
  if (!upd) return json({ error: "Update not found" }, 404);
  if (!email || upd.author.toLowerCase() !== email.toLowerCase()) return json({ error: "You can only change your own updates" }, 403);
  if (method === "DELETE") {
    await db.prepare("DELETE FROM incident_updates WHERE id = ?").bind(updateId).run();
    await audit(env, email, "incident_update_delete", `#${incidentId} update ${updateId}`, now);
    return json({ ok: true, ...(await listIncidents(env, { now, admin: true })) });
  }
  if (method !== "PATCH") return json({ error: "Method Not Allowed" }, 405, { Allow: "PATCH, DELETE" });
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, 400);
  const v = validateUpdate(body.value);
  if (v.error) return json({ error: v.error }, 400);
  await db.prepare("UPDATE incident_updates SET status = ?, body = ?, updated_at = ? WHERE id = ?").bind(v.value.status, v.value.body, now, updateId).run();
  await audit(env, email, "incident_update_edit", `#${incidentId} update ${updateId}`, now);
  return json({ ok: true, ...(await listIncidents(env, { now, admin: true })) });
}
