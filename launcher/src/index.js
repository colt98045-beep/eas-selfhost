// eas-launcher Worker entry. Only the default fetch handler is exported
// from this module (workerd rejects other named exports here).
// / and /status are served from public/ by the assets binding
// (status.html is exposed as /status via html_handling).
// /admin and /api/admin/* require a verified Cloudflare Access JWT
// and fail closed if Access is missing or misconfigured.
import { getStatus } from "./status.js";
import { currentLockouts, decorateStatus, syncLockoutIncidents } from "./lockout.js";
import { isAdminPath, requireAccess } from "./access.js";
import { handlePublicAnnouncements, handleAdminApi } from "./announcements.js";
import { handlePublicMaintenance, handleAdminMaintenance, maybeServeMaintenance } from "./maintenance.js";
import { handleAdminLogs, logRequest } from "./access-log.js";
import { handleAdminUsers } from "./admins.js";
import { handleAccessLogins } from "./access-sync.js";
import { handleAdminStats } from "./access-stats.js";
import { handlePublicUptime, resetUptimeCache } from "./uptime.js";
import { runScheduled } from "./scheduled.js";
import { handleBadge } from "./badge.js";
import { withSecurityHeaders } from "./headers.js";

function jsonResponse(payload, method) {
  const body = JSON.stringify(payload, null, 2);
  return new Response(method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function notAllowed(allow = "GET, HEAD") {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      Allow: allow,
      "cache-control": "no-store",
    },
  });
}

async function serveAdminPage(request, env) {
  if (!env || !env.ASSETS) {
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  // Fetch the canonical /admin asset path, not /admin.html.
  // html_handling auto-trailing-slash 307s /admin.html -> /admin. Forwarding
  // that Location to the browser loops with Access after login
  // (/admin -> 307 /admin). env.ASSETS.fetch("/admin") serves admin.html
  // with 200 and does not re-enter the Worker or Access.
  const assetUrl = new URL("/admin", url.origin);
  const assetRequest = new Request(assetUrl, { method: "GET" });
  const res = await env.ASSETS.fetch(assetRequest);
  // Never forward an asset redirect to the client. A failed JWT already
  // returns 403; a missing page should also fail closed, not bounce.
  if (res.status >= 300 && res.status < 400) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!res.ok) {
    const status = res.status === 404 ? 404 : 403;
    return new Response(status === 404 ? "Not Found" : "Forbidden", {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const headers = new Headers(res.headers);
  headers.delete("Location");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  if (request.method === "HEAD") {
    return new Response(null, { status: res.status, headers });
  }
  return new Response(res.body, { status: res.status, headers });
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/api/status") {
      if (method !== "GET" && method !== "HEAD") return notAllowed();
      const refresh = url.searchParams.get("refresh") === "1";
      const payload = await getStatus({ refresh });
      return jsonResponse(decorateStatus(payload, await currentLockouts(env)), method);
    }

    if (path === "/api/uptime") {
      return handlePublicUptime(request, env);
    }

    if (path === "/api/badge") {
      return handleBadge(request, env);
    }

    if (path === "/favicon.ico" && env && env.ASSETS) {
      return new Response(null, { status: 301, headers: { Location: "/icon.svg", "cache-control": "public, max-age=86400" } });
    }

    if (path === "/api/announcements") {
      return handlePublicAnnouncements(request, env);
    }

    if (path === "/api/maintenance") {
      return handlePublicMaintenance(request, env);
    }

    if (isAdminPath(path)) {
      const auth = await requireAccess(request, env);
      if (!auth.ok) return auth.response;
      if (path === "/api/admin/logs/access-logins" || path.startsWith("/api/admin/logs/access-logins/")) {
        return handleAccessLogins(request, env);
      }
      if (path === "/api/admin/logs/stats") {
        return handleAdminStats(request, env);
      }
      if (path === "/api/admin/logs" || path.startsWith("/api/admin/logs/")) {
        return handleAdminLogs(request, env);
      }
      if (path === "/api/admin/admins" || path.startsWith("/api/admin/admins/")) {
        return handleAdminUsers(request, env, auth);
      }
      if (path === "/api/admin/maintenance" || path.startsWith("/api/admin/maintenance/")) {
        const res = await handleAdminMaintenance(request, env, auth);
        if (method !== "GET" && method !== "HEAD" && res.ok) {
          // Open/close the lockout incident right away instead of waiting for the cron.
          await syncLockoutIncidents(env);
          resetUptimeCache();
        }
        return res;
      }
      if (path.startsWith("/api/admin")) {
        return handleAdminApi(request, env, auth);
      }
      if (method !== "GET" && method !== "HEAD") return notAllowed();
      return serveAdminPage(request, env);
    }

    // Launcher pages only. APIs, /admin and /api/maintenance are already handled
    // above and are also excluded inside maybeServeMaintenance.
    const locked = await maybeServeMaintenance(request, env);
    if (locked) return locked;

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
}

export default {
  async fetch(request, env, ctx) {
    const response = withSecurityHeaders(await handleRequest(request, env));
    try {
      logRequest(ctx, env, request, response, { site: "launcher" });
    } catch {
      // logging must never affect the response
    }
    return response;
  },
  // Crons (wrangler.jsonc triggers.crons):
  //   "15 9 * * *"  daily: prune access logs, admin audit and uptime history
  //   "*/5 * * * *" every 5 min: record uptime, tidy scheduled maintenance windows
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    const work = runScheduled(cron, env).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") {
      try {
        ctx.waitUntil(work);
      } catch {
        // ignore
      }
    } else {
      await work;
    }
  },
};
