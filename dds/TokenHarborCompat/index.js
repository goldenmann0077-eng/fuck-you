(function () {
    const MODULE = 'token_harbor_compat';
    const DEFAULTS = {
        enabled: true,
        onlyCustomSource: true,
        continueText: 'Continue the previous assistant message from exactly where it stopped. Do not restart it.',
        impersonateText: 'Write the next message as the user persona, not as the character.'
    };

    function getSettings() {
        const context = SillyTavern.getContext();
        context.extensionSettings[MODULE] ??= structuredClone(DEFAULTS);
        Object.assign(context.extensionSettings[MODULE], DEFAULTS, context.extensionSettings[MODULE]);
        return context.extensionSettings[MODULE];
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function addSettingsUI() {
        const settings = getSettings();
        const host = document.getElementById('extensions_settings');
        if (!host || document.getElementById(`${MODULE}_settings`)) return;

        const panel = document.createElement('div');
        panel.id = `${MODULE}_settings`;
        panel.className = 'extension_settings';
        panel.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Harbor Compatibility</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input id="${MODULE}_enabled" type="checkbox">
                        <span>Enable compatibility workaround</span>
                    </label>
                    <label class="checkbox_label">
                        <input id="${MODULE}_custom" type="checkbox">
                        <span>Only apply to Custom (OpenAI-compatible) API</span>
                    </label>
                    <small>
                        For Continue and Impersonate only. If the outgoing request ends with an assistant
                        message, this adds a final user instruction to satisfy APIs that require the
                        last message to have role=user. It does not edit chat history.
                    </small>
                    <div class="token-harbor-status" id="${MODULE}_status">Ready.</div>
                </div>
            </div>`;
        host.appendChild(panel);

        const enabled = panel.querySelector(`#${MODULE}_enabled`);
        const custom = panel.querySelector(`#${MODULE}_custom`);
        enabled.checked = !!settings.enabled;
        custom.checked = !!settings.onlyCustomSource;

        enabled.addEventListener('change', () => {
            settings.enabled = enabled.checked;
            saveSettings();
        });
        custom.addEventListener('change', () => {
            settings.onlyCustomSource = custom.checked;
            saveSettings();
        });
    }

    function setStatus(message) {
        const el = document.getElementById(`${MODULE}_status`);
        if (el) el.textContent = message;
    }

    function handlePrompt(data) {
        const settings = getSettings();
        if (!settings.enabled || !data || !Array.isArray(data.messages)) return;

        const action = String(data.type || '').toLowerCase();
        if (action !== 'continue' && action !== 'impersonate') return;

        const source = String(data.chat_completion_source || data.chat_comletion_source || '').toLowerCase();
        if (settings.onlyCustomSource && source && source !== 'custom') return;

        const messages = data.messages;
        if (!messages.length) return;

        const last = messages[messages.length - 1];
        if (!last || String(last.role).toLowerCase() !== 'assistant') return;

        const instruction = action === 'continue'
            ? settings.continueText
            : settings.impersonateText;

        messages.push({
            role: 'user',
            content: instruction
        });

        setStatus(`Applied to ${action}. A temporary final user message was added to the API request.`);
        console.info(`[${MODULE}] Added final user message for ${action}. Chat history was not changed.`);
    }

    function init() {
        const context = SillyTavern.getContext();
        addSettingsUI();
        context.eventSource.on(context.event_types.CHAT_COMPLETION_SETTINGS_READY, handlePrompt);
        context.eventSource.on(context.event_types.APP_READY, addSettingsUI);
        console.info(`[${MODULE}] Loaded.`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
