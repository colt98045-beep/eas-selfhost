// Per-site maintenance lockout. Stored in the ANNOUNCEMENTS KV under a
// separate key so announcement data is not mixed in. Public reads fail
// open (off) if storage is missing. /admin, /api/admin/*, /api/status,
// /api/announcements and /api/maintenance are never lockable.
import { formatEt } from "./status.js";
import { corsHeaders, SITES, KV_KEY as KV_ANN_KEY, MAX_ITEMS as MAX_ANNOUNCEMENTS } from "./announcements.js";
import { writeAdminAudit } from "./access-log.js";

export const KV_MAINT_KEY = "maintenance";
export const MAINT_CACHE_S = 15;
export const MAX_MESSAGE = 2000;
export const MAX_WINDOWS = 20;
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const KEEP_ENDED_MS = 7 * 24 * 60 * 60 * 1000;

const SITE_LABELS = { us: "United States", ca: "Canada", launcher: "Launcher" };

// Lockout reasons. Older KV values have no reason and read as "maintenance".
export const REASONS = ["outage", "maintenance", "update", "other"];
export const REASON_LABELS = { outage: "Outage", maintenance: "Maintenance", update: "Update", other: "Other" };
export const DEFAULT_REASON = "maintenance";
export const MAX_REASON_TEXT = 40;

export function normalizeReason(reason, reasonText) {
  const r = typeof reason === "string" && REASONS.includes(reason) ? reason : DEFAULT_REASON;
  const text = r === "other" && typeof reasonText === "string" ? cleanReasonText(reasonText) : "";
  return { reason: r, reason_text: text };
}

export function cleanReasonText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON_TEXT);
}

export function reasonLabel(reason, reasonText) {
  const n = normalizeReason(reason, reasonText);
  if (n.reason === "other") return n.reason_text || REASON_LABELS.other;
  return REASON_LABELS[n.reason];
}

function validateReason(input) {
  if (input.reason === undefined || input.reason === null || input.reason === "") return { value: { reason: DEFAULT_REASON, reason_text: "" } };
  if (typeof input.reason !== "string" || !REASONS.includes(input.reason)) return { error: "reason must be outage, maintenance, update, or other" };
  if (input.reason !== "other") return { value: { reason: input.reason, reason_text: "" } };
  if (input.reason_text !== undefined && input.reason_text !== null && typeof input.reason_text !== "string") return { error: "reason_text must be a string" };
  const raw = typeof input.reason_text === "string" ? input.reason_text.trim() : "";
  if (raw.length > MAX_REASON_TEXT) return { error: `reason_text must be at most ${MAX_REASON_TEXT} characters` };
  const text = cleanReasonText(raw);
  if (!text) return { error: "reason_text is required when reason is other" };
  return { value: { reason: "other", reason_text: text } };
}

export function emptySiteState() {
  return { on: false, message: "", eta: null, reason: DEFAULT_REASON, reason_text: "", updated_at: null, updated_by: null };
}

export function defaultMaintenance() {
  return { us: emptySiteState(), ca: emptySiteState(), launcher: emptySiteState() };
}

export function isLockoutExemptPath(pathname) {
  const path = normalizePath(pathname);
  if (path === "/admin" || path === "/admin.html") return true;
  if (path.startsWith("/api/admin")) return true;
  if (path === "/api/status" || path.startsWith("/api/status/")) return true;
  if (path === "/api/announcements" || path.startsWith("/api/announcements/")) return true;
  if (path === "/api/maintenance" || path.startsWith("/api/maintenance/")) return true;
  return false;
}

export function isLockableLauncherPath(pathname) {
  if (isLockoutExemptPath(pathname)) return false;
  const path = normalizePath(pathname);
  return path === "/" || path === "/index.html" || path === "/status" || path === "/status.html";
}

function normalizePath(pathname) {
  const raw = String(pathname || "/").split("?")[0];
  if (raw.length > 1 && raw.endsWith("/")) return raw.replace(/\/+$/, "") || "/";
  return raw || "/";
}

