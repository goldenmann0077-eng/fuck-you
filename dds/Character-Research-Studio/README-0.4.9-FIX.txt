CRS 0.4.9 Cloudflare Search Fix

Install by replacing the existing Character-Research-Studio extension folder with this folder.

In the CRS settings, enable “Use Cloudflare / local search gateway”. Set “Cloudflare Worker gateway URL” to the full Worker base URL INCLUDING the secret path segment. Do not append /search or /fetch. The known Worker domain is https://crs-search-gateway.mtflarence.workers.dev but the secret path is intentionally not included in this package.

Test the same base URL plus /health in a browser; it must return {"ok":true}. The /search route must return JSON containing a non-empty results array for a normal query.

This build keeps the 32-query research plan, limits requests to four concurrent searches, accepts both {results:[...]} and raw Serper {organic:[...]} payloads, normalizes pasted /search or /fetch suffixes, and marks zero-result runs as failed rather than reporting a misleading partial success. It also uses the same gateway base for page fetching.
