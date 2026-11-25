// CA Worker routes: /api/canada and /api/active proxy GeoMet with 90s caching;
// other /api/* is 404; everything else is served from ASSETS. Mocked upstream, no network.
import worker from "../src/index.js";
import fs from "node:fs";
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const base = "https://eas-repository-ca.your-subdomain.workers.dev";
let upstream = [];
globalThis.fetch = async (u, init = {}) => {
  upstream.push({ url: String(u), headers: init.headers || {}, cf: init.cf || {} });
  return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
    headers: { "content-type": "application/geo+json" },
  });
};
const cacheStore = new Map();
let cacheMatches = 0;
let cachePuts = 0;
globalThis.caches = {
  default: {
    async match(req) {
      cacheMatches++;
      const key = typeof req === "string" ? req : req.url;
      const hit = cacheStore.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) {
      cachePuts++;
      const key = typeof req === "string" ? req : req.url;
      cacheStore.set(key, res.clone());
    },
  },
};

const env = { ASSETS: { fetch: async (r) => new Response("ASSET " + new URL(r.url).pathname, { headers: { "content-type": "text/html" } }) } };
const get = (p, init) => worker.fetch(new Request(base + p, init), env, { waitUntil() {} });

for (const p of ["/api/canada", "/api/active"]) {
  const r = await get(p, { headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } });
  const body = await r.json();
  ok(r.status === 200 && body.type === "FeatureCollection", `${p} -> 200 GeoJSON`);
  ok(r.headers.get("access-control-allow-origin") === "*", `${p} CORS *`);
  ok(r.headers.get("x-content-type-options") === "nosniff", `${p} nosniff`);
  ok(r.headers.get("cache-control") === "public, max-age=90", `${p} Cache-Control public, max-age=90`);
}
ok(upstream.length === 1, "second default GeoMet request served from cache (1 upstream call)");
ok(upstream.every((u) => u.url.startsWith("https://api.weather.gc.ca/collections/weather-alerts/items")), "upstream is GeoMet only");
const firstHeaders = Object.fromEntries(Object.entries(upstream[0].headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
ok(firstHeaders["user-agent"]?.includes("https://github.com/your-github-user/eas-repository-ca"), "upstream User-Agent includes CA repo URL");
ok(!("cache-control" in firstHeaders) && !("pragma" in firstHeaders), "upstream fetch never sends no-cache or Pragma headers");
ok(cachePuts === 1, "GeoMet response stored in caches.default");

// Pre-seed caches.default for a query not in memCache to test Cache API hit path
const seededUrl = "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=25";
cacheStore.set(seededUrl, new Response(JSON.stringify({ type: "FeatureCollection", features: [{ id: "cached" }] }), {
  status: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=90" },
}));
const beforeCalls = upstream.length;
const seededRes = await get("/api/canada?f=json&limit=25");
const seededBody = await seededRes.json();
ok(seededRes.status === 200 && seededBody.features?.[0]?.id === "cached", "caches.default hit returns cached GeoJSON");
ok(upstream.length === beforeCalls, "caches.default hit makes zero upstream calls");
ok(cacheMatches >= 1, "caches.default.match consulted");

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
