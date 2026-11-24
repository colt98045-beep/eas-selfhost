-- Migration 0002: store the full client IP (CF-Connecting-IP) next to ip_hash.
-- Database: eas-access-log (D1 id <your D1 database id>), binding ACCESS_LOG.
-- Apply ONCE, before deploying the Workers that write the column:
--   npx wrangler d1 execute eas-access-log --remote --file=schema/migrations/0002_add_ip.sql
-- SQLite has no "ADD COLUMN IF NOT EXISTS": a second run fails with
-- "duplicate column name: ip", which is harmless. Fresh databases get the
-- column from schema/access-log.sql and must not run this file.
-- Rows are still pruned after 30 days by the launcher's daily cron.
ALTER TABLE access_logs ADD COLUMN ip TEXT;
CREATE INDEX IF NOT EXISTS idx_access_logs_ip_ts ON access_logs(ip, ts);
