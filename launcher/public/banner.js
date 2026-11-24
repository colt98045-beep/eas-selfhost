// Shared announcement banner for the launcher panel and /status.
// Fetches /api/announcements and fails silently if the API is unreachable.
(function (root) {
  var API = "/api/announcements";
  var REFRESH_MS = 60000;
  var STORAGE = "eas-ann-dismissed";

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function loadDismissed() {
    try {
      var raw = sessionStorage.getItem(STORAGE);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.map(String) : [];
    } catch (err) {
      return [];
    }
  }

  function saveDismissed(ids) {
    try {
      sessionStorage.setItem(STORAGE, JSON.stringify(ids));
    } catch (err) {
      // ignore
    }
  }

  function ensureStyle() {
    if (document.getElementById("eas-ann-style")) return;
    var style = document.createElement("style");
    style.id = "eas-ann-style";
    style.textContent = [
      "#eas-ann-host { position: sticky; top: 0; z-index: 80; display: flex; flex-direction: column; gap: 0; }",
      "#eas-ann-host:empty { display: none; }",
      ".eas-ann { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 20px; border-bottom: 1px solid rgba(255,255,255,.08); color: #f1f5f9; font-family: Inter, system-ui, sans-serif; }",
      ".eas-ann.info { background: #0b2a4a; }",
      ".eas-ann.outage { background: #4a1010; }",
      ".eas-ann.maintenance { background: #3a2a0a; }",
      ".eas-ann.resolved { background: #0d2f1c; }",
      ".eas-ann .eas-ann-body { min-width: 0; }",
      ".eas-ann .eas-ann-kicker { font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; opacity: .8; margin: 0 0 2px; }",
      ".eas-ann .eas-ann-title { margin: 0; font-size: .95rem; font-weight: 700; }",
      ".eas-ann .eas-ann-msg { margin: 2px 0 0; font-size: .85rem; color: #e2e8f0; white-space: pre-wrap; }",
      ".eas-ann .eas-ann-when { margin: 4px 0 0; font-size: .75rem; color: #cbd5e1; }",
      ".eas-ann button { flex-shrink: 0; background: transparent; border: 1px solid rgba(255,255,255,.2); color: inherit; border-radius: 8px; padding: 4px 8px; cursor: pointer; font: inherit; font-size: .8rem; }",
      ".eas-ann button:hover { background: rgba(255,255,255,.08); }",
    ].join("\n");
    document.head.appendChild(style);
  }

  function typeLabel(type) {
    if (type === "outage") return "Outage";
    if (type === "maintenance") return "Maintenance";
    if (type === "resolved") return "Resolved";
    return "Info";
  }

  function whenText(item) {
    if (item.start_et && item.end_et) return item.start_et + " — " + item.end_et;
    if (item.start_et) return "From " + item.start_et;
    if (item.end_et) return "Until " + item.end_et;
    return "";
  }

  function render(host, items, dismissed, persist) {
    host.innerHTML = "";
    items.forEach(function (item) {
      if (!item || dismissed.indexOf(String(item.id)) !== -1) return;
      var row = document.createElement("div");
      row.className = "eas-ann " + (item.type || "info");
      row.setAttribute("role", "status");
      var when = whenText(item);
      row.innerHTML =
        '<div class="eas-ann-body">' +
        '<p class="eas-ann-kicker">' + escapeHtml(typeLabel(item.type)) + "</p>" +
        '<p class="eas-ann-title">' + escapeHtml(item.title || "") + "</p>" +
        (item.message ? '<p class="eas-ann-msg">' + escapeHtml(item.message) + "</p>" : "") +
        (when ? '<p class="eas-ann-when">' + escapeHtml(when) + "</p>" : "") +
        "</div>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-label", "Dismiss announcement");
      btn.textContent = "Dismiss";
      btn.addEventListener("click", function () {
        dismissed.push(String(item.id));
        persist(dismissed);
        render(host, items, dismissed, persist);
      });
      row.appendChild(btn);
      host.appendChild(row);
    });
  }

  function mount(options) {
    options = options || {};
    var site = options.site || "launcher";
    var api = options.api || API;
    ensureStyle();
    var host = document.getElementById("eas-ann-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "eas-ann-host";
      document.body.insertBefore(host, document.body.firstChild);
    }
    var dismissed = loadDismissed();
    var last = [];

    function tick() {
      fetch(api + "?site=" + encodeURIComponent(site), { credentials: "omit", cache: "no-store" })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.announcements)) return;
          last = data.announcements;
          render(host, last, dismissed, saveDismissed);
        })
        .catch(function () {
          // fail silently
        });
    }

    tick();
    setInterval(tick, REFRESH_MS);
  }

  root.EASAnnouncements = { mount: mount };
})(window);
