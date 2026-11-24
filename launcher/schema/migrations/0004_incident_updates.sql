-- Migration 0004: incident updates (statuspage-style timeline) and manual incidents.
-- Database: eas-access-log, binding ACCESS_LOG.
-- Idempotent (CREATE ... IF NOT EXISTS only; no ALTER). Apply once before deploying the
-- launcher version that serves /api/incidents and the admin Incidents card:
--   npx wrangler d1 execute eas-access-log --remote --file=schema/migrations/0004_incident_updates.sql
-- Written only by the eas-launcher Worker. The US and CA Workers never read or write these tables.
-- Incidents themselves stay in uptime_incidents (0003): health-check rows use a check id,
-- lockout rows use "lockout:<site>", manual incidents use check_id "manual".

-- Extra fields for an incident (manual incidents always have one). One row per incident.
CREATE TABLE IF NOT EXISTS incident_meta (
  incident_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'minor',
  -- security | outage | degraded | maintenance | other
  category TEXT NOT NULL DEFAULT 'other',
  sites TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL
);

-- Timeline updates posted from /admin. Status is investigating | identified | monitoring | resolved.
CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, created_at);
