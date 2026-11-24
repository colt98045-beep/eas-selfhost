# Security Policy

## Supported versions

Only the latest commit on `main` is supported. Please update before reporting an issue.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, report it privately:

1. If **Security → Report a vulnerability** is available on
   [the repository](https://github.com/your-github-user/eas-repository/security), use it.
2. Otherwise, open an issue that only says you have a security report and would like a
   private contact. Leave out any details until a private channel is set up.

Include what you found, how to reproduce it, and the impact you expect. You should get a
reply within a week.

## Scope and known limitations

EAS Repository is designed as a **local, single-user dashboard**. Keep these in mind:

- The login screen is a convenience lock, not real authentication. The password is checked
  in the browser and stored in `localStorage`. Do not rely on it to protect a public deployment.
- If you expose the server to the internet (tunnel, cloud host), put it behind a proper
  access layer (for example Cloudflare Access, Tailscale, or HTTP auth at a reverse proxy).
- The server only proxies public, read-only alert feeds and stores nothing beyond a short
  in-memory cache.

Issues in the upstream data sources (GWES, NOAA/NWS) should be reported to those providers.
