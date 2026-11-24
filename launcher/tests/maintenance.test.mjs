import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultMaintenance,
  handleAdminMaintenance,
  handlePublicMaintenance,
  isLockableLauncherPath,
  isLockoutExemptPath,
  maybeServeMaintenance,
  publicView,
  validateMaintenancePatch,
  KV_MAINT_KEY,
} from "../src/maintenance.js";
import { US_ORIGIN, CA_ORIGIN, LAUNCHER_ORIGIN } from "../src/status.js";

const NOW = Date.parse("2026-11-24T15:30:00.000Z"); // 10:30 ET

function memoryKv(initial = {}) {
  const map = new Map();
  for (const [k, v] of Object.entries(initial)) {
    map.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return {
    async get(key, type) {
      const value = map.get(key);
      if (value == null) return null;
      if (type === "json") return JSON.parse(value);
      return value;
    },
    async put(key, value) {
      map.set(key, value);
    },
    map,
  };
}

function envWith(state) {
  return { ANNOUNCEMENTS: memoryKv(state ? { [KV_MAINT_KEY]: state } : {}) };
}

test("lockout never covers admin, status, announcement or maintenance APIs", () => {
  const exempt = [
    "/admin",
    "/admin/",
    "/admin.html",
    "/api/admin/me",
    "/api/admin/maintenance",
    "/api/admin/announcements",
    "/api/status",
    "/api/status?refresh=1",
    "/api/announcements",
    "/api/announcements?site=us",
    "/api/maintenance",
    "/api/maintenance?site=launcher",
  ];
  for (const path of exempt) {
    assert.equal(isLockoutExemptPath(path), true, path);
    assert.equal(isLockableLauncherPath(path), false, path);
  }
  assert.equal(isLockableLauncherPath("/"), true);
  assert.equal(isLockableLauncherPath("/index.html"), true);
  assert.equal(isLockableLauncherPath("/status"), true);
  assert.equal(isLockableLauncherPath("/status/"), true);
  assert.equal(isLockableLauncherPath("/status.html"), true);
  assert.equal(isLockableLauncherPath("/banner.js"), false);
});

test("validateMaintenancePatch requires a site and a boolean on flag", () => {
  const ok = validateMaintenancePatch({
    site: "US",
    on: true,
    message: " Pushing a fix. ",
    eta: "2026-11-24T20:00:00.000Z",
  });
  assert.equal(ok.value.site, "us");
  assert.equal(ok.value.on, true);
  assert.equal(ok.value.message, "Pushing a fix.");
  assert.equal(ok.value.eta, "2026-11-24T20:00:00.000Z");

  assert.match(validateMaintenancePatch({ on: true }).error, /site/);
  assert.match(validateMaintenancePatch({ site: "us", on: "yes" }).error, /on must be true or false/);
  assert.match(validateMaintenancePatch({ site: "us", on: true, eta: "not-a-date" }).error, /eta/);
  const cleared = validateMaintenancePatch({ site: "ca", on: false, message: "", eta: "" });
  assert.equal(cleared.value.on, false);
  assert.equal(cleared.value.eta, null);
});

test("public GET is off and CORS-limited when storage is empty or missing", async () => {
  const req = new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance?site=us", {
    headers: { Origin: US_ORIGIN },
  });
  const res = await handlePublicMaintenance(req, {}, { now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), US_ORIGIN);
  assert.match(res.headers.get("cache-control"), /max-age=15/);
  const body = await res.json();
  assert.equal(body.site, "us");
  assert.equal(body.on, false);
  assert.equal(body.message, "");
  assert.equal(body.eta, null);

  const other = await handlePublicMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance?site=ca", {
      headers: { Origin: "https://evil.example" },
    }),
    envWith(),
    { now: NOW },
  );
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("public GET returns only the requested site and formats the ETA in ET", async () => {
  const state = defaultMaintenance();
  state.us = {
    on: true,
    message: "Deploy in progress",
    eta: "2026-11-24T20:00:00.000Z",
    updated_at: "2026-11-24T15:00:00.000Z",
    updated_by: "admin@example.com",
  };
  const res = await handlePublicMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance?site=us", {
      headers: { Origin: CA_ORIGIN },
    }),
    envWith(state),
    { now: NOW },
  );
  const body = await res.json();
  assert.equal(body.on, true);
  assert.equal(body.message, "Deploy in progress");
  assert.equal(body.eta_et, "24/11/2026 15:00:00 ET");

  const ca = await handlePublicMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance?site=ca", {
      headers: { Origin: LAUNCHER_ORIGIN },
    }),
    envWith(state),
    { now: NOW },
  );
  assert.equal((await ca.json()).on, false);
});

