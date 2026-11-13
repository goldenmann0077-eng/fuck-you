# Token Harbor Compatibility (experimental)

A small SillyTavern UI extension that attempts to work around APIs which reject requests unless the final chat message has `role: user`.

## What it does
- Hooks `CHAT_COMPLETION_SETTINGS_READY`.
- Only acts on `continue` and `impersonate` generation types.
- If the outgoing message array ends in an assistant message, appends a temporary user instruction to the outgoing request.
- Does not edit saved chat history or change normal Generate requests.

## Install
1. Extract this folder into `SillyTavern/data/default-user/extensions/third-party/`.
2. Restart SillyTavern (or reload the page and enable the extension if it appears).
3. Open Extensions → Token Harbor Compatibility.
4. Leave the workaround enabled and keep “Only apply to Custom” checked.
5. Test Continue and Impersonate.

## Important limitations
This is an experimental compatibility workaround, not a guaranteed bypass. It changes the meaning of the final prompt slightly because the provider requires a user message. If the provider rejects the request for another reason, this will not fix it. If the extension does not activate, check the browser console for `[token_harbor_compat]` messages.

The extension expects SillyTavern to expose `CHAT_COMPLETION_SETTINGS_READY` data with `type`, `messages`, and (for source filtering) `chat_completion_source`. It is designed for modern SillyTavern versions.
