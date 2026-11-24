import test from "node:test";
import assert from "node:assert/strict";
import {
  corsHeaders,
  filterPublic,
  handleAdminApi,
  handlePublicAnnouncements,
  isActiveAt,
  matchesSite,
  validateAnnouncement,
  PUBLIC_ORIGINS,
} from "../src/announcements.js";
import { US_ORIGIN, CA_ORIGIN, LAUNCHER_ORIGIN } from "../src/status.js";

const NOW = Date.parse("2026-11-24T15:30:00.000Z"); // 10:30 ET

function memoryKv(initial = []) {
  const map = new Map();
  if (initial) map.set("announcements", JSON.stringify(initial));
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
  };
}

function envWith(list) {
  return { ANNOUNCEMENTS: memoryKv(list) };
}

const sample = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "US outage",
  message: "The US site is down for a network cut.",
  type: "outage",
  targets: ["us"],
  start: "2026-11-24T15:00:00.000Z",
  end: "2026-11-24T18:00:00.000Z",
  created_at: "2026-11-24T15:00:00.000Z",
  updated_at: "2026-11-24T15:00:00.000Z",
  created_by: "admin@example.com",
};

const allInfo = {
  ...sample,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Heads up",
  message: "Scheduled note for every site.",
  type: "info",
  targets: ["all"],
  start: null,
  end: null,
};

const futureCa = {
  ...sample,
  id: "33333333-3333-4333-8333-333333333333",
  title: "Future CA window",
  message: "Not yet.",
  type: "maintenance",
  targets: ["ca"],
  start: "2026-11-25T15:00:00.000Z",
  end: "2026-11-25T18:00:00.000Z",
};

const expired = {
  ...sample,
  id: "44444444-4444-4444-8444-444444444444",
  title: "Resolved earlier",
  message: "Already over.",
  type: "resolved",
  targets: ["all"],
  start: "2026-11-23T15:00:00.000Z",
  end: "2026-11-24T15:00:00.000Z",
};

test("isActiveAt and matchesSite filter the public feed", () => {
  assert.equal(isActiveAt(sample, NOW), true);
  assert.equal(isActiveAt(futureCa, NOW), false);
  assert.equal(isActiveAt(expired, NOW), false);
  assert.equal(matchesSite(allInfo, "us"), true);
  assert.equal(matchesSite(allInfo, "launcher"), true);
  assert.equal(matchesSite(sample, "us"), true);
  assert.equal(matchesSite(sample, "ca"), false);

  const us = filterPublic([sample, allInfo, futureCa, expired], "us", NOW).map((a) => a.id);
  const ca = filterPublic([sample, allInfo, futureCa, expired], "ca", NOW).map((a) => a.id);
  const launcher = filterPublic([sample, allInfo, futureCa, expired], "launcher", NOW).map((a) => a.id);
  assert.deepEqual(us, [sample.id, allInfo.id]);
  assert.deepEqual(ca, [allInfo.id]);
  assert.deepEqual(launcher, [allInfo.id]);
});

test("CORS allows only the US, CA and launcher origins", () => {
  assert.deepEqual(PUBLIC_ORIGINS, [US_ORIGIN, CA_ORIGIN, LAUNCHER_ORIGIN]);
  for (const origin of PUBLIC_ORIGINS) {
    const headers = corsHeaders(new Request("https://eas-launcher.your-subdomain.workers.dev/api/announcements", { headers: { Origin: origin } }));
    assert.equal(headers["access-control-allow-origin"], origin, origin);
    assert.equal(headers["access-control-allow-methods"], "GET, HEAD, OPTIONS");
    assert.equal(headers.vary, "Origin");
    assert.match(headers["cache-control"], /max-age=30/);
  }
  const other = corsHeaders(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/announcements", {
      headers: { Origin: "https://evil.example" },
    }),
  );
  assert.equal(other["access-control-allow-origin"], undefined);
});

test("public GET returns only active announcements for the requested site, with CORS", async () => {
  const env = envWith([sample, allInfo, futureCa, expired]);
  const req = new Request("https://eas-launcher.your-subdomain.workers.dev/api/announcements?site=us", {
    headers: { Origin: US_ORIGIN },
  });
  const res = await handlePublicAnnouncements(req, env, { now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), US_ORIGIN);
  const body = await res.json();
  assert.equal(body.site, "us");
  assert.equal(body.updated_at, "24/11/2026 10:30:00 ET");
  assert.deepEqual(
    body.announcements.map((a) => a.id),
    [sample.id, allInfo.id],
  );
  assert.equal(body.announcements[0].start_et, "24/11/2026 10:00:00 ET");
  assert.equal(body.announcements[0].end_et, "24/11/2026 13:00:00 ET");
});

