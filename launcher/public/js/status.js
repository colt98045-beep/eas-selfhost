// /status page: live checks from /api/status (every 20s) plus 30-day uptime
// history, latency sparklines and incidents from /api/uptime (every 60s).
// External file so the page runs under script-src 'self'.
(function () {
  "use strict";
  var REFRESH_MS = 20000;
  var UPTIME_MS = 60000;
  var timer = null;
  var groupsEl = document.getElementById("groups");
  var errorEl = document.getElementById("error");
  var metaEl = document.getElementById("meta");
  var overallLabel = document.getElementById("overall-label");
  var overallDot = document.getElementById("overall-dot");
  var refreshBtn = document.getElementById("refresh");
  var incidentsEl = document.getElementById("incidents");
  var lastStatus = null;
  var uptime = null;

  function setDot(el, state) {
    el.classList.remove("up", "gated", "down");
    if (state) el.classList.add(state);
  }

  function overallText(state) {
    if (state === "up") return "All up";
    if (state === "gated") return "Up, some gated";
    if (state === "down") return "Something is down";
    return "Checking";
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function pct(v) {
    return typeof v === "number" ? (v >= 99.995 ? "100" : v.toFixed(v >= 99 ? 2 : 1)) + "%" : "—";
  }

  function barClass(day) {
    if (!day || day.uptime == null) return "";
    if (day.uptime >= 99.9) return " b-up";
    if (day.uptime >= 95) return " b-warn";
    return " b-down";
  }

  function sparkline(points) {
    var vals = (points || []).map(function (p) { return p.avg_ms; });
    var have = vals.filter(function (v) { return typeof v === "number"; });
    if (have.length < 2) return "";
    var max = Math.max.apply(null, have) || 1;
    var w = 120, h = 26, step = w / Math.max(1, vals.length - 1);
    var d = "", pen = false;
    vals.forEach(function (v, i) {
      if (typeof v !== "number") { pen = false; return; }
      var x = (i * step).toFixed(1), y = (h - 2 - (v / max) * (h - 4)).toFixed(1);
      d += (pen ? "L" : "M") + x + " " + y + " ";
      pen = true;
    });
    var last = have[have.length - 1];
    return '<svg class="spark" viewBox="0 0 120 26" preserveAspectRatio="none" role="img" aria-label="Average latency, last 24 hours, latest ' + last + ' ms, peak ' + max + ' ms"><path d="' + d.trim() + '"/></svg>';
  }

  function historyFor(id) {
    if (!uptime || !uptime.checks) return "";
    var c = null;
    for (var i = 0; i < uptime.checks.length; i++) if (uptime.checks[i].id === id) c = uptime.checks[i];
    if (!c) return "";
    var bars = (c.bars || []).map(function (day) {
      var label = day.date + ": " + (day.uptime == null ? "no data" : pct(day.uptime) + " up" + (day.down ? ", " + day.down + " failed checks" : ""));
      return '<span class="bar' + barClass(day) + '" title="' + esc(label) + '" aria-label="' + esc(label) + '" tabindex="0"></span>';
    }).join("");
    var u = c.uptime || {};
    var first = (c.bars && c.bars[0] && c.bars[0].date) || "";
    return '<div class="history">' +
      '<div class="bars" role="group" aria-label="Daily uptime, last 30 days">' + bars + '</div>' +
      '<div class="pcts">24h <b>' + pct(u["24h"]) + '</b> · 7d <b>' + pct(u["7d"]) + '</b> · 30d <b>' + pct(u["30d"]) + '</b></div>' +
      '<div class="axis"><span>' + esc(first) + '</span><span>Today</span></div>' +
      sparkline(c.spark) +
      '</div>';
  }

  function render(data) {
    lastStatus = data;
    errorEl.hidden = true;
    setDot(overallDot, data.overall);
    overallLabel.textContent = overallText(data.overall);
    var cache = data.cache || {};
    metaEl.innerHTML = "Last checked <strong>" + esc(data.checked_at) + "</strong> · " + (cache.hit ? "cached" : "fresh") + " · auto-refresh 20s";
    groupsEl.innerHTML = (data.groups || []).map(function (group) {
      var lock = group.lockout;
      var rows = (group.checks || []).map(function (check) {
        var code = check.status == null ? "—" : String(check.status);
        var latency = typeof check.latency_ms === "number" ? check.latency_ms + " ms" : "—";
        var title = check.detail ? ' title="' + esc(check.detail) + '"' : "";
        return '<div class="row">' +
          '<div class="ident"><div class="name">' + esc(check.name) + '</div>' +
          '<a class="url" href="' + esc(check.url) + '" target="_blank" rel="noopener">' + esc(check.url) + "</a></div>" +
          '<div class="status"' + title + '><span class="dot ' + esc(check.state) + '" aria-hidden="true"></span>' + esc(check.label) + "</div>" +
          '<div class="code">HTTP ' + esc(code) + "</div>" +
          '<div class="latency">' + esc(latency) + "</div>" +
          historyFor(check.id) +
          "</div>";
      }).join("");
      return '<section class="group" aria-labelledby="g-' + esc(group.id) + '">' +
        '<div class="group-head"><h2 id="g-' + esc(group.id) + '">' + esc(group.name) + "</h2>" +
        '<div class="status"><span class="dot ' + esc(group.state) + '" aria-hidden="true"></span>' +
        esc(lock ? "Down · " + (lock.icon ? lock.icon + " " : "") + (lock.reason_label || "Maintenance") : overallText(group.state)) + "</div></div>" +
        (lock ? lockoutBanner(lock) : "") +
        rows + "</section>";
    }).join("");
  }

  // A locked site shows DOWN with its reason; its checks below still show the raw probe results.
  function lockoutBanner(lock) {
    var meta = [];
    if (lock.since_et) meta.push((lock.scheduled ? "Scheduled lockout since " : "Locked since ") + lock.since_et);
    if (lock.eta_et) meta.push("expected back " + lock.eta_et);
    return '<div class="lockout reason-' + esc(lock.reason || "maintenance") + '" role="status">' +
      '<b>Active incident: ' + esc((lock.icon ? lock.icon + " " : "") + (lock.reason_label || "Maintenance")) + '</b>' +
      (lock.message ? '<p>' + esc(lock.message) + '</p>' : '') +
      (meta.length ? '<span class="lk-meta">' + esc(meta.join(" · ")) + '</span>' : '') +
      '</div>';
  }

  function incidentHtml(i) {
    var isLock = i.kind === "lockout";
    var kind = isLock
      ? '<span class="tag kind lockout reason-' + esc(i.reason || "maintenance") + '">' + esc((i.icon ? i.icon + " " : "") + "Lockout · " + (i.reason_label || "Maintenance")) + (i.scheduled ? " (scheduled)" : "") + '</span>'
      : '<span class="tag kind auto">Health check</span>';
    var what = isLock ? esc(i.check) : esc(i.check) + ' · ' + esc(i.label) + (i.status ? " (HTTP " + esc(i.status) + ")" : "");
    return '<div class="incident' + (isLock ? " is-lockout reason-" + esc(i.reason || "maintenance") : "") + '"><div>' + what + ' ' + kind + '</div>' +
      '<span class="tag ' + (i.ongoing ? "ongoing" : "resolved") + '">' + (i.ongoing ? "Ongoing" : "Resolved") + '</span>' +
      '<div class="when">' + esc(i.started_at) + (i.ended_at ? " to " + esc(i.ended_at) : " to now") + ' · ' + esc(i.duration) + '</div>' +
      (isLock && i.message ? '<div class="msg">' + esc(i.message) + '</div>' : '') +
      '</div>';
  }

  function renderUptime(data) {
    uptime = data;
    var o = data.overall || {};
    document.getElementById("up-24h").textContent = pct(o["24h"]);
    document.getElementById("up-7d").textContent = pct(o["7d"]);
    document.getElementById("up-30d").textContent = pct(o["30d"]);
    document.getElementById("open-inc").textContent = String(data.open_incidents || 0);
    var list = data.incidents || [];
    if (!data.has_data) {
      incidentsEl.innerHTML = '<p class="muted">History starts once the 5-minute uptime check has run.</p>';
    } else if (!list.length) {
      incidentsEl.innerHTML = '<p class="muted">No incidents in the last 30 days.</p>';
    } else {
      incidentsEl.innerHTML = list.map(incidentHtml).join("");
    }
    if (lastStatus) render(lastStatus);
  }

  function uptimeUnavailable() {
    if (!uptime) incidentsEl.innerHTML = '<p class="muted">Uptime history is not available yet.</p>';
  }

  function fail(message) {
    errorEl.hidden = false;
    errorEl.textContent = message;
    metaEl.textContent = "Status check failed";
    setDot(overallDot, "down");
    overallLabel.textContent = "Check failed";
  }

  function getJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function load(manual) {
    refreshBtn.disabled = true;
    getJson(manual ? "/api/status?refresh=1" : "/api/status")
      .then(render)
      .catch(function (err) { fail("Could not load /api/status. " + (err && err.message ? err.message : String(err))); })
      .then(function () { refreshBtn.disabled = false; });
  }

  function loadUptime() {
    getJson("/api/uptime").then(renderUptime).catch(uptimeUnavailable);
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () { load(false); }, REFRESH_MS);
  }

  refreshBtn.addEventListener("click", function () { load(true); loadUptime(); schedule(); });

  load(false);
  loadUptime();
  schedule();
  setInterval(loadUptime, UPTIME_MS);
  if (window.EASAnnouncements) window.EASAnnouncements.mount({ site: "launcher" });
})();
