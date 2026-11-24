import test from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  formatEt,
  isGateResponse,
  probe,
  buildStatus,
  CHECKS,
  US_ORIGIN,
  CA_ORIGIN,
  LAUNCHER_ORIGIN,
} from "../src/status.js";

const GATE_HTML = `<!doctype html><title>Checking your browser…</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
<div class="cf-turnstile" data-sitekey="0xTEST"></div>
<h1>Quick check before you continue</h1>`;

test("formatEt uses DD/MM/YYYY and 24-hour ET", () => {
  // 24/11/2026 15:30:00 UTC is 10:30:00 ET (UTC-5).
  const text = formatEt(new Date("2026-11-24T15:30:00.000Z"));
  assert.equal(text, "24/11/2026 10:30:00 ET");
});

test("isGateResponse detects a Turnstile 403 challenge", () => {
  assert.equal(
    isGateResponse({
      status: 403,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "script-src https://challenges.cloudflare.com",
      },
      body: GATE_HTML,
    }),
    true,
  );
});

test("isGateResponse can use CSP alone on a 403 HTML response", () => {
  assert.equal(
    isGateResponse({
      status: 403,
      headers: {
        "content-type": "text/html",
        "content-security-policy": "frame-src https://challenges.cloudflare.com",
      },
      body: "",
    }),
    true,
  );
});

test("isGateResponse does not treat a plain 403 or 200 JSON as gated", () => {
  assert.equal(isGateResponse({ status: 403, headers: { "content-type": "text/plain" }, body: "Forbidden" }), false);
  assert.equal(
    isGateResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"type":"FeatureCollection","features":[]}',
    }),
    false,
  );
});

test("classify labels gate, up, timeout, and 1042 honestly", () => {
  const gated = classify({ status: 403, headers: { "content-type": "text/html" }, body: GATE_HTML });
  assert.equal(gated.state, "gated");
  assert.equal(gated.label, "Up, gated");

  const up = classify({ status: 200, headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(up.state, "up");
  assert.equal(up.label, "Up");

  const timeout = classify({ error: "The operation was aborted due to timeout" });
  assert.equal(timeout.state, "down");
  assert.match(timeout.label, /timeout/i);

  const blocked = classify({ error: "Error 1042: could not fetch workers.dev" });
  assert.equal(blocked.state, "down");
  assert.match(blocked.label, /1042/);
  assert.match(blocked.detail, /global_fetch_strictly_public/);

  const missing = classify({ status: 404, headers: { "content-type": "text/plain" }, body: "Not Found" });
  assert.equal(missing.state, "down");
  assert.equal(missing.label, "Down (404)");
});

test("CHECKS cover US, CA, and the launcher, including a state NOAA sample", () => {
  const ids = CHECKS.map((c) => c.id);
  assert.deepEqual(ids, [
    "us-site",
    "us-active",
    "us-noaa",
    "us-nws",
    "us-noaa-ny",
    "ca-site",
    "ca-canada",
    "ca-active",
    "launcher-site",
  ]);
  assert.equal(CHECKS.find((c) => c.id === "us-noaa-ny").url, `${US_ORIGIN}/api/noaa/NY`);
  assert.equal(CHECKS.find((c) => c.id === "ca-canada").url, `${CA_ORIGIN}/api/canada`);
  assert.equal(CHECKS.find((c) => c.id === "launcher-site").url, `${LAUNCHER_ORIGIN}/`);
  assert.ok(!CHECKS.some((c) => c.url.includes("/api/status")), "must not recurse into /api/status");
});

test("probe peeks HTML for a gate and cancels large JSON bodies", async () => {
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith("/api/active")) {
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(GATE_HTML, {
      status: 403,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "script-src https://challenges.cloudflare.com",
      },
    });
  };

  const gated = await probe(`${US_ORIGIN}/`, fetcher);
  assert.equal(gated.state, "gated");
  assert.equal(gated.status, 403);
  assert.ok(typeof gated.latency_ms === "number");

  const up = await probe(`${CA_ORIGIN}/api/active`, fetcher);
  assert.equal(up.state, "up");
  assert.equal(up.status, 200);
  assert.equal(calls[0].opts.redirect, "manual");
  assert.equal(calls[0].opts.headers["User-Agent"], "EAS-Launcher-Status/1.0");
});

test("buildStatus groups results and sets overall to gated when US is gated and the rest are up", async () => {
  const fetcher = async (url) => {
    if (url.startsWith(US_ORIGIN)) {
      return new Response(GATE_HTML, {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("<!doctype html><title>ok</title>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  const payload = await buildStatus({ fetcher, now: new Date("2026-11-24T15:30:00.000Z") });
  assert.equal(payload.checked_at, "24/11/2026 10:30:00 ET");
  assert.equal(payload.overall, "gated");
  assert.equal(payload.fetch_mode, "global_fetch_strictly_public");
  assert.equal(payload.groups[0].state, "gated");
  assert.equal(payload.groups[1].state, "up");
  assert.equal(payload.groups[2].state, "up");
  assert.ok(payload.groups.every((g) => g.checks.length > 0));
});
