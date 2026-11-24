import test from "node:test";
import assert from "node:assert/strict";
import { memoryKv, sqliteD1 } from "./helpers/sqlite-d1.mjs";
import {
  applyMaintenanceSchedule, effectiveSiteState, handleAdminMaintenance, handlePublicMaintenance,
  maybeServeMaintenance, validateWindow, KV_MAINT_KEY, loadMaintenance,
} from "../src/maintenance.js";
import { LAUNCHER_ORIGIN, US_ORIGIN } from "../src/status.js";

const NOW = Date.parse("2026-11-24T17:00:00.000Z"); // 12:00 ET
const iso = (min) => new Date(NOW + min * 60000).toISOString();
const who = { email: "admin@example.com" };

function post(body) {
  return new Request(`${LAUNCHER_ORIGIN}/api/admin/maintenance/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("validateWindow rules", () => {
  assert.match(validateWindow({ sites: [], start: iso(10), end: iso(20) }, { now: NOW }).error, /sites/);
  assert.match(validateWindow({ sites: ["us"], start: iso(20), end: iso(10) }, { now: NOW }).error, /after start/);
  assert.match(validateWindow({ sites: ["us"], start: iso(-30), end: iso(-10) }, { now: NOW }).error, /future/);
  assert.match(validateWindow({ sites: ["us"], start: iso(0), end: iso(8 * 24 * 60) }, { now: NOW }).error, /7 days/);
  const ok = validateWindow({ sites: ["ca", "us", "us"], start: iso(10), end: iso(70), message: " hi " }, { now: NOW });
  assert.deepEqual(ok.value.sites, ["us", "ca"]);
  assert.equal(ok.value.message, "hi");
  assert.equal(ok.value.announce, true);
});

test("scheduling a window posts a maintenance announcement and locks only during the window", async () => {
  const env = { ANNOUNCEMENTS: memoryKv(), ACCESS_LOG: sqliteD1() };
  const res = await handleAdminMaintenance(post({ sites: ["launcher", "ca"], start: iso(30), end: iso(90), message: "DB upgrade" }), env, who, { now: NOW });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.window.phase, "upcoming");
  assert.equal(body.window.start_et, "24/11/2026 12:30:00 ET");
  assert.equal(body.announced, true);
  const anns = JSON.parse(env.ANNOUNCEMENTS.map.get("announcements"));
  assert.equal(anns.length, 1);
  assert.equal(anns[0].type, "maintenance");
  assert.deepEqual(anns[0].targets, ["ca", "launcher"]);
  assert.equal(anns[0].end, iso(90));
  assert.match(anns[0].message, /12:30:00 ET to 24\/11\/2026 13:30:00 ET/);

  const state = await loadMaintenance(env);
  assert.equal(effectiveSiteState(state, "ca", NOW).on, false, "before start");
  assert.equal(effectiveSiteState(state, "ca", NOW + 30 * 60000).on, true, "start is inclusive");
  assert.equal(effectiveSiteState(state, "ca", NOW + 30 * 60000).message, "DB upgrade");
  assert.equal(effectiveSiteState(state, "us", NOW + 45 * 60000).on, false, "other sites untouched");
  assert.equal(effectiveSiteState(state, "ca", NOW + 90 * 60000).on, false, "end is exclusive");

  // Public feed used by the CA overlay reflects the window.
  const pub = await handlePublicMaintenance(new Request(`${LAUNCHER_ORIGIN}/api/maintenance?site=ca`), env, { now: NOW + 45 * 60000 });
  const view = await pub.json();
  assert.equal(view.on, true);
  assert.equal(view.eta, iso(90));
});

test("launcher pages get the maintenance page during a window; admin and APIs do not", async () => {
  const realNow = Date.now();
  const env = {
    ANNOUNCEMENTS: memoryKv({
      [KV_MAINT_KEY]: {
        launcher: { on: false }, us: { on: false }, ca: { on: false },
        schedule: [{ id: "11111111-1111-4111-8111-111111111111", sites: ["launcher"], start: new Date(realNow - 60000).toISOString(), end: new Date(realNow + 3600000).toISOString(), message: "Back soon" }],
      },
    }),
  };
  const page = await maybeServeMaintenance(new Request(`${LAUNCHER_ORIGIN}/`), env);
  assert.equal(page.status, 503);
  const html = await page.text();
  assert.match(html, /Back soon/);
  assert.match(html, /<script src="\/js\/maintenance-page.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>/, "no inline scripts under the CSP");
  assert.equal(await maybeServeMaintenance(new Request(`${LAUNCHER_ORIGIN}/admin`), env), null);
  assert.equal(await maybeServeMaintenance(new Request(`${LAUNCHER_ORIGIN}/api/status`), env), null);
  assert.equal(await maybeServeMaintenance(new Request(`${LAUNCHER_ORIGIN}/js/maintenance-page.js`), env), null);
});

test("manual PUT keeps the schedule; manual switch wins over a window", async () => {
  const env = { ANNOUNCEMENTS: memoryKv(), ACCESS_LOG: sqliteD1() };
  await handleAdminMaintenance(post({ sites: ["us"], start: iso(10), end: iso(20), announce: false }), env, who, { now: NOW });
  assert.equal(env.ANNOUNCEMENTS.map.get("announcements"), undefined, "announce:false posts nothing");
  const put = new Request(`${LAUNCHER_ORIGIN}/api/admin/maintenance`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ site: "us", on: true, message: "manual" }),
  });
  const res = await handleAdminMaintenance(put, env, who, { now: NOW });
  const body = await res.json();
  assert.equal(body.schedule.length, 1, "schedule survives a manual toggle");
  const state = await loadMaintenance(env);
  assert.equal(effectiveSiteState(state, "us", NOW + 15 * 60000).message, "manual");
});

test("cancelling a window removes it and its announcement", async () => {
  const env = { ANNOUNCEMENTS: memoryKv(), ACCESS_LOG: sqliteD1() };
  const created = await (await handleAdminMaintenance(post({ sites: ["ca"], start: iso(10), end: iso(20) }), env, who, { now: NOW })).json();
  const del = new Request(`${LAUNCHER_ORIGIN}/api/admin/maintenance/schedule/${created.window.id}`, { method: "DELETE" });
  const res = await handleAdminMaintenance(del, env, who, { now: NOW });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.announcement_removed, true);
  assert.equal(body.schedule.length, 0);
  assert.deepEqual(JSON.parse(env.ANNOUNCEMENTS.map.get("announcements")), []);
  const again = await handleAdminMaintenance(del, env, who, { now: NOW });
  assert.equal(again.status, 404);
});

test("cron records start/end once, writes KV only on change, and tidies old windows", async () => {
  const db = sqliteD1();
  const env = { ANNOUNCEMENTS: memoryKv(), ACCESS_LOG: db };
  await handleAdminMaintenance(post({ sites: ["ca"], start: iso(10), end: iso(20), announce: false }), env, who, { now: NOW });
  const w0 = env.ANNOUNCEMENTS.writes;
  let r = await applyMaintenanceSchedule(env, { now: NOW + 5 * 60000 });
  assert.equal(r.changed, false);
  assert.equal(env.ANNOUNCEMENTS.writes, w0, "quiet run writes nothing");
  r = await applyMaintenanceSchedule(env, { now: NOW + 12 * 60000 });
  assert.equal(r.started.length, 1);
  r = await applyMaintenanceSchedule(env, { now: NOW + 13 * 60000 });
  assert.equal(r.changed, false, "start recorded only once");
  r = await applyMaintenanceSchedule(env, { now: NOW + 25 * 60000 });
  assert.equal(r.ended.length, 1);
  const actions = db.db.prepare("SELECT action FROM admin_audit ORDER BY id").all().map((x) => x.action);
  assert.deepEqual(actions, ["maintenance_window_add", "maintenance_window_start", "maintenance_window_end"]);
  r = await applyMaintenanceSchedule(env, { now: NOW + 8 * 24 * 3600000 });
  assert.equal(r.changed, true);
  assert.equal((await loadMaintenance(env)).schedule.length, 0);
});

test("schedule routes reject wrong methods", async () => {
  const env = { ANNOUNCEMENTS: memoryKv() };
  const res = await handleAdminMaintenance(new Request(`${US_ORIGIN.replace("eas-repository", "eas-launcher")}/api/admin/maintenance/schedule`), env, who, { now: NOW });
  assert.equal(res.status, 405);
});
