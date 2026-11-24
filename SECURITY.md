# Security Policy

## Supported versions

Only the latest commit on `main` is supported. Please update before reporting an issue.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, report it privately:

1. If **Security → Report a vulnerability** is available on
   [this repository](https://github.com/colt98045-beep/eas-selfhost/security), use it.
2. Otherwise, open an issue that only says you have a security report and would like a
   private contact. Leave out any details until a private channel is set up.

Include what you found, how to reproduce it, and the impact you expect. You should get a
reply within a week.

## Scope and known limitations

This repository is a self-host kit with placeholders only. It must not contain
account identifiers, keys, emails or hostnames from a real deployment.

- Never commit `.dev.vars`, tokens, salts or credentials.
- Keep the United States Turnstile gate intact in `us/`. Do not add gate
  exemptions except the exact-path public `/privacy`. Do not weaken
  `/api/active`, `/api/noaa`, `/api/noaa/{{XX}}` or `/api/nws`.
- The access log can store full client IPs. Treat that as personal data and
  describe it in your own privacy policy, or change the code if you do not
  want to store it.
- `scripts/check-worker-config.mjs` in `us/` fails if the Worker config would
  bypass the gate. Leave those checks in place.


Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.
