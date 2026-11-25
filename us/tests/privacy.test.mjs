// Public /privacy on the US Worker: exact-path exemption from the Turnstile gate.
// The page is a static string in src/privacy.js, generated from
// eas-launcher/privacy/policy.html by scripts/sync-privacy.mjs. Everything else stays gated.
import fs from 'node:fs';
import worker from '../src/index.js';
import { PRIVACY_HTML } from '../src/privacy.js';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const H = 'eas-repository.your-subdomain.workers.dev';
const base = `https://${H}`;
let assetHits = 0;
const env = { TURNSTILE_SITEKEY: '0xTESTSITEKEY', TURNSTILE_HOSTNAMES: H,
  TURNSTILE_SECRET: 'test-secret', GATE_COOKIE_SECRET: 'x'.repeat(48),
  ASSETS: { fetch: async (r) => { assetHits++; return new Response('ASSET ' + new URL(r.url).pathname); } } };
globalThis.fetch = async () => { throw new Error('no network in tests'); };
const get = (p, init) => worker.fetch(new Request(base + p, init), env);

// Content
for (const w of ['Effective date: 24/11/2026', 'mailto:admin@example.com', '30 days', 'full IP address', 'Turnstile',
  'Cloudflare Access', 'PIPEDA', 'Quebec', 'Office of the Privacy Commissioner of Canada', 'California',
  'We do not sell or share personal information', 'GDPR', 'under 13', 'outside Canada', '35 days', '90 days', 'admin audit', 'not legal advice'])
  ok(PRIVACY_HTML.includes(w), `policy mentions ${w}`);
ok(!/<script/i.test(PRIVACY_HTML), 'policy page has no scripts');
ok(!/<form/i.test(PRIVACY_HTML), 'policy page has no forms');

// Served without a gate cookie
for (const p of ['/privacy', '/privacy/']) {
  const r = await get(p);
  const t = await r.text();
  ok(r.status === 200 && t === PRIVACY_HTML, `${p} -> 200 static policy without cookie`);
  ok(/text\/html/.test(r.headers.get('content-type')), `${p} is text/html`);
  ok(/default-src 'none'/.test(r.headers.get('content-security-policy') || ''), `${p} has a locked-down CSP`);
  ok(!r.headers.get('set-cookie'), `${p} sets no cookie`);
}
let r = await get('/privacy', { method: 'HEAD' });
ok(r.status === 200 && (await r.text()) === '', 'HEAD /privacy -> 200, empty body');
r = await get('/privacy', { method: 'POST' });
ok(r.status === 405, 'POST /privacy -> 405');
ok(assetHits === 0, 'policy never reads ASSETS');

// Look-alikes and everything else must still hit the gate
for (const p of ['/privacy?x=1', '/privacy.html', '/privacy/x', '/privacy%2F..%2Fapi%2Factive', '/Privacy', '/privacyx',
  '/api/privacy', '/', '/index.html', '/api/active', '/api/alerts', '/sw.js']) {
  const res = await get(p);
  const t = await res.text();
  ok(res.status === 403 && t.includes('cf-turnstile'), `${p} still gated (403 challenge)`);
}
ok(assetHits === 0, 'no gated path reached ASSETS');

// Challenge page links to the policy
r = await get('/docs');
ok((await r.text()).includes('href="/privacy"'), 'challenge page links to /privacy');

// Site links (behind the gate) and publishing
const html = fs.readFileSync('index.html', 'utf8');
ok(/href="\/privacy"/.test(html.slice(html.indexOf('<footer class="site-footer">'))), 'footer links to /privacy');
ok(!html.includes('EAS-PRIVACY:START'), 'old in-page #privacy section removed');
const ignore = fs.readFileSync('.assetsignore', 'utf8');
ok(!/privacy/.test(ignore), '.assetsignore allowlist unchanged (no privacy asset published)');
// Tab icon: one inline data: URI on every US page, no new path, CSP widened only by img-src data:
const iconOf = (h) => (h.match(/<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/) || [])[1];
const indexIcon = iconOf(html);
ok(Boolean(indexIcon), 'index.html has the inline data: tab icon');
ok(iconOf(PRIVACY_HTML) === indexIcon, '/privacy uses the same tab icon');
r = await get('/docs');
const challengeCsp = r.headers.get('content-security-policy') || '';
ok(iconOf(await r.text()) === indexIcon, 'challenge page uses the same tab icon');
ok(/(^|; )img-src data:(;|$)/.test(challengeCsp) && !/img-src[^;]*(\*|https?:)/.test(challengeCsp), 'challenge CSP allows only data: images');
ok(/default-src 'none'/.test(challengeCsp) && /frame-ancestors 'none'/.test(challengeCsp), 'challenge CSP otherwise unchanged');
r = await get('/privacy');
ok(/img-src data:;/.test(r.headers.get('content-security-policy') || ''), '/privacy CSP allows data: icon');
for (const p of ['/icon.svg', '/favicon.ico', '/favicon.svg']) {
  const res = await get(p);
  ok(res.status === 403 && (await res.text()).includes('cf-turnstile'), `${p} is still gated (no new icon path)`);
}
ok(/const CACHE = "eas-v6"/.test(fs.readFileSync('sw.js', 'utf8')), 'service worker cache bumped to eas-v5');
const footer = html.slice(html.indexOf('<footer class="site-footer">'));
for (const s of ['Data: NOAA / National Weather Service', 'FEMA', 'FCC', 'Emergency Alert System', 'for information only']) {
  ok(footer.includes(s), `footer includes ${s}`);
}
if (!process.exitCode) console.log('US privacy tests passed');
