#!/usr/bin/env node
// Fill in the placeholders in this repo with your own values, in place.
// Run from the repo root. Every flag is optional; only the ones you pass are replaced.
// Re-running is safe only for placeholders that are still present.
//
//   node scripts/configure.mjs \
//     --subdomain my-sub \                 # your workers.dev subdomain (my-sub.workers.dev)
//     --admin-email you@yourdomain.com \   # permanent admin + privacy contact
//     --github-user your-github-name \
//     --account-id <32-hex Cloudflare account id> \
//     --kv-id <KV namespace id> \
//     --d1-id <D1 database id> \
//     --access-team your-team \            # <team>.cloudflareaccess.com
//     --access-aud <Access app AUD tag> \
//     --access-app-id <Access app id> \
//     --turnstile-sitekey <0x... site key> \
//     --operator "Your Name or Org"        # name used in the privacy policy
//
// Add --dry-run to list the files that would change.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") { opt.dryRun = true; continue; }
  if (!a.startsWith("--") || i + 1 >= args.length) { console.error(`bad argument: ${a}`); process.exit(2); }
  opt[a.slice(2)] = args[++i];
}

const rules = [];
const add = (from, to, flags = "g") => rules.push([new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags), to]);
if (opt.subdomain) add("your-subdomain.workers.dev", `${opt.subdomain}.workers.dev`);
if (opt["admin-email"]) add("admin@example.com", opt["admin-email"].toLowerCase(), "gi");
if (opt["github-user"]) add("your-github-user", opt["github-user"]);
if (opt["account-id"]) add("REPLACE_WITH_ACCOUNT_ID", opt["account-id"]);
if (opt["kv-id"]) add("REPLACE_WITH_KV_NAMESPACE_ID", opt["kv-id"]);
if (opt["d1-id"]) add("REPLACE_WITH_D1_DATABASE_ID", opt["d1-id"]);
if (opt["access-team"]) add("your-team.cloudflareaccess.com", `${opt["access-team"]}.cloudflareaccess.com`);
if (opt["access-aud"]) add("REPLACE_WITH_ACCESS_APP_AUD_TAG", opt["access-aud"]);
if (opt["access-app-id"]) add("REPLACE_WITH_ACCESS_APP_ID", opt["access-app-id"]);
if (opt["turnstile-sitekey"]) add("1x00000000000000000000AA", opt["turnstile-sitekey"]);
if (opt.operator) add("[YOUR NAME OR ORGANIZATION]", opt.operator);
if (!rules.length) { console.error("Nothing to do. See the comment at the top of scripts/configure.mjs."); process.exit(2); }

const SKIP_DIRS = new Set([".git", "node_modules", ".wrangler", "worker-inline"]);
const TEXT = /\.(js|mjs|json|jsonc|html|md|sql|py|toml|txt|yml|yaml|css|svg)$|^\.(assetsignore|gitignore|dev\.vars\.example)$/;
const self = path.join(root, "scripts", "configure.mjs");
const guide = path.join(root, "README.md"); // the guide keeps showing the placeholders
const changed = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); continue; }
    if (full === self || full === guide || !TEXT.test(name)) continue;
    const before = fs.readFileSync(full, "utf8");
    let after = before;
    for (const [re, to] of rules) after = after.replace(re, to);
    if (after !== before) {
      changed.push(path.relative(root, full));
      if (!opt.dryRun) fs.writeFileSync(full, after);
    }
  }
})(root);
console.log(`${opt.dryRun ? "Would change" : "Changed"} ${changed.length} file(s):`);
for (const f of changed) console.log("  " + f);
console.log("\nStill to do by hand: edit launcher/privacy/policy*.html for YOUR deployment, then run\n  (cd launcher && node scripts/sync-privacy.mjs)");
