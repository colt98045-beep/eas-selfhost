// Optional Cloudflare Access policy sync and authentication-log reads.
// Both use the CF_API_TOKEN secret plus CF_ACCOUNT_ID. If either is missing,
// callers get a graceful { configured: false } result and no request is made.
// PERMANENT_ADMIN (set it to your own email) is always kept on the allow policy.

// CHANGE THIS to your own admin email (or run scripts/configure.mjs at the repo root).
export const PERMANENT_ADMIN = "admin@example.com";
// Set CF_ACCESS_APP_ID (Zero Trust > Access > Applications > your app > ID).
export const DEFAULT_ACCESS_APP_ID = "";

export function accessSyncConfigured(env = {}) {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
}

function apiBase(env) {
  const account = String(env.CF_ACCOUNT_ID || "").trim();
  const app = String(env.CF_ACCESS_APP_ID || DEFAULT_ACCESS_APP_ID).trim();
  return {
    account,
    app,
    token: env.CF_API_TOKEN,
    root: `https://api.cloudflare.com/client/v4/accounts/${account}`,
  };
}

async function cfFetch(fetcher, env, path, { method = "GET", body, query } = {}) {
  const { token, root } = apiBase(env);
  const url = new URL(root + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetcher(url.toString(), init);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { success: false, errors: [{ message: text || res.statusText }] };
  }
  if (!res.ok || data.success === false) {
    const msg = (data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function emailIncludes(emails) {
  const set = new Set((emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  set.add(PERMANENT_ADMIN);
  return [...set].sort().map((email) => ({ email: { email } }));
}

function includesToEmails(include) {
  const out = [];
  for (const rule of include || []) {
    if (rule && rule.email && typeof rule.email.email === "string") out.push(rule.email.email.trim().toLowerCase());
  }
  return out;
}

export async function syncAccessPolicy(env, emails, { fetcher = fetch } = {}) {
  if (!accessSyncConfigured(env)) {
    return { configured: false, ok: false, reason: "not_configured" };
  }
  try {
    const { app } = apiBase(env);
    if (!app) return { configured: false, ok: false, reason: "CF_ACCESS_APP_ID is not set" };
    const listed = await cfFetch(fetcher, env, `/access/apps/${app}/policies`);
    const policies = listed.result || [];
    const policy = policies.find((p) => p && p.decision === "allow") || policies[0];
    if (!policy || !policy.id) {
      return { configured: true, ok: false, reason: "no_policy" };
    }
    const include = emailIncludes(emails);
    const body = {
      name: policy.name || "Allow admins",
      decision: policy.decision || "allow",
      include,
      exclude: policy.exclude || [],
      require: policy.require || [],
    };
    if (policy.precedence !== undefined) body.precedence = policy.precedence;
    await cfFetch(fetcher, env, `/access/apps/${app}/policies/${policy.id}`, { method: "PUT", body });
    return {
      configured: true,
      ok: true,
      policy_id: policy.id,
      emails: includesToEmails(include),
    };
  } catch (err) {
    return { configured: true, ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

export async function fetchAccessLogins(env, { since, until, limit = 50, fetcher = fetch } = {}) {
  if (!accessSyncConfigured(env)) {
    return {
      configured: false,
      ok: false,
      reason: "not_configured",
      note: "Access login events need the CF_API_TOKEN secret and CF_ACCOUNT_ID. Site visit logs still work.",
      events: [],
    };
  }
  try {
    const { app } = apiBase(env);
    const data = await cfFetch(fetcher, env, "/access/logs/access_requests", {
      query: {
        limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
        direction: "desc",
        since: since ? new Date(since).toISOString() : undefined,
        until: until ? new Date(until).toISOString() : undefined,
        app_uid: app,
        app_uidOp: "eq",
      },
    });
    const events = (data.result || []).map((row) => ({
      ts: row.created_at || row.timestamp || null,
      email: row.user_email || row.email || null,
      allowed: row.allowed,
      app: row.app_name || row.app_uid || null,
      country: row.country || row.country_code || null,
      ip: row.ip_address || row.ip || null,
      success: row.success,
      ray_id: row.ray_id || null,
    }));
    return { configured: true, ok: true, events };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      reason: err && err.message ? err.message : String(err),
      events: [],
    };
  }
}

import { formatEt } from "./status.js";

export async function handleAccessLogins(request, env, { fetcher = fetch, now = Date.now() } = {}) {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get("from");
  const untilRaw = url.searchParams.get("to");
  const since = sinceRaw ? Date.parse(sinceRaw) || Number(sinceRaw) : now - 24 * 60 * 60 * 1000;
  const until = untilRaw ? Date.parse(untilRaw) || Number(untilRaw) : now;
  const payload = await fetchAccessLogins(env, { since, until, limit: url.searchParams.get("limit") || 50, fetcher });
  if (payload.events) {
    payload.events = payload.events.map((event) => ({
      ...event,
      ts_et: event.ts ? formatEt(new Date(event.ts)) : null,
    }));
  }
  const body = method === "HEAD" ? null : JSON.stringify(payload, null, 2);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
