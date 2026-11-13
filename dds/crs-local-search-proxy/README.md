# Character Research Studio local search proxy

Requires Node.js 18 or newer. No npm packages are needed.

## Start (Windows PowerShell)

```powershell
$env:CRS_SEARXNG_URL = "https://searx.be/"
$env:CRS_ALLOWED_ORIGINS = "http://localhost:8000,http://127.0.0.1:8000"
node .\server.js
```

Change `CRS_SEARXNG_URL` to the SearXNG instance you intend to use. The proxy fixes the upstream at startup; clients cannot supply arbitrary target URLs. If SillyTavern uses another origin/port, add that exact origin to `CRS_ALLOWED_ORIGINS` as a comma-separated value. Do not use `*`.

## Verify

Open `http://127.0.0.1:3030/health`. It should return JSON with `ok: true`. Then open `http://127.0.0.1:3030/search?q=test` in a browser. A successful response has a `results` array. A 502 response includes the upstream status or diagnostic.

## Security

- Binds only to `127.0.0.1`, not the LAN.
- Uses a single configured public SearXNG host; no request parameter can change the upstream.
- Rejects local/private target addresses and URL credentials.
- Allows only explicitly configured SillyTavern browser origins.
- Uses Node's built-in `fetch`; no Express/Axios dependencies.

This proxy handles SearXNG search requests only. Result-page extraction in the extension remains browser-side and can still fail due to destination-site CORS or site restrictions. It does not bypass upstream 403s, rate limits, CAPTCHAs, or disabled JSON output.
