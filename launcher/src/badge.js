// Shields.io endpoint badges: https://shields.io/badges/endpoint-badge
//   https://img.shields.io/endpoint?url=https://eas-launcher.your-subdomain.workers.dev/api/badge
//   ...?target=us|ca|launcher|overall|<check id>   (default overall)
//   ...&metric=status|uptime24h|uptime7d|uptime30d (default status)
// Public, read-only, CORS *. Status comes from the cached /api/status checks;
// uptime comes from the cached /api/uptime summary.
import { CHECKS, getStatus } from "./status.js";
import { getUptime } from "./uptime.js";

export const METRICS = ["status", "uptime24h", "uptime7d", "uptime30d"];
const GROUPS = { us: "US", ca: "CA", launcher: "Launcher" };

export function resolveTarget(raw) {
  const target = String(raw || "overall").toLowerCase().trim();
  if (target === "overall") return { kind: "overall", id: "overall", label: "EAS" };
  if (GROUPS[target]) return { kind: "group", id: target, label: `EAS ${GROUPS[target]}` };
  const check = CHECKS.find((c) => c.id === target);
  if (check) return { kind: "check", id: check.id, label: `${GROUPS[check.group]} ${check.name}` };
  return null;
}

export function statusBadge(label, state) {
  if (state === "up") return { schemaVersion: 1, label, message: "up", color: "brightgreen" };
  if (state === "gated") return { schemaVersion: 1, label, message: "up (gated)", color: "green" };
  if (state === "down") return { schemaVersion: 1, label, message: "down", color: "red", isError: true };
  return { schemaVersion: 1, label, message: "unknown", color: "lightgrey" };
}

export function uptimeBadge(label, window, value) {
  if (value == null) return { schemaVersion: 1, label: `${label} ${window}`, message: "no data", color: "lightgrey" };
  const color = value >= 99.9 ? "brightgreen" : value >= 99 ? "green" : value >= 95 ? "yellow" : value >= 90 ? "orange" : "red";
  const message = `${value >= 99.995 ? "100" : value.toFixed(2)}%`;
  return { schemaVersion: 1, label: `${label} ${window}`, message, color };
}

function stateFor(target, status) {
  if (target.kind === "overall") return status.overall;
  if (target.kind === "group") return (status.groups.find((g) => g.id === target.id) || {}).state;
  for (const g of status.groups) {
    const c = g.checks.find((x) => x.id === target.id);
    if (c) return c.state;
  }
  return null;
}

function uptimeFor(target, uptime, window) {
  if (target.kind === "overall") return uptime.overall[window];
  const rows = target.kind === "group" ? uptime.checks.filter((c) => c.group === target.id) : uptime.checks.filter((c) => c.id === target.id);
  const vals = rows.map((r) => r.uptime[window]).filter((v) => v != null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
}

function json(payload, status = 200, method = "GET") {
  return new Response(method === "HEAD" ? null : JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleBadge(request, env, { fetcher = fetch, now = Date.now() } = {}) {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", "cache-control": "no-store" } });
  }
  const url = new URL(request.url);
  const target = resolveTarget(url.searchParams.get("target"));
  if (!target) return json({ error: "target must be overall, us, ca, launcher or a check id" }, 400, method);
  const metric = String(url.searchParams.get("metric") || "status").toLowerCase();
  if (!METRICS.includes(metric)) return json({ error: `metric must be one of ${METRICS.join(", ")}` }, 400, method);
  if (metric === "status") {
    const status = await getStatus({ fetcher });
    return json(statusBadge(target.label, stateFor(target, status)), 200, method);
  }
  const window = metric.replace("uptime", "");
  try {
    const uptime = await getUptime(env, { now });
    if (uptime.error) return json(uptimeBadge(target.label, window, null), 200, method);
    return json(uptimeBadge(target.label, window, uptimeFor(target, uptime, window)), 200, method);
  } catch {
    return json(uptimeBadge(target.label, window, null), 200, method);
  }
}
