// Incident updates (statuspage-style timeline), manual incidents and /api/incidents.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sqliteD1 } from "./helpers/sqlite-d1.mjs";
import { memoryKv } from "./helpers/memory.mjs";
import worker from "../src/index.js";
import {
  validateUpdate, validateManual, shapeIncident, listIncidents,
  handlePublicIncidents, handleAdminIncidents, MAX_BODY, MAX_TITLE,
} from "../src/incidents.js";
import { syncLockoutIncidents, currentLockouts, decorateStatus } from "../src/lockout.js";
import { pruneUptime, recordUptime } from "../src/uptime.js";
import { KV_MAINT_KEY } from "../src/maintenance.js";

const FILES = ["schema/access-log.sql", "schema/migrations/0003_uptime.sql", "schema/migrations/0004_incident_updates.sql"];
const NOW = Date.parse("2026-11-24T18:30:00.000Z");
const ME = { email: "admin@example.com" };
const OTHER = { email: "someone@example.com" };
const BASE = "https://launcher.example";

function env(files = FILES) {
  return { ACCESS_LOG: sqliteD1({ files }), ANNOUNCEMENTS: memoryKv() };
}
function req(path, method = "GET", body) {
  return new Request(BASE + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function admin(e, path, method, body, who = ME, now = NOW) {
  const res = await handleAdminIncidents(req(path, method, body), e, who, { now });
  return { res, data: await res.json() };
}
async function auditRows(e) {
  return (await e.ACCESS_LOG.prepare("SELECT actor, action, email FROM admin_audit ORDER BY id").all()).results;
}
const manual = { title: "Slow alerts", sites: ["us", "launcher"], severity: "major", category: "degraded", status: "investigating", body: "Looking into delays" };

test("migration 0004 is idempotent and only adds new tables", () => {
  const sql = fs.readFileSync("schema/migrations/0004_incident_updates.sql", "utf8");
  const code = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /\bALTER\b|\bDROP\b/i);
  assert.equal((code.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) || []).length, (code.match(/CREATE /g) || []).length);
  const db = sqliteD1({ files: [...FILES, "schema/migrations/0004_incident_updates.sql"] });
  assert.ok(db, "running 0004 twice does not throw");
});

test("validation caps lengths and checks status, sites and severity", () => {
  assert.ok(validateUpdate({ status: "Monitoring", body: " ok " }).value);
  assert.equal(validateUpdate({ status: "monitoring", body: " ok " }).value.body, "ok");
  assert.ok(validateUpdate({ status: "fixed", body: "x" }).error);
  assert.ok(validateUpdate({ status: "resolved", body: "" }).error);
  assert.ok(validateUpdate({ status: "resolved", body: "x".repeat(MAX_BODY + 1) }).error);
  assert.ok(validateManual({ ...manual, title: "x".repeat(MAX_TITLE + 1) }).error);
  assert.ok(validateManual({ ...manual, sites: [] }).error);
  assert.ok(validateManual({ ...manual, sites: ["mx"] }).error);
  assert.ok(validateManual({ ...manual, severity: "huge" }).error);
  assert.ok(validateManual({ ...manual, status: "resolved" }).error);
  assert.ok(validateManual({ ...manual, category: "aliens" }).error);
  assert.ok(validateManual({ ...manual, category: undefined }).error);
  for (const c of ["security", "outage", "degraded", "maintenance", "other"]) assert.equal(validateManual({ ...manual, category: c }).value.category, c);
  assert.deepEqual(validateManual({ ...manual, sites: ["launcher", "US"] }).value.sites, ["us", "launcher"]);
});

