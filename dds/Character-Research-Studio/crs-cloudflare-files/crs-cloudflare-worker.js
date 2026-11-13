export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Content-Type': 'application/json; charset=utf-8'
    };

    const respond = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: corsHeaders
    });

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'GET') return respond({ error: 'Method not allowed' }, 405);
    if (!env.SECRET_PATH_TOKEN) return respond({ error: 'Gateway secret is not configured' }, 500);

    const requestUrl = new URL(request.url);
    const segments = requestUrl.pathname.split('/').filter(Boolean);
    if (segments[0] !== env.SECRET_PATH_TOKEN) return respond({ error: 'Unauthorized' }, 401);

    const endpoint = segments[1];
    if (endpoint === 'health' && segments.length === 2) {
      return respond({ ok: true, service: 'CRS Cloud Search Gateway' });
    }

    if (endpoint === 'search' && segments.length === 2) {
      if (!env.SERPER_KEY) return respond({ error: 'Search provider secret is not configured' }, 500);
      const q = requestUrl.searchParams.get('q');
      if (!q || !q.trim()) return respond({ error: 'Missing search query' }, 400);
      const safe = requestUrl.searchParams.get('safesearch') === '0' ? 'off' : 'active';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': env.SERPER_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: q.trim(), safe, num: 8 }),
          signal: controller.signal
        });
        if (!response.ok) return respond({ error: 'Search provider rejected the request', status: response.status }, 502);
        const data = await response.json();
        const results = (Array.isArray(data.organic) ? data.organic : [])
          .filter(item => item.link)
          .map(item => ({
            title: item.title || 'Untitled Result',
            url: item.link,
            content: item.snippet || '',
            engine: 'google',
            publishedDate: item.date || null
          }));
        return respond({ results });
      } catch (error) {
        if (error.name === 'AbortError') return respond({ error: 'Search request timed out' }, 504);
        return respond({ error: 'Search gateway request failed' }, 502);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (endpoint === 'fetch' && segments.length === 2) {
      const rawTarget = requestUrl.searchParams.get('url');
      if (!rawTarget) return respond({ error: 'Missing URL to fetch' }, 400);
      let target;
      try { target = new URL(rawTarget); }
      catch { return respond({ error: 'Invalid URL' }, 400); }

      const isSafeTarget = (u) => {
        if (!['http:', 'https:'].includes(u.protocol)) return false;
        if (u.username || u.password) return false;
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
        // Disallow IP-literal hosts. This blocks private, loopback, link-local,
        // multicast and other non-public address ranges without fragile parsing.
        if (/^[0-9.]+$/.test(host) || host.includes(':')) return false;
        return true;
      };
      if (!isSafeTarget(target)) return respond({ error: 'URL is not an allowed public HTTP(S) website' }, 400);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        let current = target;
        let upstream;
        for (let redirects = 0; redirects <= 3; redirects++) {
          upstream = await fetch(current.toString(), {
            method: 'GET',
            redirect: 'manual',
            headers: {
              'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
              'User-Agent': 'Mozilla/5.0 (compatible; CharacterResearchStudio/1.0; +https://developers.cloudflare.com/workers/)'
            },
            signal: controller.signal
          });
          if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
          const location = upstream.headers.get('location');
          if (!location || redirects === 3) return respond({ error: 'Website redirected too many times or supplied no redirect target' }, 502);
          const next = new URL(location, current);
          if (!isSafeTarget(next)) return respond({ error: 'Website redirected to a disallowed URL' }, 502);
          current = next;
        }

        if (!upstream || !upstream.ok) return respond({ error: `Website returned HTTP ${upstream ? upstream.status : 'unknown'}` , status: upstream?.status || 502 }, 502);
        const contentType = upstream.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return respond({ error: `Unsupported content type: ${contentType || 'unknown'}` }, 415);
        const declaredLength = Number(upstream.headers.get('content-length') || 0);
        const maxBytes = 2 * 1024 * 1024;
        if (declaredLength > maxBytes) return respond({ error: 'Website page exceeds the 2 MB retrieval limit' }, 413);
        if (!upstream.body) return respond({ error: 'Website returned an empty response body' }, 502);
        const reader = upstream.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            return respond({ error: 'Website page exceeds the 2 MB retrieval limit' }, 413);
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        return respond({ html, contentType, finalUrl: current.toString() });
      } catch (error) {
        if (error.name === 'AbortError') return respond({ error: 'Website retrieval timed out' }, 504);
        return respond({ error: 'Website retrieval failed' }, 502);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return respond({ error: 'Not found' }, 404);
  }
};
