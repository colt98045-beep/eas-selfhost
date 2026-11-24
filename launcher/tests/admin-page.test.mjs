// Runs the real admin page scripts (public/js/admin.js + admin-extra.js) against
// admin.html's element ids in a tiny DOM stub, with mocked /api/admin/* responses.
// Catches load-order bugs such as reading `let logPage` before its declaration
// (TDZ), which left the Access log card empty on page load.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function makeElement(id) {
  const el = {
    id, innerHTML: "", textContent: "", value: "", checked: false, disabled: false, hidden: false,
    style: {}, dataset: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector() { return makeElement(""); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
    setAttribute() {},
    appendChild() {},
    focus() {},
    reset() {},
  };
  return el;
}

async function runAdmin({ failLogs = false } = {}) {
  const html = fs.readFileSync("public/admin.html", "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const els = new Map(ids.map((id) => [id, makeElement(id)]));
  for (const id of ["insRange"]) els.get(id).value = "24h";
  const errors = [];
  const fetched = [];
  const responses = {
    "/api/admin/me": { email: "admin@example.com" },
    "/api/admin/announcements": { announcements: [] },
    "/api/admin/maintenance": { sites: {}, schedule: [] },
    "/api/admin/admins": { admins: [], sync: {} },
    "/api/admin/logs": { summary: { us: 1, ca: 1, launcher: 0, total: 2 }, total: 2, pages: 1,
      logs: [{ ts_et: "24/11/2026 12:00:00 ET", site: "us", method: "GET", path: "/", status: 403, country: "US", gate: "challenged", ip: "203.0.113.7", ip_hash: "abc" }] },
    "/api/admin/logs/access-logins": { ok: true, configured: true, events: [] },
    "/api/admin/logs/stats": { total: 0, unique_visitors: 0, labels: [], series: {}, bucket: "hour", status_classes: {} },
  };
  const document = {
    getElementById: (id) => els.get(id) || null,
    querySelector: () => makeElement(""),
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent() { return true; },
    createElement: () => makeElement(""),
    body: makeElement("body"),
  };
  const fetch = async (url) => {
    const path = String(url).split("?")[0];
    fetched.push(String(url));
    if (failLogs && path === "/api/admin/logs") return new Response("{}", { status: 500 });
    const body = responses[path];
    return new Response(JSON.stringify(body || { error: "not mocked" }), { status: body ? 200 : 404 });
  };
  const context = vm.createContext({
    document, fetch, window: {}, console, URLSearchParams, Intl, Date, JSON, Math, Promise, Response,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    confirm: () => false, alert: () => {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    location: { reload() {} },
  });
  context.window = context;
  const onRejection = (err) => errors.push(err);
  process.on("unhandledRejection", onRejection);
  try {
    for (const file of ["public/js/admin.js", "public/js/admin-extra.js"]) {
      vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return { els, fetched, errors };
}

test("admin page loads every card on first load, including the access log", async () => {
  const { els, fetched, errors } = await runAdmin();
  assert.deepEqual(errors, []);
  for (const path of ["/api/admin/announcements", "/api/admin/maintenance", "/api/admin/admins", "/api/admin/logs?", "/api/admin/logs/access-logins", "/api/admin/logs/stats"]) {
    assert.ok(fetched.some((u) => u.startsWith(path)), `fetched ${path} on load (got ${fetched.join(", ")})`);
  }
  const table = els.get("logTable").innerHTML;
  assert.match(table, /<table>/, "access log table rendered");
  assert.match(table, /203\.0\.113\.7/, "IP shown");
  assert.doesNotMatch(table, /before initialization|is not defined/i);
  assert.match(els.get("logPager").innerHTML, /Page 1 of 1/);
});

test("a failing access log request shows an error in its own card only", async () => {
  const { els, errors } = await runAdmin({ failLogs: true });
  assert.deepEqual(errors, []);
  assert.match(els.get("logTable").innerHTML, /HTTP 500|error/i);
  assert.doesNotMatch(els.get("loginTable").innerHTML, /HTTP 500/);
});
