// The launcher sends CSP script-src 'self', so pages must not use inline
// scripts or inline event handlers, and every script they load must exist.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CSP, withSecurityHeaders } from "../src/headers.js";
import { maintenancePageResponse } from "../src/maintenance.js";

const pages = ["index.html", "status.html", "admin.html", "privacy.html"];

test("pages have no inline scripts or inline handlers, and their scripts exist", () => {
  for (const name of pages) {
    const html = fs.readFileSync(`public/${name}`, "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name} has an inline <script>`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${name} has an inline event handler`);
    for (const [, src] of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
      assert.ok(src.startsWith("/"), `${name} loads a cross-origin script ${src}`);
      assert.ok(fs.existsSync(`public${src}`), `${name} references missing ${src}`);
    }
  }
});

test("maintenance page has no inline script", async () => {
  const html = await maintenancePageResponse({ on: true, message: "x", eta: null }).text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
});

test("CSP is strict and applied without overriding stricter handler headers", () => {
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.match(CSP, /frame-ancestors 'none'/);
  const res = withSecurityHeaders(new Response("x", { headers: { "referrer-policy": "no-referrer" } }));
  assert.equal(res.headers.get("content-security-policy"), CSP);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("wrangler.jsonc has the daily prune and the 5-minute uptime crons", () => {
  const src = fs.readFileSync("wrangler.jsonc", "utf8");
  assert.match(src, /"crons":\s*\[\s*"15 9 \* \* \*",\s*"\*\/5 \* \* \* \*"\s*\]/);
});
