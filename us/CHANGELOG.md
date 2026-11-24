# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Public `/privacy` page (effective 24/11/2026), readable without passing Turnstile because the gate logs challenged visitors. Exact-path exemption for `GET`/`HEAD` `/privacy` and `/privacy/` with no query string, served as a static string from `src/privacy.js` (no ASSETS, no API, no cookie, `default-src 'none'` CSP). Every other path, including look-alikes such as `/privacy.html` and `/privacy?x=1`, still gets the Turnstile 403. The challenge page, footer and login screen link to it; the earlier in-page `#privacy` section is removed. Generated from `eas-launcher/privacy/policy.html`. Service worker cache `eas-v4`.
- Access log rows now include the full client IP (`ip`, from `CF-Connecting-IP`) next to `ip_hash`. Run `schema/migrations/0002_add_ip.sql` once on `eas-access-log`; until then the logger falls back to the old insert. Logging hook only: the Turnstile gate, the API routes and `.assetsignore` are unchanged.
- Access logging to a shared D1 database (`ACCESS_LOG`). Writes are scheduled with `waitUntil` and cannot change the Turnstile gate or API responses. The salt for hashed IPs is the Worker secret `ACCESS_LOG_SALT`.
- Dashboard maintenance lockout, toggled from the EAS launcher admin page. A client script reads `/api/maintenance?site=us` and, if the site is locked, shows a full-screen maintenance page. If that request fails, the dashboard stays normal. The Turnstile gate, the API routes and `.assetsignore` are unchanged.
- Dismissible announcement banner on the dashboard. It reads active notices from the EAS launcher (`/api/announcements?site=us`) and fails silently if that API is unreachable. The Turnstile gate, the API routes and `.assetsignore` are unchanged.

- `DEPLOY.md` (replaces `DEPLOY.txt`) with Markdown formatting.
- `SECURITY.md`, `CHANGELOG.md`, `.editorconfig`, issue and pull request templates.
- GitHub Actions CI: ruff lint/format check, JavaScript syntax check, JSON validation,
  and a server smoke test.
- Footer in the dashboard with GWES / NOAA attribution and a non-affiliation note.
- CI job "Cloudflare Worker deploy guard": checks `wrangler.jsonc` and `.assetsignore`,
  runs Turnstile gate and API route tests for `src/index.js`, and a `wrangler deploy --dry-run`.
- The server also reads the `PORT` environment variable when `EAS_PORT` is not set.

### Fixed
- NOAA alerts now use the feed's entry ID, so the same alert no longer re-triggers
  notifications on every refresh.

### Changed
- `eas_monitor.py` formatted with ruff (no behavior change).
- External links open with `rel="noopener noreferrer"`.

## [1.0.0-beta] - 2026-11-20

### Added
- Local Python backend (standard library only) proxying the GWES Central Alert Repository
  and NOAA CAP feeds, with a short in-memory cache.
- Dashboard: active alerts, source and event filters, search, pins, history with timeline
  scrubber, approximate Leaflet map, NWS radar loop, links, and stats.
- Desktop notifications, sound, mute, keyword notification rules, and county (FIPS) alerting.
- Multiple persisted themes, settings pack export/import, and JSON export.
- PWA manifest and service worker, offline/cached status indicator.
- Password lock screen, configurable port via `EAS_PORT`.
- Apache 2.0 license, NOTICE, and CONTRIBUTING guide.
- README screenshots of the Active, History and Radar tabs.

### Fixed
- Map tab reliably displays the Leaflet map.

