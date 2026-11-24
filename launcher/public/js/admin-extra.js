// EAS admin: scheduled maintenance windows and access-log insights.
// Separate from admin.js so each card fails on its own. All calls go to
// /api/admin/*, which is behind Cloudflare Access.
(function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  async function api(path, options) {
    const res = await fetch(path, Object.assign({ credentials: "same-origin" }, options));
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text || res.statusText }; }
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  function etParts(date) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const get = function (type) { const p = parts.find(function (x) { return x.type === type; }); return p ? p.value : ""; };
    return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
  }

  // datetime-local value read as ET wall-clock time -> ISO (UTC).
  function inputToIso(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
    if (!m) return null;
    const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    let utc = want + 5 * 3600 * 1000;
    for (let i = 0; i < 4; i++) {
      const p = etParts(new Date(utc));
      const got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
      if (got === want) break;
      utc += want - got;
    }
    return new Date(utc).toISOString();
  }

  // ---------------------------------------------------------------- schedule
  const schedList = document.getElementById("schedList");
  const schedForm = document.getElementById("schedForm");
  const schedError = document.getElementById("schedError");
  const PHASE = { upcoming: "Upcoming", active: "Locked now", ended: "Ended" };

  function renderSchedule(list) {
    if (!schedList) return;
    if (!list || !list.length) {
      schedList.innerHTML = '<p class="empty">No windows scheduled.</p>';
      return;
    }
    schedList.innerHTML = list.map(function (w) {
      return '<article class="item ' + esc(w.phase) + '" data-window="' + esc(w.id) + '">' +
        '<div class="item-head"><div>' +
        '<h3>' + esc(w.sites_label) + '</h3>' +
        '<p>' + esc(w.start_et) + ' to ' + esc(w.end_et) + '</p>' +
        (w.message ? '<p>' + esc(w.message) + '</p>' : '') +
        '</div><div class="actions">' +
        (w.phase !== "ended" ? '<button type="button" class="danger" data-act="cancel">' + (w.phase === "active" ? "End now" : "Cancel") + '</button>' : '') +
        '</div></div>' +
        '<div class="meta"><span class="pill ' + (w.phase === "active" ? "on" : "off") + '">' + esc(PHASE[w.phase] || w.phase) + '</span>' +
        (w.announcement_id ? '<span>Announcement posted</span>' : '') +
        (w.created_by ? '<span>By ' + esc(w.created_by) + '</span>' : '') +
        '</div></article>';
    }).join("");
  }

  async function reloadAll() {
    // admin.js owns the lockout card; ask it to refresh by reloading its data too.
    const data = await api("/api/admin/maintenance");
    renderSchedule(data.schedule || []);
    return data;
  }

  document.addEventListener("eas:maintenance", function (e) {
    renderSchedule((e.detail && e.detail.schedule) || []);
  });

  if (schedForm) {
    schedForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      schedError.textContent = "";
      const sites = Array.from(schedForm.querySelectorAll('input[name="schedSite"]:checked')).map(function (b) { return b.value; });
      const start = inputToIso(document.getElementById("schedStart").value);
      const end = inputToIso(document.getElementById("schedEnd").value);
      if (!sites.length) { schedError.textContent = "Pick at least one site."; return; }
      if (!start || !end) { schedError.textContent = "Start and end are required."; return; }
      try {
        const data = await api("/api/admin/maintenance/schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sites: sites, start: start, end: end,
            message: document.getElementById("schedMessage").value,
            announce: document.getElementById("schedAnnounce").checked,
          }),
        });
        renderSchedule(data.schedule || []);
        schedForm.reset();
        document.getElementById("schedAnnounce").checked = true;
        if (data.announced === false && document.getElementById("schedAnnounce")) {
          schedError.textContent = "Scheduled, but the announcement was not posted (announcement list full).";
        }
      } catch (err) {
        schedError.textContent = err.message || "Could not schedule";
      }
    });
  }

  if (schedList) {
    schedList.addEventListener("click", async function (event) {
      const btn = event.target.closest('button[data-act="cancel"]');
      if (!btn) return;
      const id = btn.closest("[data-window]").getAttribute("data-window");
      if (!confirm("Cancel this maintenance window? Its announcement is removed too.")) return;
      try {
        const data = await api("/api/admin/maintenance/schedule/" + encodeURIComponent(id), { method: "DELETE" });
        renderSchedule(data.schedule || []);
      } catch (err) {
        schedError.textContent = err.message || "Could not cancel";
      }
    });
  }

  reloadAll().catch(function (err) {
    if (schedList) schedList.innerHTML = '<p class="error">' + esc(err.message || "Could not load the schedule") + '</p>';
  });

  // ---------------------------------------------------------------- insights
  const insBody = document.getElementById("insBody");
  const insRange = document.getElementById("insRange");
  const insSite = document.getElementById("insSite");
  const SITES = [["us", "US"], ["ca", "CA"], ["launcher", "Launcher"]];

  function hbars(rows, labelOf) {
    if (!rows || !rows.length) return '<p class="empty">No data.</p>';
    const max = Math.max.apply(null, rows.map(function (r) { return r.n; })) || 1;
    return rows.map(function (r) {
      return '<div class="hbar"><span class="t" title="' + esc(labelOf(r)) + '">' + esc(labelOf(r)) + '</span>' +
        '<span class="n">' + esc(r.n) + '</span><span class="b" style="width:' + Math.max(2, Math.round((r.n / max) * 100)) + '%"></span></div>';
    }).join("");
  }

  function chart(d) {
    const n = (d.labels || []).length;
    if (!n) return '<p class="empty">No data.</p>';
    const totals = d.labels.map(function (_, i) {
      return SITES.reduce(function (sum, s) { return sum + ((d.series[s[0]] || [])[i] || 0); }, 0);
    });
    const max = Math.max.apply(null, totals) || 1;
    const cols = d.labels.map(function (label, i) {
      const parts = SITES.map(function (s) {
        const v = (d.series[s[0]] || [])[i] || 0;
        return v ? '<span class="s-' + s[0] + '" style="height:' + ((v / max) * 100).toFixed(2) + '%"></span>' : "";
      }).join("");
      return '<div class="ins-col" title="' + esc(label + ": " + totals[i]) + '">' + parts + '</div>';
    }).join("");
    const legend = SITES.map(function (s) { return '<span><i class="s-' + s[0] + '"></i>' + s[1] + '</span>'; }).join("");
    return '<div class="ins-chart" role="img" aria-label="Requests per ' + esc(d.bucket) + ', peak ' + max + '">' + cols + '</div>' +
      '<div class="ins-axis"><span>' + esc(d.labels[0]) + '</span><span>' + esc(d.labels[n - 1]) + '</span></div>' +
      '<div class="legend">' + legend + '</div>';
  }

  function renderInsights(d) {
    const sc = d.status_classes || {};
    insBody.innerHTML =
      '<div class="summary">' +
        '<span>Requests: <strong>' + esc(d.total) + '</strong></span>' +
        '<span>Unique visitors: <strong>' + esc(d.unique_visitors) + '</strong></span>' +
        '<span>2xx ' + esc(sc["2xx"] || 0) + ' · 3xx ' + esc(sc["3xx"] || 0) + ' · 4xx ' + esc(sc["4xx"] || 0) + ' · 5xx ' + esc(sc["5xx"] || 0) + '</span>' +
        '<span>' + esc(d.from_et) + ' to ' + esc(d.to_et) + '</span>' +
      '</div>' +
      '<div class="ins-grid">' +
        '<div class="ins-box" style="grid-column:1/-1"><h3>Requests per ' + esc(d.bucket) + '</h3>' + chart(d) + '</div>' +
        '<div class="ins-box"><h3>Top paths</h3>' + hbars(d.top_paths, function (r) { return r.site + " " + r.path; }) + '</div>' +
        '<div class="ins-box"><h3>Countries</h3>' + hbars(d.countries, function (r) { return r.country; }) + '</div>' +
        '<div class="ins-box"><h3>Top IPs</h3>' + hbars(d.top_ips, function (r) { return r.ip + (r.country ? " (" + r.country + ")" : ""); }) + '</div>' +
        '<div class="ins-box"><h3>Status codes</h3>' + hbars(d.statuses, function (r) { return String(r.status); }) + '</div>' +
        '<div class="ins-box"><h3>US gate outcomes</h3>' + hbars(d.us_gate, function (r) { return r.gate; }) + '</div>' +
      '</div>';
  }

  async function loadInsights() {
    if (!insBody) return;
    const q = "range=" + encodeURIComponent(insRange.value) + (insSite.value ? "&site=" + encodeURIComponent(insSite.value) : "");
    try {
      renderInsights(await api("/api/admin/logs/stats?" + q));
    } catch (err) {
      insBody.innerHTML = '<p class="error">' + esc(err.message || "Could not load insights") + '</p>';
    }
  }

  if (insRange) insRange.addEventListener("change", loadInsights);
  if (insSite) insSite.addEventListener("change", loadInsights);
  loadInsights();
})();
