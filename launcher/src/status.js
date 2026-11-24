// eas-launcher: static launcher panel plus a server-side status API.
// Fetches of other Workers on this account go out through the public
// front door because wrangler.jsonc enables global_fetch_strictly_public
// (avoids error 1042). This Worker does not touch or bypass the US
// Turnstile gate.

export const TIMEOUT_MS = 8000;
export const CACHE_TTL_MS = 15000;
export const PEEK_BYTES = 4096;

export const US_ORIGIN = "https://eas-repository.your-subdomain.workers.dev";
export const CA_ORIGIN = "https://eas-repository-ca.your-subdomain.workers.dev";
export const LAUNCHER_ORIGIN = "https://eas-launcher.your-subdomain.workers.dev";

export const CHECKS = [
  { group: "us", groupName: "United States", id: "us-site", name: "Site", url: `${US_ORIGIN}/` },
  { group: "us", groupName: "United States", id: "us-active", name: "/api/active", url: `${US_ORIGIN}/api/active` },
  { group: "us", groupName: "United States", id: "us-noaa", name: "/api/noaa", url: `${US_ORIGIN}/api/noaa` },
  { group: "us", groupName: "United States", id: "us-nws", name: "/api/nws", url: `${US_ORIGIN}/api/nws` },
  { group: "us", groupName: "United States", id: "us-noaa-ny", name: "/api/noaa/NY", url: `${US_ORIGIN}/api/noaa/NY` },
  { group: "ca", groupName: "Canada", id: "ca-site", name: "Site", url: `${CA_ORIGIN}/` },
  { group: "ca", groupName: "Canada", id: "ca-canada", name: "/api/canada", url: `${CA_ORIGIN}/api/canada` },
  { group: "ca", groupName: "Canada", id: "ca-active", name: "/api/active", url: `${CA_ORIGIN}/api/active` },
  { group: "launcher", groupName: "Launcher", id: "launcher-site", name: "Site", url: `${LAUNCHER_ORIGIN}/` },
];

const GROUP_ORDER = ["us", "ca", "launcher"];

let cache = { expires: 0, builtAt: 0, payload: null };

export function formatEt(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")} ET`;
}

export function isGateResponse({ status, headers = {}, body = "" } = {}) {
  const csp = header(headers, "content-security-policy");
  const html = header(headers, "content-type").includes("text/html");
  const blob = `${csp}\n${body}`;
  const turnstile =
    /challenges\.cloudflare\.com\/turnstile/i.test(blob) ||
    /cf-turnstile/i.test(blob) ||
    /turnstile\/v0\/api\.js/i.test(blob);
  const challengePage =
    /Checking your browser/i.test(body) ||
    /Quick check before you continue/i.test(body);
  if (turnstile || (html && challengePage)) return true;
  // A 403 HTML challenge with the Turnstile CSP host, even if the body was not peeked.
  if (status === 403 && html && /challenges\.cloudflare\.com/i.test(csp)) return true;
  return false;
}

function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] ?? "") : "";
}

export function classify({ status, headers, body, error }) {
  if (error) {
    const message = String(error);
    if (/1042/.test(message)) {
      return {
        state: "down",
        label: "Down (error 1042)",
        detail: "Worker-to-Worker fetch on this account was blocked. Needs global_fetch_strictly_public or a service binding.",
      };
    }
    if (/abort|timeout|timed out/i.test(message)) {
      return { state: "down", label: "Down (timeout)", detail: `No response within ${TIMEOUT_MS / 1000}s` };
    }
    return { state: "down", label: "Down", detail: message.slice(0, 200) };
  }
  if (isGateResponse({ status, headers, body })) {
    return {
      state: "gated",
      label: "Up, gated",
      detail: "Turnstile challenge page. The Worker is up; this check does not pass the gate or read the API body.",
    };
  }
  if (status >= 200 && status < 400) {
    return { state: "up", label: "Up", detail: null };
  }
  if (status) {
    return { state: "down", label: `Down (${status})`, detail: `HTTP ${status}` };
  }
  return { state: "down", label: "Down", detail: "No response" };
}

async function peekBody(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  const out = new Uint8Array(Math.min(received, PEEK_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(out);
}

export async function probe(url, fetcher = fetch) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), TIMEOUT_MS);
  try {
    const res = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
        "User-Agent": "EAS-Launcher-Status/1.0",
      },
    });
    const latency_ms = Date.now() - started;
    const contentType = res.headers.get("content-type") || "";
    const maybeGate =
      res.status === 403 ||
      contentType.includes("text/html") ||
      /challenges\.cloudflare\.com/i.test(res.headers.get("content-security-policy") || "");
    const body = maybeGate ? await peekBody(res) : "";
    if (!maybeGate && res.body) {
      try {
        await res.body.cancel();
      } catch {
        // ignore
      }
    }
    const verdict = classify({ status: res.status, headers: res.headers, body });
    return {
      url,
      status: res.status,
      latency_ms,
      content_type: contentType.split(";")[0].trim() || null,
      ...verdict,
    };
  } catch (err) {
    const latency_ms = Date.now() - started;
    const verdict = classify({ error: err && err.message ? err.message : String(err) });
    return {
      url,
      status: null,
      latency_ms,
      content_type: null,
      ...verdict,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildStatus({ fetcher = fetch, now = new Date() } = {}) {
  const results = await Promise.all(CHECKS.map((check) => probe(check.url, fetcher)));
  const byId = new Map(CHECKS.map((check, i) => [check.id, { ...check, ...results[i] }]));
  const groups = GROUP_ORDER.map((id) => {
    const items = CHECKS.filter((check) => check.group === id).map((check) => {
      const row = byId.get(check.id);
      return {
        id: row.id,
        name: row.name,
        url: row.url,
        state: row.state,
        label: row.label,
        status: row.status,
        latency_ms: row.latency_ms,
        content_type: row.content_type,
        detail: row.detail,
      };
    });
    const states = items.map((item) => item.state);
    let state = "up";
    if (states.includes("down")) state = "down";
    else if (states.includes("gated")) state = "gated";
    return {
      id,
      name: items.length ? CHECKS.find((c) => c.group === id).groupName : id,
      state,
      checks: items,
    };
  });
  const all = groups.flatMap((g) => g.checks);
  let overall = "up";
  if (all.some((c) => c.state === "down")) overall = "down";
  else if (all.some((c) => c.state === "gated")) overall = "gated";
  return {
    checked_at: formatEt(now),
    checked_at_iso: now.toISOString(),
    overall,
    timeout_ms: TIMEOUT_MS,
    cache_ttl_ms: CACHE_TTL_MS,
    fetch_mode: "global_fetch_strictly_public",
    groups,
  };
}

export function resetStatusCache() {
  cache = { expires: 0, builtAt: 0, payload: null };
}

export async function getStatus({ refresh = false, fetcher = fetch } = {}) {
  const now = Date.now();
  if (!refresh && cache.payload && now < cache.expires) {
    return {
      ...cache.payload,
      cache: { hit: true, ttl_ms: CACHE_TTL_MS, age_ms: now - cache.builtAt },
    };
  }
  const payload = await buildStatus({ fetcher, now: new Date(now) });
  cache = { expires: now + CACHE_TTL_MS, builtAt: now, payload };
  return {
    ...payload,
    cache: { hit: false, ttl_ms: CACHE_TTL_MS, age_ms: 0 },
  };
}
