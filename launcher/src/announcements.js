// Announcement storage, public read API, and Access-protected admin writes.
import { formatEt, US_ORIGIN, CA_ORIGIN, LAUNCHER_ORIGIN } from "./status.js";

export const SITES = ["us", "ca", "launcher"];
export const TYPES = ["info", "outage", "maintenance", "resolved"];
export const TARGETS = ["all", "us", "ca", "launcher"];
export const PUBLIC_CACHE_S = 30;
export const KV_KEY = "announcements";
export const MAX_TITLE = 200;
export const MAX_MESSAGE = 2000;
export const MAX_ITEMS = 50;

export const PUBLIC_ORIGINS = [US_ORIGIN, CA_ORIGIN, LAUNCHER_ORIGIN];

const ORIGIN_SET = new Set(PUBLIC_ORIGINS);

export function corsHeaders(request, extra = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": `public, max-age=${PUBLIC_CACHE_S}`,
    "x-content-type-options": "nosniff",
    vary: "Origin",
    ...extra,
  };
  const origin = request.headers.get("Origin");
  if (origin && ORIGIN_SET.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, HEAD, OPTIONS";
    headers["access-control-allow-headers"] = "Content-Type";
    headers["access-control-max-age"] = "600";
  }
  return headers;
}

export function isActiveAt(announcement, now = Date.now()) {
  const start = announcement.start ? Date.parse(announcement.start) : NaN;
  const end = announcement.end ? Date.parse(announcement.end) : NaN;
  if (Number.isFinite(start) && now < start) return false;
  if (Number.isFinite(end) && now >= end) return false;
  return true;
}

export function matchesSite(announcement, site) {
  const targets = Array.isArray(announcement.targets) ? announcement.targets : [];
  if (targets.includes("all")) return true;
  return targets.includes(site);
}

export function filterPublic(announcements, site, now = Date.now()) {
  return announcements
    .filter((item) => matchesSite(item, site) && isActiveAt(item, now))
    .sort((a, b) => {
      const rank = (t) => (t === "outage" ? 0 : t === "maintenance" ? 1 : t === "info" ? 2 : 3);
      const r = rank(a.type) - rank(b.type);
      if (r !== 0) return r;
      return String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""));
    });
}

export function publicView(item) {
  return {
    id: item.id,
    title: item.title,
    message: item.message,
    type: item.type,
    targets: item.targets,
    start: item.start,
    end: item.end,
    start_et: item.start ? formatEt(new Date(item.start)) : null,
    end_et: item.end ? formatEt(new Date(item.end)) : null,
  };
}

function jsonResponse(payload, { status = 200, request, cache = "no-store", cors = false, method = "GET" } = {}) {
  const headers = cors
    ? corsHeaders(request, { "cache-control": `public, max-age=${PUBLIC_CACHE_S}` })
    : {
        "content-type": "application/json; charset=utf-8",
        "cache-control": cache,
        "x-content-type-options": "nosniff",
      };
  const body = method === "HEAD" ? null : JSON.stringify(payload, null, 2);
  return new Response(body, { status, headers });
}

async function loadList(env) {
  if (!env || !env.ANNOUNCEMENTS) return [];
  const data = await env.ANNOUNCEMENTS.get(KV_KEY, "json");
  return Array.isArray(data) ? data : [];
}

async function saveList(env, list) {
  await env.ANNOUNCEMENTS.put(KV_KEY, JSON.stringify(list));
}

function normalizeTargets(input) {
  if (!Array.isArray(input)) return null;
  const unique = [...new Set(input.map((t) => String(t).toLowerCase().trim()))];
  if (!unique.length || unique.some((t) => !TARGETS.includes(t))) return null;
  if (unique.includes("all")) return ["all"];
  return unique;
}

function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function validateAnnouncement(input, { partial = false } = {}) {
  if (!input || typeof input !== "object") return { error: "Expected a JSON object" };

  const out = {};
  if (!partial || "title" in input) {
    if (typeof input.title !== "string") return { error: "title is required" };
    const title = input.title.trim();
    if (!title) return { error: "title is required" };
    if (title.length > MAX_TITLE) return { error: `title must be at most ${MAX_TITLE} characters` };
    out.title = title;
  }
  if (!partial || "message" in input) {
    if (typeof input.message !== "string") return { error: "message is required" };
    const message = input.message.trim();
    if (!message) return { error: "message is required" };
    if (message.length > MAX_MESSAGE) return { error: `message must be at most ${MAX_MESSAGE} characters` };
    out.message = message;
  }
  if (!partial || "type" in input) {
    if (!TYPES.includes(input.type)) return { error: "type must be info, outage, maintenance, or resolved" };
    out.type = input.type;
  }
  if (!partial || "targets" in input) {
    const targets = normalizeTargets(input.targets);
    if (!targets) return { error: "targets must be a non-empty subset of all, us, ca, launcher" };
    out.targets = targets;
  }
  if (!partial || "start" in input) {
    const start = parseTime(input.start);
    if (start === undefined) return { error: "start must be an ISO timestamp or empty" };
    out.start = start;
  }
  if (!partial || "end" in input) {
    const end = parseTime(input.end);
    if (end === undefined) return { error: "end must be an ISO timestamp or empty" };
    out.end = end;
  }
  if (out.start && out.end && Date.parse(out.end) <= Date.parse(out.start)) {
    return { error: "end must be after start" };
  }
  return { value: out };
}