function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function validateMaintenancePatch(input) {
  if (!input || typeof input !== "object") return { error: "Expected a JSON object" };
  const site = typeof input.site === "string" ? input.site.toLowerCase().trim() : "";
  if (!SITES.includes(site)) return { error: "site must be us, ca, or launcher" };
  if (typeof input.on !== "boolean") return { error: "on must be true or false" };
  let message = "";
  if (input.message !== undefined && input.message !== null) {
    if (typeof input.message !== "string") return { error: "message must be a string" };
    message = input.message.trim();
    if (message.length > MAX_MESSAGE) return { error: `message must be at most ${MAX_MESSAGE} characters` };
  }
  const eta = parseTime(input.eta);
  if (eta === undefined) return { error: "eta must be an ISO timestamp or empty" };
  const reason = validateReason(input);
  if (reason.error) return { error: reason.error };
  return { value: { site, on: input.on, message, eta, ...reason.value } };
}

export function publicView(site, row, now = Date.now()) {
  const state = row || emptySiteState();
  const reason = normalizeReason(state.reason, state.reason_text);
  return {
    site,
    on: Boolean(state.on),
    reason: reason.reason,
    reason_text: reason.reason_text,
    reason_label: reasonLabel(reason.reason, reason.reason_text),
    message: state.message || "",
    eta: state.eta || null,
    eta_et: state.eta ? formatEt(new Date(state.eta)) : null,
    updated_at: state.updated_at ? formatEt(new Date(state.updated_at)) : formatEt(new Date(now)),
  };
}

export function adminPayload(state, now = Date.now()) {
  const schedule = ((state && state.schedule) || [])
    .map((w) => windowView(w, now))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { sites: adminView(state, now), schedule };
}

export function adminView(state, now = Date.now()) {
  const out = {};
  for (const site of SITES) {
    const row = (state && state[site]) || emptySiteState();
    out[site] = {
      ...emptySiteState(),
      ...row,
      on: Boolean(row.on),
      reason_label: reasonLabel(row.reason, row.reason_text),
      label: SITE_LABELS[site],
      eta_et: row.eta ? formatEt(new Date(row.eta)) : null,
      updated_at_et: row.updated_at ? formatEt(new Date(row.updated_at)) : null,
      checked_at: formatEt(new Date(now)),
    };
    const eff = effectiveSiteState(state, site, now);
    out[site].effective_on = Boolean(eff.on);
    out[site].scheduled = eff.scheduled
      ? { ...eff.scheduled, start_et: formatEt(new Date(eff.scheduled.start)), end_et: formatEt(new Date(eff.scheduled.end)) }
      : null;
  }
  return out;
}

export async function loadMaintenance(env) {
  const empty = { ...defaultMaintenance(), schedule: [] };
  if (!env || !env.ANNOUNCEMENTS) return empty;
  const data = await env.ANNOUNCEMENTS.get(KV_MAINT_KEY, "json");
  if (!data || typeof data !== "object") return empty;
  const out = defaultMaintenance();
  for (const site of SITES) {
    const row = data[site] || {};
    out[site] = {
      on: Boolean(row.on),
      message: typeof row.message === "string" ? row.message : "",
      eta: row.eta || null,
      ...normalizeReason(row.reason, row.reason_text),
      updated_at: row.updated_at || null,
      updated_by: row.updated_by || null,
    };
  }
  out.schedule = normalizeSchedule(data.schedule);
  return out;
}

// ---- Scheduled maintenance windows -------------------------------------
// Stored in the same KV document as the manual switches (key "maintenance",
// field "schedule") so a public read is still one KV get. A window locks its
// sites from start (inclusive) to end (exclusive), evaluated on every request,
// so it starts and ends on time. The */5 cron only records the transitions
// (admin_audit rows) and tidies ended windows; it never has to be on time.

export function normalizeSchedule(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => w && typeof w === "object" && typeof w.id === "string" && Array.isArray(w.sites))
    .map((w) => ({
      id: w.id,
      sites: w.sites.filter((s) => SITES.includes(s)),
      start: w.start,
      end: w.end,
      message: typeof w.message === "string" ? w.message : "",
      ...normalizeReason(w.reason, w.reason_text),
      announcement_id: w.announcement_id || null,
      created_at: w.created_at || null,
      created_by: w.created_by || null,
      started_logged: Boolean(w.started_logged),
      ended_logged: Boolean(w.ended_logged),
    }))
    .filter((w) => w.sites.length && Number.isFinite(Date.parse(w.start)) && Number.isFinite(Date.parse(w.end)));
}

