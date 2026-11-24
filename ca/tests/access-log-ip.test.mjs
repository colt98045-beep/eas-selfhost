// Full client IP (CF-Connecting-IP) is written next to ip_hash, and logging
// still works on a database that has not run 0002_add_ip.sql yet.
import { writeAccessLog, clientIp } from "../src/access-log.js";

const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

function fakeD1({ hasIp }) {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (/\bip,/.test(sql) && !hasIp) throw new Error("D1_ERROR: table access_logs has no column named ip: SQLITE_ERROR");
              rows.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

const req = () => new Request("https://example.workers.dev/", { headers: { "CF-Connecting-IP": "203.0.113.7", "user-agent": "UA" } });

ok(clientIp(req()) === "203.0.113.7", "clientIp reads CF-Connecting-IP");
ok(clientIp(new Request("https://x/", { headers: { "X-Forwarded-For": "198.51.100.1" } })) === null, "clientIp ignores X-Forwarded-For");

let db = fakeD1({ hasIp: true });
await writeAccessLog({ ACCESS_LOG: db, ACCESS_LOG_SALT: "s" }, req(), new Response("ok"), { site: "test" });
ok(db.rows.length === 1 && db.rows[0].args[7] === "203.0.113.7" && typeof db.rows[0].args[6] === "string" && db.rows[0].args[8] === "UA", "ip stored next to ip_hash");

db = fakeD1({ hasIp: false });
await writeAccessLog({ ACCESS_LOG: db, ACCESS_LOG_SALT: "s" }, req(), new Response("ok"), { site: "test" });
ok(db.rows.length === 1 && !/\bip,/.test(db.rows[0].sql) && db.rows[0].args[7] === "UA", "falls back to the old insert before the migration");

if (!process.exitCode) console.log("access-log ip tests passed");
