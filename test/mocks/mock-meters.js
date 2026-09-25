// Mock of Anthropic's usage endpoint (GET /api/oauth/usage).
//   node mock-meters.js [port]        (default 4870)
//   /usage-ok, /usage-401   fixed responses (meters.test.sh)
//   /usage                  answers per the current mode (meters-cache.test.sh):
//                           ok (the /usage-ok body) | 429 (+ Retry-After) | 500
//                           | proto (the ok body plus top-level "__proto__"
//                           and "constructor" keys, as raw JSON text)
//   /mode?m=ok|429|500|proto[&retry=<seconds>]   switch the /usage mode
//   /count                  {"hits": n} — requests seen on /usage* so far
const http = require('http');
const PORT = parseInt(process.argv[2], 10) || 4870;
let hits = 0;
let mode = 'ok';
let retryAfter = null;

function okBody() {
  return JSON.stringify({
    // utilization is a 0–100 PERCENTAGE. 0.9 = a start-of-window reading of
    // 0.9% — the old "≤ 1 means fraction" rule showed it as 90%.
    five_hour: { utilization: 0.9, resets_at: new Date(Date.now() + 2.4 * 3600e3).toISOString() },
    seven_day: { utilization: 61, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() },
    seven_day_opus: { utilization: 88, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() },
    extra_unknown_key: { something: true },
    // Undisclosed rotating codename buckets Anthropic never documented: at 0
    // with no reset they must stay HIDDEN; one carrying real usage must show.
    nimbus_quill: { utilization: 0.0, resets_at: null },
    cinder_cove: { utilization: 0, resets_at: null },
    tangelo: { utilization: 42, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() },
    // A documented newer key gets a proper label
    seven_day_cowork: { utilization: 10, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() },
    limits: [
      // the real thing: per-model weekly window
      { kind: 'weekly_scoped', group: 'g', percent: 76, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString(),
        scope: { model: { display_name: 'Fable' } } },
      // duplicate of the legacy seven_day_opus key — must be deduped
      { kind: 'weekly_scoped', group: 'g', percent: 88, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString(),
        scope: { model: { display_name: 'Opus' } } },
      // wrong kind — ignore
      { kind: 'five_hour', group: 'g', percent: 34, resets_at: null, scope: { model: { display_name: 'Nope' } } },
      // surface-scoped, no model — ignore
      { kind: 'weekly_scoped', group: 'g', percent: 12, resets_at: null, scope: { surface: { display_name: 'apps' } } },
      // malformed — ignore
      { kind: 'weekly_scoped', percent: 'NaN', scope: { model: { display_name: 'Broken' } } },
      null,
    ],
  });
}

http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  const auth = q.headers['authorization'] || '';
  if (u.pathname === '/count') {
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ hits }));
    return;
  }
  if (u.pathname === '/mode') {
    mode = u.searchParams.get('m') || 'ok';
    retryAfter = u.searchParams.get('retry');
    s.writeHead(200); s.end(mode);
    return;
  }
  if (u.pathname.startsWith('/usage')) hits++;
  if (u.pathname === '/usage-ok' || (u.pathname === '/usage' && (mode === 'ok' || mode === 'proto'))) {
    if (auth !== 'Bearer sk-test-oauth-token') { s.writeHead(401); s.end('{"error":"bad token"}'); return; }
    s.writeHead(200, { 'Content-Type': 'application/json' });
    // JSON.parse turns a "__proto__" key into an OWN property (an object
    // literal would set the prototype instead), so it is spliced in as text.
    s.end(u.pathname === '/usage' && mode === 'proto'
      ? '{"__proto__":{"utilization":85,"resets_at":null},"constructor":{"utilization":20,"resets_at":null},"prototype":{"utilization":30},' + okBody().slice(1)
      : okBody());
    return;
  }
  if (u.pathname === '/usage' && mode === '429') {
    s.writeHead(429, Object.assign({ 'Content-Type': 'application/json' }, retryAfter ? { 'Retry-After': retryAfter } : {}));
    s.end('{"error":{"type":"rate_limit_error"}}');
    return;
  }
  if (u.pathname === '/usage' && mode === '500') { s.writeHead(500); s.end('{}'); return; }
  if (u.pathname === '/usage-401') { s.writeHead(401); s.end('{}'); return; }
  s.writeHead(404); s.end();
}).listen(PORT, '127.0.0.1', () => console.log('mock meters up on ' + PORT));
