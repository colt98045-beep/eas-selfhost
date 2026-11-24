# EAS self-host kit

Run the EAS dashboards yourself: a **US** emergency-alert dashboard (behind a Cloudflare Turnstile gate), a **Canada** dashboard, and a **launcher** with a status page, uptime history, an announcements/maintenance admin panel locked by Cloudflare Access, and a shared access log.

You can run it two ways:

- **(a) Locally**, on your own machine, with Python (dashboards) and `wrangler dev` (Workers, local D1/KV).
- **(b) On your own Cloudflare account**, as three Workers sharing one KV namespace and one D1 database.

> This repo ships with **placeholders only**. No account ids, keys, emails or hostnames from any real deployment are included. You fill in your own (step 2 below).

> ⚠️ **The privacy policy is a template.** `launcher/privacy/policy.html` and `policy.fr.html` describe one specific deployment. You **must** rewrite them for yours (who you are, what you log, where, how long, your contact, the laws that apply to you) and delete the visible "Template notice" before you publish. It is not legal advice.

## What's in here

| Folder | What it is |
| --- | --- |
| `launcher/` | `eas-launcher` Worker + static assets: `/`, `/status`, `/privacy`, `/admin`, `/api/status`, `/api/uptime`, `/api/badge`, `/api/announcements`, `/api/maintenance`, `/api/admin/*`. Crons for log pruning, uptime and scheduled maintenance. |
| `us/` | `eas-repository` Worker: the US dashboard and its `/api/*` proxies (GWES + NOAA/NWS), all behind a Turnstile gate except `/privacy` and `/manifest.json`. Also `eas_monitor.py`, a plain local server with no gate. |
| `ca/` | `eas-repository-ca` Worker: the Canada dashboard and `/api/canada`, `/api/active` (Environment Canada GeoMet). Also `eas_monitor.py` for local use. |
| `schema/migrations/` | D1 migrations `0001_init.sql`, `0002_add_ip.sql`, `0003_uptime.sql` for the shared `eas-access-log` database. |
| `scripts/configure.mjs` | Replaces the placeholders with your values in one go. |

Each folder also has its own README with route-level detail.

## Requirements

- Node.js 22+ (tests use `node:test` and `node:sqlite`; CI uses Node 24)
- Python 3.10+ (only for the local `eas_monitor.py` servers)
- A Cloudflare account (free plan is fine) for path (b), and `npx wrangler login`

## 1. Run the tests

```bash
(cd launcher && npm test)
(cd us && node scripts/check-worker-config.mjs && for t in tests/*.test.mjs; do node "$t"; done)
(cd ca && for t in tests/*.test.mjs; do node "$t"; done)
```

All tests run offline with mocked upstreams.

## 2. Fill in your values

Placeholders you will see:

