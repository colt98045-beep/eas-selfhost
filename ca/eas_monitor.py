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
import urllib.request
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import os

PORT = int(os.environ.get("EAS_PORT", "8080"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(BASE_DIR, "index.html")
USER_AGENT = "EASRepositoryCA/1.0 (https://github.com/your-github-user/eas-repository-ca)"

_cache = {"data": None, "ts": 0}
CACHE_TTL = 15

def fetch_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def fetch_canada_alerts():
    now = time.time()
    if _cache["data"] is not None and now - _cache["ts"] < CACHE_TTL:
        return _cache["data"]
    try:
        url = "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=500"
        data = fetch_json(url)
        features = data.get("features", [])
        alerts = []
        for f in features:
            props = f.get("properties", {})
            alerts.append({
                "id": props.get("id") or props.get("identifier") or str(hash(str(props))),
                "type": (props.get("event") or props.get("alertType") or "ALERT").upper()[:12],
                "severity": (props.get("severity") or "UNKNOWN").upper(),
                "originator": "EC",
                "callsign": "MSC",
                "translation": props.get("headline") or props.get("description") or props.get("areaDesc") or "",
                "source": "canada",
                "fipsCodes": [],
                "province": props.get("provinceCode") or "",
                "audioUrl": None,
                "effective": props.get("effective"),
                "expires": props.get("expires")
            })
        _cache["data"] = alerts
        _cache["ts"] = now
        return alerts
    except Exception as e:
        print(f"Environment Canada fetch error: {e}")
        return _cache["data"] or []

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

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

        if path == "/api/canada" or path == "/api/active":
            alerts = fetch_canada_alerts()
            self._send_json(alerts)
            return

        self.send_error(404)

    def _send_json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    print(f"Starting EAS Repository Canada on http://localhost:{PORT}")
    print(f"Serving HTML from: {HTML_FILE}")
    print("Default password: eas  (change this in Settings)")
    print("Press Ctrl+C to stop")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\nShutting down.")
        server.shutdown()
