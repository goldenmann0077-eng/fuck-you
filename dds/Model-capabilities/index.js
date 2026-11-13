
/*
 * Model Capabilities for SillyTavern 1.19.x
 * Reads model IDs from currently rendered provider controls only.
 * Does not call providers directly, read API keys, or claim unknown capabilities.
 */
(() => {
    'use strict';

    const EXT = 'model_capabilities';
    const VERSION = '0.1.0';

    let observer;
    let scanTimer;
    let models = [];
    let ctx;
    let lastRefreshed = null;

    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];

    const esc = s => String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[c]));

    function providerLabel() {
        const selectors = [
            '#chat_completion_source',
            '#api_type',
            '#main_api',
            '#api_connection',
        ];

        for (const sel of selectors) {
            const el = $(sel);
            if (!el) continue;

            const opt = el.selectedOptions?.[0];
            const val = (opt?.textContent || el.value || '').trim();

            if (val) return val;
        }

        const label = $$('label').find(l =>
            /API|Source/i.test(l.textContent || '')
        );

        return label?.textContent?.trim()
            || 'Active SillyTavern connection (source not identified)';
    }

    function modelControls() {
        const all = $$('select, input[list], .selectize-control');
        const chosen = [];

        for (const el of all) {
            const id = `${el.id || ''} ${el.name || ''} ${el.className || ''}`.toLowerCase();

            const parentText = (
                el.closest('.flex-container, .form-group, .inline-drawer-content, .range-block')
                    ?.innerText || ''
            ).slice(0, 180).toLowerCase();

            const looksLikeModel =
                /model|horde|engine/.test(id)
                || /model|horde model/.test(parentText);

            if (looksLikeModel) chosen.push(el);
        }

        if (!chosen.length) {
            for (const el of all) {
                if (el.tagName !== 'SELECT' || el.options?.length <= 1) continue;

                const opts = [...el.options]
                    .map(o => o.textContent.trim())
                    .filter(Boolean);

                if (opts.some(v =>
                    /deepseek|qwen|llama|claude|gpt-|gemini|mistral|command|wizard|mythomax/i.test(v)
                )) {
                    chosen.push(el);
                }
            }
        }

        return [...new Set(chosen)];
    }

    function readModels() {
        const found = new Map();

        for (const el of modelControls()) {
            let entries = [];

            if (el.tagName === 'SELECT') {
                entries = [...el.options].map(o => ({
                    id: (o.value || o.textContent || '').trim(),
                    label: o.textContent.trim(),
                    disabled: o.disabled,
                }));
            } else if (el.matches('input[list]')) {
                const list = el.list
                    || $(`#${CSS.escape(el.getAttribute('list') || '')}`);

                entries = [...(list?.options || [])].map(o => ({
                    id: o.value.trim(),
                    label: o.label || o.value,
                    disabled: false,
                }));
            } else if (el.classList.contains('selectize-control')) {
                const input = $('input', el);
                const instance = input?.selectize;

                if (instance?.options) {
                    entries = Object.keys(instance.options).map(k => ({
                        id: k,
                        label: instance.options[k].text || k,
                        disabled: false,
                    }));
                }
            }

            for (const entry of entries) {
                const id = entry.id.trim();

                if (!id || /^(select|choose|none|\-+|loading)/i.test(id)) {
                    continue;
                }

                if (!found.has(id)) {
                    found.set(id, {
                        id,
                        label: entry.label || id,
                        disabled: Boolean(entry.disabled),
                        source: el.id || el.name || el.className || 'model selector',
                    });
                }
            }
        }

        return [...found.values()].sort((a, b) =>
            a.id.localeCompare(b.id)
        );
    }

    function setStatus(message) {
        const el = $('#mc-status');
        if (el) el.textContent = message;
    }

    function formatRefreshTime(date) {
        if (!date) return 'Not refreshed yet';

        return `Last refreshed: ${date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        })}`;
    }

    function refresh() {
        models = readModels();
        lastRefreshed = new Date();

        const status = models.length
            ? `${models.length} model ID(s) currently exposed by ${providerLabel()}. ${formatRefreshTime(lastRefreshed)}.`
            : `No model list detected for ${providerLabel()}. Open the API panel, wait for its model list to load, then refresh. ${formatRefreshTime(lastRefreshed)}.`;

        setStatus(status);
        render();
    }

    function testedIds() {
        const settings = ctx?.extensionSettings?.[EXT] || {};

        return new Set(
            Array.isArray(settings.tested) ? settings.tested : []
        );
    }

    function render() {
        const list = $('#mc-list');
        if (!list) return;

        const query = ($('#mc-search')?.value || '').toLowerCase().trim();
        const filter = $('#mc-filter')?.value || 'all';
        const tested = testedIds();

        const visible = models.filter(model =>
            (!query
                || model.id.toLowerCase().includes(query)
                || model.label.toLowerCase().includes(query))
            && (filter !== 'tested' || tested.has(model.id))
        );

        const summary = $('#mc-summary');

        if (summary) {
            summary.textContent =
                `${visible.length} shown / ${models.length} currently discovered · ${tested.size} personally tested`;
        }

        if (!visible.length) {
            list.innerHTML = `
                <div class="mc-empty">
                    No matching models discovered. Open the API panel,
                    load its model list, and press Refresh models.
                </div>
            `;
            return;
        }

        list.innerHTML = visible.map(model => {
            const isTested = tested.has(model.id);

            return `
                <article class="mc-card">
                    <div class="mc-card-head">
                        <span class="mc-name">${esc(model.id)}</span>
                        <span class="mc-badge">
                            ${model.disabled ? 'Listed but disabled' : 'Currently listed'}
                        </span>
                        <button
                            class="menu_button mc-copy"
                            data-id="${esc(model.id)}"
                        >
                            Copy name
                        </button>
                    </div>

                    <div class="mc-meta">
                        <div class="mc-field">
                            <b>NSFW policy</b>
                            Unknown — provider/model dependent
                        </div>
                        <div class="mc-field">
                            <b>Detailed / long prose</b>
                            Not tested
                        </div>
                        <div class="mc-field">
                            <b>Adult-industry research</b>
                            Not tested
                        </div>
                        <div class="mc-field">
                            <b>Context window</b>
                            Unknown from live selector
                        </div>
                        <div class="mc-field">
                            <b>Maximum output</b>
                            Unknown from live selector
                        </div>
                        <div class="mc-field">
                            <b>Streaming / reasoning</b>
                            Not verified
                        </div>
                    </div>

                    <div class="mc-actions">
                        <label>
                            <input
                                type="checkbox"
                                class="mc-tested"
                                data-id="${esc(model.id)}"
                                ${isTested ? 'checked' : ''}
                            >
                            I have tested this model
                        </label>

                        <span class="notes">
                            Source control: ${esc(model.source)}
                        </span>
                    </div>
                </article>
            `;
        }).join('');

        $$('.mc-copy', list).forEach(button => {
            button.addEventListener('click', () =>
                copyText(button.dataset.id)
            );
        });

        $$('.mc-tested', list).forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                const settings = ctx.extensionSettings[EXT];
                const set = new Set(settings.tested || []);

                checkbox.checked
                    ? set.add(checkbox.dataset.id)
                    : set.delete(checkbox.dataset.id);

                settings.tested = [...set];
                ctx.saveSettingsDebounced();
                render();
            });
        });
    }

    async function copyText(value) {
        try {
            await navigator.clipboard.writeText(value);
            toast('success', 'Copied model name.');
        } catch {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            document.body.append(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();

            toast('success', 'Copied model name.');
        }
    }

    function toast(kind, message) {
        const fn = globalThis.toastr?.[kind]
            || globalThis.toastr?.info;

        if (fn) fn(message, 'Model Capabilities');
    }

    function openModal() {
        const modal = $('#mc-modal');
        if (!modal) return;

        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');

        refresh();
    }

    function closeModal() {
        const modal = $('#mc-modal');

        if (modal) {
            modal.classList.remove('open');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    function scheduleRefresh() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(refresh, 650);
    }

    async function init() {
        ctx = SillyTavern.getContext();
        ctx.extensionSettings[EXT] ||= { tested: [] };

        const html = await ctx.renderExtensionTemplateAsync(
            'third-party/model-capabilities',
            'settings'
        );

        let target = $('#extensions_settings2')
            || $('#extensions_settings');

        if (!target) {
            target = await new Promise(resolve => {
                const mo = new MutationObserver(() => {
                    const found = $('#extensions_settings2')
                        || $('#extensions_settings');

                    if (found) {
                        mo.disconnect();
                        resolve(found);
                    }
                });

                mo.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                });

                setTimeout(() => {
                    mo.disconnect();

                    resolve(
                        $('#extensions_settings2')
                        || $('#extensions_settings')
                    );
                }, 12000);
            });
        }

        if (!target || $('#mc-extension')) return;

        target.insertAdjacentHTML('beforeend', html);

        $('#mc-open')?.addEventListener('click', openModal);
        $('#mc-refresh')?.addEventListener('click', refresh);
        $('#mc-close')?.addEventListener('click', closeModal);

        $('#mc-modal')?.addEventListener('click', event => {
            if (event.target.id === 'mc-modal') closeModal();
        });

        $('#mc-search')?.addEventListener('input', render);
        $('#mc-filter')?.addEventListener('change', render);

        $('#mc-copy-all')?.addEventListener('click', () => {
            copyText(models.map(model => model.id).join('\n'));
        });

        $('#mc-copy-visible')?.addEventListener('click', () => {
            const query = ($('#mc-search')?.value || '').toLowerCase();
            const filter = $('#mc-filter')?.value || 'all';
            const tested = testedIds();

            const visible = models.filter(model =>
                (model.id.toLowerCase().includes(query)
                    || model.label.toLowerCase().includes(query))
                && (filter !== 'tested' || tested.has(model.id))
            );

            copyText(visible.map(model => model.id).join('\n'));
        });

        const { eventSource, event_types } = ctx;

        for (const name of [
            'MAIN_API_CHANGED',
            'CHATCOMPLETION_SOURCE_CHANGED',
            'CHATCOMPLETION_MODEL_CHANGED',
            'CONNECTION_PROFILE_LOADED',
        ]) {
            if (event_types?.[name]) {
                eventSource.on(event_types[name], scheduleRefresh);
            }
        }

        observer = new MutationObserver(scheduleRefresh);

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        refresh();

        console.info(`[Model Capabilities] v${VERSION} initialized.`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            () => init().catch(error =>
                console.error('[Model Capabilities]', error)
            ),
            { once: true }
        );
    } else {
        init().catch(error =>
            console.error('[Model Capabilities]', error)
        );
    }
})();
