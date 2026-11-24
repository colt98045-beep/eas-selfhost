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

async function runAdmin({ failLogs = false, failPut = false } = {}) {
  const html = fs.readFileSync("public/admin.html", "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const els = new Map(ids.map((id) => [id, makeElement(id)]));
  for (const id of ["insRange"]) els.get(id).value = "24h";
  const errors = [];
  const fetched = [];
  const calls = [];
  const responses = {
    "/api/admin/me": { email: "admin@example.com" },
    "/api/admin/announcements": { announcements: [] },
    "/api/admin/maintenance": { sites: {}, schedule: [] },
    "/api/admin/admins": { admins: [], sync: {} },
    "/api/admin/logs": { summary: { us: 1, ca: 1, launcher: 0, total: 2 }, total: 2, pages: 1,
      logs: [{ ts_et: "24/11/2026 12:00:00 ET", site: "us", method: "GET", path: "/", status: 403, country: "US", gate: "challenged", ip: "203.0.113.7", ip_hash: "abc" }] },
    "/api/admin/logs/access-logins": { ok: true, configured: true, events: [] },
    "/api/admin/logs/stats": { total: 0, unique_visitors: 0, labels: [], series: {}, bucket: "hour", status_classes: {} },
    "/api/admin/incidents": { me: "admin@example.com", updates_enabled: true, active: [], recent: [] },
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
  const fetch = async (url, options = {}) => {
    const path = String(url).split("?")[0];
    fetched.push(String(url));
    calls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (options.method === "PUT" && path === "/api/admin/maintenance") {
      if (failPut) return new Response(JSON.stringify({ error: "KV write failed" }), { status: 500 });
      return new Response(JSON.stringify({ sites: { us: { on: false, label: "US" } }, schedule: [] }), { status: 200 });
    }
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
    for (const file of ["public/js/admin.js", "public/js/admin-extra.js", "public/js/admin-incidents.js"]) {
      vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return { els, fetched, errors, calls };
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

// Fake site card for the Maintenance grid: a locked US form whose switch was just turned off.
function lockedForm({ checked = false } = {}) {
  const parts = {
    '[name="message"]': { value: "API Down" }, '[name="eta"]': { value: "" },
    '[name="reason"]': { value: "outage" }, '[name="reason_text"]': { value: "" },
    ".toggle-state": { textContent: "" }, "button[type='submit']": { textContent: "", disabled: false },
    'input[name="on"]': null,
  };
  const toggle = { name: "on", checked };
  parts['input[name="on"]'] = toggle;
  const form = {
    classList: { toggle() {} },
    getAttribute: (k) => ({ "data-site": "us", "data-was-on": "1" })[k] ?? null,
    querySelector: (sel) => parts[sel] || { value: "" },
  };
  toggle.closest = () => form;
  return { form, toggle, parts };
}

test("switching a locked site to Open saves the unlock straight away", async () => {
  const { els, calls } = await runAdmin();
  const { toggle, parts } = lockedForm();
  const ok = await els.get("maintGrid").listeners.change[0]({ target: toggle });
  assert.equal(ok, true);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "PUT sent without pressing the button");
  assert.equal(put.path, "/api/admin/maintenance");
  assert.equal(put.body.site, "us");
  assert.equal(put.body.on, false);
  assert.equal(els.get("maintError").textContent, "");
  assert.notEqual(parts["button[type='submit']"].textContent, "Lock site");
});

test("a failed unlock shows an error and flips the switch back to Locked", async () => {
  const { els } = await runAdmin({ failPut: true });
  const { toggle, parts } = lockedForm();
  const ok = await els.get("maintGrid").listeners.change[0]({ target: toggle });
  assert.equal(ok, false);
  assert.match(els.get("maintError").textContent, /Not saved: KV write failed/);
  assert.equal(toggle.checked, true);
  assert.equal(parts[".toggle-state"].textContent, "Locked");
  assert.equal(parts["button[type='submit']"].textContent, "Update lockout");
});

test("button labels match the action", () => {
  const src = fs.readFileSync("public/js/admin.js", "utf8");
  const fn = new Function(src.match(/function maintButtonLabel[\s\S]*?\n  \}/)[0] + "; return maintButtonLabel;")();
  assert.equal(fn(true, true), "Update lockout");
  assert.equal(fn(true, false), "Unlock site");
  assert.equal(fn(false, true), "Lock site");
  assert.notEqual(fn(false, false), "Lock site");
});

test("turning a lock on does not save until the button is pressed", async () => {
  const { els, calls } = await runAdmin();
  const { form, toggle } = lockedForm({ checked: true });
  form.getAttribute = (k) => ({ "data-site": "ca", "data-was-on": "0" })[k] ?? null;
  await els.get("maintGrid").listeners.change[0]({ target: toggle });
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});
