import worker from "../src/index.js";

const base = "https://eas-repository-ca.your-subdomain.workers.dev";
const env = {
  ASSETS: { fetch: async (r) => new Response("ASSET " + new URL(r.url).pathname) },
};
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

const throwD1 = { prepare() { throw new Error("d1 down"); } };
const throwCtx = { waitUntil() { throw new Error("waitUntil down"); } };

let r = await worker.fetch(new Request(base + "/"), { ...env, ACCESS_LOG: throwD1 }, throwCtx);
ok(r.status === 200 && (await r.text()) === "ASSET /", "throwing logger does not change /");

r = await worker.fetch(new Request(base + "/api/nope"), { ...env, ACCESS_LOG: throwD1 }, throwCtx);
ok(r.status === 404, "throwing logger does not change unknown API");

r = await worker.fetch(new Request(base + "/api/canada", { method: "POST" }), { ...env, ACCESS_LOG: throwD1 }, throwCtx);
ok(r.status === 501, "throwing logger does not change method check");

if (!process.exitCode) console.log("CA access-log hook tests passed");
