// Launcher home: active-incident banner from /api/incidents (same origin, CSP-safe).
// Built with DOM nodes and textContent only, so update text can never inject markup.
(function () {
  "use strict";
  var host = document.getElementById("incidentBanner");
  if (!host) return;
  var MAX_SHOWN = 3;
  var SEVERITY = { critical: "#ef4444", major: "#f97316", minor: "#eab308", maintenance: "#3b82f6" };
  var SEV_LABEL = { critical: "Critical", major: "Major", minor: "Minor", maintenance: "Maintenance" };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function colour(i) {
    return (i.kind === "lockout" && i.color) || SEVERITY[i.severity] || SEVERITY.major;
  }

  function item(i) {
    var box = el("div", "inc-banner sev-" + (i.kind === "lockout" ? "lockout reason-" + (i.reason || "maintenance") : i.severity || "major"));
    box.style.setProperty("--sev", colour(i));
    var head = el("div", "inc-head");
    head.appendChild(el("span", "inc-sev", i.kind === "lockout" ? (i.icon ? i.icon + " " : "") + (i.reason_label || "Lockout") : (i.category_label || "Incident") + " · " + (SEV_LABEL[i.severity] || "Major")));
    head.appendChild(el("strong", "inc-title", i.title || "Incident"));
    if (i.sites_label) head.appendChild(el("span", "inc-sites", i.sites_label));
    box.appendChild(head);
    var u = i.latest_update;
    var text = u ? u.status_label + ": " + u.body : i.kind === "lockout" && i.message ? i.message : "We're looking into it.";
    box.appendChild(el("p", "inc-text", text));
    var meta = el("p", "inc-meta");
    meta.appendChild(document.createTextNode((u ? "Updated " + u.at : "Since " + i.started_at) + " · "));
    var a = el("a", null, "Details on the status page");
    a.href = "/status#incidents";
    meta.appendChild(a);
    box.appendChild(meta);
    return box;
  }

  function render(data) {
    var active = (data && data.active) || [];
    host.textContent = "";
    if (!active.length) { host.hidden = true; return; }
    if (active.length > 1) host.appendChild(el("p", "inc-count", active.length + " active incidents"));
    active.slice(0, MAX_SHOWN).forEach(function (i) { host.appendChild(item(i)); });
    if (active.length > MAX_SHOWN) {
      var more = el("p", "inc-more");
      var link = el("a", null, "+" + (active.length - MAX_SHOWN) + " more on the status page");
      link.href = "/status#incidents";
      more.appendChild(link);
      host.appendChild(more);
    }
    host.hidden = false;
  }

  function load() {
    fetch("/api/incidents", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data) render(data); })
      .catch(function () {});
  }

  window.EASIncidentBanner = { render: render };
  load();
  setInterval(function () { if (document.visibilityState === "visible") load(); }, 60000);
})();
