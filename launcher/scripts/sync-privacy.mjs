// Writes the shared privacy policy (privacy/policy.html) into all three sites.
//   node scripts/sync-privacy.mjs          write
//   node scripts/sync-privacy.mjs --check  exit 1 if any output is stale
// Sibling checkouts are expected at ../eas-repository and ../eas-repository-ca
// (override with EAS_US_DIR / EAS_CA_DIR). Missing siblings are skipped with a note.
//   launcher: public/privacy.html          (served at /privacy; not lockable, not behind Access)
//   CA:       privacy.html                 (served at /privacy; allowlisted in .assetsignore)
//   US:       src/privacy.js               (Worker serves it at exact /privacy, before the Turnstile gate)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const usDir = process.env.EAS_US_DIR || path.resolve(root, "..", "us");
const caDir = process.env.EAS_CA_DIR || path.resolve(root, "..", "ca");

const strip = (src) => src.replace(/^(\s*<!--[\s\S]*?-->)+\s*/, "").trim();
const body = strip(fs.readFileSync(path.join(root, "privacy", "policy.html"), "utf8"));
const bodyFr = strip(fs.readFileSync(path.join(root, "privacy", "policy.fr.html"), "utf8"));

function page({ title, back, backLabel, bilingual = false }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${title}</title>
  <!-- Generated from eas-launcher/privacy/policy.html by scripts/sync-privacy.mjs. Do not edit here. -->
  <style>
    :root { --bg:#070b14; --surface:#0f1623; --border:rgba(255,255,255,.08); --text:#f1f5f9; --muted:#94a3b8; --link:#93c5fd; }
    @media (prefers-color-scheme: light) { :root { --bg:#f8fafc; --surface:#fff; --border:rgba(15,23,42,.14); --text:#0f172a; --muted:#475569; --link:#1d4ed8; } }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:Inter,system-ui,-apple-system,sans-serif; line-height:1.6; }
    main { max-width:46rem; margin:0 auto; padding:28px 20px 56px; }
    article { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:24px 22px; }
    h1 { margin:0 0 6px; font-size:1.6rem; }
    h2 { margin:26px 0 8px; font-size:1.1rem; }
    p, li { font-size:.95rem; }
    a { color:var(--link); }
    a:focus-visible { outline:2px solid var(--link); outline-offset:2px; }
    .privacy-meta { color:var(--muted); font-size:.85rem; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em; }
    nav { margin-bottom:16px; }
  </style>
</head>
<body>
  <main>
    <nav><a href="${back}">← ${backLabel}</a>${bilingual ? ` · <a href="#fr" hreflang="fr" lang="fr">Version française</a>` : ""}</nav>
    <article id="en" aria-labelledby="privacy-title">
${indent(body, 6)}
    </article>${bilingual ? `
    <p class="privacy-meta" style="margin:20px 0"><a href="#en">English version</a></p>
    <article id="fr" lang="fr" aria-labelledby="privacy-title-fr">
${indent(bodyFr, 6)}
    </article>` : ""}
  </main>
</body>
</html>
`;
}

function indent(text, n) {
  const pad = " ".repeat(n);
  return text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

let stale = 0;
function write(file, content) {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (prev === content) return;
  if (check) {
    console.error(`stale: ${file}`);
    stale++;
    return;
  }
  fs.writeFileSync(file, content);
  console.log(`wrote ${file}`);
}

write(path.join(root, "public", "privacy.html"), page({ title: "Privacy policy · EAS Launcher", back: "/", backLabel: "EAS Launcher" }));

if (fs.existsSync(path.join(caDir, "index.html"))) {
  write(path.join(caDir, "privacy.html"), page({ title: "Privacy policy · Politique de confidentialité · EAS Repository Canada", back: "/", backLabel: "EAS Repository Canada", bilingual: true }));
} else console.log(`skip CA (${caDir} not found)`);

if (fs.existsSync(path.join(usDir, "src", "index.js"))) {
  const html = page({ title: "Privacy policy · EAS Repository", back: "/", backLabel: "EAS Repository" });
  write(
    path.join(usDir, "src", "privacy.js"),
    `// Generated from eas-launcher/privacy/policy.html by scripts/sync-privacy.mjs. Do not edit here.\n` +
      `// Served by src/index.js at exactly /privacy (GET/HEAD, no query) before the Turnstile gate.\n` +
      `export const PRIVACY_HTML = ${JSON.stringify(html)};\n`,
  );
} else console.log(`skip US (${usDir} not found)`);

if (stale) process.exit(1);