test("public OPTIONS is a CORS preflight and an invalid site is 400", async () => {
  const preflight = await handlePublicAnnouncements(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/announcements?site=us", {
      method: "OPTIONS",
      headers: { Origin: CA_ORIGIN, "Access-Control-Request-Method": "GET" },
    }),
    envWith([]),
    { now: NOW },
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), CA_ORIGIN);

  const bad = await handlePublicAnnouncements(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/announcements?site=mx", {
      headers: { Origin: US_ORIGIN },
    }),
    envWith([]),
    { now: NOW },
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("access-control-allow-origin"), US_ORIGIN);
});

test("validateAnnouncement rejects bad types, targets and windows", () => {
  const ok = validateAnnouncement({
    title: "Maintenance",
    message: "We will be offline briefly.",
    type: "maintenance",
    targets: ["ca", "all"],
    start: "2026-11-24T16:00:00.000Z",
    end: "2026-11-24T17:00:00.000Z",
  });
  assert.deepEqual(ok.value.targets, ["all"]);
  assert.equal(ok.value.type, "maintenance");

  assert.match(validateAnnouncement({ title: "x", message: "y", type: "alert", targets: ["us"] }).error, /type/);
  assert.match(validateAnnouncement({ title: "x", message: "y", type: "info", targets: ["mx"] }).error, /targets/);
  assert.match(
    validateAnnouncement({
      title: "x",
      message: "y",
      type: "info",
      targets: ["us"],
      start: "2026-11-24T17:00:00.000Z",
      end: "2026-11-24T16:00:00.000Z",
    }).error,
    /end must be after start/,
  );
  assert.match(validateAnnouncement({ title: "  ", message: "y", type: "info", targets: ["us"] }).error, /title/);
});

test("admin API creates, lists, updates and deletes announcements", async () => {
  const env = envWith([]);
  const identity = { email: "admin@example.com" };
  const created = await handleAdminApi(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "CA maintenance",
        message: "GeoMet proxy window.",
        type: "maintenance",
        targets: ["ca"],
        start: "2026-11-24T16:00:00.000Z",
        end: "2026-11-24T17:00:00.000Z",
      }),
    }),
    env,
    identity,
    { now: NOW },
  );
  assert.equal(created.status, 201);
  const item = (await created.json()).announcement;
  assert.equal(item.created_by, identity.email);
  assert.equal(item.active, false);
  assert.equal(item.start_et, "24/11/2026 11:00:00 ET");

  const listed = await handleAdminApi(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/announcements"),
    env,
    identity,
    { now: NOW },
  );
  const list = await listed.json();
  assert.equal(list.announcements.length, 1);
  assert.equal(list.announcements[0].id, item.id);

  const updated = await handleAdminApi(
    new Request(`https://eas-launcher.your-subdomain.workers.dev/api/admin/announcements/${item.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "CA maintenance",
        message: "Window extended.",
        type: "maintenance",
        targets: ["ca"],
        start: null,
        end: null,
      }),
    }),
    env,
    identity,
    { now: NOW },
  );
  assert.equal(updated.status, 200);
  const after = (await updated.json()).announcement;
  assert.equal(after.message, "Window extended.");
  assert.equal(after.active, true);

  const gone = await handleAdminApi(
    new Request(`https://eas-launcher.your-subdomain.workers.dev/api/admin/announcements/${item.id}`, { method: "DELETE" }),
    env,
    identity,
    { now: NOW },
  );
  assert.equal(gone.status, 200);
  const empty = await handleAdminApi(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/announcements"),
    env,
    identity,
    { now: NOW },
  );
  assert.equal((await empty.json()).announcements.length, 0);
});

test("admin writes fail closed when KV is not bound", async () => {
  const res = await handleAdminApi(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", message: "y", type: "info", targets: ["all"] }),
    }),
    {},
    { email: "admin@example.com" },
    { now: NOW },
  );
  assert.equal(res.status, 503);
});

test("public GET is empty and 200 when KV is missing so banners stay quiet", async () => {
  const res = await handlePublicAnnouncements(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/announcements?site=launcher"),
    {},
    { now: NOW },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.announcements, []);
});
