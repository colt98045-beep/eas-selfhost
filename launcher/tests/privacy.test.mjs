import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { isLockableLauncherPath } from "../src/maintenance.js";
import { isAdminPath } from "../src/access.js";

test("/privacy is generated from privacy/policy.html and is current", () => {
  // --check exits non-zero if any generated copy is stale (siblings are skipped if absent).
  execFileSync(process.execPath, ["scripts/sync-privacy.mjs", "--check"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const page = fs.readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");
  assert.match(page, /Effective date: 24\/11\/2026/);
  assert.match(page, /mailto:admin@example.com/);
  for (const w of ["30 days", "full IP address", "Cloudflare Access", "Turnstile", "PIPEDA", "GDPR", "California", "not legal advice"]) assert.ok(page.includes(w), w);
  assert.doesNotMatch(page, /<script/i, "no scripts, works under any CSP");
});

test("/privacy is never locked by maintenance and never behind Access", () => {
  for (const p of ["/privacy", "/privacy/", "/privacy.html"]) {
    assert.equal(isLockableLauncherPath(p), false, p);
    assert.equal(isAdminPath(p), false, p);
  }
});

test("launcher pages link to /privacy", () => {
  for (const f of ["index.html", "status.html"]) {
    assert.match(fs.readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8"), /href="\/privacy"/, f);
  }
});
