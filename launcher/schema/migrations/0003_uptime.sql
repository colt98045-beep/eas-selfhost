-- Migration 0003: uptime history for /status.
-- Database: eas-access-log (D1 id <your D1 database id>), binding ACCESS_LOG.
-- Idempotent. Apply once before deploying the launcher version that records uptime:
--   npx wrangler d1 execute eas-access-log --remote --file=schema/migrations/0003_uptime.sql
-- Written only by the eas-launcher Worker (*/5 cron). The US and CA Workers never read or write these tables.

-- One row per check per UTC hour. The 5-minute cron upserts into the current hour,
-- so a full hour has 12 samples. "up" counts both up and gated (a Turnstile 403 on
-- the US site means the Worker is up). Kept 35 days.
CREATE TABLE IF NOT EXISTS uptime_hourly (
  hour_ts INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,
  gated INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_max INTEGER NOT NULL DEFAULT 0,
  last_state TEXT,
  last_status INTEGER,
  PRIMARY KEY (hour_ts, check_id)
) WITHOUT ROWID;

-- Down/up transitions. An incident opens when a check is first seen down and
-- closes on the first later sample that is up or gated. Kept 90 days.
CREATE TABLE IF NOT EXISTS uptime_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  label TEXT,
  status INTEGER,
  samples INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_uptime_incidents_started ON uptime_incidents(started_at);
CREATE INDEX IF NOT EXISTS idx_uptime_incidents_open ON uptime_incidents(check_id, ended_at);
