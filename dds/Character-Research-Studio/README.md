# Character Research Studio 0.4.6

A global SillyTavern extension for automatic pre-generation web research and manual generation reviews. It is not tied to a dedicated character or bot and does not require function calling.

## What changed in 0.3.7

- Recognizes natural explicit search commands including “now, search”, “search now”, “search online”, “search for”, and “look it up”; users do not need to type the exact phrase “web search”.
- Keeps an explicitly started search task active across relevant clarifications and corrections such as “I meant…”, “not talking about…”, “not the singer”, and “different person”.
- The technical log records the explicit trigger type so a missed trigger can be diagnosed.

## What changed in 0.3.5

- Combines research retrieval and Web Search task enforcement in the existing extension; no separate extension or research bot is required.
- Adds a global explicit-task trigger: messages containing “web search”, “websearch”, or “search the web” force the retrieval workflow past the intent-detection gate. A previously declared task can also be continued with short follow-ups such as “now”, “finally”, “continue”, “do it”, or “those links”.
- Injects a task-execution directive alongside the research packet. It tells any active character/bot to use the evidence, carry forward user-requested deliverables from the conversation, and complete permissible parts rather than silently ignoring the search task. It explicitly does not override system/provider/safety restrictions.
- Adds a settings toggle for explicit Web Search task enforcement.
- The manual review now audits task compliance as well as research retrieval and generation quality.

## What changed in 0.3.4

- Replaces the v0.2.x model-invoked function tool with SillyTavern's documented `generate_interceptor` prompt-interception mechanism.
- Detects likely research/profile/fact-check requests in the latest user message.
- Searches the configured SearXNG instance directly (default `https://www.isci.si/`) before the model request is built.
- Attempts to fetch and extract readable text from selected result pages; records CORS/HTTP failures instead of pretending pages were read.
- Injects search results, snippets, extracted page text, and research instructions into the pending prompt.
- Records a per-generation stage log: request detection, each SearXNG query and result count, each supplied/result URL fetch, extracted character counts, packet creation, and insertion into the pending chat. Individual search failures no longer cancel the other searches. User-supplied URLs are fetched directly.
- The manual Review dialog includes a collapsible technical log as well as the model-written audit. It checks for visible refusals, partial refusals, omissions, unsupported claims, fabricated sources, and likely failure points. The report appears in the manual Review dialog; the technical log is available in a collapsible section and in the browser console.
- Removes the requirement for function calling. Continue using Chat Completion and your chosen OpenRouter/DeepSeek connection.

## Install / update

1. Back up or rename the existing `Character-Research-Studio` extension folder.
2. Unzip this archive.
3. Replace the existing folder at `SillyTavern/public/scripts/extensions/third-party/Character-Research-Studio/` with the included `Character-Research-Studio` folder.
4. Reload SillyTavern and open Extensions → Character Research Studio.
5. Confirm the SearXNG URL is `https://www.isci.si/` and that automatic research and diagnostics are enabled.

## How it works

The extension registers `characterResearchStudioInterceptor` in `manifest.json`. SillyTavern calls it before building a generation prompt. If the latest user message explicitly invokes Web Search (or continues a previously declared Web Search task), the extension forces the research workflow past the intent gate. Otherwise, if the latest user message looks like a research, fact-check, biography, or character-profile request, the extension performs SearXNG searches and attempts page extraction, then inserts a research packet immediately before the latest user message. Ordinary roleplay messages that do not match the research-intent heuristic are left alone.

After generation ends, the extension sends a separate diagnostic prompt through SillyTavern's currently selected generation connection. It does not replace the generated answer or write the diagnostic into chat history.

## SearXNG requirements and limitations

- SearXNG JSON output must be enabled (`search.formats` includes `json`).
- Browser CORS must allow requests from the SillyTavern origin.
- Individual result pages must also allow browser fetches from the SillyTavern origin for full text extraction. If they do not, snippets and URLs are retained and the page is marked blocked.
- This is not a CORS bypass, proxy, scraper service, login/paywall bypass, or guaranteed full-web crawler.

