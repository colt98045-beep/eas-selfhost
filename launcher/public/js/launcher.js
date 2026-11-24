// Launcher panel: status dots from the server-side checks (/api/status),
// 24h uptime from /api/uptime, the "Open both sites" button and the banner.
// Same-origin only, so it works under the launcher's script-src/connect-src 'self' CSP.
(function () {
  var US = "https://eas-repository.your-subdomain.workers.dev/";
  var CA = "https://eas-repository-ca.your-subdomain.workers.dev/";
  var REFRESH_MS = 60000;

  var locked = { us: false, ca: false };

  function setStatus(prefix, state, label, title) {
    var dot = document.getElementById(prefix + "-dot");
    var text = document.getElementById(prefix + "-status");
    if (!dot || !text) return;
    dot.classList.remove("up", "gated", "down");
    if (state) dot.classList.add(state);
    text.textContent = label;
    text.parentElement.title = title;
  }

  // A locked site (maintenance lockout or an active scheduled window) shows as
  // DOWN with its reason and message, and hides the normal uptime line.
  function setLockout(prefix, lock) {
    var box = document.getElementById(prefix + "-lockout");
    var up = document.getElementById(prefix + "-uptime");
    var status = document.getElementById(prefix + "-status");
    locked[prefix] = Boolean(lock);
    if (status) status.parentElement.classList.toggle("locked", Boolean(lock));
    if (up) up.hidden = Boolean(lock);
    if (!box) return;
    if (!lock) { box.hidden = true; box.textContent = ""; return; }
    box.className = "lockout reason-" + (lock.reason || "maintenance");
    box.textContent = "";
    var head = document.createElement("b");
    head.textContent = "Active incident: " + (lock.icon ? lock.icon + " " : "") + (lock.reason_label || "Maintenance");
    box.appendChild(head);
    if (lock.message) box.appendChild(document.createTextNode("\n" + lock.message));
    var meta = [];
    if (lock.since_et) meta.push((lock.scheduled ? "Scheduled lockout since " : "Locked since ") + lock.since_et);
    if (lock.eta_et) meta.push("expected back " + lock.eta_et);
    if (meta.length) {
      var m = document.createElement("span");
      m.className = "lk-meta";
      m.textContent = meta.join(" · ");
      box.appendChild(m);
    }
    box.hidden = false;
  }

  function groupLabel(state) {
    if (state === "up") return "Up";
    if (state === "gated") return "Up, gated";
    if (state === "down") return "Down";
    return "Unknown";
  }

  function loadStatus() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
      .then(function (data) {
        (data.groups || []).forEach(function (group) {
          if (group.id !== "us" && group.id !== "ca") return;
          if (group.lockout) {
            var l = group.lockout;
            setStatus(group.id, "down", "Down · " + (l.icon ? l.icon + " " : "") + (l.reason_label || "Maintenance"), l.message || "Locked by the admin");
            setLockout(group.id, l);
            return;
          }
          setLockout(group.id, null);
          var down = (group.checks || []).filter(function (c) { return c.state === "down"; }).map(function (c) { return c.name; });
          var title = down.length ? "Down: " + down.join(", ") : "All checks passing · " + (data.checked_at || "");
          setStatus(group.id, group.state, groupLabel(group.state), title);
        });
      })
      .catch(function () {
        setStatus("us", null, "Unknown", "Status check failed");
        setStatus("ca", null, "Unknown", "Status check failed");
      });
  }

  function loadUptime() {
    fetch("/api/uptime", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.checks) return;
        ["us", "ca"].forEach(function (group) {
          var vals = data.checks.filter(function (c) { return c.group === group && c.uptime["24h"] != null; }).map(function (c) { return c.uptime["24h"]; });
          var el = document.getElementById(group + "-uptime");
          if (!el || locked[group]) return;
          el.textContent = vals.length ? "24h uptime " + (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length).toFixed(2) + "%" : "";
        });
      })
      .catch(function () {});
  }

  var openBoth = document.getElementById("openBoth");
  if (openBoth) {
    openBoth.addEventListener("click", function () {
      // No "noopener" feature string: with it, window.open always returns null,
      // which made the pop-up warning show even when both tabs opened.
      // The opener link is cut by hand instead.
      var first = window.open(US, "_blank");
      var second = window.open(CA, "_blank");
      if (first) first.opener = null;
      if (second) second.opener = null;
      var blocked = !first || !second;
      document.getElementById("popupWarn").hidden = !blocked;
      document.getElementById("popupHint").hidden = blocked;
    });
  }

  loadStatus();
  loadUptime();
  setInterval(function () {
    if (document.visibilityState === "visible") { loadStatus(); loadUptime(); }
  }, REFRESH_MS);

  if (window.EASAnnouncements) window.EASAnnouncements.mount({ site: "launcher" });
})();
