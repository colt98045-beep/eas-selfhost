import test from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./helpers/sqlite-d1.mjs";
import { handleAdminStats, parseStatsQuery, buckets, statusClasses } from "../src/access-stats.js";
import { withSecurityHeaders, CSP } from "../src/headers.js";
import worker from "../src/index.js";

const NOW = Date.parse("2026-11-24T17:00:00.000Z");

function seed(db) {
  const ins = db.db.prepare("INSERT INTO access_logs (ts, site, method, path, status, country, ip_hash, ip, user_agent, gate) VALUES (?, ?, 'GET', ?, ?, ?, ?, ?, ?, ?)");
  ins.run(NOW - 60000, "us", "/", 403, "US", "aaa", "203.0.113.1", "Mozilla", "challenged");
  ins.run(NOW - 120000, "us", "/", 200, "US", "aaa", "203.0.113.1", "Mozilla", "passed");
  ins.run(NOW - 3 * 3600000, "ca", "/api/canada", 200, "CA", "bbb", "198.51.100.2", "Mozilla", null);
  ins.run(NOW - 2 * 86400000, "launcher", "/status", 200, "GB", "ccc", "192.0.2.3", "Mozilla", null);
  ins.run(NOW - 60000, "ca", "/", 200, "US", "zzz", "192.0.2.99", "EAS-Launcher-Status/1.0", null);
}

test("stats query: series, tops, status classes, gate outcomes; monitor excluded", async () => {
  const db = sqliteD1();
  seed(db);
  const res = await handleAdminStats(new Request("https://x/api/admin/logs/stats?range=24h"), { ACCESS_LOG: db }, { now: NOW });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.total, 3, "monitor UA and >24h rows excluded");
  assert.equal(s.unique_visitors, 2);
  assert.equal(s.labels.length, 24);
  assert.equal(s.series.us.reduce((a, b) => a + b, 0), 2);
  assert.equal(s.series.ca.reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(s.top_paths[0], { site: "us", path: "/", n: 2 });
  assert.equal(s.countries[0].country, "US");
  assert.deepEqual(s.status_classes, { "2xx": 2, "3xx": 0, "4xx": 1, "5xx": 0, other: 0 });
  assert.deepEqual(s.us_gate.map((g) => g.gate).sort(), ["challenged", "passed"]);
  assert.equal(s.top_ips[0].ip, "203.0.113.1");
  assert.match(s.to_et, /^24\/11\/2026 12:00:00 ET$/);

  const week = await (await handleAdminStats(new Request("https://x/api/admin/logs/stats?range=7d&site=launcher"), { ACCESS_LOG: db }, { now: NOW })).json();
  assert.equal(week.total, 1);
  assert.equal(week.labels.length, 7);
  assert.equal(week.labels.at(-1), "24/11");
});

test("stats query validation", async () => {
  assert.ok(parseStatsQuery(new URL("https://x/?range=1y")).error);
  assert.ok(parseStatsQuery(new URL("https://x/?site=mars")).error);
  assert.equal(buckets("30d", NOW).length, 30);
  assert.deepEqual(statusClasses([{ status: 503, n: 2 }, { status: 0, n: 1 }]), { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 2, other: 1 });
  const res = await handleAdminStats(new Request("https://x/api/admin/logs/stats"), {}, { now: NOW });
  assert.equal(res.status, 503);
});

test("security headers: strict CSP, keeps handler choices, keeps CORS", async () => {
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/);
  const res = withSecurityHeaders(new Response("{}", { headers: { "referrer-policy": "no-referrer", "access-control-allow-origin": "https://eas-repository.your-subdomain.workers.dev" } }));
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("access-control-allow-origin"), "https://eas-repository.your-subdomain.workers.dev");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.ok(res.headers.get("strict-transport-security"));
  assert.equal(res.headers.get("cross-origin-resource-policy"), null, "no CORP: US/CA must still fetch the feeds");
});

test("worker: public feeds keep CORS for US/CA with headers applied; admin stays locked", async () => {
  const env = { ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) } };
  const origin = "https://eas-repository-ca.your-subdomain.workers.dev";
  let res = await worker.fetch(new Request("https://eas-launcher.your-subdomain.workers.dev/api/maintenance?site=ca", { headers: { Origin: origin } }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  assert.ok(res.headers.get("content-security-policy"));
  res = await worker.fetch(new Request("https://eas-launcher.your-subdomain.workers.dev/api/announcements?site=us", { headers: { Origin: "https://eas-repository.your-subdomain.workers.dev" } }), env, {});
  assert.equal(res.headers.get("access-control-allow-origin"), "https://eas-repository.your-subdomain.workers.dev");
  res = await worker.fetch(new Request("https://eas-launcher.your-subdomain.workers.dev/"), env, {});
  assert.equal(res.headers.get("content-security-policy"), CSP);
  res = await worker.fetch(new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/logs/stats"), env, {});
  assert.ok(res.status === 401 || res.status === 403, `admin stats must fail closed without Access (got ${res.status})`);
  res = await worker.fetch(new Request("https://eas-launcher.your-subdomain.workers.dev/favicon.ico"), env, {});
  assert.equal(res.status, 301);
});