test("public OPTIONS is a CORS preflight and an invalid site is 400", async () => {
  const preflight = await handlePublicMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance?site=us", {
      method: "OPTIONS",
      headers: { Origin: US_ORIGIN, "Access-Control-Request-Method": "GET" },
    }),
    envWith(),
    { now: NOW },
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), US_ORIGIN);

  const bad = await handlePublicMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance"),
    envWith(),
    { now: NOW },
  );
  assert.equal(bad.status, 400);
});

test("admin PUT toggles one site and leaves the others alone", async () => {
  const env = envWith();
  const identity = { email: "admin@example.com" };
  const saved = await handleAdminMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/maintenance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        site: "launcher",
        on: true,
        message: "Adding a feature",
        eta: "2026-11-24T21:00:00.000Z",
      }),
    }),
    env,
    identity,
    { now: NOW },
  );
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.sites.launcher.on, true);
  assert.equal(body.sites.launcher.message, "Adding a feature");
  assert.equal(body.sites.launcher.eta_et, "24/11/2026 16:00:00 ET");
  assert.equal(body.sites.launcher.updated_by, identity.email);
  assert.equal(body.sites.us.on, false);
  assert.equal(body.sites.ca.on, false);

  const listed = await handleAdminMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/maintenance"),
    env,
    identity,
    { now: NOW },
  );
  assert.equal((await listed.json()).sites.launcher.on, true);
});

test("maybeServeMaintenance locks only launcher pages and fails open", async () => {
  const state = defaultMaintenance();
  state.launcher = { on: true, message: "Hold tight.", eta: "2026-11-25T20:00:00.000Z", updated_at: null, updated_by: null };
  const env = envWith(state);

  const page = await maybeServeMaintenance(new Request("https://eas-launcher.your-subdomain.workers.dev/"), env);
  assert.ok(page);
  assert.equal(page.status, 503);
  const html = await page.text();
  assert.match(html, /Hold tight/);
  assert.match(html, /25\/11\/2026 15:00:00 ET/);
  assert.ok(page.headers.get("retry-after"));

  const statusPage = await maybeServeMaintenance(new Request("https://eas-launcher.your-subdomain.workers.dev/status"), env);
  assert.equal(statusPage.status, 503);

  const admin = await maybeServeMaintenance(new Request("https://eas-launcher.your-subdomain.workers.dev/admin"), env);
  assert.equal(admin, null);
  const api = await maybeServeMaintenance(new Request("https://eas-launcher.your-subdomain.workers.dev/api/status"), env);
  assert.equal(api, null);
  const maintApi = await maybeServeMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance?site=launcher"),
    env,
  );
  assert.equal(maintApi, null);
  const banner = await maybeServeMaintenance(new Request("https://eas-launcher.your-subdomain.workers.dev/banner.js"), env);
  assert.equal(banner, null);

  const off = defaultMaintenance();
  const unlocked = await maybeServeMaintenance(
    new Request("https://eas-launcher.your-subdomain.workers.dev/"),
    envWith(off),
  );
  assert.equal(unlocked, null);

  const missing = await maybeServeMaintenance(new Request("https://eas-launcher.your-subdomain.workers.dev/"), {});
  assert.equal(missing, null);
});

test("publicView reports off when the row is missing", () => {
  const view = publicView("ca", null, NOW);
  assert.equal(view.on, false);
  assert.equal(view.site, "ca");
});
