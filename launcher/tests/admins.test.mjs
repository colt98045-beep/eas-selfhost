import test from "node:test";
import assert from "node:assert/strict";
import { handleAdminUsers, PERMANENT_ADMIN, isValidEmail, allowedAdminEmails } from "../src/admins.js";
import { syncAccessPolicy, fetchAccessLogins, accessSyncConfigured } from "../src/access-sync.js";

function memoryKv(values = {}) {
  const map = new Map(Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    async get(key, type) {
      const value = map.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      map.set(key, value);
    },
    map,
  };
}

function memoryD1() {
  const audit = [];
  return {
    audit,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (/INSERT INTO admin_audit/.test(sql)) {
                audit.push({ ts: args[0], actor: args[1], action: args[2], email: args[3] });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function env(overrides = {}) {
  return {
    ANNOUNCEMENTS: memoryKv(),
    ACCESS_LOG: memoryD1(),
    CF_ACCESS_ALLOWED_EMAILS: PERMANENT_ADMIN,
    ...overrides,
  };
}

const actor = { email: PERMANENT_ADMIN };

test("isValidEmail accepts normal addresses and rejects junk", () => {
  assert.equal(isValidEmail("Admin@Example.com"), true);
  assert.equal(isValidEmail("bad"), false);
  assert.equal(isValidEmail(""), false);
});

test("allowedAdminEmails always includes the permanent admin, even if KV fails", async () => {
  const list = await allowedAdminEmails(env({ ANNOUNCEMENTS: { async get() { throw new Error("nope"); } } }));
  assert.ok(list.includes(PERMANENT_ADMIN));
});

test("admin API adds and removes emails, and refuses to remove the permanent admin", async () => {
  const e = env();
  const created = await handleAdminUsers(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/admins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "New.Admin@example.com" }),
    }),
    e,
    actor,
  );
  assert.equal(created.status, 201);
  const added = await created.json();
  assert.ok(added.admins.some((a) => a.email === "new.admin@example.com"));
  assert.equal(added.access_sync.configured, false);
  assert.match(added.sync.note, /Cloudflare Access/);
  assert.equal(e.ACCESS_LOG.audit[0].action, "add");
  assert.equal(e.ACCESS_LOG.audit[0].email, "new.admin@example.com");

  const blocked = await handleAdminUsers(
    new Request(`https://eas-launcher.your-subdomain.workers.dev/api/admin/admins?email=${PERMANENT_ADMIN}`, { method: "DELETE" }),
    e,
    actor,
  );
  assert.equal(blocked.status, 403);
  const listed = await handleAdminUsers(new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/admins"), e, actor);
  const names = (await listed.json()).admins.map((a) => a.email);
  assert.ok(names.includes(PERMANENT_ADMIN));

  const removed = await handleAdminUsers(
    new Request("https://eas-launcher.your-subdomain.workers.dev/api/admin/admins?email=new.admin@example.com", { method: "DELETE" }),
    e,
    actor,
  );
  assert.equal(removed.status, 200);
  assert.equal(e.ACCESS_LOG.audit.at(-1).action, "remove");
});

test("syncAccessPolicy updates the allow list and never drops the permanent admin", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.includes("/policies") && init.method === "GET" || (url.endsWith("/policies") && (!init.method || init.method === "GET"))) {
      return new Response(JSON.stringify({
        success: true,
        result: [{
          id: "55555555-5555-4555-8555-555555555555",
          decision: "allow",
          name: "Allow admin@example.com only",
          include: [{ email: { email: PERMANENT_ADMIN } }],
          exclude: [],
          require: [],
          precedence: 1,
        }],
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true, result: { id: "55555555-5555-4555-8555-555555555555" } }), { headers: { "content-type": "application/json" } });
  };
  const base = {
    CF_API_TOKEN: "token",
    CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CF_ACCESS_APP_ID: "00000000-0000-4000-8000-000000000000",
  };
  const result = await syncAccessPolicy(base, ["other@example.com"], { fetcher });
  assert.equal(result.ok, true);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put);
  const body = JSON.parse(put.body);
  const emails = body.include.map((r) => r.email.email);
  assert.ok(emails.includes(PERMANENT_ADMIN));
  assert.ok(emails.includes("other@example.com"));

  const empty = await syncAccessPolicy({ CF_ACCOUNT_ID: "x" }, ["a@b.com"], { fetcher });
  assert.equal(empty.configured, false);
  assert.equal(accessSyncConfigured({}), false);
});

test("fetchAccessLogins degrades when the token is missing and maps events when present", async () => {
  const missing = await fetchAccessLogins({});
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.events, []);
  assert.match(missing.note, /CF_API_TOKEN/);

  const fetcher = async (url) => {
    assert.match(url, /access_requests/);
    assert.match(url, /app_uid=00000000-0000-4000-8000-000000000000/);
    return new Response(JSON.stringify({
      success: true,
      result: [{ created_at: "2026-11-24T16:00:00.000Z", user_email: PERMANENT_ADMIN, allowed: true, country: "US", app_name: "EAS Launcher Admin" }],
    }), { headers: { "content-type": "application/json" } });
  };
  const got = await fetchAccessLogins(
    { CF_API_TOKEN: "token", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_ACCESS_APP_ID: "00000000-0000-4000-8000-000000000000" },
    { fetcher },
  );
  assert.equal(got.ok, true);
  assert.equal(got.events[0].email, PERMANENT_ADMIN);
  assert.equal(got.events[0].allowed, true);
});
