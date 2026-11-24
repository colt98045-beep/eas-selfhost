// Launcher maintenance page: "Check again" button plus a 15s poll that reloads
// once the lockout is off. External file so the page works under script-src 'self'.
(function () {
  var btn = document.getElementById("retry");
  if (btn) btn.addEventListener("click", function () { location.reload(); });
  setInterval(function () {
    fetch("/api/maintenance?site=launcher", { credentials: "omit", cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data && data.on === false) location.reload(); })
      .catch(function () {});
  }, 15000);
})();
