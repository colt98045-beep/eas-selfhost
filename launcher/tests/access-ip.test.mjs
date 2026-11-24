// Full client IP in the visit log and the Access login events.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { clientIp, writeAccessLog, parseLogFilters, queryAccessLogs } from "../src/access-log.js";
import { fetchAccessLogins } from "../src/access-sync.js";

function d1(sqlFiles) {
  const db = new DatabaseSync(":memory:");
  for (const f of sqlFiles) db.exec(fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() { db.prepare(sql).run(...args); return { success: true }; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) || null; },
  });
  return { db, prepare: (sql) => stmt(sql) };
}

const NOW = Date.parse("2026-11-24T17:00:00.000Z");

test("clientIp takes CF-Connecting-IP only and rejects junk", () => {
  assert.equal(clientIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "203.0.113.7" } })), "203.0.113.7");
  assert.equal(clientIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "2001:db8::1" } })), "2001:db8::1");
  assert.equal(clientIp(new Request("https://x/", { headers: { "X-Forwarded-For": "198.51.100.1" } })), null);
  assert.equal(clientIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "<script>" } })), null);
});

test("migration 0002 adds ip to an existing database, and fresh schema has it", () => {
  // Simulate the pre-migration table, then apply the migration.
  const old = fs.readFileSync(new URL("../schema/access-log.sql", import.meta.url), "utf8")
    .replace("  ip TEXT,\n", "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_access_logs_ip_ts[^\n]*\n/, "");
  const db = new DatabaseSync(":memory:");
  db.exec(old);
  assert.ok(!db.prepare("PRAGMA table_info(access_logs)").all().some((c) => c.name === "ip"));
  db.exec(fs.readFileSync(new URL("../schema/migrations/0002_add_ip.sql", import.meta.url), "utf8"));
  assert.ok(db.prepare("PRAGMA table_info(access_logs)").all().some((c) => c.name === "ip"));
  const fresh = d1(["schema/access-log.sql"]);
  assert.ok(fresh.db.prepare("PRAGMA table_info(access_logs)").all().some((c) => c.name === "ip"));
});

test("visit log stores ip and ip_hash, and filters by IP prefix", async () => {
  const ACCESS_LOG = d1(["schema/access-log.sql"]);
  const env = { ACCESS_LOG, ACCESS_LOG_SALT: "salt" };
  for (const [ip, path] of [["203.0.113.7", "/"], ["203.0.113.9", "/api/active"], ["198.51.100.2", "/"]]) {
    const req = new Request(`https://eas-launcher.your-subdomain.workers.dev${path}`, { headers: { "CF-Connecting-IP": ip, "user-agent": "UA" } });
    assert.equal(await writeAccessLog(env, req, new Response("ok"), { site: "launcher", now: NOW - 1000 }), true);
  }
  const all = await queryAccessLogs(env, parseLogFilters(new URL("https://x/api/admin/logs"), { now: NOW }));
  assert.equal(all.total, 3);
  assert.ok(all.logs.every((r) => r.ip && r.ip_hash && r.ip_hash.length === 12));
  assert.equal(all.logs.find((r) => r.ip === "198.51.100.2").user_agent, "UA");
  const some = await queryAccessLogs(env, parseLogFilters(new URL("https://x/api/admin/logs?ip=203.0.113."), { now: NOW }));
  assert.equal(some.total, 2);
  assert.equal(some.filters.ip, "203.0.113.");
  const one = await queryAccessLogs(env, parseLogFilters(new URL("https://x/api/admin/logs?ip=198.51.100.2"), { now: NOW }));
  assert.deepEqual(one.logs.map((r) => r.ip), ["198.51.100.2"]);
  // LIKE wildcards in the filter are literal.
  const none = await queryAccessLogs(env, parseLogFilters(new URL("https://x/api/admin/logs?ip=%25"), { now: NOW }));
  assert.equal(none.total, 0);
});

test("Access login events include ip_address", async () => {
  const env = { CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  const fetcher = async () =>
    new Response(JSON.stringify({ success: true, result: [{ created_at: "2026-11-24T16:59:00Z", user_email: "admin@example.com", allowed: true, ip_address: "203.0.113.7", country: "us" }] }), { status: 200 });
  const out = await fetchAccessLogins(env, { fetcher });
  assert.equal(out.ok, true);
  assert.equal(out.events[0].ip, "203.0.113.7");
});

test("writes still succeed on a database that has not run 0002_add_ip.sql yet", async () => {
  const ACCESS_LOG = d1([]);
  const old = fs.readFileSync(new URL("../schema/access-log.sql", import.meta.url), "utf8")
    .replace("  ip TEXT,\n", "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_access_logs_ip_ts[^\n]*\n/, "");
  ACCESS_LOG.db.exec(old);
  const req = new Request("https://x/", { headers: { "CF-Connecting-IP": "203.0.113.7" } });
  assert.equal(await writeAccessLog({ ACCESS_LOG, ACCESS_LOG_SALT: "s" }, req, new Response("ok"), { site: "ca", now: NOW }), true);
  assert.equal(ACCESS_LOG.db.prepare("SELECT COUNT(*) AS n FROM access_logs").get().n, 1);
});

// Reading the log before migration 0002 must not fail (launcher may deploy first).
{
  const { queryAccessLogs } = await import("../src/access-log.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE access_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, site TEXT NOT NULL,
    method TEXT, path TEXT, status INTEGER, country TEXT, ip_hash TEXT, user_agent TEXT, gate TEXT)`);
  db.prepare("INSERT INTO access_logs (ts, site, method, path, status, country, ip_hash, user_agent, gate) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(Date.now(), "us", "GET", "/", 403, "CA", "h", "ua", "challenged");
  const d1 = { prepare(sql) { const st = { args: [], bind(...a) { st.args = a; return st; },
    async first() { return db.prepare(sql).get(...st.args); }, async all() { return { results: db.prepare(sql).all(...st.args) }; } }; return st; } };
  const now = Date.now();
  const out = await queryAccessLogs({ ACCESS_LOG: d1 }, { from: now - 86400000, to: now + 1000, page: 1, limit: 50, ip: "203.0." , site: null, path: null, status: null });
  const rows = out.rows || out.results || out.logs || [];
  const ok = !out.error && out.ip_column_missing === true && out.total === 1;
  console.log((ok ? "PASS " : "FAIL ") + "query falls back when the ip column is missing (ip filter ignored, ip null)");
  if (!ok) { console.log(JSON.stringify(out).slice(0, 400)); process.exitCode = 1; }
}
