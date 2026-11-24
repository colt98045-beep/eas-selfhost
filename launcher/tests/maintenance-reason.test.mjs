// Lockout reasons: validation, backward compatibility, public API, overlay page,
// scheduled windows, audit, and parity with the US/CA client overlays.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  effectiveSiteState,
  handleAdminMaintenance,
  handlePublicMaintenance,
  loadMaintenance,
  maintenancePageResponse,
  publicView,
  reasonLabel,
  validateMaintenancePatch,
  validateWindow,
  KV_MAINT_KEY,
  REASON_STYLE,
} from "../src/maintenance.js";
import { memoryKv, auditDb } from "./helpers/memory.mjs";

const NOW = Date.parse("2026-11-24T18:00:00.000Z");

test("validateMaintenancePatch accepts the four reasons and caps/escapes custom text", () => {
  for (const r of ["outage", "maintenance", "update"]) {
    assert.equal(validateMaintenancePatch({ site: "us", on: true, reason: r }).value.reason, r);
  }
  assert.equal(validateMaintenancePatch({ site: "us", on: true }).value.reason, "maintenance");
  const other = validateMaintenancePatch({ site: "us", on: true, reason: "other", reason_text: "  DNS\n migration " });
  assert.deepEqual([other.value.reason, other.value.reason_text], ["other", "DNS migration"]);
  assert.match(validateMaintenancePatch({ site: "us", on: true, reason: "other", reason_text: "" }).error, /required/);
  assert.match(validateMaintenancePatch({ site: "us", on: true, reason: "other", reason_text: "x".repeat(41) }).error, /40/);
  assert.match(validateMaintenancePatch({ site: "us", on: true, reason: "nuke" }).error, /reason must be/);
  assert.equal(validateMaintenancePatch({ site: "us", on: true, reason: "update", reason_text: "ignored" }).value.reason_text, "");
});

test("old KV values with no reason read as Maintenance", async () => {
  const env = { ANNOUNCEMENTS: memoryKv({ [KV_MAINT_KEY]: { us: { on: true, message: "old", eta: null } } }) };
  const state = await loadMaintenance(env);
  assert.equal(state.us.reason, "maintenance");
  const res = await handlePublicMaintenance(new Request("https://x/api/maintenance?site=us"), env, { now: NOW });
  const body = await res.json();
  assert.equal(body.on, true);
  assert.equal(body.reason, "maintenance");
  assert.equal(body.reason_label, "Maintenance");
});

test("/api/maintenance exposes reason and label", () => {
  const v = publicView("ca", { on: true, reason: "other", reason_text: "Vendor issue", message: "" }, NOW);
  assert.equal(v.reason, "other");
  assert.equal(v.reason_label, "Vendor issue");
  assert.equal(publicView("ca", { on: true, reason: "outage" }, NOW).reason_label, "Outage");
  assert.equal(reasonLabel("bogus"), "Maintenance");
});

test("lockout page shows a coloured reason label and escapes custom text", async () => {
  const outage = await maintenancePageResponse({ on: true, reason: "outage" }).text();
  assert.match(outage, /--amber:#ef4444/);
  assert.match(outage, /⚠️<\/span> Outage/);
  assert.match(outage, /<title>EAS — Outage<\/title>/);
  const upd = await maintenancePageResponse({ on: true, reason: "update" }).text();
  assert.doesNotMatch(upd, /deploy/i);
  assert.match(upd, /--amber:#3b82f6/);
  assert.match(upd, /⬆️<\/span> Update/);
  const legacy = await maintenancePageResponse({ on: true }).text();
  assert.match(legacy, /🔧<\/span> Maintenance/);
  assert.match(legacy, /--amber:#f59e0b/);
  const evil = await maintenancePageResponse({ on: true, reason: "other", reason_text: "<img src=x onerror=alert(1)>" }).text();
  assert.doesNotMatch(evil, /<img src=x/);
  assert.match(evil, /&lt;img src=x/);
});

test("scheduled windows carry a reason into the effective state", () => {
  const checked = validateWindow(
    { sites: ["us"], start: "2026-11-24T17:00:00Z", end: "2026-11-24T19:00:00Z", reason: "update" },
    { now: NOW },
  );
  assert.equal(checked.value.reason, "update");
  assert.match(validateWindow({ sites: ["us"], start: "2026-11-24T17:00:00Z", end: "2026-11-24T19:00:00Z", reason: "x" }, { now: NOW }).error, /reason/);
  const state = { us: { on: false }, schedule: [{ id: "w", sites: ["us"], start: "2026-11-24T17:00:00Z", end: "2026-11-24T19:00:00Z", reason: "update", reason_text: "" }] };
  const eff = effectiveSiteState(state, "us", NOW);
  assert.equal(eff.on, true);
  assert.equal(eff.reason, "update");
});

test("admin PUT stores the reason and audits lock, reason change and unlock", async () => {
  const db = auditDb();
  const env = { ANNOUNCEMENTS: memoryKv(), ACCESS_LOG: db };
  const put = (body) =>
    handleAdminMaintenance(
      new Request("https://x/api/admin/maintenance", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      env,
      { email: "admin@example.com" },
      { now: NOW },
    );
  let res = await put({ site: "us", on: true, reason: "outage" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sites.us.reason_label, "Outage");
  await put({ site: "us", on: true, reason: "other", reason_text: "Carrier fault" });
  await put({ site: "us", on: false });
  assert.deepEqual(db.rows.map((r) => r.action), ["maintenance_lock", "maintenance_reason_change", "maintenance_unlock"]);
  assert.equal(db.rows[1].email, "us: Outage -> Carrier fault");
  const stored = JSON.parse(env.ANNOUNCEMENTS.map.get(KV_MAINT_KEY));
  assert.equal(stored.us.reason, "maintenance");
});

test("US and CA overlays use the same reasons, colours and labels as the launcher", () => {
  for (const [dir, site] of [["eas-repository", "us"], ["eas-repository-ca", "ca"]]) {
    const file = path.resolve(process.env[`EAS_${site.toUpperCase()}_DIR`] || path.join("..", dir), "index.html");
    if (!fs.existsSync(file)) continue; // sibling checkout not present (e.g. CI)
    const html = fs.readFileSync(file, "utf8");
    for (const [key, look] of Object.entries(REASON_STYLE)) {
      assert.ok(html.includes(`${key}: { icon:`), `${site} overlay lacks ${key}`);
      assert.ok(html.includes(look.color), `${site} overlay lacks colour ${look.color}`);
      assert.ok(html.includes(look.heading), `${site} overlay lacks heading for ${key}`);
    }
  }
});