## Important provider limitation

This extension cannot overwrite or disable OpenRouter's, DeepSeek's, or any upstream provider's refusal/moderation systems. It can add research context before generation and audit the visible response afterward, but it cannot see hidden moderation logs or prove the exact internal reason for a refusal. Adult mode controls SearXNG SafeSearch only.

## Research quality rules

The injected instructions require source URLs, cross-checking, confidence labels, separation of fact from inference, and explicit uncertainty. They prohibit fabricated facts or private intimate details. Fictional subjects should distinguish canon, adaptations, interpretation, and fanon. Roleplay instructions remain open to any `{{user}}` species, body, or size and must not dictate `{{user}}` actions, thoughts, or dialogue.

## Testing status

The package is statically checked for JavaScript syntax. It has not been run inside the user's SillyTavern installation or against the live `isci.si` instance. First test with a harmless research request. The Review dialog now exposes the recorded pipeline stages directly, so opening the browser console is optional. Static checks do not prove live SearXNG CORS access or successful runtime interception.

## License

AGPL-3.0-or-later.


## v0.3.5 changes
- Explicit Web Search task invocation bypasses the heuristic gate and runs the retrieval pipeline globally for whichever character is active.
- The injected packet now includes a task-execution directive and user-only task brief, so multi-turn deliverables remain visible to the active bot.
- Review checks whether the bot followed the Web Search task, not just whether the retrieval pipeline ran.

## v0.3.4 changes
- Intent detection now evaluates the latest user message together with a short recent conversation window.
- Explicit follow-ups such as “visit the links”, “read those links”, and “is she real?” can trigger research even when the latest message contains no URL or formal research keyword.
- URLs from the recent context window are carried into direct page retrieval.
- The review log records whether context was included and how many supplied URLs were detected.

This improves follow-up handling; it does not bypass model/provider moderation or guarantee that every website permits browser fetching.


### v0.3.4 full-chat context change

The interceptor now examines the complete available chat history before the triggering user message (up to a 60,000-character diagnostic context), recovers URLs from all user messages in that history, and builds a focused research brief from user messages containing research/deliverable/link details plus the latest five user turns. This supports multi-turn tasks where the requested deliverables, identity details, and URLs were supplied far apart. It does not send the assistant refusal text as the search brief.


## v0.3.7 changes
- Natural search commands such as “now, search” explicitly bypass the automatic intent gate.
- Follow-up corrections continue a previously declared search task and are logged as such.


## v0.3.7 query isolation fix

- Conversation context is used to identify the active subject, not copied into SearXNG queries.
- Search queries are short subject-only phrases (official profile, biography/interviews, independent verification).
- User URLs are filtered to links associated with the active subject/task; unrelated historical URLs are excluded.
- Technical review logs the selected subject and only the URLs selected for the current task.
- This fixes the v0.3.6 bug where long prior character-card text was prepended to every search query.


## v0.3.8 natural knowledge-intent detection
- Treats ordinary information-seeking questions ("Do you know anything about X?", "What can you tell me about X?", "Tell me more about X", "Who is X?") as automatic research requests, even without explicit search commands.
- For vague follow-ups such as "Do you know anything?", attempts to recover the subject from earlier user messages and relevant profile links.
- If no identifiable subject exists in the available conversation, the model should ask what the user means rather than send an empty or meaningless search query.
- Keeps explicit search commands and manual review functionality.


## v0.3.9 diagnostic and intent fixes

- Corrected the visible settings-panel version label; it now matches the manifest version (0.3.9).
- Internal SillyTavern quiet generations (including the manual-review prompt) are ignored before a generation snapshot is created. They can no longer overwrite the real user request with a `quiet` / `skipped_diagnostic_generation` record.
- Expanded subject extraction for phrasing such as “search for info about X”, “research X”, and “do you know anything about X”.
- Broadened knowledge-question detection so users do not need to type the literal words “search” or “look up”. Vague follow-ups should resolve against the conversation subject where possible.


