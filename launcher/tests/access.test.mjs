import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  getAccessConfig,
  normalizeTeamDomain,
  parseAllowedEmails,
  resetAccessCache,
  verifyAccessJwt,
  isAdminPath,
  accessDeniedResponse,
} from "../src/access.js";

const TEAM = "https://example.cloudflareaccess.com";
const AUD = "test-aud-tag-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EMAIL = "admin@example.com";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", kty: "RSA", alg: "RS256", use: "sig" };

function env(overrides = {}) {
  return {
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_ALLOWED_EMAILS: EMAIL,
    ...overrides,
  };
}

function b64url(data) {
  return Buffer.from(data).toString("base64url");
}

function jwt(payload, { alg = "RS256", kid = "test-kid", key = privateKey, omitSig = false } = {}) {
  const header = b64url(JSON.stringify({ typ: "JWT", alg, kid }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  if (omitSig) return `${data}.`;
  const sig = sign("sha256", Buffer.from(data), key).toString("base64url");
  return `${data}.${sig}`;
}

function claims(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TEAM,
    aud: AUD,
    email: EMAIL,
    exp: now + 3600,
    nbf: now - 10,
    iat: now - 10,
    ...extra,
  };
}

function requestWith(token, url = "https://eas-launcher.your-subdomain.workers.dev/api/admin/me") {
  const headers = {};
  if (token !== undefined) headers["Cf-Access-Jwt-Assertion"] = token;
  return new Request(url, { headers });
}

function certsFetcher(jwks = { keys: [JWK] }, { status = 200, fail = false } = {}) {
  return async (url) => {
    assert.match(url, new RegExp(`^${TEAM}/cdn-cgi/access/certs$`));
    if (fail) throw new Error("network down");
    return new Response(JSON.stringify(jwks), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

test("isAdminPath covers admin pages and APIs only", () => {
  assert.equal(isAdminPath("/admin"), true);
  assert.equal(isAdminPath("/admin/"), true);
  assert.equal(isAdminPath("/admin.html"), true);
  assert.equal(isAdminPath("/api/admin/announcements"), true);
  assert.equal(isAdminPath("/api/admin/announcements/abc"), true);
  assert.equal(isAdminPath("/api/announcements"), false);
  assert.equal(isAdminPath("/api/status"), false);
  assert.equal(isAdminPath("/"), false);
  assert.equal(isAdminPath("/status"), false);
});

test("normalizeTeamDomain requires https *.cloudflareaccess.com", () => {
  assert.equal(normalizeTeamDomain("example.cloudflareaccess.com"), TEAM);
  assert.equal(normalizeTeamDomain("https://example.cloudflareaccess.com/"), TEAM);
  assert.equal(normalizeTeamDomain("https://evil.example.com"), null);
  assert.equal(normalizeTeamDomain("http://example.cloudflareaccess.com"), null);
  assert.equal(normalizeTeamDomain("cloudflareaccess.com"), null);
  assert.equal(normalizeTeamDomain(""), null);
  assert.equal(normalizeTeamDomain(null), null);
});

test("getAccessConfig fails closed when any required field is missing", () => {
  assert.equal(getAccessConfig(env()).ok, true);
  assert.equal(getAccessConfig(env({ CF_ACCESS_TEAM_DOMAIN: "" })).ok, false);
  assert.equal(getAccessConfig(env({ CF_ACCESS_AUD: "  " })).ok, false);
  // The permanent admin is always allowed, even if the env list is empty.
  assert.equal(getAccessConfig(env({ CF_ACCESS_ALLOWED_EMAILS: "" })).ok, true);
  assert.equal(getAccessConfig({}).ok, false);
  assert.deepEqual(parseAllowedEmails(" Admin@Example.com ,other@x.com "), [EMAIL, "other@x.com"]);
});

test("missing Access config returns 403 not_configured", async () => {
  resetAccessCache();
  const result = await verifyAccessJwt(requestWith("ignore"), {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "not_configured");
  const res = accessDeniedResponse(result);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /not configured/i);
});

test("missing JWT returns 401", async () => {
  resetAccessCache();
  const result = await verifyAccessJwt(requestWith(undefined), env(), { fetcher: certsFetcher() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "missing_token");
});

test("a valid RS256 token with the allowed email succeeds", async () => {
  resetAccessCache();
  const result = await verifyAccessJwt(requestWith(jwt(claims())), env(), { fetcher: certsFetcher() });
  assert.equal(result.ok, true);
  assert.equal(result.email, EMAIL);
});

test("alg none and HS256 are rejected", async () => {
  resetAccessCache();
  for (const alg of ["none", "HS256"]) {
    // Keep a dummy third segment so the token is well-formed and the alg check runs.
    const token = jwt(claims(), { alg });
    const result = await verifyAccessJwt(requestWith(token), env(), { fetcher: certsFetcher() });
    assert.equal(result.ok, false, alg);
    assert.equal(result.status, 403, alg);
    assert.equal(result.code, "bad_alg", alg);
  }
});

test("a token with an empty signature segment is rejected", async () => {
  resetAccessCache();
  const token = jwt(claims(), { alg: "none", omitSig: true });
  const result = await verifyAccessJwt(requestWith(token), env(), { fetcher: certsFetcher() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.ok(["malformed", "bad_alg"].includes(result.code));
});

test("a bad signature is rejected", async () => {
  resetAccessCache();
  const token = jwt(claims(), { key: otherKeys.privateKey });
  const result = await verifyAccessJwt(requestWith(token), env(), { fetcher: certsFetcher() });
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad_signature");
  assert.equal(result.status, 403);
});

test("wrong aud, issuer, email, expiry and nbf fail closed", async () => {
  const cases = [
    [{ aud: "someone-else" }, "bad_aud"],
    [{ iss: "https://other.cloudflareaccess.com" }, "bad_iss"],
    [{ email: "intruder@example.com" }, "email_not_allowed"],
    [{ email: "" }, "email_not_allowed"],
    [{ exp: Math.floor(Date.now() / 1000) - 120 }, "expired"],
    [{ nbf: Math.floor(Date.now() / 1000) + 600 }, "not_yet_valid"],
  ];
  for (const [extra, code] of cases) {
    resetAccessCache();
    const result = await verifyAccessJwt(requestWith(jwt(claims(extra))), env(), { fetcher: certsFetcher() });
    assert.equal(result.ok, false, code);
    assert.equal(result.status, 403, code);
    assert.equal(result.code, code);
  }
});

test("unknown kid and a failed certs fetch fail closed", async () => {
  resetAccessCache();
  const unknown = await verifyAccessJwt(requestWith(jwt(claims())), env(), {
    fetcher: certsFetcher({ keys: [{ ...JWK, kid: "other" }] }),
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "unknown_kid");

  resetAccessCache();
  const down = await verifyAccessJwt(requestWith(jwt(claims())), env(), {
    fetcher: certsFetcher({ keys: [JWK] }, { fail: true }),
  });
  assert.equal(down.ok, false);
  assert.equal(down.code, "certs_unavailable");
});

test("aud arrays and identity.email are accepted", async () => {
  resetAccessCache();
  const result = await verifyAccessJwt(
    requestWith(jwt(claims({ aud: ["other", AUD], email: undefined, identity: { email: "Admin@Example.com" } }))),
    env(),
    { fetcher: certsFetcher() },
  );
  assert.equal(result.ok, true);
  assert.equal(result.email, EMAIL);
});

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
  };
}

test("KV extra admins are allowed and a KV failure still allows the permanent admin", async () => {
  resetAccessCache();
  const withList = env({ ANNOUNCEMENTS: memoryKv({ admins: ["extra@example.com"] }) });
  const extra = await verifyAccessJwt(requestWith(jwt(claims({ email: "extra@example.com" }))), withList, { fetcher: certsFetcher() });
  assert.equal(extra.ok, true);
  assert.equal(extra.email, "extra@example.com");

  resetAccessCache();
  const broken = env({
    ANNOUNCEMENTS: {
      async get() {
        throw new Error("kv down");
      },
    },
  });
  const permanent = await verifyAccessJwt(requestWith(jwt(claims())), broken, { fetcher: certsFetcher() });
  assert.equal(permanent.ok, true);
  resetAccessCache();
  const stranger = await verifyAccessJwt(requestWith(jwt(claims({ email: "intruder@example.com" }))), broken, { fetcher: certsFetcher() });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.code, "email_not_allowed");
});