test("create a manual incident, post updates newest first, resolve closes it, all audited", async () => {
  const e = env();
  let { res, data } = await admin(e, "/api/admin/incidents", "POST", manual);
  assert.equal(res.status, 201);
  const id = data.id;
  assert.equal(data.active.length, 1);
  const inc = data.active[0];
  assert.equal(inc.kind, "manual");
  assert.equal(inc.title, "Slow alerts");
  assert.equal(inc.severity, "major");
  assert.equal(inc.category, "degraded");
  assert.equal(inc.category_label, "Degraded performance");
  assert.equal(inc.sites_label, "United States, Launcher");
  assert.equal(inc.latest_update.author, ME.email);
  assert.match(inc.latest_update.at, /^24\/11\/2026 13:30(:\d\d)? ET$/);

  ({ res } = await admin(e, `/api/admin/incidents/${id}/updates`, "POST", { status: "identified", body: "Found it" }, ME, NOW + 60000));
  assert.equal(res.status, 201);
  ({ res, data } = await admin(e, `/api/admin/incidents/${id}/updates`, "POST", { status: "resolved", body: "Fixed" }, ME, NOW + 120000));
  assert.equal(data.resolved, true);
  assert.equal(data.active.length, 0);
  const done = data.recent[0];
  assert.equal(done.ongoing, false);
  assert.deepEqual(done.updates.map((u) => u.status), ["resolved", "identified", "investigating"]);
  assert.equal(done.current_status, "resolved");
  assert.deepEqual((await auditRows(e)).map((r) => r.action), ["incident_create", "incident_update_add", "incident_resolve"]);
  assert.ok((await auditRows(e)).every((r) => r.actor === ME.email));
});

test("a lockout incident cannot be resolved by an update but takes comments", async () => {
  const e = env();
  await e.ANNOUNCEMENTS.put(KV_MAINT_KEY, JSON.stringify({ us: { on: true, reason: "outage", message: "API down", updated_at: "2026-11-24T18:20:00Z" } }));
  await syncLockoutIncidents(e, NOW);
  let { data } = await admin(e, "/api/admin/incidents", "GET");
  const lock = data.active.find((i) => i.kind === "lockout");
  assert.ok(lock);
  assert.equal(lock.severity, "critical");
  let { res } = await admin(e, `/api/admin/incidents/${lock.id}/updates`, "POST", { status: "resolved", body: "done" });
  assert.equal(res.status, 409);
  ({ res, data } = await admin(e, `/api/admin/incidents/${lock.id}/updates`, "POST", { status: "monitoring", body: "Back soon" }));
  assert.equal(res.status, 201);
  assert.equal(data.active[0].latest_update.body, "Back soon");
  // Unlocking closes it and keeps the timeline.
  await e.ANNOUNCEMENTS.put(KV_MAINT_KEY, JSON.stringify({ us: { on: false } }));
  await syncLockoutIncidents(e, NOW + 60000);
  data = await listIncidents(e, { now: NOW + 60000 });
  assert.equal(data.active.length, 0);
  assert.equal(data.recent[0].updates.length, 1);
});

test("health-check incidents take updates and Resolved closes them", async () => {
  const e = env();
  await e.ACCESS_LOG.prepare("INSERT INTO uptime_incidents (check_id, started_at, ended_at, label, status, samples) VALUES ('us-site', ?, NULL, 'Down', 502, 3)").bind(NOW - 600000).run();
  let { data } = await admin(e, "/api/admin/incidents", "GET");
  assert.equal(data.active[0].kind, "outage");
  assert.equal(data.active[0].current_status, "investigating");
  ({ data } = await admin(e, `/api/admin/incidents/${data.active[0].id}/updates`, "POST", { status: "resolved", body: "Origin back" }));
  assert.equal(data.active.length, 0);
});

test("only the author can edit or delete an update", async () => {
  const e = env();
  const { data } = await admin(e, "/api/admin/incidents", "POST", manual);
  const id = data.id;
  const uid = data.active[0].updates[0].id;
  const path = `/api/admin/incidents/${id}/updates/${uid}`;
  assert.equal((await admin(e, path, "PATCH", { status: "identified", body: "hack" }, OTHER)).res.status, 403);
  assert.equal((await admin(e, path, "DELETE", undefined, OTHER)).res.status, 403);
  const edited = await admin(e, path, "PATCH", { status: "identified", body: "Edited <b>x</b>" }, ME, NOW + 5000);
  assert.equal(edited.res.status, 200);
  const u = edited.data.active[0].updates[0];
  assert.equal(u.body, "Edited <b>x</b>"); // stored raw; every renderer escapes or uses textContent
  assert.ok(u.edited);
  assert.equal((await admin(e, path, "DELETE")).res.status, 200);
  assert.equal((await listIncidents(e, { now: NOW })).active[0].updates.length, 0);
  assert.equal((await admin(e, `/api/admin/incidents/${id}/updates/99999`, "DELETE")).res.status, 404);
  assert.equal((await admin(e, "/api/admin/incidents/424242/updates", "POST", { status: "identified", body: "x" })).res.status, 404);
  assert.deepEqual((await auditRows(e)).map((r) => r.action), ["incident_create", "incident_update_edit", "incident_update_delete"]);
});