## v0.4.0 — forced research pipeline and failure diagnostics

- **Force means execute research, not merely mark intent as forced.** Explicit commands including `search now`, `now, search`, `try again`, `force it`, `search anyway`, `run the search`, and `do the search` bypass the intent gate. Short follow-ups continue a previously declared search task.
- **Subject recovery is a separately logged stage.** The extension looks through prior user messages for direct search phrases, ordinary knowledge questions, alias pairs (`X also known as Y`), named subjects near research cues, and task-related profile URLs. A bare `search now` reuses the prior subject. If there is genuinely no recoverable subject, the extension says so instead of querying the literal words `search now`.
- **The preparation path is now protected.** Context collection, subject resolution, URL selection, query planning, search, page retrieval, packet creation, and injection have separate stage statuses. An exception before the first network request is captured with `failureStage`, rather than leaving an unexplained `search: not_started` and an empty error list.
- **Broader research plan.** Up to eight focused SearXNG queries cover exact-name matches, aliases, credits/filmography, biography/interviews, official/social profiles, independent corroboration, and relevant supplied domains. Defaults increased to eight results per query, eight pages, and 9,000 extracted characters per page.
- **Search errors are more actionable.** Network/CORS failures, HTTP status, disabled JSON output, non-JSON/challenge responses, and missing results arrays receive distinct diagnostic messages. Individual failed queries do not cancel the other queries.
- **Evidence packet creation is attempted even after failed searches or blocked page fetches.** The packet records the failure and preserves any snippets/URLs that were returned, allowing the model to explain what was and was not retrieved.
- **Research and downstream writing are explicitly separated.** The packet tells the model to report neutral public factual research even if a separate requested writing/roleplay deliverable cannot be completed. This is a task-separation instruction, not a way to override system, model, or provider restrictions.
- Corrected all visible and console version labels to `0.4.0`.

### Important limitations

The extension runs before SillyTavern asks the selected model to generate. It cannot override upstream OpenRouter/DeepSeek/provider policies. It does not bypass CORS: the configured SearXNG instance must allow browser requests from the SillyTavern origin and have JSON output enabled. Direct page text extraction also depends on each destination site's CORS policy. If search fails, the technical log now identifies the failure stage and error instead of implying that research ran.

### v0.4.0 validation

Static validation includes JavaScript syntax checking, manifest JSON parsing, and ZIP integrity. This archive has not been live-tested in the user's SillyTavern browser or against the configured SearXNG endpoint; runtime network access, CORS, and provider behavior must be confirmed in that environment.


## v0.4.2 — settings drawer recovery

- Adds explicit initialization and settings-attachment diagnostics.
- If SillyTavern's template renderer fails, tries a direct template fetch and then a self-contained fallback settings drawer.
- Tries `#extensions_settings2` first and `#extensions_settings` as a compatibility fallback.
- Prevents duplicate settings drawers.

### v0.4.2 validation

JavaScript syntax, manifest JSON, and ZIP integrity checked. This is not live-tested in the user's SillyTavern instance.


## v0.4.3 — subject isolation and neutral evidence packets