export function windowPhase(win, now = Date.now()) {
  const start = Date.parse(win.start);
  const end = Date.parse(win.end);
  if (now < start) return "upcoming";
  if (now >= end) return "ended";
  return "active";
}

export function activeWindowFor(state, site, now = Date.now()) {
  const list = (state && state.schedule) || [];
  return list
    .filter((w) => w.sites.includes(site) && windowPhase(w, now) === "active")
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0] || null;
}

// The state visitors actually get: a manual switch wins; otherwise an active
// scheduled window locks the site until its end.
export function effectiveSiteState(state, site, now = Date.now()) {
  const row = (state && state[site]) || emptySiteState();
  if (row.on) return { ...row, scheduled: null };
  const win = activeWindowFor(state, site, now);
  if (!win) return { ...row, scheduled: null };
  return {
    ...row,
    on: true,
    reason: win.reason || DEFAULT_REASON,
    reason_text: win.reason_text || "",
    message: win.message || row.message || "",
    eta: win.end,
    scheduled: { id: win.id, start: win.start, end: win.end },
  };
}

export function validateWindow(input, { now = Date.now(), existing = [] } = {}) {
  if (!input || typeof input !== "object") return { error: "Expected a JSON object" };
  const raw = Array.isArray(input.sites) ? input.sites : [];
  const sites = [...new Set(raw.map((s) => String(s).toLowerCase().trim()))];
  if (!sites.length || sites.some((s) => !SITES.includes(s))) return { error: "sites must be a non-empty subset of us, ca, launcher" };
  const start = parseTime(input.start);
  const end = parseTime(input.end);
  if (!start || !end) return { error: "start and end are required ISO timestamps" };
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (endMs <= startMs) return { error: "end must be after start" };
  if (endMs <= now) return { error: "end must be in the future" };
  if (endMs - startMs > MAX_WINDOW_MS) return { error: "a window can be at most 7 days long" };
  let message = "";
  if (input.message !== undefined && input.message !== null) {
    if (typeof input.message !== "string") return { error: "message must be a string" };
    message = input.message.trim();
    if (message.length > MAX_MESSAGE) return { error: `message must be at most ${MAX_MESSAGE} characters` };
  }
  const reason = validateReason(input);
  if (reason.error) return { error: reason.error };
  const live = existing.filter((w) => windowPhase(w, now) !== "ended");
  if (live.length >= MAX_WINDOWS) return { error: `At most ${MAX_WINDOWS} upcoming windows can be scheduled` };
  return { value: { sites: SITES.filter((s) => sites.includes(s)), start, end, message, ...reason.value, announce: input.announce !== false } };
}

export function windowView(win, now = Date.now()) {
  return {
    ...win,
    phase: windowPhase(win, now),
    start_et: formatEt(new Date(win.start)),
    end_et: formatEt(new Date(win.end)),
    sites_label: win.sites.map((s) => SITE_LABELS[s]).join(", "),
    reason_label: reasonLabel(win.reason, win.reason_text),
  };
}

export function announcementForWindow(win, { id, stamp, email }) {
  const names = win.sites.map((s) => SITE_LABELS[s]).join(", ");
  const from = formatEt(new Date(win.start));
  const to = formatEt(new Date(win.end));
  const extra = win.message ? `\n\n${win.message}` : "";
  const label = reasonLabel(win.reason, win.reason_text);
  return {
    id,
    title: win.reason && win.reason !== DEFAULT_REASON ? `Scheduled lockout: ${label}` : "Scheduled maintenance",
    message: `${names} will be unavailable from ${from} to ${to}.${extra}`.slice(0, MAX_MESSAGE),
    type: "maintenance",
    targets: win.sites.length === SITES.length ? ["all"] : win.sites.slice(),
    // Shown from now as advance notice, removed when the window ends.
    start: null,
    end: win.end,
    created_at: stamp,
    updated_at: stamp,
    created_by: email,
    maintenance_window_id: win.window_id || null,
  };
}

