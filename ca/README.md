# EAS Repository Canada

A local, open-source dashboard for monitoring Canadian weather and emergency alerts from Environment Canada / Meteorological Service of Canada (MSC).

It runs entirely on your machine, proxies the public GeoMet OGC API Features endpoint, and presents alerts in a clean interface with filtering, notifications, history, and more.

**Status:** v1.0.0-beta — Canadian edition. Core features working; bilingual support and province filtering still improving.

## Screenshots

<!-- Replace with actual screenshots -->

![Alerts list](https://via.placeholder.com/800x450.png?text=Canadian+Alerts+Screenshot)

## Features
- Live Environment Canada / MSC weather alerts (GeoMet)
- Province filtering
- Desktop notifications
- National radar loop (Environment Canada)
- Multiple themes
- Alert history
- PWA support
- 100% local — no accounts or API keys required

## Requirements
- Python 3.8 or newer
- Internet connection
- Modern browser

## Quick Start
```bash
git clone https://github.com/your-github-user/eas-repository-ca.git
cd eas-repository-ca
python eas_monitor.py
```
Open http://localhost:8080

Default password: `eas` (change in Settings)

## Attribution & Data Sources
- Environment Canada / Meteorological Service of Canada (MSC)
- GeoMet OGC API Features: https://api.weather.gc.ca/collections/weather-alerts/items
- MSC Datamart CAP feeds

This project is not affiliated with Environment Canada, MSC, or the Government of Canada.

Data is proxied and displayed locally. Please respect upstream terms of service.

## License
Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 The EAS Authors.

Copyright 2026 The EAS Authors

## Hosted Cloudflare Worker

The hosted Canada site is the `eas-repository-ca` Worker. `src/index.js` serves the dashboard assets and proxies `/api/canada` and `/api/active` from Environment Canada GeoMet. It also writes visit logs to the shared `ACCESS_LOG` D1 database, including the full client IP (`CF-Connecting-IP`) next to its salted hash (migration `schema/migrations/0002_add_ip.sql`; 30-day retention, pruned by the launcher). The IP hash salt is the Worker secret `ACCESS_LOG_SALT` (same value as the launcher and US Workers). Logging is best-effort and must not change API responses.

## Privacy

The privacy policy is served at `/privacy` (`privacy.html`, allowlisted in `.assetsignore`) and linked from the footer and the login screen. It is generated from `eas-launcher/privacy/policy.html` by `eas-launcher/scripts/sync-privacy.mjs`; edit it there, not here. Effective date 24/11/2026.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request: Python compile check, manifest and script syntax, Worker route tests (mocked GeoMet), access-log and privacy tests, and a credential-free `wrangler deploy --dry-run`. It does not deploy; deploys stay manual. Dependabot keeps the Actions versions current.
