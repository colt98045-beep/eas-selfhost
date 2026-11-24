// Cron dispatch for the launcher. Kept out of src/index.js because the
// Worker entry module should only export the default handler object.
import { pruneAccessLogs } from "./access-log.js";
import { recordUptime, pruneUptime, PRUNE_CRON } from "./uptime.js";
import { applyMaintenanceSchedule } from "./maintenance.js";
import { syncLockoutIncidents } from "./lockout.js";

export async function runScheduled(cron, env, { now = Date.now(), fetcher } = {}) {
  if (cron === PRUNE_CRON) {
    const results = await Promise.allSettled([pruneAccessLogs(env, { now }), pruneUptime(env, { now })]);
    return { kind: "prune", results: results.map((r) => r.status) };
  }
  // Any other cron (the */5 one) records uptime and applies the maintenance schedule.
  const results = await Promise.allSettled([
    recordUptime(env, fetcher ? { now, fetcher } : { now }),
    applyMaintenanceSchedule(env, { now }),
    syncLockoutIncidents(env, { now }),
  ]);
  return { kind: "minute", results: results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false })) };
}