async function addAnnouncement(env, item) {
  const list = (await env.ANNOUNCEMENTS.get(KV_ANN_KEY, "json")) || [];
  const arr = Array.isArray(list) ? list : [];
  if (arr.length >= MAX_ANNOUNCEMENTS) return false;
  arr.push(item);
  await env.ANNOUNCEMENTS.put(KV_ANN_KEY, JSON.stringify(arr));
  return true;
}

async function removeAnnouncement(env, id) {
  if (!id) return false;
  const list = (await env.ANNOUNCEMENTS.get(KV_ANN_KEY, "json")) || [];
  if (!Array.isArray(list)) return false;
  const next = list.filter((row) => row.id !== id);
  if (next.length === list.length) return false;
  await env.ANNOUNCEMENTS.put(KV_ANN_KEY, JSON.stringify(next));
  return true;
}

// Cron housekeeping. Writes KV only when something changed, so the */5 cron
// does not burn KV writes on quiet runs.
export async function applyMaintenanceSchedule(env, { now = Date.now() } = {}) {
  if (!env || !env.ANNOUNCEMENTS) return { ok: false, reason: "no_binding" };
  const state = await loadMaintenance(env);
  if (!state.schedule.length) return { ok: true, changed: false, started: [], ended: [] };
  const started = [];
  const ended = [];
  let changed = false;
  const keep = [];
  for (const win of state.schedule) {
    const phase = windowPhase(win, now);
    if (phase !== "upcoming" && !win.started_logged) {
      win.started_logged = true;
      started.push(win.id);
      changed = true;
    }
    if (phase === "ended" && !win.ended_logged) {
      win.ended_logged = true;
      ended.push(win.id);
      changed = true;
    }
    if (phase === "ended" && now - Date.parse(win.end) > KEEP_ENDED_MS) {
      changed = true;
      continue;
    }
    keep.push(win);
  }
  if (!changed) return { ok: true, changed: false, started, ended };
  state.schedule = keep;
  await saveMaintenance(env, state);
  const byId = new Map(keep.map((w) => [w.id, w]));
  const audits = [
    ...started.map((id) => ({ action: "maintenance_window_start", id })),
    ...ended.map((id) => ({ action: "maintenance_window_end", id })),
  ];
  for (const a of audits) {
    const win = byId.get(a.id);
    try {
      await writeAdminAudit(env, { actor: "cron", action: a.action, email: win ? win.sites.join(",") : a.id, now });
    } catch {
      // audit is best-effort
    }
  }
  return { ok: true, changed: true, started, ended };
}

async function saveMaintenance(env, state) {
  await env.ANNOUNCEMENTS.put(KV_MAINT_KEY, JSON.stringify(state));
}

function jsonResponse(payload, { status = 200, request, cors = false, cache, method = "GET" } = {}) {
  const headers = cors
    ? corsHeaders(request, { "cache-control": `public, max-age=${cache ?? MAINT_CACHE_S}` })
    : {
        "content-type": "application/json; charset=utf-8",
        "cache-control": cache || "no-store",
        "x-content-type-options": "nosniff",
      };
  const body = method === "HEAD" ? null : JSON.stringify(payload, null, 2);
  return new Response(body, { status, headers });
}

export async function handlePublicMaintenance(request, env, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  const method = request.method;
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, { "cache-control": `public, max-age=${MAINT_CACHE_S}` }) });
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...corsHeaders(request), Allow: "GET, HEAD, OPTIONS" },
    });
  }
  const site = (url.searchParams.get("site") || "").toLowerCase().trim();
  if (!SITES.includes(site)) {
    return jsonResponse({ error: "site must be us, ca, or launcher" }, { status: 400, request, cors: true, method });
  }
  let state;
  try {
    state = await loadMaintenance(env);
  } catch {
    state = defaultMaintenance();
  }
  return jsonResponse(publicView(site, effectiveSiteState(state, site, now), now), { request, cors: true, method });
}

