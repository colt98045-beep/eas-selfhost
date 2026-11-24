# Contributing to EAS self-host kit

Thanks for your interest in the project.

## Development

```bash
git clone https://github.com/colt98045-beep/eas-selfhost.git
cd eas-selfhost
(cd launcher && npm test)
(cd us && node scripts/check-worker-config.mjs && for t in tests/*.test.mjs; do node "$t"; done)
(cd ca && for t in tests/*.test.mjs; do node "$t"; done)
```

All tests run offline with mocked upstreams. Do not add real account identifiers,
keys, emails or deployment hostnames. A secret scan is part of preparing a change.


## Reporting issues

Please open a [GitHub issue](https://github.com/colt98045-beep/eas-selfhost/issues/new/choose) and include:

- What you expected
- What happened
- Steps to reproduce
- Relevant versions (runtime, OS, browser)

Security problems should be reported privately. See [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork the repository.
2. Create a branch for your change.
3. Keep the style consistent with the existing project.
4. Run the checks above and confirm they pass.
5. Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
6. Open a pull request with a clear description.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Keep placeholder values (for example `your-subdomain.workers.dev` and `admin@example.com`) in sample config and tests.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE) that covers this project.
