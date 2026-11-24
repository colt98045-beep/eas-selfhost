import test from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./helpers/sqlite-d1.mjs";
import {
  recordUptime, getUptime, pruneUptime, summarize, hourFloor, formatDuration, resetUptimeCache,
  HOUR_MS, DAY_MS, HOURLY_RETENTION_MS,
} from "../src/uptime.js";
import { CHECKS, resetStatusCache } from "../src/status.js";
import { handleBadge, resolveTarget, uptimeBadge } from "../src/badge.js";
import { runScheduled } from "../src/scheduled.js";

const NOW = Date.parse("2026-11-24T17:02:00.000Z"); // 12:02 ET

// Fetcher that answers like production: US = Turnstile 403, CA + launcher = 200.
function fetcherWith({ down = new Set() } = {}) {
  return async (url) => {
    const check = CHECKS.find((c) => c.url === url);
    if (down.has(check.id)) return new Response("oops", { status: 502, headers: { "content-type": "text/plain" } });
    if (check.group === "us") {
      return new Response('<div class="cf-turnstile"></div>', {
        status: 403,
        headers: { "content-type": "text/html", "content-security-policy": "script-src https://challenges.cloudflare.com" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("recordUptime folds samples into hourly rows; gated counts as up", async () => {
  const db = sqliteD1();
  const env = { ACCESS_LOG: db };
  for (let i = 0; i < 3; i++) {
    const r = await recordUptime(env, { fetcher: fetcherWith(), now: NOW + i * 5 * 60000 });
    assert.equal(r.ok, true);
    assert.equal(r.samples, CHECKS.length);
  }
  const rows = db.db.prepare("SELECT * FROM uptime_hourly").all();
  assert.equal(rows.length, CHECKS.length, "one row per check per hour");
  for (const row of rows) {
    assert.equal(row.samples, 3);
    assert.equal(row.up, 3);
    assert.equal(row.down, 0);
    assert.equal(row.hour_ts, hourFloor(NOW));
  }
  assert.equal(rows.find((r) => r.check_id === "us-active").gated, 3);
  assert.equal(rows.find((r) => r.check_id === "us-active").last_status, 403);
});

test("down/up transitions open and close exactly one incident", async () => {
  const db = sqliteD1();
  const env = { ACCESS_LOG: db };
  const t = (m) => NOW + m * 60000;
  await recordUptime(env, { fetcher: fetcherWith(), now: t(0) });
  await recordUptime(env, { fetcher: fetcherWith({ down: new Set(["ca-canada"]) }), now: t(5) });
  await recordUptime(env, { fetcher: fetcherWith({ down: new Set(["ca-canada"]) }), now: t(10) });
  let inc = db.db.prepare("SELECT * FROM uptime_incidents").all();
  assert.equal(inc.length, 1);
  assert.equal(inc[0].ended_at, null);
  assert.equal(inc[0].samples, 2);
  assert.equal(inc[0].status, 502);
  await recordUptime(env, { fetcher: fetcherWith(), now: t(15) });
  inc = db.db.prepare("SELECT * FROM uptime_incidents").all();
  assert.equal(inc.length, 1);
  assert.equal(inc[0].ended_at, t(15));

  resetUptimeCache();
  const summary = await getUptime(env, { now: t(16), useCache: false });
  assert.equal(summary.incidents.length, 1);
  assert.equal(summary.incidents[0].ongoing, false);
  assert.equal(summary.incidents[0].duration, "10m");
  assert.match(summary.incidents[0].started_at, /^24\/11\/2026 12:07:00 ET$/);
  const ca = summary.checks.find((c) => c.id === "ca-canada");
  assert.equal(ca.uptime["24h"], 50);
  assert.equal(summary.checks.find((c) => c.id === "us-site").uptime["24h"], 100);
  assert.equal(summary.open_incidents, 0);
});

test("summarize: windows, 30 ET-day bars, 24 sparkline points, DD/MM/YYYY", () => {
  const h = hourFloor(NOW);
  const hourly = [
    { hour_ts: h, check_id: "ca-site", samples: 12, up: 12, gated: 0, down: 0, latency_sum: 1200, latency_max: 150, last_state: "up" },
    { hour_ts: h - 3 * DAY_MS, check_id: "ca-site", samples: 12, up: 6, gated: 0, down: 6, latency_sum: 2400, latency_max: 900, last_state: "down" },
    { hour_ts: h - 20 * DAY_MS, check_id: "ca-site", samples: 12, up: 0, gated: 0, down: 12, latency_sum: 0, latency_max: 0, last_state: "down" },
  ];
  const s = summarize(hourly, [], NOW);
  const ca = s.checks.find((c) => c.id === "ca-site");
  assert.equal(ca.uptime["24h"], 100);
  assert.equal(ca.uptime["7d"], 75);
  assert.equal(ca.uptime["30d"], 50);
  assert.equal(ca.bars.length, 30);
  assert.equal(ca.bars.at(-1).date, "24/11/2026");
  assert.equal(ca.bars.at(-1).uptime, 100);
  assert.equal(ca.spark.length, 24);
  assert.equal(ca.spark.at(-1).avg_ms, 100);
  assert.match(ca.spark.at(-1).hour, /^12:00$/);
  assert.equal(s.checks.find((c) => c.id === "us-site").uptime["24h"], null, "no data is null, not 0");
  assert.match(s.generated_at, /^24\/11\/2026 12:02:00 ET$/);
});

test("pruneUptime keeps 35 days of hourly rows and open incidents", async () => {
  const db = sqliteD1();
  db.db.prepare("INSERT INTO uptime_hourly (hour_ts, check_id, samples) VALUES (?, 'ca-site', 1)").run(NOW - HOURLY_RETENTION_MS - HOUR_MS);
  db.db.prepare("INSERT INTO uptime_hourly (hour_ts, check_id, samples) VALUES (?, 'ca-site', 1)").run(NOW - DAY_MS);
  db.db.prepare("INSERT INTO uptime_incidents (check_id, started_at, ended_at) VALUES ('ca-site', ?, ?)").run(NOW - 100 * DAY_MS, NOW - 99 * DAY_MS);
  db.db.prepare("INSERT INTO uptime_incidents (check_id, started_at, ended_at) VALUES ('ca-site', ?, NULL)").run(NOW - 100 * DAY_MS);
  await pruneUptime({ ACCESS_LOG: db }, { now: NOW });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM uptime_hourly").get().n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM uptime_incidents").get().n, 1);
});

test("runScheduled routes the daily cron to pruning and */5 to uptime", async () => {
  const db = sqliteD1();
  const env = { ACCESS_LOG: db };
  const minute = await runScheduled("*/5 * * * *", env, { now: NOW, fetcher: fetcherWith() });
  assert.equal(minute.kind, "minute");
  assert.equal(minute.results[0].ok, true);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM uptime_hourly").get().n, CHECKS.length);
  const daily = await runScheduled("15 9 * * *", env, { now: NOW });
  assert.equal(daily.kind, "prune");
  assert.deepEqual(daily.results, ["fulfilled", "fulfilled"]);
});

test("recordUptime and /api/uptime fail soft without the binding or migration", async () => {
  assert.equal((await recordUptime({}, { now: NOW })).ok, false);
  const { handlePublicUptime } = await import("../src/uptime.js");
  resetUptimeCache();
  const noTables = sqliteD1({ files: ["schema/access-log.sql"] });
  const res = await handlePublicUptime(new Request("https://x/api/uptime"), { ACCESS_LOG: noTables }, { now: NOW });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("formatDuration", () => {
  assert.equal(formatDuration(30 * 1000), "1m");
  assert.equal(formatDuration(65 * 60000), "1h 5m");
  assert.equal(formatDuration(DAY_MS + 2 * HOUR_MS), "1d 2h");
});

test("badges: shields endpoint schema for status and uptime", async () => {
  resetStatusCache();
  resetUptimeCache();
  assert.equal(resolveTarget("nope"), null);
  assert.equal(resolveTarget("us").kind, "group");
  assert.equal(resolveTarget("ca-canada").kind, "check");
  let res = await handleBadge(new Request("https://x/api/badge?target=us"), {}, { fetcher: fetcherWith() });
  let body = await res.json();
  assert.deepEqual(body, { schemaVersion: 1, label: "EAS US", message: "up (gated)", color: "green" });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  resetStatusCache();
  res = await handleBadge(new Request("https://x/api/badge?target=ca"), {}, { fetcher: fetcherWith({ down: new Set(["ca-active"]) }) });
  body = await res.json();
  assert.equal(body.message, "down");
  assert.equal(body.color, "red");
  res = await handleBadge(new Request("https://x/api/badge?metric=uptime24h"), {}, {});
  body = await res.json();
  assert.equal(body.message, "no data");
  res = await handleBadge(new Request("https://x/api/badge?metric=bogus"), {}, {});
  assert.equal(res.status, 400);
  assert.equal(uptimeBadge("EAS", "30d", 99.95).color, "brightgreen");
  assert.equal(uptimeBadge("EAS", "30d", 97).message, "97.00%");
  resetStatusCache();
});