export async function handleAdminMaintenance(request, env, identity, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const email = identity && identity.email ? identity.email : "";

  if (!env || !env.ANNOUNCEMENTS) {
    return jsonResponse({ error: "Announcement storage is not bound" }, { status: 503, method });
  }
  if (path === "/api/admin/maintenance/schedule") {
    if (method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST", "cache-control": "no-store" } });
    }
    const body = await readJson(request);
    if (body.error) return jsonResponse({ error: body.error }, { status: 400 });
    const state = await loadMaintenance(env);
    const checked = validateWindow(body.value, { now, existing: state.schedule });
    if (checked.error) return jsonResponse({ error: checked.error }, { status: 400 });
    const stamp = new Date(now).toISOString();
    const win = {
      id: crypto.randomUUID(),
      sites: checked.value.sites,
      start: checked.value.start,
      end: checked.value.end,
      message: checked.value.message,
      reason: checked.value.reason,
      reason_text: checked.value.reason_text,
      announcement_id: null,
      created_at: stamp,
      created_by: email,
      started_logged: false,
      ended_logged: false,
    };
    let announced = false;
    if (checked.value.announce) {
      const annId = crypto.randomUUID();
      announced = await addAnnouncement(env, announcementForWindow({ ...win, window_id: win.id }, { id: annId, stamp, email }));
      if (announced) win.announcement_id = annId;
    }
    state.schedule.push(win);
    await saveMaintenance(env, state);
    try {
      await writeAdminAudit(env, { actor: email || "unknown", action: "maintenance_window_add", email: win.sites.join(","), now });
    } catch {
      // best-effort
    }
    return jsonResponse({ window: windowView(win, now), announced, ...adminPayload(state, now) }, { status: 201 });
  }
  const windowMatch = path.match(/^\/api\/admin\/maintenance\/schedule\/([0-9a-fA-F-]{36})$/);
  if (windowMatch) {
    if (method !== "DELETE") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "DELETE", "cache-control": "no-store" } });
    }
    const state = await loadMaintenance(env);
    const win = state.schedule.find((w) => w.id === windowMatch[1]);
    if (!win) return jsonResponse({ error: "Not Found" }, { status: 404 });
    state.schedule = state.schedule.filter((w) => w.id !== win.id);
    await saveMaintenance(env, state);
    let announcementRemoved = false;
    try {
      announcementRemoved = await removeAnnouncement(env, win.announcement_id);
    } catch {
      // the notice can still be deleted by hand
    }
    try {
      await writeAdminAudit(env, { actor: email || "unknown", action: "maintenance_window_cancel", email: win.sites.join(","), now });
    } catch {
      // best-effort
    }
    return jsonResponse({ ok: true, id: win.id, announcement_removed: announcementRemoved, ...adminPayload(state, now) });
  }
  if (path !== "/api/admin/maintenance") {
    return jsonResponse({ error: "Not Found" }, { status: 404, method });
  }
  if (method === "GET" || method === "HEAD") {
    const state = await loadMaintenance(env);
    return jsonResponse(adminPayload(state, now), { method });
  }
  if (method === "PUT") {
    const body = await readJson(request);
    if (body.error) return jsonResponse({ error: body.error }, { status: 400 });
    const checked = validateMaintenancePatch(body.value);
    if (checked.error) return jsonResponse({ error: checked.error }, { status: 400 });
    const state = await loadMaintenance(env);
    const stamp = new Date(now).toISOString();
    const site = checked.value.site;
    const prev = state[site] || emptySiteState();
    const wasOn = Boolean(prev.on);
    state[site] = {
      on: checked.value.on,
      message: checked.value.message,
      eta: checked.value.eta,
      reason: checked.value.reason,
      reason_text: checked.value.reason_text,
      updated_at: stamp,
      updated_by: email,
    };
    await saveMaintenance(env, state);
    const label = reasonLabel(checked.value.reason, checked.value.reason_text);
    const audits = [];
    if (checked.value.on && !wasOn) audits.push(["maintenance_lock", `${site}: ${label}`]);
    else if (!checked.value.on && wasOn) audits.push(["maintenance_unlock", site]);
    else if (checked.value.on && reasonLabel(prev.reason, prev.reason_text) !== label) {
      audits.push(["maintenance_reason_change", `${site}: ${reasonLabel(prev.reason, prev.reason_text)} -> ${label}`]);
    }
    for (const [action, target] of audits) {
      try {
        await writeAdminAudit(env, { actor: email || "unknown", action, email: target, now });
      } catch {
        // best-effort
      }
    }
    return jsonResponse(adminPayload(state, now));
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT", "cache-control": "no-store" },
  });
}

