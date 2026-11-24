// Guards the Cloudflare deploy config. Every push to main is deployed by Workers Builds
// (`npx wrangler deploy`), so a bad change here would take the live site down or expose files.
// Fails if the Turnstile gate, the API routes or the asset allowlist would be lost.
import fs from 'node:fs';

const errors = [];
const fail = (m) => errors.push(m);

// wrangler.jsonc: strip // and /* */ comments (outside strings) and trailing commas, then parse.
function parseJsonc(src) {
  let out = '', inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; if (i === 0) throw new Error('unterminated comment'); continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

let cfg;
try { cfg = parseJsonc(fs.readFileSync('wrangler.jsonc', 'utf8')); } catch (e) { fail(`wrangler.jsonc does not parse: ${e.message}`); }
for (const f of ['wrangler.toml', 'wrangler.json']) if (fs.existsSync(f)) fail(`${f} must not exist (wrangler would read it instead of wrangler.jsonc)`);

if (cfg) {
  const a = cfg.assets || {};
  if (cfg.name !== 'eas-repository') fail(`name must be "eas-repository" (got ${JSON.stringify(cfg.name)})`);
  if (cfg.main !== 'src/index.js') fail(`main must be "src/index.js" (got ${JSON.stringify(cfg.main)}); without it the gate and APIs are dropped`);
  if (a.directory !== '.') fail(`assets.directory must be "." (got ${JSON.stringify(a.directory)})`);
  if (a.binding !== 'ASSETS') fail('assets.binding must be "ASSETS"');
  if (a.run_worker_first !== true) fail('assets.run_worker_first must be true, or static files bypass the Turnstile gate');
  if (a.not_found_handling && a.not_found_handling !== 'none') fail('assets.not_found_handling must be "none"');
  const v = cfg.vars || {};
  // 1x00000000000000000000AA is Cloudflare's always-pass test sitekey (fine for local dev).
  if (!/^[0-9]x[0-9A-Za-z_-]+$/.test(v.TURNSTILE_SITEKEY || '')) fail('vars.TURNSTILE_SITEKEY missing or malformed');
  if (!String(v.TURNSTILE_HOSTNAMES || '').split(',').map((s) => s.trim()).filter(Boolean).length)
    fail('vars.TURNSTILE_HOSTNAMES must list the hostname(s) your US Worker is served on');
  for (const s of ['TURNSTILE_SECRET', 'GATE_COOKIE_SECRET', 'ACCESS_LOG_SALT']) if (s in v) fail(`${s} is a secret and must not be in vars`);
  if (cfg.routes || cfg.route) fail('routes are not expected; the site is served on workers.dev');
  const d1 = (cfg.d1_databases || []).find((d) => d.binding === 'ACCESS_LOG');
  if (!d1) fail('d1_databases must include the ACCESS_LOG binding');
  if (!d1.database_id) fail('ACCESS_LOG database_id must be set (the id printed by `wrangler d1 create eas-access-log`)');
  if (d1.database_name && d1.database_name !== 'eas-access-log') fail('ACCESS_LOG database_name must be eas-access-log');
}

// .assetsignore: ignore everything, then allowlist exactly the three web app files.
const want = ['*', '!index.html', '!manifest.json', '!sw.js'];
let ignore = [];
try {
  ignore = fs.readFileSync('.assetsignore', 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
} catch { fail('.assetsignore is missing; every repo file would be published'); }
if (ignore.length && JSON.stringify(ignore) !== JSON.stringify(want))
  fail(`.assetsignore must be exactly ${JSON.stringify(want)} (got ${JSON.stringify(ignore)})`);
for (const f of ['index.html', 'manifest.json', 'sw.js', 'src/index.js', 'src/access-log.js']) if (!fs.existsSync(f)) fail(`${f} is missing`);

// src/index.js: the gate and API routes must still be present.
if (fs.existsSync('src/index.js')) {
  const js = fs.readFileSync('src/index.js', 'utf8');
  for (const needle of ["'__Host-eas_gate'", "'/__turnstile/verify'", 'TURNSTILE_SECRET', 'GATE_COOKIE_SECRET', 'siteverify',
    "'/api/active'", "'/api/noaa'", "'/api/noaa/'", "'/api/nws'", "new Set(['/manifest.json'])"])
    if (!js.includes(needle)) fail(`src/index.js no longer contains ${needle}`);
}

if (errors.length) { for (const e of errors) console.error(`::error::${e}`); process.exit(1); }
console.log('Worker deploy config OK');
