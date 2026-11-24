#!/usr/bin/env python3
# Copyright 2026 The EAS Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import json
import os
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

API_BASE = "https://alerts.globaleas.org"
# EAS_PORT takes precedence; PORT is the variable most hosting platforms set.
PORT = int(os.environ.get("EAS_PORT") or os.environ.get("PORT") or "8080")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(BASE_DIR, "index.html")
USER_AGENT = "EASRepository/1.0 (https://github.com/your-github-user/eas-repository)"

_cache = {"data": None, "ts": 0}
CACHE_TTL = 10


def fetch_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_active_alerts():
    now = time.time()
    if _cache["data"] is not None and now - _cache["ts"] < CACHE_TTL:
        return _cache["data"]
    try:
        data = fetch_json(f"{API_BASE}/api/v2/alerts/active")
        _cache["data"] = data
        _cache["ts"] = now
        return data
    except Exception as e:
        print(f"GlobalEAS fetch error: {e}")
        return _cache["data"] or []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Serve static PWA files
        if path in ("/manifest.json", "/sw.js"):
            fname = path.lstrip("/")
            fpath = os.path.join(BASE_DIR, fname)
            ctype = "application/json" if fname.endswith(".json") else "application/javascript"
            try:
                with open(fpath, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_error(404)
            return

        # Serve the frontend
        if path in ("/", "/index.html"):
            try:
                with open(HTML_FILE, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_error(500, "index.html not found")
            return

        # GlobalEAS active alerts
        if path == "/api/active":
            alerts = fetch_active_alerts()
            self._send_json(alerts)
            return

        # NOAA national CAP/Atom feed
        if path == "/api/noaa":
            self._proxy("https://alerts.weather.gov/cap/us.php?x=1", content_type="application/xml")
            return

        # Optional: NOAA by state (example: /api/noaa/FL)
        if path.startswith("/api/noaa/"):
            state = path.split("/")[-1].upper()
            if len(state) == 2:
                self._proxy(
                    f"https://alerts.weather.gov/cap/wwaatmget.php?x={state}",
                    content_type="application/xml",
                )
                return

        # Optional: api.weather.gov JSON (cleaner)
        if path == "/api/nws":
            self._proxy(
                "https://api.weather.gov/alerts/active",
                content_type="application/json",
                headers={"Accept": "application/geo+json", "User-Agent": USER_AGENT},
            )
            return

        self.send_error(404)

    def _send_json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def _proxy(self, url, content_type="application/xml", headers=None, timeout=20):
        try:
            hdrs = {"User-Agent": USER_AGENT}
            if headers:
                hdrs.update(headers)
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            print(f"Proxy error ({url}): {e}")
            self.send_error(502, "Upstream feed unavailable")

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"Starting EAS Repository on http://localhost:{PORT}")
    print(f"Serving HTML from: {HTML_FILE}")
    print("Press Ctrl+C to stop")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()
