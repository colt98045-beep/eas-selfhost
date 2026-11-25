# Changelog

All notable changes to the EAS self-host kit are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Dates are DD/MM/YYYY.

This kit tracks the launcher, US and Canada projects. Folder-level history for
the US dashboard also lives in `us/CHANGELOG.md`.

## [Unreleased]

## 24/11/2026

### Changed
- Added a documentation link to the project wiki.

### Changed
- Synced legal compliance and caching updates across `launcher/`, `us/` and
  `ca/` (preserving placeholders only): bilingual Open Government Licence –
  Canada credits and disclaimers, non-flag CA tab icon, US NOAA/NWS/FEMA/FCC
  disclaimers, 90-second Worker upstream Cache API + isolate caching, and
  accurate D1 retention windows in `/privacy`.

### Added
- Launcher incident updates, manual incidents with a type, an active-incident
  banner, and the admin unlock fix. D1 migration `0004_incident_updates.sql`
  is included in `schema/migrations/` and in the apply instructions.
- Lockout reasons and lockout incidents, tab icons, privacy pages, access-log
  IP column, uptime history, CI and security headers, synced from upstream
  with placeholders only (no deployment identifiers).
