# EAS Launcher

A single dark, mobile-friendly panel that opens the United States and Canada EAS sites and GitHub repositories from one place, plus a status page that checks those sites and their APIs, and an Access-locked admin page for announcements and outage notices.

This is a Worker (`eas-launcher`) with a module entrypoint (`src/index.js`) and static assets in `public/`. It does not modify `eas-repository` or `eas-repository-ca`, and it does not change or bypass those Workers.

## Links

| | Site | GitHub |
| --- | --- | --- |
| United States | https://eas-repository.your-subdomain.workers.dev/ | https://github.com/your-github-user/eas-repository |
| Canada | https://eas-repository-ca.your-subdomain.workers.dev/ | https://github.com/your-github-user/eas-repository-ca (private) |

After deploy, the launcher is served by the `eas-launcher` Worker at `https://eas-launcher.your-subdomain.workers.dev/`.

The panel includes an **Open both sites** button (opens both site URLs in new tabs; a pop-up blocker may need to allow the second tab). Each card has **Open site** and **Open GitHub repo**. A **Status** link opens `/status`. Optional status dots on the panel use `fetch` with `mode: "no-cors"`. A reachable response counts as up, including a Turnstile-gated 403 on the US site.

## Status page

`/status` reads `/api/status`, which the Worker builds server-side (browser cross-origin fetches cannot read HTTP status). Checks use an 8s timeout, a 15s in-memory cache, and `?refresh=1` to bypass the cache. The page auto-refreshes every 20s. Times are 24-hour America/New_York (ET); dates are DD/MM/YYYY.

| Group | Checked |
| --- | --- |
| United States | Site, `/api/active`, `/api/noaa`, `/api/nws`, `/api/noaa/NY` (sample state feed) |
| Canada | Site, `/api/canada`, `/api/active` |
| Launcher | Site (`/`) |

An unauthenticated request to the US site or its APIs is expected to receive the Turnstile challenge (HTTP 403 + challenge HTML). The status API labels that **Up, gated** and does not try to pass the gate or read the API body. A missing or failing endpoint is **Down**. Same-account `*.workers.dev` fetches use the `global_fetch_strictly_public` compatibility flag so they go out through Cloudflare's public front door and do not hit error 1042.

The status API does not fetch `/api/status` against itself.

### Uptime history, incidents and badges

A 5-minute cron (`*/5 * * * *`) runs the same checks and folds each result into an hourly row in D1 (`uptime_hourly`, kept 35 days). An incident opens in `uptime_incidents` (kept 90 days) when a check is first seen down and closes when it is next seen up or gated. Tables come from `schema/migrations/0003_uptime.sql`.