test("bad input is rejected", async () => {
  const e = env();
  assert.equal((await admin(e, "/api/admin/incidents", "POST", { ...manual, severity: "x" })).res.status, 400);
  const res = await handleAdminIncidents(new Request(BASE + "/api/admin/incidents", { method: "POST", body: "{}" }), e, ME, { now: NOW });
  assert.equal(res.status, 400, "non-JSON content type rejected");
  assert.equal((await admin(e, "/api/admin/incidents", "DELETE")).res.status, 405);
});

test("public /api/incidents hides authors, is cacheable and served by the worker", async () => {
  const e = env();
  await admin(e, "/api/admin/incidents", "POST", manual);
  const res = await handlePublicIncidents(req("/api/incidents"), e, { now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=30");
  const data = await res.json();
  assert.equal(data.updates_enabled, true);
  assert.equal(data.active[0].latest_update.author, undefined);
  assert.doesNotMatch(JSON.stringify(data), /admin@example/);
  assert.equal((await handlePublicIncidents(req("/api/incidents", "POST", {}), e)).status, 405);
  const viaWorker = await worker.fetch(req("/api/incidents"), { ...e, ASSETS: { fetch: async () => new Response("x") } }, { waitUntil() {} });
  assert.equal(viaWorker.status, 200);
  assert.ok(Array.isArray((await viaWorker.json()).active));
});

test("/api/incidents still works before migration 0004 is applied", async () => {
  const e = env(["schema/access-log.sql", "schema/migrations/0003_uptime.sql"]);
  await e.ACCESS_LOG.prepare("INSERT INTO uptime_incidents (check_id, started_at, ended_at, label, status, samples) VALUES ('us-site', ?, NULL, 'Down', 502, 1)").bind(NOW).run();
  const data = await listIncidents(e, { now: NOW });
  assert.equal(data.updates_enabled, false);
  assert.equal(data.active.length, 1);
  assert.deepEqual(data.active[0].updates, []);
  assert.deepEqual(await pruneUptime(e, NOW), { ok: true }, "prune tolerates missing 0004 tables");
});

test("prune drops updates of pruned incidents", async () => {
  const e = env();
  const old = NOW - 400 * 24 * 3600 * 1000;
  const { data } = await admin(e, "/api/admin/incidents", "POST", manual, ME, old);
  await admin(e, `/api/admin/incidents/${data.id}/updates`, "POST", { status: "resolved", body: "ok" }, ME, old + 1000);
  await pruneUptime(e, NOW);
  const left = await e.ACCESS_LOG.prepare("SELECT COUNT(*) AS n FROM incident_updates").first();
  assert.equal(Number(left.n), 0);
});

test("shapeIncident: lockout severity and empty timeline defaults", () => {
  const row = { id: 1, check_id: "lockout:ca", started_at: NOW, ended_at: null, label: JSON.stringify({ r: "update", l: "Update", m: "", s: 1 }) };
  const s = shapeIncident(row, null, [], NOW);
  assert.equal(s.severity, "maintenance");
  assert.equal(s.title, "Canada locked: Update");
  assert.equal(s.current_status, "investigating");
  assert.equal(s.latest_update, null);
});

test("new front-end scripts never build markup from update text unescaped", () => {
  const banner = fs.readFileSync("public/js/incident-banner.js", "utf8");
  assert.doesNotMatch(banner, /innerHTML/);
  const adminJs = fs.readFileSync("public/js/admin-incidents.js", "utf8");
  for (const field of ["u.body", "i.title", "u.author"]) assert.match(adminJs, new RegExp(`esc\\(${field.replace(".", "\\.")}`));
  const statusJs = fs.readFileSync("public/js/status.js", "utf8");
  assert.match(statusJs, /esc\(u\.body\)/);
  const index = fs.readFileSync("public/index.html", "utf8");
  assert.match(index, /<script src="\/js\/incident-banner\.js"><\/script>/);
});

test("a manual security incident never locks a site or changes up/down status", async () => {
  const e = env();
  const { res, data } = await admin(e, "/api/admin/incidents", "POST", {
    title: "Suspicious admin logins", sites: ["us", "ca"], severity: "critical", category: "security", body: "Investigating odd sign-ins",
  });
  assert.equal(res.status, 201);
  const inc = data.active[0];
  assert.equal(inc.kind, "manual");
  assert.equal(inc.category_label, "Security incident");
  assert.equal(inc.severity, "critical");
  // No lockout state written, so no overlay and no DOWN marking.
  assert.equal(await e.ANNOUNCEMENTS.get(KV_MAINT_KEY), null);
  const lockouts = await currentLockouts(e, NOW);
  assert.ok(Object.values(lockouts).every((l) => !l));
  const payload = { overall: "up", groups: [{ id: "us", state: "gated", checks: [] }, { id: "ca", state: "up", checks: [] }] };
  const status = decorateStatus(payload, lockouts);
  assert.deepEqual(status.groups.map((g) => g.state), ["gated", "up"]);
  assert.equal(status.overall, "gated");
  const maint = await worker.fetch(req("/api/maintenance?site=us"), { ...e, ASSETS: { fetch: async () => new Response("x") } }, { waitUntil() {} });
  assert.equal((await maint.json()).on, false);
  // Lockout sync and health-check sampling leave the manual incident alone.
  await syncLockoutIncidents(e, NOW + 1000);
  await recordUptime(e, { fetcher: async () => new Response("{}", { status: 200 }), now: NOW + 2000 });
  let list = await listIncidents(e, { now: NOW + 3000 });
  assert.equal(list.active.length, 1);
  assert.equal(list.active[0].id, inc.id);
  // It is on the public feed (banner and /status), then Resolved closes it.
  const pub = await (await handlePublicIncidents(req("/api/incidents"), e, { now: NOW + 3000 })).json();
  assert.equal(pub.active[0].category_label, "Security incident");
  await admin(e, `/api/admin/incidents/${inc.id}/updates`, "POST", { status: "resolved", body: "False alarm" }, ME, NOW + 4000);
  list = await listIncidents(e, { now: NOW + 5000 });
  assert.equal(list.active.length, 0);
  assert.equal(list.recent[0].current_status, "resolved");
  const actions = (await auditRows(e)).map((r) => r.action);
  assert.deepEqual(actions, ["incident_create", "incident_resolve"]);
  assert.match((await auditRows(e))[0].email, /Security incident critical: Suspicious admin logins/);
});

test("health-check and lockout incidents get a category too", () => {
  const out = shapeIncident({ id: 2, check_id: "us-site", started_at: NOW, ended_at: null, label: "Down", status: 502 }, null, [], NOW);
  assert.equal(out.category_label, "Outage");
  const lock = shapeIncident({ id: 3, check_id: "lockout:us", started_at: NOW, ended_at: null, label: JSON.stringify({ r: "maintenance", l: "Maintenance", m: "", s: 0 }) }, null, [], NOW);
  assert.equal(lock.category_label, "Maintenance");
});

test("banner and /status show the incident type label", () => {
  assert.match(fs.readFileSync("public/js/incident-banner.js", "utf8"), /category_label/);
  assert.match(fs.readFileSync("public/js/status.js", "utf8"), /category_label/);
  assert.match(fs.readFileSync("public/js/admin-incidents.js", "utf8"), /category_label/);
  assert.match(fs.readFileSync("public/admin.html", "utf8"), /id="incNewCategory"[\s\S]*Security incident[\s\S]*Degraded performance/);
});
