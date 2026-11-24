-- Migration 0001: access log and admin audit tables.
-- Database: eas-access-log (binding ACCESS_LOG on all three Workers).
--   npx wrangler d1 execute eas-access-log --remote --file=schema/migrations/0001_init.sql
-- Then apply 0002_add_ip.sql and 0003_uptime.sql in order. All three are idempotent
-- except 0002's ALTER TABLE, which errors harmlessly ("duplicate column") if re-run.

CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  site TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  country TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  gate TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_logs_ts ON access_logs(ts);
CREATE INDEX IF NOT EXISTS idx_access_logs_site_ts ON access_logs(site, ts);
CREATE INDEX IF NOT EXISTS idx_access_logs_status_ts ON access_logs(status, ts);
CREATE INDEX IF NOT EXISTS idx_access_logs_path ON access_logs(path);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);