- `GET /api/uptime` (public, CORS `*`, cached 60s): 24h, 7-day and 30-day uptime overall and per check, 30 daily bars (ET days), a 24-hour latency sparkline per check, and the last 30 days of incidents. Returns 503 until the migration is applied; `/status` then just hides the history.
- `GET /api/badge?target=overall|us|ca|launcher[&metric=status|uptime24h|uptime7d|uptime30d]` (public): a [shields.io endpoint](https://shields.io/badges/endpoint-badge) payload, e.g. `https://img.shields.io/endpoint?url=https://eas-launcher.your-subdomain.workers.dev/api/badge?target=us`.

A gated US 403 counts as up. The checker's own requests (User-Agent `EAS-Launcher-Status/1.0`) are still written to the access log but are left out of the admin Insights.

The panel and the status page also show a dismissible banner of active announcements from `/api/announcements?site=launcher`. The same feed is used by the US and Canada dashboards (`?site=us` or `?site=ca`).

## Announcements and admin

`/admin` is a dark-themed editor for notices (info, outage, maintenance, resolved) aimed at all sites, or just the US site, the CA site, or the launcher. Each notice can have an optional start and end. Times are 24-hour America/New_York (ET); dates display as DD/MM/YYYY.

The public feed is `GET /api/announcements?site=us|ca|launcher`. It returns only currently active notices as JSON, with CORS limited to the US, CA and launcher origins and a 30s cache. The US and CA dashboards load this from `https://eas-launcher.your-subdomain.workers.dev` and fail silently if it is unreachable.

Write APIs (`/api/admin/*`) and `/admin` itself are locked:

1. Put a Cloudflare Access self-hosted application in front of `https://eas-launcher.your-subdomain.workers.dev/admin*` and `/api/admin*` (not the public `/`, `/status`, `/api/announcements` or `/api/maintenance`). Allow only `admin@example.com`.
2. The Worker also verifies the `Cf-Access-Jwt-Assertion` header against the team's certs (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), the application AUD tag, and the allowed email. This fails closed: if Access is missing or misconfigured, or the JWT is absent or invalid, `/admin` and `/api/admin/*` return 401 or 403 and are not usable.

### Bindings and variables to create

| Binding / var | Where | Purpose |
| --- | --- | --- |
| `ANNOUNCEMENTS` | KV namespace | Stores the announcement list under the `announcements` key |
| `CF_ACCESS_TEAM_DOMAIN` | Worker var or secret | `https://<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Worker var or secret | Access application AUD tag |
| `CF_ACCESS_ALLOWED_EMAILS` | Worker var (already in `wrangler.jsonc`) | `admin@example.com` |

Create the KV namespace, then replace the placeholder `id` in `wrangler.jsonc`:

```bash
npx wrangler kv namespace create ANNOUNCEMENTS
```

Set the two Access values after the Access application exists:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

Or add them as Worker vars. Until they are set, the admin page stays locked (403, "Admin is not configured").

## Access log and admins

The admin page has an **Admins** card and an **Access log** card.

- Each of the three Workers writes visit logs to the shared D1 database `eas-access-log` (binding `ACCESS_LOG`, id `<your D1 database id>`) with `waitUntil`. Fields: time, site, method, path (no query string), status, country, the full client IP (`ip`, from `CF-Connecting-IP`), a 12-character salted SHA-256 hash of it (`ip_hash`), user agent, and on the US site a gate outcome (`challenged`, `passed`, or `api`). Noisy paths (`/api/status`, `/sw.js`, `/banner.js`, `/manifest.json`, `/api/maintenance`, `/api/uptime`, `/api/badge`, `/icon.svg`, `/favicon.ico`, and on the launcher anything under `/js/`) are skipped, or override that list with `ACCESS_LOG_EXCLUDE`. Retention is 30 days; a daily cron on this Worker prunes old rows.
- `GET /api/admin/logs` (behind the Access JWT) supports site, path, IP-prefix, status and time filters, a 24-hour count per site, and pagination. Times are 24-hour ET; dates are DD/MM/YYYY.
- `GET /api/admin/logs/stats?range=24h|7d|30d[&site=us|ca|launcher]` powers the **Insights** card: requests per hour or ET day by site, unique visitors (distinct `ip_hash`), top paths, countries, IPs, status codes and US gate outcomes. Status-checker requests are excluded.
- `GET /api/admin/logs/access-logins` reads Cloudflare Access authentication events when `CF_API_TOKEN` and `CF_ACCOUNT_ID` are set. If they are missing, the card says so and site visit logs still work.
- Extra admins are stored in the `ANNOUNCEMENTS` KV under `admins`. The Worker allow list is `CF_ACCESS_ALLOWED_EMAILS` plus that list. `admin@example.com` is permanent and cannot be removed. When `CF_API_TOKEN` is set, adds and removals are also synced to Access app `00000000-0000-4000-8000-000000000000`. Without the token, the UI tells you to also change the Access policy by hand.

Run the schema once against the database:

```bash
npx wrangler d1 execute eas-access-log --remote --file=schema/access-log.sql
```

Set these on the launcher Worker (secrets, never in the repo): `CF_API_TOKEN`, `ACCESS_LOG_SALT`. The same `ACCESS_LOG_SALT` must be set on the US and CA Workers so hashes match. Vars already in `wrangler.jsonc`: `CF_ACCOUNT_ID`, `CF_ACCESS_APP_ID`.


## Site lockout

The admin page also has an on/off switch for the US site, the CA site, and the launcher, with an optional message and expected-back time (24-hour ET, dates as DD/MM/YYYY). State is stored in the same `ANNOUNCEMENTS` KV under the `maintenance` key.

`GET /api/maintenance?site=us|ca|launcher` is public, uses the same CORS allowlist as the announcements feed, and is cached for 15s. If storage is missing or the request fails, the result is treated as off (fail open).

When a site is locked, its **pages** show a full-screen maintenance screen. The APIs keep working. These paths are never locked: `/admin`, `/api/admin/*`, `/api/status`, `/api/announcements`, and `/api/maintenance`, so you can always turn the lockout off.

**Scheduled windows.** The admin page can also schedule a lockout for one or more sites (up to 7 days, at most 20 live windows). The 5-minute cron and every public read apply it: a site is locked while a window is active, and the manual switch always wins. By default a maintenance announcement is posted at once and removed when the window ends; cancelling a window removes it too. Windows live in the same `maintenance` KV value (`schedule` array), so a public read is still one KV get.

On the launcher the Worker serves the maintenance page (HTTP 503). On the US and Canada dashboards a small client script fetches this API and overlays the screen; if the fetch fails, the site stays normal. The US Turnstile gate is not involved and is not changed.

## Deploy

See the top-level [README](../README.md) for the full self-host guide.

Deploy with this config so `/api/status` and the admin routes are not dropped:

```bash
npx wrangler deploy
```

From the repo root. Requires Wrangler auth to the Cloudflare account that owns the `your-subdomain.workers.dev` zone. Config is `wrangler.jsonc`:

- Worker name `eas-launcher`
- `main`: `src/index.js`
- `assets.directory`: `./public`
- `compatibility_date`: 19/11/2026
- `compatibility_flags`: `["global_fetch_strictly_public"]`
- `assets.run_worker_first`: `true` (so the Worker can lock `/` and `/status`; `/admin` and the listed APIs stay exempt)
- `kv_namespaces`: binding `ANNOUNCEMENTS`
- `d1_databases`: binding `ACCESS_LOG` (`eas-access-log`, id `<your D1 database id>`)
- `triggers.crons`: `15 9 * * *` (prunes access logs older than 30 days, the admin audit, and uptime history) and `*/5 * * * *` (records uptime, applies scheduled maintenance windows)
- `vars.CF_ACCESS_ALLOWED_EMAILS`: `admin@example.com`

If Wrangler is not logged in and the connector cannot upload asset buckets, regenerate the in-memory ASSETS shim and deploy that bundled Worker instead (the output is gitignored):

```bash
node scripts/build-inline.mjs
```

The generated entry is `worker-inline/shim-entry.js`. Bind `ANNOUNCEMENTS`, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` on that upload, and keep `global_fetch_strictly_public`. A later Workers Builds hook on this repo should use `npx wrangler deploy` from the repo root so `/api/status`, `/api/announcements`, `/api/maintenance` and the admin routes are not dropped.

Validate first with `npm test` and `npx wrangler deploy --dry-run`. GitHub Actions (`.github/workflows/ci.yml`) runs the same checks, the privacy sync check and the inline shim build on every push; it never deploys. After deploy, confirm `GET /`, `GET /status`, `GET /api/status`, `GET /api/announcements?site=launcher` and `GET /api/maintenance?site=launcher` return HTTP 200 when lockout is off, that US endpoints are labelled **Up, gated** rather than a fake 200, that `GET /admin` without an Access JWT is 401 or 403 (not the admin page), and that turning launcher lockout on serves a 503 maintenance page on `/` while `/admin` and `/api/maintenance` stay reachable.

## Security headers

Every launcher response gets a Content-Security-Policy (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, no plugins), HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, a Referrer-Policy and a Permissions-Policy (`src/headers.js`). Page scripts live in `public/js/` and the pages have no inline scripts or handlers; `tests/csp.test.mjs` enforces that. A handler's stricter header (e.g. the admin page's `no-referrer`) is kept.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 The EAS Authors.

## Privacy policy

`/privacy` (`public/privacy.html`) is the shared EAS privacy policy, effective 24/11/2026. It is not lockable by the maintenance switch and is not behind Access. The single source is `privacy/policy.html`; after editing it, run:

```bash
node scripts/sync-privacy.mjs          # writes launcher /privacy, CA privacy.html and the US index.html #privacy section
node scripts/sync-privacy.mjs --check  # fails if any copy is stale (used by npm test)
```

The script expects `../eas-repository` and `../eas-repository-ca` next to this repo (or `EAS_US_DIR` / `EAS_CA_DIR`). Commit and push each repo afterwards; a US push auto-deploys.
