// /privacy page (privacy.html, generated from eas-launcher/privacy/policy.html).
import fs from "node:fs";
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const page = fs.readFileSync("privacy.html", "utf8");
ok(page.includes("Effective date: 24/11/2026"), "effective date DD/MM/YYYY");
ok(page.includes("mailto:admin@example.com"), "contact email");
for (const w of ["30 days", "full IP address", "PIPEDA", "GDPR", "California", "not legal advice"]) ok(page.includes(w), `mentions ${w}`);
ok(!/<script/i.test(page), "no scripts");
// French version (Quebec Law 25 / Charter of the French Language)
ok(/<article id="fr" lang="fr"/.test(page), "French version present with lang=fr");
ok(page.includes('href="#fr"') && page.includes('href="#en"'), "language switch links");
for (const w of ["Politique de confidentialité", "Date d'entrée en vigueur : 24/11/2026", "30 jours", "LPRPDE", "Loi 25",
  "Commission d'accès à l'information du Québec", "Commissariat à la protection de la vie privée du Canada",
  "à l'extérieur du Canada", "Nous ne vendons ni ne partageons aucun renseignement personnel", "moins de 13 ans"])
  ok(page.includes(w), `French mentions ${w}`);
const ignore = fs.readFileSync(".assetsignore", "utf8").split(/\r?\n/).map((l) => l.trim());
ok(ignore.includes("!privacy.html"), "privacy.html is published");
ok(ignore.includes("*"), "everything else still ignored");
const index = fs.readFileSync("index.html", "utf8");
ok(index.includes('href="/privacy"'), "index links to /privacy");
ok(/const CACHE = "eas-ca-v\d+"/.test(fs.readFileSync("sw.js", "utf8")), "service worker cache name present");
// Tab icon: CA variant as an inline data: URI, identical on index and /privacy (no new asset path)
const iconOf = (h) => (h.match(/<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/) || [])[1];
const caIcon = iconOf(index);
ok(Boolean(caIcon) && decodeURIComponent(caIcon).includes("#d52b1e"), "index.html has the CA tab icon");
ok(iconOf(page) === caIcon, "/privacy uses the same CA tab icon");
ok(!ignore.some((l) => /icon|favicon/i.test(l)), ".assetsignore unchanged for icons");
ok(/const CACHE = "eas-ca-v5"/.test(fs.readFileSync("sw.js", "utf8")), "service worker cache bumped to eas-ca-v5");
if (!process.exitCode) console.log("CA privacy tests passed");