export async function handlePublicAnnouncements(request, env, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...corsHeaders(request), Allow: "GET, HEAD, OPTIONS" },
    });
  }

  const site = (url.searchParams.get("site") || "").toLowerCase().trim();
  if (!SITES.includes(site)) {
    return jsonResponse(
      { error: "site must be us, ca, or launcher" },
      { status: 400, request, cors: true, method },
    );
  }

  let list = [];
  try {
    list = await loadList(env);
  } catch {
    list = [];
  }

  const announcements = filterPublic(list, site, now).map(publicView);
  return jsonResponse(
    {
      site,
      updated_at: formatEt(new Date(now)),
      announcements,
    },
    { request, cors: true, method },
  );
}

export async function handleAdminApi(request, env, identity, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const email = identity && identity.email ? identity.email : "";

  if (!env || !env.ANNOUNCEMENTS) {
    if (path === "/api/admin/me" && (method === "GET" || method === "HEAD")) {
      return jsonResponse({ email, storage: "unavailable" }, { method });
    }
    return jsonResponse({ error: "Announcement storage is not bound" }, { status: 503, method });
  }

  if (path === "/api/admin/me") {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return jsonResponse({ email, storage: "ok" }, { method });
  }

  if (path === "/api/admin/announcements") {
    if (method === "GET" || method === "HEAD") {
      const list = await loadList(env);
      const items = [...list].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
      return jsonResponse({ announcements: items.map((item) => adminView(item, now)) }, { method });
    }
    if (method === "POST") {
      const body = await readJson(request);
      if (body.error) return jsonResponse({ error: body.error }, { status: 400 });
      const checked = validateAnnouncement(body.value);
      if (checked.error) return jsonResponse({ error: checked.error }, { status: 400 });
      const list = await loadList(env);
      if (list.length >= MAX_ITEMS) {
        return jsonResponse({ error: `At most ${MAX_ITEMS} announcements can be stored` }, { status: 400 });
      }
      const stamp = new Date(now).toISOString();
      const item = {
        id: crypto.randomUUID(),
        ...checked.value,
        created_at: stamp,
        updated_at: stamp,
        created_by: email,
      };
      list.push(item);
      await saveList(env, list);
      return jsonResponse({ announcement: adminView(item, now) }, { status: 201 });
    }
    return methodNotAllowed("GET, HEAD, POST");
  }

  const match = path.match(/^\/api\/admin\/announcements\/([0-9a-fA-F-]{36})$/);
  if (!match) return jsonResponse({ error: "Not Found" }, { status: 404 });
  const id = match[1];

  if (method === "GET" || method === "HEAD") {
    const list = await loadList(env);
    const item = list.find((row) => row.id === id);
    if (!item) return jsonResponse({ error: "Not Found" }, { status: 404, method });
    return jsonResponse({ announcement: adminView(item, now) }, { method });
  }

  if (method === "PUT") {
    const body = await readJson(request);
    if (body.error) return jsonResponse({ error: body.error }, { status: 400 });
    const list = await loadList(env);
    const index = list.findIndex((row) => row.id === id);
    if (index === -1) return jsonResponse({ error: "Not Found" }, { status: 404 });
    const checked = validateAnnouncement({ ...list[index], ...body.value });
    if (checked.error) return jsonResponse({ error: checked.error }, { status: 400 });
    const item = {
      ...list[index],
      ...checked.value,
      id,
      updated_at: new Date(now).toISOString(),
    };
    list[index] = item;
    await saveList(env, list);
    return jsonResponse({ announcement: adminView(item, now) });
  }

  if (method === "DELETE") {
    const list = await loadList(env);
    const next = list.filter((row) => row.id !== id);
    if (next.length === list.length) return jsonResponse({ error: "Not Found" }, { status: 404 });
    await saveList(env, next);
    return jsonResponse({ ok: true, id });
  }

  return methodNotAllowed("GET, HEAD, PUT, DELETE");
}

function adminView(item, now) {
  return {
    ...item,
    start_et: item.start ? formatEt(new Date(item.start)) : null,
    end_et: item.end ? formatEt(new Date(item.end)) : null,
    active: isActiveAt(item, now),
  };
}

async function readJson(request) {
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (ctype && !ctype.includes("application/json")) {
    return { error: "Content-Type must be application/json" };
  }
  try {
    const text = await request.text();
    if (text.length > 32 * 1024) return { error: "Request body is too large" };
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "Expected a JSON object" };
    }
    return { value };
  } catch {
    return { error: "Invalid JSON" };
  }
}

function methodNotAllowed(allow) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: allow, "cache-control": "no-store" },
  });
}
