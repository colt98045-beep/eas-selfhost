# Contributing to EAS Repository

Thanks for your interest in the project!

## Running locally

```bash
git clone https://github.com/your-github-user/eas-repository.git
cd eas-repository
python eas_monitor.py
```

Then open <http://localhost:8080> in your browser (default password: `eas`).

## Development checks

The server uses only the Python standard library. Linting uses
[ruff](https://docs.astral.sh/ruff/) (configured in `pyproject.toml`):

```bash
pip install ruff
ruff check .
ruff format --check .
```

CI also runs a JavaScript syntax check on `sw.js` and the inline script in `index.html`,
validates `manifest.json`, and starts the server for a quick smoke test.

## Reporting issues

Please open a [GitHub issue](https://github.com/your-github-user/eas-repository/issues/new/choose)
and include:

- What you expected
- What happened
- Steps to reproduce
- Python version, OS, and browser

Security problems should be reported privately. See [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork the repository.
2. Create a branch for your change.
3. Make your changes, keeping the style consistent with the existing code
   (see `.editorconfig`).
4. Check that the server starts, the dashboard loads, and the checks above pass.
5. Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
6. Open a pull request with a clear description.

## Data sources

Use the public GWES and NOAA APIs only (no scraping), keep the descriptive User-Agent, and
keep the attribution and non-affiliation notes intact. See [NOTICE](NOTICE).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE) that covers this project.
