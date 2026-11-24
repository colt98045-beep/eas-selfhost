// Lockout incidents. A site under the maintenance lockout (manual switch or an
// active scheduled window) is shown as DOWN with its reason on the launcher and
// /status, and gets an incident in uptime_incidents so it appears in the
// incident history next to automatic health-check outages.
//
// No schema change: a lockout incident is a normal uptime_incidents row with
// check_id "lockout:<site>" (never a real check id) and a small JSON label
// {"r": reason key, "l": reason label, "m": message, "s": scheduled}.
// Health-check incidents keep their plain-text label, so the two are told apart
// by the check_id prefix.
import { SITES } from "./announcements.js";
import { effectiveSiteState, loadMaintenance, reasonLabel, REASON_STYLE } from "./maintenance.js";
import { formatEt } from "./status.js";

export const LOCKOUT_PREFIX = "lockout:";
export const MAX_INCIDENT_MESSAGE = 280;
export const SITE_NAMES = { us: "United States", ca: "Canada", launcher: "Launcher" };
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;

export function isLockoutCheckId(id) {
  return typeof id === "string" && id.startsWith(LOCKOUT_PREFIX);
}

// Current lockout per site, or null when open. Pure.
export function lockoutsFromState(state, now = Date.now()) {
  const out = {};
  for (const site of SITES) {
    const eff = effectiveSiteState(state, site, now);
    if (!eff.on) {
      out[site] = null;
      continue;
    }
    const reason = REASON_STYLE[eff.reason] ? eff.reason : "maintenance";
    const look = REASON_STYLE[reason];
    const since = eff.scheduled ? eff.scheduled.start : eff.updated_at || null;
    out[site] = {
      site,
      reason,
      reason_label: reasonLabel(reason, eff.reason_text),
      icon: look.icon,
      color: look.color,
      message: typeof eff.message === "string" ? eff.message.trim() : "",
      scheduled: Boolean(eff.scheduled),
      since: since || null,
      since_et: since && Number.isFinite(Date.parse(since)) ? formatEt(new Date(since)) : null,
      eta: eff.eta || null,
      eta_et: eff.eta && Number.isFinite(Date.parse(eff.eta)) ? formatEt(new Date(eff.eta)) : null,
    };
  }
  return out;
}

export async function currentLockouts(env, now = Date.now()) {
  try {
    if (!env || !env.ANNOUNCEMENTS) return {};
    return lockoutsFromState(await loadMaintenance(env), now);
  } catch {
    return {}; // fail open: never break /api/status over a KV hiccup
  }
}

// Mark locked groups DOWN with their lockout details. Checks keep their raw results.
export function decorateStatus(payload, lockouts) {
  if (!payload || !Array.isArray(payload.groups)) return payload;
  const groups = payload.groups.map((g) => {
    const lock = lockouts && lockouts[g.id];
    return lock ? { ...g, state: "down", lockout: lock } : { ...g, lockout: null };
  });
  let overall = "up";
  if (groups.some((g) => g.state === "down")) overall = "down";
  else if (groups.some((g) => g.state === "gated")) overall = "gated";
  return { ...payload, groups, overall, locked: groups.filter((g) => g.lockout).map((g) => g.id) };
}

export function encodeLockoutLabel(lock) {
  return JSON.stringify({
    r: lock.reason,
    l: lock.reason_label,
    m: (lock.message || "").slice(0, MAX_INCIDENT_MESSAGE),
    s: lock.scheduled ? 1 : 0,
  });
}

export function decodeLockoutLabel(label) {
  try {
    const v = JSON.parse(label);
    if (!v || typeof v !== "object") throw new Error("bad");
    const reason = REASON_STYLE[v.r] ? v.r : "maintenance";
    return {
      reason,
      reason_label: typeof v.l === "string" && v.l ? v.l : reasonLabel(reason),
      message: typeof v.m === "string" ? v.m : "",
      scheduled: Boolean(v.s),
      icon: REASON_STYLE[reason].icon,
      color: REASON_STYLE[reason].color,
    };
  } catch {
    return { reason: "maintenance", reason_label: reasonLabel("maintenance"), message: "", scheduled: false, icon: REASON_STYLE.maintenance.icon, color: REASON_STYLE.maintenance.color };
  }
}

// Open, update or close lockout incidents to match the current lockout state.
// Called after every admin lockout change and from the */5 cron (which picks up
// scheduled windows starting/ending). Never throws.
export async function syncLockoutIncidents(env, { now = Date.now(), state } = {}) {
  if (!env || !env.ACCESS_LOG) return { ok: false, reason: "no_binding" };
  try {
    const st = state || (await loadMaintenance(env));
    const locks = lockoutsFromState(st, now);
    const db = env.ACCESS_LOG;
    const res = await db
      .prepare("SELECT id, check_id, label FROM uptime_incidents WHERE ended_at IS NULL AND check_id LIKE 'lockout:%'")
      .all();
    const open = new Map(((res && res.results) || []).map((r) => [r.check_id, r]));
    const statements = [];
    const opened = [];
    const closed = [];
    for (const site of SITES) {
      const id = LOCKOUT_PREFIX + site;
      const lock = locks[site];
      const row = open.get(id);
      if (lock && !row) {
        const since = Date.parse(lock.since || "");
        const started = Number.isFinite(since) && since <= now && now - since <= MAX_BACKDATE_MS ? since : now;
        statements.push(
          db
            .prepare("INSERT INTO uptime_incidents (check_id, started_at, ended_at, label, status, samples) VALUES (?, ?, NULL, ?, NULL, 1)")
            .bind(id, started, encodeLockoutLabel(lock)),
        );
        opened.push(site);
      } else if (lock && row && row.label !== encodeLockoutLabel(lock)) {
        statements.push(db.prepare("UPDATE uptime_incidents SET label = ? WHERE id = ?").bind(encodeLockoutLabel(lock), row.id));
      } else if (!lock && row) {
        statements.push(db.prepare("UPDATE uptime_incidents SET ended_at = ? WHERE id = ?").bind(now, row.id));
        closed.push(site);
      }
    }
    if (statements.length) await db.batch(statements);
    return { ok: true, opened, closed, changed: statements.length };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 200) };
  }
}
