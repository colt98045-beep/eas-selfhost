// Turnstile gate tests for src/index.js: mocked ASSETS + siteverify (no network, no Cloudflare).
import worker from '../src/index.js';
const H = 'eas-repository.your-subdomain.workers.dev';
const env = { TURNSTILE_SITEKEY: '0xTESTSITEKEY', TURNSTILE_HOSTNAMES: H,
  TURNSTILE_SECRET: 'test-secret', GATE_COOKIE_SECRET: 'x'.repeat(48),
  ASSETS: { fetch: async (r) => new Response('ASSET ' + new URL(r.url).pathname) } };
let sv = { success: true, action: 'gate', hostname: H };
globalThis.fetch = async (u, init) => { if (sv === 'throw') throw new Error('net'); return new Response(JSON.stringify(sv)); };
const base = `https://${H}`;
const post = (body, h = {}) => worker.fetch(new Request(base + '/__turnstile/verify', { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, ...h }, body }), env);
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

let r = await worker.fetch(new Request(base + '/docs?x=1'), env);
let t = await r.text();
ok(r.status === 403 && t.includes('cf-turnstile') && t.includes('data-action="gate"') && t.includes('value="/docs?x=1"'), 'no cookie -> challenge page');
r = await worker.fetch(new Request(base + '/x', { method: 'POST' }), env); ok(r.status === 403, 'no cookie POST -> 403');
r = await worker.fetch(new Request(base + '/__turnstile/verify'), env); ok(r.status === 405, 'GET verify -> 405');
r = await post('return=%2Fdocs'); ok(r.status === 403, 'missing token -> 403');
sv = { success: false, 'error-codes': ['invalid-input-response'] };
r = await post('cf-turnstile-response=DUMMY&return=%2F'); ok(r.status === 403 && !r.headers.get('set-cookie'), 'dummy token rejected');
sv = { success: true, action: 'login', hostname: H }; r = await post('cf-turnstile-response=T'); ok(r.status === 403, 'wrong action -> 403');
sv = { success: true, action: 'gate', hostname: 'evil.com' }; r = await post('cf-turnstile-response=T'); ok(r.status === 403, 'wrong hostname -> 403');
sv = 'throw'; r = await post('cf-turnstile-response=T'); ok(r.status === 403, 'siteverify error -> fail closed');
sv = { success: true, action: 'gate', hostname: H };
r = await post('cf-turnstile-response=T', { Origin: 'https://evil.com' }); ok(r.status === 403, 'cross-origin post -> 403');
r = await post('cf-turnstile-response=T&return=%2F%2Fevil.com'); ok(r.status === 303 && r.headers.get('location') === '/', 'open redirect blocked');
r = await post('cf-turnstile-response=T&return=%2Fdocs%3Fx%3D1');
const sc = r.headers.get('set-cookie');
ok(r.status === 303 && r.headers.get('location') === '/docs?x=1' && /HttpOnly; Secure; SameSite=Lax/.test(sc) && /Max-Age=43200/.test(sc), 'valid token -> 303 + cookie');
const cookie = sc.split(';')[0];
r = await worker.fetch(new Request(base + '/docs', { headers: { Cookie: cookie } }), env); ok((await r.text()) === 'ASSET /docs', 'valid cookie -> original handler');
const bad = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
r = await worker.fetch(new Request(base + '/docs', { headers: { Cookie: bad } }), env); ok(r.status === 403, 'tampered cookie -> challenge');
r = await worker.fetch(new Request('https://other.workers.dev/docs', { headers: { Cookie: cookie } }), env); ok(r.status === 403, 'cookie bound to hostname');
const exp = Math.floor(Date.now()/1000) - 1; r = await worker.fetch(new Request(base + '/', { headers: { Cookie: `__Host-eas_gate=${exp}.${'A'.repeat(43)}` } }), env); ok(r.status === 403, 'expired cookie -> challenge');
r = await post('cf-turnstile-response=T', {}); const env2 = { ...env, TURNSTILE_SECRET: '' };
r = await worker.fetch(new Request(base + '/__turnstile/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'cf-turnstile-response=T' }), env2); ok(r.status === 503, 'missing secret -> fail closed');
r = await worker.fetch(new Request(base + '/manifest.json'), env); ok((await r.text()) === 'ASSET /manifest.json', 'manifest.json ungated');
r = await worker.fetch(new Request(base + '/sw.js'), env); ok(r.status === 403, 'sw.js gated without cookie');
r = await worker.fetch(new Request(base + '/sw.js', { headers: { Cookie: cookie } }), env); ok((await r.text()) === 'ASSET /sw.js', 'sw.js with cookie');

// Access log must never change gate or API responses, even when D1 or waitUntil throws.
const throwD1 = { prepare() { throw new Error('d1 down'); } };
const throwCtx = { waitUntil() { throw new Error('waitUntil down'); } };
r = await worker.fetch(new Request(base + '/docs?x=1'), { ...env, ACCESS_LOG: throwD1 }, throwCtx);
t = await r.text();
ok(r.status === 403 && t.includes('cf-turnstile'), 'throwing logger does not change challenge');
r = await worker.fetch(new Request(base + '/docs', { headers: { Cookie: cookie } }), { ...env, ACCESS_LOG: throwD1 }, throwCtx);
ok((await r.text()) === 'ASSET /docs', 'throwing logger does not change passed response');
r = await worker.fetch(new Request(base + '/manifest.json'), { ...env, ACCESS_LOG: throwD1 }, throwCtx);
ok((await r.text()) === 'ASSET /manifest.json', 'throwing logger does not change ungated asset');
r = await worker.fetch(new Request(base + '/api/active'), { ...env, ACCESS_LOG: throwD1 }, throwCtx);
ok(r.status === 403, 'throwing logger does not change gated API');