- Replaced broad transcript-to-brief copying with subject-scoped user-message selection. Only messages that match the resolved subject are eligible for the evidence brief; long matched messages are clipped to excerpts around subject mentions. The current request is always retained.
- The latest explicit named lookup now takes priority over older alias/name candidates, reducing accidental subject carry-over.
- Alias pairs separated by `/` are searched as separate name variants rather than as one literal combined name. Queries are diversified across each variant.
- Supplied URLs are selected using the URL's own host/path or an immediately preceding subject reference, ranked, and capped. Unrelated historical links are no longer accepted merely because the subject appeared somewhere else in the same message.
- Page retrieval now obeys the configured `pagesToRead` limit even when more user-supplied URLs are present.
- The evidence packet no longer contains a forceful task-execution directive or the undocumented `extra.bias = 'system'` field. It is inserted as a normal extension-authored assistant message and explicitly defers to the active conversation instructions and provider rules.
- Diagnostics now report the subject filter and included/excluded user-message counts. When every search fails, `failureStage` remains `search` instead of being cleared after packet injection.
- **No server-side proxy is included in 0.4.3.** Search still uses browser `fetch()` and therefore still requires the configured SearXNG instance to support JSON and CORS. A local proxy requires a separately installed and secured server component; this release does not pretend a browser-side change can bypass CORS.

Static validation performed for this archive: JavaScript syntax check, manifest JSON parsing, focused helper tests for subject resolution, URL selection, alias query planning, and retrieval caps, plus ZIP integrity. It has not been run inside the user's SillyTavern installation or against a live search endpoint.


## v0.4.4 — secured local search proxy support

- Adds an optional local Node.js companion proxy for SearXNG search requests; enabled by default.
- Uses a fixed upstream configured on the local server, not a client-supplied URL.
- Companion binds to loopback only, applies an explicit origin allowlist, rejects private/local upstream targets, and uses Node.js built-in fetch (no Express/Axios dependencies).
- Adds separate settings for proxy enablement and local proxy address. Direct browser-to-SearXNG mode remains available.
- Diagnostics now distinguish an unavailable local proxy from a direct browser network failure without claiming that every `Failed to fetch` is CORS.
- Search results are returned as a normalized `results` array.

The proxy handles search only. Direct result-page extraction remains browser-side and can still be blocked by individual sites. The proxy cannot bypass upstream blocks, rate limits, CAPTCHAs, or disabled SearXNG JSON output.

Static validation: JavaScript syntax, manifest JSON, proxy syntax, and ZIP integrity. Not live-tested inside SillyTavern or against a live SearXNG instance.


## v0.4.6 — generation standard and prose demonstrations

- Preserves the 0.4.4 search request path, local/Cloudflare gateway configuration, `/fetch` page-retrieval route, and existing settings keys.
- Injects a structured three-document generation contract: Research Register → About Me / Master Character Reference → RP Opening.
- Adds worked good/bad prose demonstrations for physical presence, biography, personality, voice, opening scenes, and anti-padding. The examples teach technique and must not leak example identities or traits into unrelated characters.
- Expands evidence handling and completion checks so search snippets are not presented as opened pages, contradictions remain visible, and interrupted output is not reported as complete.
- Clarifies handling of real-person public professional information versus fictional character invention. The extension does not disable model/provider restrictions or authorize fabrication of private facts.
- Updates manifest and visible settings version to 0.4.6.

### 0.4.6 validation

JavaScript syntax, manifest JSON, and ZIP integrity are checked at packaging time. The original search gateway files are carried forward unchanged. This package has not been runtime-tested in the user's SillyTavern installation; verify settings, search, `/fetch`, and generation output after installation.


## 0.4.8 page extraction and Cloudflare gateway

This update expands page extraction beyond visible DOM text. The browser-side extractor now also reads page title and relevant Open Graph/Twitter/profile metadata, JSON-LD, and common structured hydration payloads (including Next.js-style profile data). These are combined with visible article/main/body text and passed into the existing evidence packet. Embedded data is treated as untrusted source material, just like visible page text.

For a Cloudflare Worker deployment, set the extension's **Gateway base URL** to the Worker URL **including the secret path segment** (the value corresponding to `SECRET_PATH_TOKEN`). The extension appends `/search` and `/fetch`; do not add either endpoint suffix yourself. The local companion remains supported at `http://127.0.0.1:3030`. Public pages that require authentication, CAPTCHA clearance, or block Cloudflare's fetch runtime remain unavailable and are logged as blocked rather than represented as read.
