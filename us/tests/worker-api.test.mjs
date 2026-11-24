// API route tests for src/index.js: mocked upstreams with small inline fixtures (no network).
import worker from '../src/index.js';
const H = 'eas-repository.your-subdomain.workers.dev', base = `https://${H}`;
const env = { TURNSTILE_SITEKEY: '0xT', TURNSTILE_HOSTNAMES: H, TURNSTILE_SECRET: 's', GATE_COOKIE_SECRET: 'x'.repeat(48),
  ASSETS: { fetch: async (r) => new Response('ASSET ' + new URL(r.url).pathname) } };
const entry = (t) => `<entry><title>${t}</title><summary>${t} summary</summary><cap:event>${t}</cap:event></entry>`;
const geas = JSON.stringify([{ id: 'a1', translation: 'Test alert' }, { id: 'a2', translation: 'Second' }]);
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entry('US1')}${entry('US2')}</feed>`;
const fl = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entry('FL1')}</feed>`;
const nws = JSON.stringify({ type: 'FeatureCollection', features: [] });
let mode = 'ok'; const calls = [];
globalThis.fetch = async (u, init) => {
  u = String(u);
  calls.push({ u, h: init?.headers });
  if (u.startsWith('https://challenges')) return new Response(JSON.stringify({ success: true, action: 'gate', hostname: H }));
  if (u.includes('alerts.weather.gov')) throw new TypeError('DNS lookup failed'); // legacy host is gone
  if (mode === 'down') throw new Error('timeout');
  if (mode === '500') return new Response('err', { status: 500 });
  if (u.includes('globaleas')) return new Response(geas);
  if (u.endsWith('active.atom')) return new Response(atom);
  if (u.includes('area=FL')) return new Response(fl);
  if (u.includes('area=')) return new Response('bad', { status: 400 });
  if (u.endsWith('/alerts/active')) return new Response(nws);
  return new Response('?', { status: 404 });
};
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const v = await worker.fetch(new Request(base + '/__turnstile/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: 'cf-turnstile-response=T' }), env);
const cookie = v.headers.get('set-cookie').split(';')[0];
const get = (p) => worker.fetch(new Request(base + p, { headers: { Cookie: cookie } }), env);

for (const p of ['/api/active', '/api/noaa', '/api/noaa/FL', '/api/nws']) {
  const r = await worker.fetch(new Request(base + p), env);
  ok(r.status === 403 && (await r.text()).includes('cf-turnstile'), `${p} gated without cookie`);
}
let r = await get('/api/active'); const j = await r.json();
ok(r.status === 200 && r.headers.get('content-type') === 'application/json' && r.headers.get('access-control-allow-origin') === '*' && Array.isArray(j) && j[0].id && j[0].translation, '/api/active JSON array');
const ua = calls.find(c => c.u.includes('globaleas')).h['User-Agent'];
ok(ua === 'EASRepository/1.0 (https://github.com/your-github-user/eas-repository)', 'User-Agent matches eas_monitor.py');
mode = 'down'; r = await get('/api/active'); ok((await r.json()).length === j.length, '/api/active served from cache when upstream is down');
mode = 'ok'; r = await get('/api/noaa'); let t = await r.text();
ok(r.status === 200 && r.headers.get('content-type') === 'application/xml' && (t.match(/<entry>/g) || []).length === 2, '/api/noaa falls back to api.weather.gov atom');
r = await get('/api/noaa/fl'); t = await r.text(); ok(r.status === 200 && t.includes('FL1'), '/api/noaa/fl -> FL feed');
r = await get('/api/noaa/ZZ'); ok(r.status === 502 && (await r.text()) === 'Upstream feed unavailable', '/api/noaa/ZZ upstream 400 -> 502');
r = await get('/api/noaa/FLA'); ok(r.status === 404, '/api/noaa/FLA -> 404');
r = await get('/api/nws'); ok(r.status === 200 && r.headers.get('content-type') === 'application/json' && (await r.json()).type === 'FeatureCollection', '/api/nws GeoJSON');
ok(calls.filter(c => c.u === 'https://api.weather.gov/alerts/active').every(c => c.h.Accept === 'application/geo+json'), '/api/nws sends Accept geo+json');
mode = '500'; r = await get('/api/nws'); ok(r.status === 200, '/api/nws served from cache on upstream 500');
r = await get('/api/nope'); ok(r.status === 404, 'unknown /api/* -> 404');
r = await worker.fetch(new Request(base + '/api/active', { method: 'POST', headers: { Cookie: cookie } }), env); ok(r.status === 501, 'POST /api/active -> 501');
r = await get('/index.html'); ok((await r.text()) === 'ASSET /index.html', 'assets served with cookie');
r = await worker.fetch(new Request(base + '/sw.js', { headers: { Cookie: cookie } }), env); ok((await r.text()) === 'ASSET /sw.js', 'sw.js with cookie');

const throwD1 = { prepare() { throw new Error('d1 down'); } };
const throwCtx = { waitUntil() { throw new Error('waitUntil down'); } };
const envLog = { ...env, ACCESS_LOG: throwD1 };
r = await worker.fetch(new Request(base + '/api/active', { headers: { Cookie: cookie } }), envLog, throwCtx);
ok(r.status === 200 && Array.isArray(await r.json()), 'throwing logger does not change /api/active');
r = await worker.fetch(new Request(base + '/api/nws', { headers: { Cookie: cookie } }), envLog, throwCtx);
ok(r.status === 200, 'throwing logger does not change /api/nws');
r = await worker.fetch(new Request(base + '/index.html', { headers: { Cookie: cookie } }), envLog, throwCtx);
ok((await r.text()) === 'ASSET /index.html', 'throwing logger does not change assets');
