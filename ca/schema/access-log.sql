-- eas-access-log (D1 id <your D1 database id>)
-- Run once against the database before the first deploy that writes logs:
--   wrangler d1 execute eas-access-log --remote --file=schema/access-log.sql
-- Existing databases: also run schema/migrations/0002_add_ip.sql once (adds the ip column).
-- Shared by eas-launcher, eas-repository, and eas-repository-ca.

CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  site TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  country TEXT,
  ip_hash TEXT,
  ip TEXT,
  user_agent TEXT,
  gate TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_logs_ts ON access_logs(ts);
CREATE INDEX IF NOT EXISTS idx_access_logs_site_ts ON access_logs(site, ts);
CREATE INDEX IF NOT EXISTS idx_access_logs_status_ts ON access_logs(status, ts);
CREATE INDEX IF NOT EXISTS idx_access_logs_path ON access_logs(path);
CREATE INDEX IF NOT EXISTS idx_access_logs_ip_ts ON access_logs(ip, ts);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);