export async function maybeServeMaintenance(request, env) {
  const path = new URL(request.url).pathname;
  if (isLockoutExemptPath(path) || !isLockableLauncherPath(path)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let state;
  try {
    state = await loadMaintenance(env);
  } catch {
    return null;
  }
  const launcher = effectiveSiteState(state, "launcher");
  if (!launcher.on) return null;
  return maintenancePageResponse(launcher, request.method);
}

// How each reason looks on the lockout page. Kept in sync with the client
// overlays in the US and CA index.html (tests/maintenance-reason.test.mjs).
export const REASON_STYLE = {
  outage: { icon: "\u26a0\ufe0f", color: "#ef4444", heading: "This site is down right now", fallback: "We're working on a fix. Please check back shortly." },
  maintenance: { icon: "\ud83d\udd27", color: "#f59e0b", heading: "This site is temporarily down", fallback: "We're making updates. Please check back shortly." },
  update: { icon: "\u2b06\ufe0f", color: "#3b82f6", heading: "This site is being updated", fallback: "We're rolling out an update. This usually takes a few minutes." },
  other: { icon: "\u2139\ufe0f", color: "#a78bfa", heading: "This site is temporarily unavailable", fallback: "Please check back shortly." },
};

export function maintenancePageResponse(row, method = "GET") {
  const { reason, reason_text: reasonText } = normalizeReason(row.reason, row.reason_text);
  const look = REASON_STYLE[reason];
  const label = escapeHtml(reasonLabel(reason, reasonText));
  const message = typeof row.message === "string" ? row.message.trim() : "";
  const etaEt = row.eta ? formatEt(new Date(row.eta)) : "";
  const retryAfter = row.eta ? Math.max(0, Math.ceil((Date.parse(row.eta) - Date.now()) / 1000)) : 0;
  const safeMessage = escapeHtml(message);
  const safeEta = escapeHtml(etaEt);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EAS — ${label}</title>
  <link rel="icon" type="image/svg+xml" href="/icon.svg">
  <style>
    :root { --bg:#070b14; --surface:#0f1623; --border:rgba(255,255,255,.08); --text:#f1f5f9; --muted:#94a3b8; --amber:${look.color}; --radius:12px; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--bg); color:var(--text); font-family:Inter,system-ui,sans-serif; padding:24px; }
    main { max-width:34rem; width:100%; background:var(--surface); border:1px solid var(--border); border-top:4px solid var(--amber); border-radius:var(--radius); padding:28px 24px; text-align:center; }
    p.kicker { margin:0 0 8px; font-size:.72rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--amber); }
    h1 { margin:0 0 10px; font-size:1.4rem; }
    p { margin:0 0 10px; color:var(--muted); white-space:pre-wrap; }
    p.eta { color:var(--text); font-weight:600; }
    button { margin-top:12px; font:inherit; font-weight:500; border-radius:8px; border:1px solid var(--border); background:#1a2332; color:var(--text); padding:9px 14px; cursor:pointer; }
  </style>
</head>
<body>
  <main>
    <p class="kicker reason-${reason}"><span aria-hidden="true">${look.icon}</span> ${label}</p>
    <h1>${look.heading}</h1>
    ${safeMessage ? `<p>${safeMessage}</p>` : `<p>${escapeHtml(look.fallback)}</p>`}
    ${safeEta ? `<p class="eta">Expected back: ${safeEta}</p>` : ""}
    <button type="button" id="retry">Check again</button>
  </main>
  <script src="/js/maintenance-page.js" defer></script>
</body>
</html>`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (retryAfter > 0) headers["retry-after"] = String(retryAfter);
  return new Response(method === "HEAD" ? null : html, { status: 503, headers });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function readJson(request) {
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (ctype && !ctype.includes("application/json")) {
    return { error: "Content-Type must be application/json" };
  }
  try {
    const text = await request.text();
    if (text.length > 32 * 1024) return { error: "Request body is too large" };
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "Expected a JSON object" };
    }
    return { value };
  } catch {
    return { error: "Invalid JSON" };
  }
}

