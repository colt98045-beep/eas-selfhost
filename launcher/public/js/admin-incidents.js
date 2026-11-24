// EAS admin: Incidents card. Post statuspage-style updates on any incident
// (health-check, lockout or manual), edit/delete your own updates, create manual incidents.
// External file so it runs under script-src 'self'. All text is escaped before insertion.
(function () {
  "use strict";
  var list = document.getElementById("incList");
  var errorEl = document.getElementById("incError");
  var form = document.getElementById("incNewForm");
  if (!list) return;
  var me = "";
  var STATUS = [["investigating", "Investigating"], ["identified", "Identified"], ["monitoring", "Monitoring"], ["resolved", "Resolved"]];
  var SEV = { critical: "Critical", major: "Major", minor: "Minor", maintenance: "Maintenance" };
  var KIND = { outage: "Health check", manual: "Manual", lockout: "Lockout" };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  async function api(path, options) {
    var res = await fetch(path, Object.assign({ credentials: "same-origin" }, options));
    var text = await res.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text || res.statusText }; }
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  function send(path, method, body) {
    return api(path, { method: method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  }

  function statusOptions(selected, allowResolved) {
    return STATUS.filter(function (s) { return allowResolved || s[0] !== "resolved"; }).map(function (s) {
      return '<option value="' + s[0] + '"' + (s[0] === selected ? " selected" : "") + ">" + s[1] + "</option>";
    }).join("");
  }

  function incidentHtml(i) {
    var badge = i.kind === "lockout"
      ? (i.icon ? i.icon + " " : "") + "Lockout · " + (i.reason_label || "")
      : (i.category_label || "Other") + " · " + (KIND[i.kind] || "Incident") + " · " + (SEV[i.severity] || i.severity);
    var updates = (i.updates || []).map(function (u) {
      var mine = me && u.author && u.author.toLowerCase() === me.toLowerCase();
      return '<li class="upd st-' + esc(u.status) + '" data-update="' + esc(u.id) + '" data-status="' + esc(u.status) + '">' +
        '<b>' + esc(u.status_label) + '</b> · ' + esc(u.at) + (u.edited ? " (edited " + esc(u.edited) + ")" : "") + " · " + esc(u.author || "") +
        '<p>' + esc(u.body) + '</p>' +
        (mine ? '<div class="actions"><button type="button" data-act="edit">Edit</button><button type="button" class="danger" data-act="delete">Delete</button></div>' : "") +
        "</li>";
    }).join("");
    var lockNote = i.kind === "lockout" && i.ongoing ? '<p class="hint">Resolves automatically when the site is unlocked in the Maintenance card.</p>' : "";
    return '<article class="item" data-incident="' + esc(i.id) + '">' +
      '<div class="item-head"><div><h3>' + esc(i.title) + "</h3>" +
      "<p>" + esc(badge) + (i.sites_label ? " · " + esc(i.sites_label) : "") + "</p>" +
      "<p>" + esc(i.started_at) + (i.ended_at ? " to " + esc(i.ended_at) : " to now") + " · " + esc(i.duration) + "</p></div>" +
      '<span class="pill ' + (i.ongoing ? "on" : "off") + '">' + (i.ongoing ? "Ongoing" : "Resolved") + "</span></div>" +
      (updates ? '<ol class="inc-updates">' + updates + "</ol>" : "") + lockNote +
      '<form class="inc-post" autocomplete="off"><div class="row">' +
      '<label>Status <select name="status">' + statusOptions(i.ongoing ? "identified" : "resolved", !(i.kind === "lockout" && i.ongoing)) + "</select></label></div>" +
      '<label>Update (max 1000 characters)<textarea name="body" maxlength="1000" required></textarea></label>' +
      '<div class="actions"><button class="primary" type="submit">Post update</button></div></form>' +
      "</article>";
  }

  function render(data) {
    me = data.me || me;
    var all = (data.active || []).concat(data.recent || []);
    list.innerHTML = all.length ? all.map(incidentHtml).join("") : '<p class="empty">No incidents in the last 30 days.</p>';
    if (data.updates_enabled === false) errorEl.textContent = "Incident updates need migration 0004 (incident_updates) applied.";
  }

  function fail(err) { errorEl.textContent = (err && err.message) || "Request failed"; }

  async function load() {
    try { render(await api("/api/admin/incidents")); } catch (err) { list.innerHTML = '<p class="error">' + esc(err.message || "Could not load incidents") + "</p>"; }
  }

  list.addEventListener("submit", async function (event) {
    var f = event.target.closest("form.inc-post");
    if (!f) return;
    event.preventDefault();
    errorEl.textContent = "";
    var id = f.closest("[data-incident]").getAttribute("data-incident");
    try {
      render(await send("/api/admin/incidents/" + encodeURIComponent(id) + "/updates", "POST", {
        status: f.querySelector('[name="status"]').value,
        body: f.querySelector('[name="body"]').value,
      }));
    } catch (err) { fail(err); }
  });

  list.addEventListener("click", async function (event) {
    var btn = event.target.closest("button[data-act]");
    if (!btn) return;
    var li = btn.closest("[data-update]");
    var id = btn.closest("[data-incident]").getAttribute("data-incident");
    var path = "/api/admin/incidents/" + encodeURIComponent(id) + "/updates/" + encodeURIComponent(li.getAttribute("data-update"));
    errorEl.textContent = "";
    try {
      if (btn.getAttribute("data-act") === "delete") {
        if (!confirm("Delete this update?")) return;
        render(await send(path, "DELETE"));
      } else {
        var current = li.querySelector("p") ? li.querySelector("p").textContent : "";
        var text = prompt("Edit update text (max 1000 characters)", current);
        if (text == null) return;
        render(await send(path, "PATCH", { status: li.getAttribute("data-status"), body: text }));
      }
    } catch (err) { fail(err); }
  });

  if (form) {
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      errorEl.textContent = "";
      var sites = Array.from(form.querySelectorAll('input[name="incSite"]:checked')).map(function (b) { return b.value; });
      try {
        render(await send("/api/admin/incidents", "POST", {
          title: document.getElementById("incNewTitle").value,
          sites: sites,
          severity: document.getElementById("incNewSeverity").value,
          category: document.getElementById("incNewCategory").value,
          status: document.getElementById("incNewStatus").value,
          body: document.getElementById("incNewBody").value,
        }));
        form.reset();
      } catch (err) { fail(err); }
    });
  }

  load();
})();
