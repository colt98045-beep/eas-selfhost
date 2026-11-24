// Admin allow-list stored in the ANNOUNCEMENTS KV under the "admins" key.
// admin@example.com is permanent: always allowed, and it cannot be removed.
import { writeAdminAudit } from "./access-log.js";
import { syncAccessPolicy, accessSyncConfigured } from "./access-sync.js";

// CHANGE THIS to your own admin email (or run scripts/configure.mjs at the repo root).
// It must match the email on your Cloudflare Access policy.
export const PERMANENT_ADMIN = "admin@example.com";
export const ADMINS_KEY = "admins";

export function isValidEmail(value) {
  if (typeof value !== "string") return false;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return false;
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email);
}

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function parseAllowedEmails(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => normalizeEmail(s))
    .filter((s) => isValidEmail(s));
}

export async function loadKvAdmins(env) {
  if (!env || !env.ANNOUNCEMENTS) return [];
  const data = await env.ANNOUNCEMENTS.get(ADMINS_KEY, "json");
  if (!Array.isArray(data)) return [];
  return [...new Set(data.map(normalizeEmail).filter(isValidEmail))];
}

export async function allowedAdminEmails(env) {
  const set = new Set(parseAllowedEmails(env && env.CF_ACCESS_ALLOWED_EMAILS));
  set.add(PERMANENT_ADMIN);
  try {
    for (const email of await loadKvAdmins(env)) set.add(email);
  } catch {
    // KV failed: permanent + env emails still apply
  }
  return [...set];
}

export async function saveKvAdmins(env, emails) {
  const unique = [...new Set(emails.map(normalizeEmail).filter(isValidEmail))].filter((e) => e !== PERMANENT_ADMIN);
  await env.ANNOUNCEMENTS.put(ADMINS_KEY, JSON.stringify(unique));
  return unique;
}

function json(payload, status = 200, method = "GET") {
  return new Response(method === "HEAD" ? null : JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function listPayload(env, extras = {}) {
  const kv = await loadKvAdmins(env).catch(() => []);
  const envEmails = parseAllowedEmails(env && env.CF_ACCESS_ALLOWED_EMAILS);
  const all = await allowedAdminEmails(env);
  const admins = all
    .sort((a, b) => {
      if (a === PERMANENT_ADMIN) return -1;
      if (b === PERMANENT_ADMIN) return 1;
      return a.localeCompare(b);
    })
    .map((email) => ({
      email,
      permanent: email === PERMANENT_ADMIN,
      source: email === PERMANENT_ADMIN || envEmails.includes(email) ? (kv.includes(email) ? "env+kv" : "env") : "kv",
    }));
  const sync = accessSyncConfigured(env);
  return {
    admins,
    permanent: PERMANENT_ADMIN,
    sync: {
      configured: sync,
      mode: "access_policy",
      note: sync
        ? "Adds and removals are synced to the Cloudflare Access policy for this admin app."
        : "Cloudflare Access sync is not configured (missing CF_API_TOKEN or CF_ACCOUNT_ID). Also add or remove this email in Cloudflare Access.",
    },
    ...extras,
  };
}

export async function handleAdminUsers(request, env, identity, { now = Date.now(), fetcher = fetch } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const actor = identity && identity.email ? identity.email : "";

  if (path !== "/api/admin/admins") return json({ error: "Not Found" }, 404);

  if (!env || !env.ANNOUNCEMENTS) {
    if (method === "GET" || method === "HEAD") {
      return json(await listPayload(env, { storage: "unavailable" }), 200, method);
    }
    return json({ error: "Announcement storage is not bound" }, 503);
  }

  if (method === "GET" || method === "HEAD") {
    return json(await listPayload(env, { storage: "ok" }), 200, method);
  }

  if (method === "POST") {
    const body = await readJson(request);
    if (body.error) return json({ error: body.error }, 400);
    const email = normalizeEmail(body.value.email);
    if (!isValidEmail(email)) return json({ error: "A valid email is required" }, 400);
    if (email === PERMANENT_ADMIN) return json({ error: `${PERMANENT_ADMIN} is already a permanent admin` }, 400);
    const current = await loadKvAdmins(env);
    if (current.includes(email) || parseAllowedEmails(env.CF_ACCESS_ALLOWED_EMAILS).includes(email)) {
      return json({ error: "That email is already an admin" }, 409);
    }
    const next = await saveKvAdmins(env, [...current, email]);
    await writeAdminAudit(env, { actor, action: "add", email, now }).catch(() => {});
    const sync = await syncAccessPolicy(env, await allowedAdminEmails(env), { fetcher });
    return json(await listPayload(env, { added: email, kv: next, access_sync: sync }), 201);
  }

  if (method === "DELETE") {
    const email = normalizeEmail(url.searchParams.get("email") || "");
    if (!isValidEmail(email)) return json({ error: "A valid email is required" }, 400);
    if (email === PERMANENT_ADMIN) {
      return json({ error: `${PERMANENT_ADMIN} is a permanent admin and cannot be removed` }, 403);
    }
    const current = await loadKvAdmins(env);
    if (!current.includes(email)) return json({ error: "Not Found" }, 404);
    const next = await saveKvAdmins(env, current.filter((item) => item !== email));
    await writeAdminAudit(env, { actor, action: "remove", email, now }).catch(() => {});
    const sync = await syncAccessPolicy(env, await allowedAdminEmails(env), { fetcher });
    return json(await listPayload(env, { removed: email, kv: next, access_sync: sync }));
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET, HEAD, POST, DELETE", "cache-control": "no-store" },
  });
}

async function readJson(request) {
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (ctype && !ctype.includes("application/json")) {
    return { error: "Content-Type must be application/json" };
  }
  try {
    const text = await request.text();
    if (text.length > 8 * 1024) return { error: "Request body is too large" };
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Expected a JSON object" };
    return { value };
  } catch {
    return { error: "Invalid JSON" };
  }
}

