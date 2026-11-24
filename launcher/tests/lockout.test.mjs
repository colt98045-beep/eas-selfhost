// Locked sites show DOWN with their reason and are tracked as lockout incidents.
import test from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./helpers/sqlite-d1.mjs";
import { memoryKv } from "./helpers/memory.mjs";
import { decorateStatus, lockoutsFromState, syncLockoutIncidents } from "../src/lockout.js";
import { recordUptime, getUptime, resetUptimeCache } from "../src/uptime.js";
import { CHECKS } from "../src/status.js";
import { KV_MAINT_KEY } from "../src/maintenance.js";

const NOW = Date.parse("2026-11-24T18:30:00.000Z");
const LOCKED_AT = "2026-11-24T18:20:00.000Z";

function fetcher({ down = new Set() } = {}) {
  return async (url) => {
    const c = CHECKS.find((x) => x.url === url);
    if (down.has(c.group)) return new Response("x", { status: 502 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("lockoutsFromState: manual and active scheduled windows count as locked", () => {
  const state = {
    us: { on: true, reason: "outage", message: "Fixing it", updated_at: LOCKED_AT },
    ca: { on: false },
    launcher: { on: false },
    schedule: [{ id: "w", sites: ["ca"], start: "2026-11-24T18:00:00Z", end: "2026-11-24T19:00:00Z", reason: "update", reason_text: "" }],
  };
  const l = lockoutsFromState(state, NOW);
  assert.equal(l.us.reason_label, "Outage");
  assert.equal(l.us.message, "Fixing it");
  assert.equal(l.us.color, "#ef4444");
  assert.equal(l.ca.reason_label, "Update");
  assert.equal(l.ca.scheduled, true);
  assert.equal(l.launcher, null);
});

test("decorateStatus marks a locked group DOWN with the lockout, others untouched", () => {
  const payload = { overall: "up", groups: [{ id: "us", state: "gated", checks: [] }, { id: "ca", state: "up", checks: [] }] };
  const out = decorateStatus(payload, { us: { reason: "maintenance", reason_label: "Maintenance" }, ca: null });
  assert.equal(out.groups[0].state, "down");
  assert.equal(out.groups[0].lockout.reason_label, "Maintenance");
  assert.equal(out.groups[1].state, "up");
  assert.equal(out.groups[1].lockout, null);
  assert.equal(out.overall, "down");
  assert.deepEqual(out.locked, ["us"]);
  assert.equal(payload.groups[0].state, "gated", "cached payload not mutated");
});

test("lockout opens an incident, updates on reason change, closes on unlock; listed apart from health checks", async () => {
  const db = sqliteD1();
  const kv = memoryKv({ [KV_MAINT_KEY]: { us: { on: true, reason: "outage", message: "Broke it", updated_at: LOCKED_AT } } });
  const env = { ACCESS_LOG: db, ANNOUNCEMENTS: kv };
  let r = await syncLockoutIncidents(env, { now: NOW });
  assert.deepEqual(r.opened, ["us"]);
  r = await syncLockoutIncidents(env, { now: NOW + 1000 });
  assert.equal(r.changed, 0, "idempotent");
  let rows = db.db.prepare("SELECT * FROM uptime_incidents").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].check_id, "lockout:us");
  assert.equal(rows[0].started_at, Date.parse(LOCKED_AT), "backdated to the lock time");

  // While US is locked, its failing checks are recorded as locked: no samples, no outage incident.
  await recordUptime(env, { fetcher: fetcher({ down: new Set(["us", "ca"]) }), now: NOW });
  const hourly = db.db.prepare("SELECT * FROM uptime_hourly WHERE check_id = 'us-site'").get();
  assert.equal(hourly.samples, 0);
  assert.equal(hourly.last_state, "locked");
  rows = db.db.prepare("SELECT check_id FROM uptime_incidents ORDER BY id").all().map((x) => x.check_id);
  assert.ok(!rows.includes("us-site"), "no health-check incident for a locked site");
  assert.ok(rows.includes("ca-site"), "unlocked CA outage still recorded");

  await kv.put(KV_MAINT_KEY, JSON.stringify({ us: { on: true, reason: "other", reason_text: "DNS move", message: "Broke it", updated_at: LOCKED_AT } }));
  await syncLockoutIncidents(env, { now: NOW + 60000 });
  await kv.put(KV_MAINT_KEY, JSON.stringify({ us: { on: false } }));
  r = await syncLockoutIncidents(env, { now: NOW + 120000 });
  assert.deepEqual(r.closed, ["us"]);

  resetUptimeCache();
  const s = await getUptime(env, { now: NOW + 180000, useCache: false });
  const lock = s.incidents.find((i) => i.kind === "lockout");
  assert.equal(lock.reason_label, "DNS move");
  assert.equal(lock.message, "Broke it");
  assert.equal(lock.ongoing, false);
  assert.equal(lock.duration, "12m");
  assert.match(lock.check, /United States · Lockout/);
  assert.ok(s.incidents.some((i) => i.kind === "outage" && i.check_id === "ca-site"));
});

test("launcher.js renders lockout text with textContent only", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("public/js/launcher.js", "utf8");
  assert.doesNotMatch(src, /innerHTML/);
  assert.match(src, /group\.lockout/);
  assert.match(fs.readFileSync("public/index.html", "utf8"), /id="us-lockout"[\s\S]*id="ca-lockout"/);
});
