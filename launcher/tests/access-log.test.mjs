import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXCLUDE,
  handleAdminLogs,
  hashIp,
  logRequest,
  parseLogFilters,
  pruneAccessLogs,
  shouldLogPath,
  usGateOutcome,
  writeAccessLog,
  RETENTION_MS,
} from "../src/access-log.js";

function memoryD1(seed = []) {
  const rows = seed.slice();
  const audit = [];
  return {
    rows,
    audit,
    prepare(sql) {
      const source = String(sql);
      return {
        bind(...args) {
          return {
            async run() {
              if (/INSERT INTO access_logs/.test(source)) {
                const [ts, site, method, path, status, country, ip_hash, ip, user_agent, gate] = args;
                rows.push({ id: rows.length + 1, ts, site, method, path, status, country, ip_hash, ip, user_agent, gate });
              }
              if (/DELETE FROM access_logs/.test(source)) {
                const cutoff = args[0];
                const keep = rows.filter((r) => r.ts >= cutoff);
                rows.length = 0;
                rows.push(...keep);
              }
              if (/DELETE FROM admin_audit/.test(source)) {
                const cutoff = args[0];
                const keep = audit.filter((r) => r.ts >= cutoff);
                audit.length = 0;
                audit.push(...keep);
              }
              return { success: true };
            },
            async first() {
              if (/COUNT\(\*\)/.test(source)) {
                return { n: filter(source, args, rows).length };
              }
              return null;
            },
            async all() {
              if (/GROUP BY site/.test(source)) {
                const from = args[0], to = args[1];
                const counts = {};
                for (const row of rows) {
                  if (row.ts >= from && row.ts <= to) counts[row.site] = (counts[row.site] || 0) + 1;
                }
                return { results: Object.entries(counts).map(([site, n]) => ({ site, n })) };
              }
              const found = filter(source, args, rows).sort((a, b) => b.ts - a.ts || b.id - a.id);
              let limit = found.length, offset = 0;
              if (/LIMIT \? OFFSET \?/.test(source)) {
                limit = args[args.length - 2];
                offset = args[args.length - 1];
              }
              return { results: found.slice(offset, offset + limit) };
            },
          };
        },
      };
    },
  };
}

function filter(sql, args, rows) {
  // Test helper: apply the bound predicates used by queryAccessLogs.
  let site, path, status, from, to;
  from = args[0];
  to = args[1];
  let i = 2;
  if (sql.includes("site = ?")) site = args[i++];
  if (sql.includes("path LIKE ?")) path = args[i++];
  if (sql.includes("status = ?")) status = args[i++];
  return rows.filter((row) => {
    if (row.ts < from || row.ts > to) return false;
    if (site && row.site !== site) return false;
    if (status !== undefined && !sql.includes("COUNT") && sql.includes("status = ?") && row.status !== status) return false;
    if (path) {
      const needle = String(path).replace(/^%/, "").replace(/%$/, "");
      if (!row.path.includes(needle)) return false;
    }
    return true;
  });
}

test("noisy paths are excluded by default and can be overridden", () => {
  for (const path of DEFAULT_EXCLUDE) assert.equal(shouldLogPath(path), false, path);
  assert.equal(shouldLogPath("/"), true);
  assert.equal(shouldLogPath("/admin"), true);
  assert.equal(shouldLogPath("/api/active"), true);
  assert.equal(shouldLogPath("/sw.js", { ACCESS_LOG_EXCLUDE: "/favicon.ico" }), true);
  assert.equal(shouldLogPath("/favicon.ico", { ACCESS_LOG_EXCLUDE: "/favicon.ico" }), false);
});

test("hashIp is a salted SHA-256 prefix and is null without a salt", async () => {
  const a = await hashIp("1.2.3.4", "salt-a");
  const b = await hashIp("1.2.3.4", "salt-b");
  const again = await hashIp("1.2.3.4", "salt-a");
  assert.equal(a.length, 12);
  assert.notEqual(a, b);
  assert.equal(a, again);
  assert.equal(await hashIp("1.2.3.4", ""), null);
  assert.equal(await hashIp("", "salt-a"), null);
});

test("usGateOutcome labels challenge, API and passed responses", () => {
  const html = new Headers({ "content-type": "text/html" });
  const json = new Headers({ "content-type": "application/json" });
  assert.equal(usGateOutcome(new Request("https://x/"), new Response("c", { status: 403, headers: html })), "challenged");
  assert.equal(usGateOutcome(new Request("https://x/api/active"), new Response("{}", { status: 200, headers: json })), "api");
  assert.equal(usGateOutcome(new Request("https://x/"), new Response("ok", { status: 200, headers: html })), "passed");
});

test("writeAccessLog and the admin query support filters, summary and pagination", async () => {
  const now = Date.parse("2026-11-24T15:30:00.000Z");
  const db = memoryD1();
  const env = { ACCESS_LOG: db, ACCESS_LOG_SALT: "test-salt" };
  const req = new Request("https://eas-launcher.your-subdomain.workers.dev/status", {
    headers: { "user-agent": "TestAgent", "CF-Connecting-IP": "1.2.3.4", "CF-IPCountry": "US" },
  });
  req.cf = { country: "US" };
  const logged = await writeAccessLog(env, req, new Response("ok", { status: 200 }), { site: "launcher", now });
  assert.equal(logged, true);
  await writeAccessLog(env, new Request("https://x/api/active"), new Response("{}", { status: 200 }), { site: "us", gate: "api", now: now - 1000 });
  await writeAccessLog(env, new Request("https://x/api/status"), new Response("{}", { status: 200 }), { site: "launcher", now });
  assert.equal(db.rows.some((r) => r.path === "/api/status"), false);
  assert.equal(db.rows[0].ip_hash.length, 12);
  assert.equal(db.rows[0].path, "/status");

  const res = await handleAdminLogs(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/logs?site=launcher&path=/status&page=1&limit=10"),
    env,
    { now },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 1);
  assert.equal(body.logs[0].path, "/status");
  assert.equal(body.logs[0].ts_et, "24/11/2026 10:30:00 ET");
  assert.equal(body.summary.launcher, 1);
  assert.equal(body.summary.us, 1);
});

test("a throwing logger scheduled via logRequest does not reject", async () => {
  const calls = [];
  const ctx = { waitUntil(p) { calls.push(p); } };
  logRequest(ctx, { ACCESS_LOG: { prepare() { throw new Error("d1"); } } }, new Request("https://x/"), new Response("ok"), { site: "launcher" });
  assert.equal(calls.length, 1);
  await assert.doesNotReject(calls[0]);
});

test("pruneAccessLogs deletes rows older than 30 days", async () => {
  const now = Date.parse("2026-11-24T15:30:00.000Z");
  const db = memoryD1([
    { id: 1, ts: now - RETENTION_MS - 1000, site: "us", method: "GET", path: "/", status: 200 },
    { id: 2, ts: now - 1000, site: "us", method: "GET", path: "/", status: 200 },
  ]);
  const result = await pruneAccessLogs({ ACCESS_LOG: db }, { now });
  assert.equal(result.ok, true);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].id, 2);
});

test("parseLogFilters rejects a bad site and defaults the window to 24 hours", () => {
  const now = Date.parse("2026-11-24T15:30:00.000Z");
  const bad = parseLogFilters(new URL("https://x/api/admin/logs?site=mx"), { now });
  assert.match(bad.error, /site/);
  const ok = parseLogFilters(new URL("https://x/api/admin/logs"), { now });
  assert.equal(ok.from, now - 24 * 60 * 60 * 1000);
  assert.equal(ok.to, now);
  assert.equal(ok.page, 1);
});
