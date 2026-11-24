# Deployment Guide

How to run EAS Repository locally, and how to host it elsewhere while keeping the local
option available.

- [Key files](#key-files)
- [1. Local run (recommended)](#1-local-run-recommended)
- [2. Docker](#2-docker)
- [3. Railway](#3-railway)
- [4. Render](#4-render)
- [5. Fly.io](#5-flyio)
- [6. Expose a local instance](#6-expose-a-local-instance-no-cloud-hosting)
- [7. Important notes](#7-important-notes)
- [8. Quick health check](#8-quick-health-check)
- [9. Cloudflare Workers (hosted instance)](#9-cloudflare-workers-hosted-instance)

## Key files

| File | Purpose |
| --- | --- |
| `eas_monitor.py` | Python backend: serves the dashboard and proxies GWES/NOAA feeds |
| `index.html` | Frontend dashboard |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker |

The backend uses only the Python standard library. No `pip install` is required.

## 1. Local run (recommended)

Requirements: Python 3.8+

```bash
git clone https://github.com/your-github-user/eas-repository.git
cd eas-repository
python eas_monitor.py
```

Open <http://localhost:8080>. The default password is `eas`; change it in **Settings** after
logging in.

Optional port:

```bash
export EAS_PORT=3000
python eas_monitor.py
```

Stop with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

## 2. Docker

Create a `Dockerfile` in the repo root:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
EXPOSE 8080
ENV EAS_PORT=8080
CMD ["python", "eas_monitor.py"]
```

Build and run:

```bash
docker build -t eas-repo .
docker run -p 8080:8080 eas-repo
```

`docker-compose.yml` example:

```yaml
services:
  eas:
    build: .
    ports:
      - "8080:8080"
    restart: unless-stopped
```

The same image works locally and on any Docker host.

## 3. Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Select `your-github-user/eas-repository`.
3. Deploy. Railway sets `PORT`, which the server reads automatically when `EAS_PORT` is
   not set. Railway gives you a public URL.

The server binds to `0.0.0.0`, so no other changes are needed.

## 4. Render

1. [render.com](https://render.com) → **New** → **Web Service** → connect the GitHub repo.
2. Runtime: **Python 3**
3. Build command: leave blank (no dependencies)
4. Start command: `python eas_monitor.py`
5. Deploy. Render sets `PORT`, which the server picks up automatically.

The free tier sleeps after inactivity.

## 5. Fly.io

1. Install `flyctl`.
2. Run `fly launch` (accept the defaults or use the Dockerfile above).
3. Run `fly deploy`.

## 6. Expose a local instance (no cloud hosting)

Cloudflare Tunnel (public HTTPS, no open ports):

```bash
cloudflared tunnel --url http://localhost:8080
```

Tailscale Funnel (temporary public URL):

```bash
tailscale funnel 8080
```

These keep the app running only on your machine.

## 7. Important notes

- The app is designed to be local-first. Remote hosting is optional.
- All data is proxied; nothing is stored on the server except a short in-memory cache.
- Change the default password after first login. The password lock runs in the browser
  and is **not** real authentication. For a public deployment, put the app behind an access
  layer such as Cloudflare Access or Tailscale. See [SECURITY.md](SECURITY.md).
- For production, use a process manager (systemd, a Docker restart policy, etc.).
- Requests to GWES and NOAA include a descriptive User-Agent identifying this project.

## 8. Quick health check

After starting:

```bash
curl http://localhost:8080/api/active
curl http://localhost:8080/
```

You should see JSON alerts and the HTML dashboard.

## 9. Cloudflare Workers (hosted instance)

The hosted US instance runs as a Cloudflare Worker. `wrangler.jsonc` and `src/index.js` define it: the Worker serves `index.html`, `manifest.json` and `sw.js` as static assets (see `.assetsignore`), puts a Turnstile check in front of the site, and serves `/api/active` (GWES), `/api/noaa`, `/api/noaa/{XX}` and `/api/nws` (api.weather.gov). Cloudflare Workers Builds runs `npx wrangler deploy` on every push to `main`, so keep these files in the repo. If they're removed, the next deploy ships the static page with no API. The secrets `TURNSTILE_SECRET`, `GATE_COOKIE_SECRET` and `ACCESS_LOG_SALT` live on the Worker, not in the repo. The Worker also binds the `ACCESS_LOG` D1 database (`eas-access-log`) to record visits; logging is best-effort and must not change the gate or the APIs.

### Before you push to `main`

Every push to `main`, even a docs-only one, triggers a new deploy of the live site.

- CI's **Cloudflare Worker deploy guard** job checks `src/index.js`, `wrangler.jsonc` and
  `.assetsignore`, runs the Turnstile gate and API route tests, and does a
  `wrangler deploy --dry-run`. Run the same checks locally:

  ```bash
  node scripts/check-worker-config.mjs
  node tests/worker-gate.test.mjs
  node tests/worker-api.test.mjs
  npx wrangler deploy --dry-run --outdir /tmp/worker-dry-run
  ```

- Keep `assets.run_worker_first: true`. Without it, static files skip the Turnstile check.
- Keep `.assetsignore` as `*` plus `!index.html`, `!manifest.json` and `!sw.js`, so only the
  web app is published (not `eas_monitor.py`, docs or config).
- Never put `TURNSTILE_SECRET` or `GATE_COOKIE_SECRET` in `wrangler.jsonc`. They are Worker
  secrets (`wrangler secret put`). If they are missing, the gate fails closed: visitors see
  "Verification failed" and can't get in, but nothing is exposed.
- After a deploy, an unauthenticated request to `/` or `/api/active` should return the
  Turnstile check page (HTTP 403), and `/manifest.json` should return HTTP 200.


---

Copyright 2026 The EAS Authors. Licensed under the [Apache License 2.0](LICENSE).
