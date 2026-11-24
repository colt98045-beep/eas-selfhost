// CA Worker routes: /api/canada and /api/active proxy GeoMet; other /api/* is 404;
// everything else is served from ASSETS. Mocked upstream, no network.
import worker from "../src/index.js";
import fs from "node:fs";
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const base = "https://eas-repository-ca.your-subdomain.workers.dev";
let upstream = [];
globalThis.fetch = async (u) => { upstream.push(String(u)); return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { headers: { "content-type": "application/geo+json" } }); };
const env = { ASSETS: { fetch: async (r) => new Response("ASSET " + new URL(r.url).pathname, { headers: { "content-type": "text/html" } }) } };
const get = (p, init) => worker.fetch(new Request(base + p, init), env, { waitUntil() {} });

for (const p of ["/api/canada", "/api/active"]) {
  const r = await get(p);
  const body = await r.json();
  ok(r.status === 200 && body.type === "FeatureCollection", `${p} -> 200 GeoJSON`);
  ok(r.headers.get("access-control-allow-origin") === "*", `${p} CORS *`);
  ok(r.headers.get("x-content-type-options") === "nosniff", `${p} nosniff`);
}
ok(upstream.every((u) => u.startsWith("https://api.weather.gc.ca/collections/weather-alerts/items")), "upstream is GeoMet only");
let r = await get("/api/nope"); ok(r.status === 404, "unknown /api/* -> 404");
r = await get("/api/canada", { method: "POST" }); ok(r.status === 501, "POST /api/canada -> 501");
r = await get("/"); ok((await r.text()) === "ASSET /", "/ served from ASSETS");
r = await get("/privacy"); ok((await r.text()) === "ASSET /privacy", "/privacy served from ASSETS");
ok(r.headers.get("strict-transport-security") === "max-age=31536000", "HSTS on assets");

const ignore = fs.readFileSync(".assetsignore", "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
ok(ignore[0] === "*" && ignore.slice(1).sort().join(",") === "!index.html,!manifest.json,!privacy.html,!sw.js", ".assetsignore publishes only the web app files");
const cfg = fs.readFileSync("wrangler.jsonc", "utf8");
ok(/"main":\s*"src\/index\.js"/.test(cfg) && /"run_worker_first":\s*true/.test(cfg) && /"binding":\s*"ACCESS_LOG"/.test(cfg), "wrangler.jsonc keeps main, run_worker_first and ACCESS_LOG");
if (!process.exitCode) console.log("CA worker route tests passed");