| Placeholder | Where it comes from |
| --- | --- |
| `your-subdomain.workers.dev` | Your workers.dev subdomain (Workers & Pages → overview), or edit the origins in `launcher/src/status.js` if you use custom domains |
| `admin@example.com` | Your email: the permanent admin (`launcher/src/admins.js`, `access-sync.js`, `CF_ACCESS_ALLOWED_EMAILS`) and the privacy contact |
| `REPLACE_WITH_ACCOUNT_ID` | Cloudflare dashboard → Account ID |
| `REPLACE_WITH_KV_NAMESPACE_ID` | `npx wrangler kv namespace create ANNOUNCEMENTS` |
| `REPLACE_WITH_D1_DATABASE_ID` | `npx wrangler d1 create eas-access-log` |
| `your-team.cloudflareaccess.com` | Zero Trust → Settings → Custom pages / team domain |
| `REPLACE_WITH_ACCESS_APP_AUD_TAG`, `REPLACE_WITH_ACCESS_APP_ID` | Zero Trust → Access → Applications → your admin app (step 4b) |
| `1x00000000000000000000AA` | Turnstile site key (this default is Cloudflare's always-pass **test** key) |
| `your-github-user` | Your GitHub user, for repo links |
| `[YOUR NAME OR ORGANIZATION]` | Your name in the privacy policy |

Replace them all at once:

```bash
node scripts/configure.mjs --dry-run --subdomain my-sub --admin-email me@mydomain.com   # preview
node scripts/configure.mjs \
  --subdomain my-sub --admin-email me@mydomain.com --github-user me \
  --account-id <id> --kv-id <id> --d1-id <id> \
  --access-team my-team --access-aud <aud> --access-app-id <id> \
  --turnstile-sitekey 0x... --operator "My Name"
```

You can pass only the values you have and run it again later. Then edit the privacy policy text (see the warning above) and regenerate the three copies:

```bash
(cd launcher && node scripts/sync-privacy.mjs)
```

## 3. Path (a): run locally

### Dashboards only (simplest)

```bash
(cd us && EAS_PORT=8080 python3 eas_monitor.py)   # http://localhost:8080
(cd ca && EAS_PORT=8081 python3 eas_monitor.py)   # http://localhost:8081
```

These serve the dashboards and their `/api/*` proxies directly. There is no Turnstile gate, no logging and no D1. The dashboards still try to read announcements and maintenance state from your launcher URL; if that is unreachable they simply show nothing.

### Workers with wrangler dev (local KV + D1)

Use one shared state directory so all three Workers see the same local D1:

```bash
for d in launcher us ca; do cp $d/.dev.vars.example $d/.dev.vars; done   # then edit them

cd launcher
npm install --no-save wrangler            # or use npx wrangler everywhere
npx wrangler d1 migrations apply eas-access-log --local --persist-to ../.wrangler-state
npx wrangler dev --port 8787 --persist-to ../.wrangler-state --test-scheduled
# cron test: curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

```bash
(cd us && npx wrangler dev --port 8788 --persist-to ../.wrangler-state)
(cd ca && npx wrangler dev --port 8789 --persist-to ../.wrangler-state)
```

Local caveats:

- **Admin (`/admin`) needs Cloudflare Access** and fails closed locally (403) unless the request carries a valid Access JWT. Develop admin UI against a deployed launcher, or temporarily point `CF_ACCESS_*` at a real Access app.
- **The US gate cannot be passed with Cloudflare's dummy Turnstile keys**: the Worker requires `action: "gate"` and a hostname from `TURNSTILE_HOSTNAMES`, and test keys return neither. Create a real Turnstile widget whose hostnames include `localhost`, put its site key in `us/wrangler.jsonc` (or `--var TURNSTILE_SITEKEY:...`), its secret in `us/.dev.vars`, and add `localhost` to `TURNSTILE_HOSTNAMES` for local runs only. Do not weaken the checks.
- The launcher's status checks, CORS allowlist and the dashboards' banner scripts use the `*.your-subdomain.workers.dev` origins, so locally they point at your deployed sites, not at localhost.

## 4. Path (b): deploy to your Cloudflare account

All commands run with `npx wrangler` after `npx wrangler login`.

### 4a. Storage

```bash
npx wrangler kv namespace create ANNOUNCEMENTS     # -> KV id
npx wrangler d1 create eas-access-log              # -> D1 id
node scripts/configure.mjs --kv-id <kv id> --d1-id <d1 id> --account-id <account id> --subdomain <sub>
cd launcher && npx wrangler d1 migrations apply eas-access-log --remote && cd ..
```

`migrations apply` runs `schema/migrations/0001_init.sql`, `0002_add_ip.sql` and `0003_uptime.sql` in order and records what it applied. To apply them by hand instead:

```bash
cd launcher
for f in 0001_init 0002_add_ip 0003_uptime; do
  npx wrangler d1 execute eas-access-log --remote --file=../schema/migrations/$f.sql
done
```

All three Workers bind the same D1 database as `ACCESS_LOG`. Only the launcher binds the KV namespace (`ANNOUNCEMENTS`).

### 4b. Cloudflare Access for the admin panel

1. Zero Trust → Access → Applications → **Add a self-hosted application**.
2. Domain: `eas-launcher.<sub>.workers.dev` with paths `/admin*` and `/api/admin*` only. Do **not** protect `/`, `/status`, `/privacy` or the public APIs.
3. Policy: **Allow**, include your email (the one you set as `admin@example.com`). Short session (for example 5 minutes to 24 hours).
4. Copy the application **AUD tag** and **application id**, and your **team domain**, then:
   `node scripts/configure.mjs --access-team <team> --access-aud <aud> --access-app-id <id>`

The Worker verifies the `Cf-Access-Jwt-Assertion` JWT itself (issuer, AUD, signature, email allow list) and fails closed if any of it is missing.

**Optional** (lets the admin page add/remove admins on the Access policy and show Access login events): create an account API token with **Access: Apps and Policies Edit** and **Access: Audit Logs Read**, then `cd launcher && npx wrangler secret put CF_API_TOKEN`. Without it the panel still works and tells you to edit the Access policy by hand.

### 4c. Turnstile for the US site

1. Turnstile → **Add widget**, hostname `eas-repository.<sub>.workers.dev`, mode Managed.
2. Put the **site key** in `us/wrangler.jsonc` (`TURNSTILE_SITEKEY`, or `configure.mjs --turnstile-sitekey`). Keep `TURNSTILE_HOSTNAMES` equal to the hostname(s) the US Worker is served on.
3. Secrets:

```bash
cd us
npx wrangler secret put TURNSTILE_SECRET        # the widget's secret key
npx wrangler secret put GATE_COOKIE_SECRET      # openssl rand -base64 48
```

### 4d. Shared secret

Use the **same** value on all three Workers so hashed IPs line up across sites:

```bash
SALT=$(openssl rand -base64 48)
for d in launcher us ca; do (cd $d && echo "$SALT" | npx wrangler secret put ACCESS_LOG_SALT); done
```

### 4e. Deploy

```bash
(cd ca && npx wrangler deploy)
(cd us && node scripts/check-worker-config.mjs && npx wrangler deploy)
(cd launcher && npx wrangler deploy)
```

`launcher/wrangler.jsonc` registers two **crons**:

| Cron | Does |
| --- | --- |
| `15 9 * * *` (daily, UTC) | Deletes access-log rows and admin audit rows older than 30 days, and old uptime history (hourly rows 35 days, incidents 90 days) |
| `*/5 * * * *` | Records uptime for every status check and starts/ends scheduled maintenance windows |

If you deploy through the dashboard or an API upload instead of `wrangler deploy`, add both crons under the Worker's **Settings → Triggers** yourself. If you cannot upload assets that way, `node launcher/scripts/build-inline.mjs` builds a single-file Worker with the assets embedded.

### 4f. Check it

- `https://eas-launcher.<sub>.workers.dev/` and `/status` return 200; `/api/uptime` returns 200 (503 means migration 0003 is missing). After about 5 minutes the status page shows uptime bars.
- `/admin` redirects to your Access login; after login the admin page loads.
- `https://eas-repository.<sub>.workers.dev/` returns the Turnstile challenge (403) without the gate cookie; `/privacy` and `/manifest.json` return 200.
- `https://eas-repository-ca.<sub>.workers.dev/`, `/api/canada` and `/api/active` return 200.

## Security notes

- Never commit `.dev.vars`, tokens or salts. `wrangler.jsonc` holds only non-secret ids.
- Keep the US gate checks (action, hostname, signed cookie, `run_worker_first`) intact. `us/scripts/check-worker-config.mjs` fails if the config would bypass the gate.
- The access log stores **full client IPs** for 30 days. That is personal data in most places. Say so in your privacy policy, or change the code if you don't want it.
- Every launcher response carries a strict CSP (`script-src 'self'`). Keep page scripts in `launcher/public/js/`.

## License

[Apache License 2.0](LICENSE). Copyright 2026 The EAS Authors. Third-party data notices for the US dashboard are in `us/NOTICE`.
