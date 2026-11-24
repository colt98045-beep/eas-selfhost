// EAS admin page script (moved out of admin.html so the page runs under
// script-src 'self'). The APIs it calls are all behind Cloudflare Access.
(function () {
  const form = document.getElementById("form");
  const listEl = document.getElementById("list");
  const formError = document.getElementById("formError");
  const formTitle = document.getElementById("formTitle");
  const saveBtn = document.getElementById("saveBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const targetBoxes = Array.from(document.querySelectorAll('input[name="target"]'));
  let items = [];
  // All page state is declared here, before any load runs (a `let` read before
  // its declaration throws a TDZ ReferenceError and the card never loads).
  let logPage = 1;

  function etParts(date) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
    return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
  }

  function formatEt(iso) {
    if (!iso) return "";
    const p = etParts(new Date(iso));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ET`;
  }

  function isoToInput(iso) {
    if (!iso) return "";
    const p = etParts(new Date(iso));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  function inputToIso(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const hour = Number(match[4]), minute = Number(match[5]);
    let utc = Date.UTC(year, month - 1, day, hour + 5, minute);
    for (let i = 0; i < 4; i++) {
      const p = etParts(new Date(utc));
      const got = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
      const want = Date.UTC(year, month - 1, day, hour, minute);
      if (got === want) break;
      utc += want - got;
    }
    return new Date(utc).toISOString();
  }

  const maintGrid = document.getElementById("maintGrid");
  const maintError = document.getElementById("maintError");
  const SITE_ORDER = ["us", "ca", "launcher"];
  const REASONS = [["maintenance", "🔧 Maintenance"], ["outage", "⚠️ Outage"], ["update", "⬆️ Update"], ["other", "ℹ️ Other"]];

  function reasonFields(reason, reasonText, prefix) {
    const r = REASONS.some(([v]) => v === reason) ? reason : "maintenance";
    const opts = REASONS.map(([v, l]) => `<option value="${v}"${v === r ? " selected" : ""}>${l}</option>`).join("");
    return `<label>Reason
          <select name="reason" class="reason-select">${opts}</select>
        </label>
        <label class="reason-other"${r === "other" ? "" : " hidden"}>Custom reason (max 40 characters)
          <input name="reason_text" maxlength="40" value="${escapeHtml(reasonText || "")}"${prefix ? ` id="${prefix}ReasonText"` : ""}>
        </label>`;
  }

  // Button text matches what pressing it will do (was: "Lock site" shown while unlocking).
  function maintButtonLabel(wasOn, checked) {
    if (wasOn) return checked ? "Update lockout" : "Unlock site";
    return checked ? "Lock site" : "Save (stays open)";
  }

  function renderMaintenance(sites) {
    maintGrid.innerHTML = SITE_ORDER.map((id) => {
      const row = (sites && sites[id]) || { on: false, message: "", eta: null, label: id };
      const checked = row.on ? "checked" : "";
      const onClass = row.on || row.effective_on ? " on" : "";
      const label = row.on ? "Locked" : "Open";
      const action = maintButtonLabel(!!row.on, !!row.on);
      return `<form class="maint-site${onClass}" data-site="${id}" data-was-on="${row.on ? "1" : "0"}">
        <div class="maint-head">
          <h3>${escapeHtml(row.label || id)}${!row.on && row.scheduled ? ` <span class="pill sched">Scheduled lock until ${escapeHtml(row.scheduled.end_et || "")}</span>` : ""}</h3>
          <label class="toggle"><input type="checkbox" name="on" ${checked}><span class="toggle-state">${label}</span></label>
        </div>
        ${row.on ? `<p class="meta"><span class="pill reason-${escapeHtml(row.reason || "maintenance")}">${escapeHtml(row.reason_label || "Maintenance")}</span></p>` : ""}
        ${reasonFields(row.reason, row.reason_text)}
        <label>Message (optional)
          <textarea name="message" maxlength="2000">${escapeHtml(row.message || "")}</textarea>
        </label>
        <label>Expected back (optional, ET)
          <input name="eta" type="datetime-local" step="60" value="${isoToInput(row.eta) || ""}">
        </label>
        <div class="actions">
          <button class="primary" type="submit">${action}</button>
        </div>
      </form>`;
    }).join("");
  }

  async function loadMaintenance() {
    const data = await api("/api/admin/maintenance");
    renderMaintenance(data.sites || {});
  }

  function selectedTargets() {

    return targetBoxes.filter((box) => box.checked).map((box) => box.value);
  }

  function setTargets(values) {
    const set = new Set(values && values.length ? values : ["all"]);
    targetBoxes.forEach((box) => {
      box.checked = set.has(box.value);
    });
    syncTargets();
  }

  function syncTargets() {
    const all = targetBoxes.find((box) => box.value === "all");
    targetBoxes.forEach((box) => {
      if (box.value !== "all") box.disabled = all.checked;
      if (all.checked && box.value !== "all") box.checked = false;
    });
  }

  targetBoxes.forEach((box) => box.addEventListener("change", () => {
    if (box.value === "all" && box.checked) {
      targetBoxes.forEach((other) => { if (other.value !== "all") other.checked = false; });
    }
    if (box.value !== "all" && box.checked) {
      targetBoxes.find((other) => other.value === "all").checked = false;
    }
    syncTargets();
  }));
  syncTargets();

  function resetForm() {
    form.reset();
    document.getElementById("id").value = "";
    setTargets(["all"]);
    formTitle.textContent = "New announcement";
    saveBtn.textContent = "Publish";
    cancelBtn.hidden = true;
    formError.textContent = "";
  }

  function fillForm(item) {
    document.getElementById("id").value = item.id;
    document.getElementById("title").value = item.title || "";
    document.getElementById("message").value = item.message || "";
    document.getElementById("type").value = item.type || "info";
    document.getElementById("start").value = isoToInput(item.start);
    document.getElementById("end").value = isoToInput(item.end);
    setTargets(item.targets);
    formTitle.textContent = "Edit announcement";
    saveBtn.textContent = "Save changes";
    cancelBtn.hidden = false;
    formError.textContent = "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function renderList() {
    if (!items.length) {
      listEl.innerHTML = '<p class="empty">No announcements yet.</p>';
      return;
    }
    listEl.innerHTML = items.map((item) => {
      const when = [item.start_et || formatEt(item.start), item.end_et || formatEt(item.end)].filter(Boolean).join(" — ");
      const targets = (item.targets || []).join(", ");
      return `<article class="item ${escapeHtml(item.type || "info")}" data-id="${escapeHtml(item.id)}">
        <div class="item-head">
          <div>
            <h3>${escapeHtml(item.title || "")}</h3>
            <p>${escapeHtml(item.message || "")}</p>
          </div>
          <div class="actions">
            <button type="button" data-act="edit">Edit</button>
            <button type="button" class="danger" data-act="delete">Delete</button>
          </div>
        </div>
        <div class="meta">
          <span class="pill ${item.active ? "on" : "off"}">${item.active ? "Active" : "Inactive"}</span>
          <span class="pill">${escapeHtml(item.type || "info")}</span>
          <span>Targets: ${escapeHtml(targets)}</span>
          ${when ? `<span>${escapeHtml(when)}</span>` : ""}
          ${item.created_by ? `<span>By ${escapeHtml(item.created_by)}</span>` : ""}
        </div>
      </article>`;
    }).join("");
  }

  async function api(path, options) {
    const res = await fetch(path, Object.assign({ credentials: "same-origin" }, options));
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || res.statusText }; }
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  async function load() {
    const data = await api("/api/admin/announcements");
    items = data.announcements || [];
    renderList();
  }

  document.getElementById("who").textContent = "Loading…";
  api("/api/admin/me")
    .then((me) => {
      document.getElementById("who").textContent = "Signed in as " + (me.email || "unknown") + (me.storage === "unavailable" ? " — announcement storage is not bound yet." : "");
    })
    .catch((err) => {
      document.getElementById("who").textContent = err.message || "Access required";
    });

  async function loadAdmins() {
    const data = await api("/api/admin/admins");
    const list = document.getElementById("adminList");
    const note = document.getElementById("adminSyncNote");
    if (note) note.textContent = (data.sync && data.sync.note) || "";
    const rows = (data.admins || []).map((admin) => {
      const badge = admin.permanent ? '<span class="pill on">Permanent</span>' : "";
      const remove = admin.permanent ? "" : `<button type="button" class="danger" data-email="${escapeHtml(admin.email)}">Remove</button>`;
      return `<div class="admin-row"><div><strong>${escapeHtml(admin.email)}</strong> ${badge}</div>${remove}</div>`;
    });
    list.innerHTML = rows.join("") || '<p class="empty">No admins.</p>';
  }

  document.getElementById("adminList").addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-email]");
    if (!btn) return;
    const email = btn.getAttribute("data-email");
    if (!confirm("Remove " + email + " as an admin?")) return;
    document.getElementById("adminError").textContent = "";
    try {
      await api("/api/admin/admins?email=" + encodeURIComponent(email), { method: "DELETE" });
      await loadAdmins();
    } catch (err) {
      document.getElementById("adminError").textContent = err.message || "Remove failed";
    }
  });

  document.getElementById("adminForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    document.getElementById("adminError").textContent = "";
    try {
      await api("/api/admin/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: document.getElementById("adminEmail").value }),
      });
      document.getElementById("adminEmail").value = "";
      await loadAdmins();
    } catch (err) {
      document.getElementById("adminError").textContent = err.message || "Add failed";
    }
  });


  function logQuery(page) {
    const params = new URLSearchParams();
    const site = document.getElementById("logSite").value;
    const pathVal = document.getElementById("logPath").value.trim();
    const status = document.getElementById("logStatus").value.trim();
    const ipVal = document.getElementById("logIp").value.trim();
    const from = inputToIso(document.getElementById("logFrom").value);
    const to = inputToIso(document.getElementById("logTo").value);
    if (site) params.set("site", site);
    if (pathVal) params.set("path", pathVal);
    if (ipVal) params.set("ip", ipVal);
    if (status) params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("page", String(page || 1));
    params.set("limit", "50");
    return params.toString();
  }

  async function loadLogs(page) {
    logPage = page || 1;
    const data = await api("/api/admin/logs?" + logQuery(logPage));
    const summary = document.getElementById("logSummary");
    const s = data.summary || {};
    summary.innerHTML = `<span>US 24h: ${s.us || 0}</span><span>CA 24h: ${s.ca || 0}</span><span>Launcher 24h: ${s.launcher || 0}</span><span>Total 24h: ${s.total || 0}</span>`;
    const logs = data.logs || [];
    if (!logs.length) {
      document.getElementById("logTable").innerHTML = '<p class="empty">No visits in this range.</p>';
    } else {
      document.getElementById("logTable").innerHTML = `<table><thead><tr><th>Time (ET)</th><th>Site</th><th>Method</th><th>Path</th><th>Status</th><th>Country</th><th>Gate</th><th>IP</th><th>IP hash</th></tr></thead><tbody>${logs.map((row) => `<tr>
        <td>${escapeHtml(row.ts_et || "")}</td>
        <td>${escapeHtml(row.site || "")}</td>
        <td>${escapeHtml(row.method || "")}</td>
        <td class="mono">${escapeHtml(row.path || "")}</td>
        <td>${escapeHtml(String(row.status ?? ""))}</td>
        <td>${escapeHtml(row.country || "")}</td>
        <td>${escapeHtml(row.gate || "")}</td>
        <td class="mono">${row.ip ? `<button type="button" class="linklike mono" data-ip="${escapeHtml(row.ip)}" title="Show only this IP">${escapeHtml(row.ip)}</button>` : "—"}</td>
        <td class="mono">${escapeHtml(row.ip_hash || "")}</td>
      </tr>`).join("")}</tbody></table>`;
    }
    const pager = document.getElementById("logPager");
    const pages = data.pages || 1;
    pager.innerHTML = `<button type="button" data-page="${Math.max(1, logPage - 1)}" ${logPage <= 1 ? "disabled" : ""}>Previous</button><span>Page ${logPage} of ${pages} (${data.total || 0} visits)</span><button type="button" data-page="${Math.min(pages, logPage + 1)}" ${logPage >= pages ? "disabled" : ""}>Next</button>`;
  }

  document.getElementById("logFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    loadLogs(1).catch((err) => {
      document.getElementById("logTable").innerHTML = `<p class="empty">${escapeHtml(err.message || "Could not load the access log.")}</p>`;
    });
    loadLogins().catch((err) => {
      document.getElementById("loginTable").innerHTML = `<p class="empty">${escapeHtml(err.message || "Could not load Access logins.")}</p>`;
    });
  });
  document.getElementById("logTable").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-ip]");
    if (!btn) return;
    document.getElementById("logIp").value = btn.getAttribute("data-ip");
    loadLogs(1).catch(() => {});
  });
  document.getElementById("logPager").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-page]");
    if (!btn || btn.disabled) return;
    loadLogs(Number(btn.getAttribute("data-page"))).catch(() => {});
  });

  async function loadLogins() {
    const params = new URLSearchParams();
    const from = inputToIso(document.getElementById("logFrom").value);
    const to = inputToIso(document.getElementById("logTo").value);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const data = await api("/api/admin/logs/access-logins?" + params.toString());
    const note = document.getElementById("loginNote");
    note.textContent = data.note || (data.configured ? "Cloudflare Access authentication events for this admin app." : "Access login events are unavailable until CF_API_TOKEN is set. Site visit logs still work.");
    const events = data.events || [];
    if (!data.ok && !events.length) {
      document.getElementById("loginTable").innerHTML = `<p class="empty">${escapeHtml(data.reason || data.note || "Access login events are not available.")}</p>`;
      return;
    }
    if (!events.length) {
      document.getElementById("loginTable").innerHTML = '<p class="empty">No Access login events in this range.</p>';
      return;
    }
    document.getElementById("loginTable").innerHTML = `<table><thead><tr><th>Time (ET)</th><th>Email</th><th>Allowed</th><th>IP</th><th>Country</th><th>App</th></tr></thead><tbody>${events.map((row) => `<tr>
      <td>${escapeHtml(row.ts_et || row.ts || "")}</td>
      <td>${escapeHtml(row.email || "")}</td>
      <td>${row.allowed === false ? "Denied" : "Allowed"}</td>
      <td class="mono">${escapeHtml(row.ip || "")}</td>
      <td>${escapeHtml(row.country || "")}</td>
      <td>${escapeHtml(row.app || "")}</td>
    </tr>`).join("")}</tbody></table>`;
  }

  document.addEventListener("change", (event) => {
    if (!event.target.matches || !event.target.matches("select.reason-select")) return;
    const wrap = event.target.closest("form");
    const other = wrap && wrap.querySelector(".reason-other");
    if (other) other.hidden = event.target.value !== "other";
  });

  async function saveMaintenance(form, on) {
    maintError.textContent = "";
    const btn = form.querySelector("button[type='submit']");
    if (btn) btn.disabled = true;
    try {
      const data = await api("/api/admin/maintenance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          site: form.getAttribute("data-site"),
          on,
          message: form.querySelector('[name="message"]').value,
          eta: inputToIso(form.querySelector('[name="eta"]').value),
          reason: form.querySelector('[name="reason"]').value,
          reason_text: form.querySelector('[name="reason_text"]').value,
        }),
      });
      renderMaintenance(data.sites || {});
      return true;
    } catch (err) {
      maintError.textContent = "Not saved: " + (err.message || "could not update lockout");
      if (btn) btn.disabled = false;
      return false;
    }
  }

  maintGrid.addEventListener("change", (event) => {
    const form = event.target.closest("form[data-site]");
    if (!form || event.target.name !== "on") return;
    const on = event.target.checked;
    const wasOn = form.getAttribute("data-was-on") === "1";
    form.classList.toggle("on", on);
    const state = form.querySelector(".toggle-state");
    if (state) state.textContent = on ? "Locked" : "Open";
    const btn = form.querySelector("button[type='submit']");
    if (btn) btn.textContent = maintButtonLabel(wasOn, on);
    // Switching a locked site to Open saves the unlock straight away; locking still
    // needs the button so the reason and message can be set first.
    if (wasOn && !on) {
      if (state) state.textContent = "Unlocking…";
      return saveMaintenance(form, false).then((ok) => {
        if (!ok) {
          event.target.checked = true;
          form.classList.toggle("on", true);
          if (state) state.textContent = "Locked";
          if (btn) btn.textContent = maintButtonLabel(true, true);
        }
        return ok;
      });
    }
  });

  maintGrid.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target.closest("form[data-site]");
    if (!form) return;
    await saveMaintenance(form, form.querySelector('input[name="on"]').checked);
  });


  cancelBtn.addEventListener("click", resetForm);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const id = document.getElementById("id").value;
    const payload = {
      title: document.getElementById("title").value,
      message: document.getElementById("message").value,
      type: document.getElementById("type").value,
      targets: selectedTargets(),
      start: inputToIso(document.getElementById("start").value),
      end: inputToIso(document.getElementById("end").value),
    };
    if (!payload.targets.length) {
      formError.textContent = "Pick at least one target.";
      return;
    }
    try {
      if (id) {
        await api("/api/admin/announcements/" + encodeURIComponent(id), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        await api("/api/admin/announcements", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      resetForm();
      await load();
    } catch (err) {
      formError.textContent = err.message || "Save failed";
    }
  });

  listEl.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-act]");
    if (!btn) return;
    const article = btn.closest("[data-id]");
    const id = article && article.getAttribute("data-id");
    const item = items.find((row) => row.id === id);
    if (!item) return;
    if (btn.getAttribute("data-act") === "edit") {
      fillForm(item);
      return;
    }
    if (btn.getAttribute("data-act") === "delete") {
      if (!confirm("Delete this announcement?")) return;
      try {
        await api("/api/admin/announcements/" + encodeURIComponent(id), { method: "DELETE" });
        if (document.getElementById("id").value === id) resetForm();
        await load();
      } catch (err) {
        alert(err.message || "Delete failed");
      }
    }
  });
  // Initial loads run last, after every function and state variable exists.
  load().catch((err) => {
    listEl.innerHTML = `<p class="empty">${escapeHtml(err.message || "Could not load announcements.")}</p>`;
  });
  loadMaintenance().catch((err) => {
    maintGrid.innerHTML = `<p class="empty">${escapeHtml(err.message || "Could not load lockout state.")}</p>`;
  });
  loadAdmins().catch((err) => {
    document.getElementById("adminList").innerHTML = `<p class="empty">${escapeHtml(err.message || "Could not load admins.")}</p>`;
  });
  loadLogs(1).catch((err) => {
    document.getElementById("logTable").innerHTML = `<p class="empty">${escapeHtml(err.message || "Could not load the access log.")}</p>`;
  });
  loadLogins().catch((err) => {
    document.getElementById("loginTable").innerHTML = `<p class="empty">${escapeHtml(err.message || "Could not load Access logins.")}</p>`;
  });
})();
