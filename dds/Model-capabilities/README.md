# Model Capabilities for SillyTavern

Version 0.1.0 — early scanner build for SillyTavern 1.19.x.

## Install

1. Extract `model-capabilities.zip`.
2. Copy the `model-capabilities` folder into `SillyTavern/data/default-user/extensions/`.
3. Restart/reload SillyTavern.
4. Open Extensions → Model Capabilities → Open Model Capabilities.

## What this build does

- Reads model IDs currently exposed by model selectors in the active SillyTavern UI.
- Refreshes when the main API, Chat Completion source/model, or connection profile changes, and when model selector DOM content changes.
- Provides search, copy-one, copy-visible, and copy-all actions.
- Lets the user mark a model as personally tested; those marks are stored in SillyTavern extension settings.
- Does not read API keys or make external requests.
- Labels policy, context, output-token, streaming, and prose capabilities as unknown unless a future adapter can verify them.

## Important limitations of 0.1.0

This is a live-UI scanner, not yet a complete provider adapter suite. Provider model controls differ. Some selectors may not be detected until the API panel is open and the model list has loaded. Some APIs expose only the selected model or a text input rather than a complete list. AI Horde availability is volatile; this extension reports only what SillyTavern currently renders, not worker capacity or guaranteed immediate generation availability.

Capability verification is intentionally conservative. A listed model is not proof that NSFW content is allowed. Context and maximum output are not inferred from model names.
