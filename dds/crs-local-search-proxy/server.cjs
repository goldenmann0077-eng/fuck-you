// Character Research Studio local search companion
// Node.js 18+; built-in modules only. Binds to loopback and permits one configured SearXNG origin.
'use strict';
const http = require('node:http');
const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');
const HOST = '127.0.0.1';
const PORT = Number(process.env.CRS_PROXY_PORT || 3030);
const INSTANCE = process.env.CRS_SEARXNG_URL || 'https://www.isci.si/';
const ALLOWED_ORIGINS = new Set((process.env.CRS_ALLOWED_ORIGINS || 'http://localhost:8000,http://127.0.0.1:8000').split(',').map(x => x.trim()).filter(Boolean));
const TIMEOUT_MS = Math.min(Math.max(Number(process.env.CRS_TIMEOUT_MS || 15000), 3000), 45000);
function normalizeInstance(raw) {
  const u = new URL(raw);
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('SearXNG URL must use HTTP or HTTPS.');
  if (u.username || u.password) throw new Error('Credentials in the SearXNG URL are not allowed.');
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) throw new Error('SearXNG target must be a public host, not a private/local address.');
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/(search|preferences|about|stats(?:\/engines)?)$/i, '');
  u.search = ''; u.hash = '';
  return u;
}
let target;
try { target = normalizeInstance(INSTANCE); }
catch (e) { console.error('[CRS PROXY] Invalid CRS_SEARXNG_URL:', e.message); process.exit(1); }

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  if (family === 6) {
    const a = address.toLowerCase();
    return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') ||
      /^fe[89ab]/.test(a) || a.startsWith('::ffff:');
  }
  return true;
}
async function validatePublicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS pages can be fetched.');
  if (u.username || u.password) throw new Error('URLs containing credentials are not allowed.');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Only standard HTTP/HTTPS ports are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Local/private hosts are not allowed.');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Private or reserved IP addresses are not allowed.');
  } else {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some(record => isPrivateAddress(record.address))) {
      throw new Error('The page host resolves to a private or reserved IP address.');
    }
  }
  u.hash = '';
  return u;
}
async function fetchPublicPage(rawUrl) {
  let current = rawUrl;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const u = await validatePublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(u, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'User-Agent': 'Mozilla/5.0 (compatible; CharacterResearchStudio/0.4.7)' }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('The page redirected without a destination.');
        if (redirects === 5) throw new Error('Too many redirects.');
        current = new URL(location, u).toString();
        continue;
      }
      if (!response.ok) throw new Error(`Page server returned HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error(`Unsupported page content type: ${contentType || 'unknown'}`);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > 2 * 1024 * 1024) throw new Error('Page is larger than the 2 MB retrieval limit.');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Page response had no readable body.');
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Page exceeded the 2 MB retrieval limit.'); }
        chunks.push(Buffer.from(value));
      }
      return { html: Buffer.concat(chunks).toString('utf8'), contentType, finalUrl: u.toString() };
    } finally { clearTimeout(timer); }
  }
  throw new Error('Too many redirects.');
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'Origin not allowed', allowedOrigins: [...ALLOWED_ORIGINS] });
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'Character Research Studio local search proxy', upstream: target.origin, port: PORT, fetch: true });
  if (req.method === 'GET' && url.pathname === '/fetch') {
    const raw = (url.searchParams.get('url') || '').trim();
    if (!raw || raw.length > 2048) return send(res, 400, { error: 'A page URL is required (maximum 2048 characters).' });
    try {
      const page = await fetchPublicPage(raw);
      return send(res, 200, page);
    } catch (e) {
      const timeout = e.name === 'AbortError';
      return send(res, 502, { error: timeout ? `Page retrieval timed out after ${TIMEOUT_MS} ms.` : (e.message || 'Page retrieval failed.') });
    }
  }
  if (req.method !== 'GET' || url.pathname !== '/search') return send(res, 404, { error: 'Not found' });
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > 500) return send(res, 400, { error: 'Query is required and must be at most 500 characters.' });
  const search = new URL(`${target.origin}${target.pathname}/search`);
  search.searchParams.set('q', q);
  search.searchParams.set('format', 'json');
  search.searchParams.set('safesearch', url.searchParams.get('safesearch') === '1' ? '1' : '0');
  search.searchParams.set('language', /^[a-z]{2}(?:-[A-Z]{2})?$/.test(url.searchParams.get('language') || '') ? url.searchParams.get('language') : 'en');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(search, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'CharacterResearchStudio-LocalProxy/0.4.4' }, redirect: 'error' });
    const contentType = upstream.headers.get('content-type') || '';
    const body = await upstream.text();
    if (!upstream.ok) return send(res, 502, { error: `SearXNG upstream returned HTTP ${upstream.status}.`, statusCode: upstream.status, responseType: contentType, details: body.slice(0, 300) });
    if (!contentType.toLowerCase().includes('json')) return send(res, 502, { error: 'SearXNG did not return JSON. The instance may have JSON output disabled or returned an HTML challenge.', responseType: contentType, details: body.slice(0, 300) });
    let data;
    try { data = JSON.parse(body); } catch { return send(res, 502, { error: 'SearXNG returned invalid JSON.' }); }
    if (!Array.isArray(data.results)) return send(res, 502, { error: 'SearXNG JSON did not contain a results array.' });
    return send(res, 200, { results: data.results.map(x => ({ title: x.title || '', url: x.url || '', content: x.content || x.snippet || '', engine: x.engine || '', publishedDate: x.publishedDate || null })) });
  } catch (e) {
    const timeout = e.name === 'AbortError';
    return send(res, 502, { error: timeout ? `SearXNG request timed out after ${TIMEOUT_MS} ms.` : 'Could not connect to the configured SearXNG instance.', details: e.message || String(e) });
  } finally { clearTimeout(timer); }
});
server.listen(PORT, HOST, () => {
  console.log(`[CRS PROXY] Listening only on http://${HOST}:${PORT}`);
  console.log(`[CRS PROXY] Fixed upstream: ${target.origin}${target.pathname}`);
  console.log(`[CRS PROXY] Allowed browser origins: ${[...ALLOWED_ORIGINS].join(', ') || '(none; same-origin requests only)'}`);
  console.log('[CRS PROXY] Health check: http://127.0.0.1:' + PORT + '/health');
});
server.on('error', e => { console.error('[CRS PROXY] Server error:', e.message); process.exitCode = 1; });
