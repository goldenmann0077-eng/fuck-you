/*
 * Smart Continuation & Output Repair for SillyTavern
 * Target: SillyTavern 1.19.x, AI Horde / Text Completion.
 * Conservative by design: never deletes whole messages; only removes exact adjacent
 * duplicate paragraphs and optionally normalizes the user's requested *** wrappers.
 */

(() => {
    'use strict';

    const EXT = 'smart_continuation_repair';
    const VERSION = '0.5.20';
    const DEFAULTS = {
        enabled: true,
        injectGuidance: true,
        // Destructive text rewriting is OFF by default. Enable only after testing on a disposable chat.
        autoFormat: false,
        paragraphWrappers: false,
        removeInlineAsteriskEmphasis: false,
        removeExactAdjacentDuplicates: false,
        maxAutoContinues: 3,
        detectCrossMessageRepetition: true,
        replaceContinueMenuItem: true,
        addSmartRegenerateMenuItem: true,
        sceneFocusRegenerate: true,
        detectPromptEcho: true,
        varyImpersonateRetries: true,
        rememberImpersonateAttempts: true,
        narrativeDiversity: true,
        diversityLookback: 5,
        impersonateAttemptCount: 0,
        impersonateAttemptOriginal: '',
        recentImpersonateAttempts: [],
    };

    let ctx;
    let settings;
    // Keep the exact prompt array reference for cleanup; do not assume it is ctx.chat.
    let pendingInjected = [];
    let injectedCleanupTimer = null;
    let autoContinueBusy = false;
    let lastHandledMessage = null;
    let uiReady = false;
    let menuObserver = null;
    let menuClickHandlerInstalled = false;
    let generationSnapshot = null;
    let lastInterceptorInfo = 'Not yet observed';
    let lastGenerationType = 'Unknown';
    let pendingSmartImpersonate = null;
    let smartImpersonateBusy = false;
    let pendingFocusAnalysis = null;
    // A manual Smart Continue may use a bounded extra generation pass when the
    // model hits its per-request token ceiling in the middle of a sentence.
    let pendingAssistantContinue = null;

    const $ = (selector, root = document) => root.querySelector(selector);

    function getSettings() {
        const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
        if (!extensionSettings[EXT]) extensionSettings[EXT] = structuredClone(DEFAULTS);
        for (const [key, value] of Object.entries(DEFAULTS)) {
            if (!(key in extensionSettings[EXT])) extensionSettings[EXT][key] = value;
        }
        settings = extensionSettings[EXT];
        // 0.5.9 effectively allowed only one follow-up pass. Raise that old
        // default to three bounded passes so a long unfinished utterance can
        // survive multiple short AI Horde completions.
        if (settings.maxAutoContinues === 1) settings.maxAutoContinues = 3;
        return { settings, saveSettingsDebounced };
    }

    function toast(kind, message) {
        const fn = globalThis.toastr?.[kind] || globalThis.toastr?.info;
        if (fn) fn(message, 'Smart Continuation');
        else console[kind === 'error' ? 'error' : 'log'](`[Smart Continuation] ${message}`);
    }

    function lastChatMessage() {
        const chat = SillyTavern.getContext().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_system && !m.extra?.isSmallSys && typeof m.mes === 'string' && m.mes.trim()) {
                return { message: m, index: i, chat };
            }
        }
        return null;
    }

    function lastAssistantMessage() {
        const chat = SillyTavern.getContext().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) {
                return { message: m, index: i, chat };
            }
        }
        return null;
    }

    function splitParagraphs(text) {
        return String(text ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
    }

    function stripInlineAsteriskEmphasis(text) {
        // Preserve *** paragraph wrappers; remove only isolated **bold** and *italic* spans.
        let out = text.replace(/(^|[^*])\*\*([^*\n]+)\*\*(?!\*)/g, '$1$2');
        out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
        return out;
    }

    function normalizeParagraph(paragraph) {
        let p = paragraph.trim();
        if (!p) return p;
        if (/^```/.test(p) || /^~~~/.test(p) || /^#{1,6}\s/.test(p) || /^\s*>/.test(p)) return p;

        // Remove one existing outer wrapper pair before normalizing inner emphasis.
        const hadOpen = p.startsWith('***');
        const hadClose = p.endsWith('***') && p.length >= 6;
        if (hadOpen) p = p.slice(3).trimStart();
        if (hadClose) p = p.slice(0, -3).trimEnd();

        if (settings.removeInlineAsteriskEmphasis) p = stripInlineAsteriskEmphasis(p);
        if (settings.paragraphWrappers && p.trim()) p = `***${p.trim()}***`;
        else if (hadOpen || hadClose) p = `${hadOpen ? '***' : ''}${p}${hadClose ? '***' : ''}`;
        return p;
    }

    function normalizeFormatting(text) {
        if (!settings.autoFormat) return text;
        const paragraphs = splitParagraphs(text);
        let inFence = false;
        const result = [];
        for (const raw of paragraphs) {
            const trimmed = raw.trim();
            if (/^```|^~~~/.test(trimmed)) inFence = !inFence;
            if (inFence || !trimmed) result.push(raw);
            else result.push(normalizeParagraph(raw));
        }
        return result.join('\n\n');
    }

    function normalizedForCompare(text) {
        return String(text).replace(/\*{1,3}/g, '').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
    }

    // Echo detection must survive Gemma changing quote style, punctuation, or
    // Markdown while copying a long composer draft. Keep letters/numbers and
    // collapsed word boundaries; punctuation is deliberately ignored ONLY for
    // matching. The user's original source is never normalized or rewritten.
    function comparableEcho(text) {
        return String(text || '').toLocaleLowerCase().normalize('NFKC')
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    }

    function rawOffsetAfterComparableEchoPrefix(rawText, comparablePrefix) {
        const raw = String(rawText || '');
        const target = String(comparablePrefix || '');
        let value = '';
        let offset = 0;
        let pendingSpace = false;
        for (; offset < raw.length; offset++) {
            const ch = raw[offset];
            if (/[\p{L}\p{N}]/u.test(ch)) {
                if (pendingSpace && value.length) value += ' ';
                pendingSpace = false;
                value += ch.toLocaleLowerCase().normalize('NFKC');
                if (!target.startsWith(value)) return -1;
                if (value === target) return offset + 1;
            } else {
                // Punctuation is a word boundary for comparison purposes too
                // (e.g. straight vs curly quotes, apostrophes, and em dashes).
                pendingSpace = value.length > 0;
            }
        }
        return value === target ? offset : -1;
    }

    function isExplicitOpenDialogueMarker(text) {
        return /\*{3}\s*[\"“]\s*$/.test(String(text || '').trimEnd());
    }

    // Find the raw-string offset immediately after a normalized prefix. This lets
    // us discard a model's echoed copy of the draft while keeping the user's exact
    // original formatting and every paragraph marker byte-for-byte.
    function rawOffsetAfterNormalizedPrefix(rawText, normalizedPrefix) {
        const raw = String(rawText || '');
        const target = String(normalizedPrefix || '');
        let matched = 0;
        let offset = 0;
        for (; offset < raw.length && matched < target.length; offset++) {
            const ch = raw[offset];
            if (ch === '*' || /[\s\u00a0]/.test(ch)) continue;
            if (ch.toLowerCase() !== target[matched]) return -1;
            matched++;
        }
        return matched === target.length ? offset : -1;
    }

    function removeExactAdjacentDuplicateParagraphs(text) {
        if (!settings.removeExactAdjacentDuplicates) return { text, removed: 0 };
        const paragraphs = splitParagraphs(text);
        const kept = [];
        let removed = 0;
        for (const p of paragraphs) {
            const current = normalizedForCompare(p);
            const previous = normalizedForCompare(kept[kept.length - 1] || '');
            // Only remove long, exact adjacent repeats; short repeated lines may be intentional.
            if (current.length >= 80 && current === previous) {
                removed++;
                continue;
            }
            kept.push(p);
        }
        return { text: kept.join('\n\n'), removed };
    }

    function analyzeEnding(text) {
        // Inspect the raw ending BEFORE trimming. This preserves evidence such as
        // a trailing space, an unfinished quote, or punctuation at the exact end.
        const raw = String(text || '').replace(/\r\n/g, '\n');
        const hasTrailingSpace = /[ \t\u00a0]$/.test(raw);

        // Remove only our paragraph wrappers and formatting delimiters for the
        // linguistic check. Do not silently discard dialogue punctuation.
        let ending = raw.replace(/[ \t\u00a0]+$/g, '');
        ending = ending.replace(/\*{3}\s*$/g, '').replace(/[ \t\u00a0]+$/g, '');
        // Strip closing Markdown emphasis/code delimiters for analysis only.
        // AI roleplay drafts often end in combinations such as **_, _**, ***,
        // or a single * / _. These are formatting tokens, not the sentence's
        // final character; leaving them in place hides an unfinished prose tail.
        ending = ending.replace(/(?:\*\*|__|~~|`|\*|_)+$/g, '').replace(/[ \t\u00a0]+$/g, '');
        const tail = ending.slice(-180);
        if (!ending.trim()) return { status: 'unknown', reason: 'The message is empty.', tail };
        if (isExplicitOpenDialogueMarker(ending)) {
            return { status: 'complete', reason: 'The final ***\" is an intentional opening for dialogue or quoted thought, not a malformed or accidental unmatched quote.', tail, finalSentence: '' };
        }

        // Keep the final visible punctuation/quote for structural checks.
        const visibleEnd = ending.slice(-1);
        const punctuationEnd = /[.,:;!?…*()\[\]{}<>\\/\\|_+=~—–-]/.test(visibleEnd);
        const quoteChars = (ending.match(/"/g) || []).length;
        const smartOpen = (ending.match(/“/g) || []).length;
        const smartClose = (ending.match(/”/g) || []).length;
        const straightQuoteOpen = quoteChars % 2 === 1;
        const smartQuoteOpen = smartOpen > smartClose;
        const singleSmartOpen = (ending.match(/‘/g) || []).length > (ending.match(/’/g) || []).length;

        // Extract the last sentence without throwing away the sentence when it
        // ends in punctuation. Keep a pre-terminal fragment for dialogue checks.
        const hasTerminal = /[.!?…]["'”’»\])}]*$/.test(ending);
        const withoutFinalStop = ending.replace(/[.!?…]["'”’»\])}]*$/, '').trimEnd();
        const previousStop = Math.max(withoutFinalStop.lastIndexOf('.'), withoutFinalStop.lastIndexOf('!'), withoutFinalStop.lastIndexOf('?'), withoutFinalStop.lastIndexOf('…'));
        const finalSentence = withoutFinalStop.slice(previousStop + 1).trim().replace(/^["'“‘([{\s]+/, '').trim();
        // Ignore trailing separators and whitespace when finding the final word.
        // Thus ", but", ",but", ", but ", and ", but..." remain unfinished.
        const finalLower = finalSentence.toLowerCase().replace(/[\s*_`~]+$/g, '').replace(/[,;:]+$/g, '').trim();
        const lastWordMatch = finalLower.match(/([a-z]+(?:['’][a-z]+)?|[a-z]+['’])$/i);
        const lastWord = lastWordMatch ? lastWordMatch[1].toLowerCase() : '';
        const trailingConnectorMatch = ending.match(/(?:[,;:]\s*)?(but|and|or|yet|so|because|although|though|while|when|if|unless|until|whether|which|that|who|whom|whose|where|what|with|without|to|of|for|from|by|at|in|on|into|onto|over|under)\s*(?:(?:\.{2,})|…)?[\"“‘]*$/i);
        const trailingConnector = trailingConnectorMatch ? trailingConnectorMatch[1].toLowerCase() : '';

        const danglingEndings = new Set([
            'and','or','but','because','although','though','while','when','whenever','if','unless','until',
            'which','that','who','whom','whose','where','what','why','how','whether',
            'with','without','to','of','for','from','by','at','in','on','into','onto','over','under',
            'the','a','an',
            'is','am','are','was','were','be','been','being','has','have','had','do','does','did',
            'can','could','will','would','shall','should','may','might','must'
        ]);
        const orphanSubjects = new Set(['i','he','she','they','we','it','you','who','someone','somebody','something']);
        const unfinishedWord = /[a-z]['’]$/i.test(finalSentence) || /(?:[a-z]{2,})[-–—]$/i.test(finalSentence);
        const danglingWord = danglingEndings.has(lastWord);
        const orphanSubject = orphanSubjects.has(finalLower.replace(/[.!?,;:]+$/g, '').trim());
        const incompleteClause = /\b(?:because|although|though|when|while|if|unless|before|after|until|as soon as)\s+\w+(?:\s+\w+){0,5}$/i.test(finalSentence);
        const adjectiveOnlyTail = /\b(?:a|an)\s+(?:(?:soft|gentle|quiet|faint|low|small|subtle|warm|cold|deep|strange|odd|almost|nearly|rather|somewhat)\s*,?\s*){1,4}(?:almost\s+)?(?:reverent|solemn|tender|gentle|quiet|soft|faint|subtle|warm|cold|strange|unusual|intimate|deliberate|careful|awkward|uncertain|hopeful|wistful|musical|reverberant)$/i.test(finalSentence);

        // An unmatched opening quote is stronger evidence than the presence of
        // a period. Also detect dialogue deliberately cut off by a dash/ellipsis
        // immediately before its closing quote (e.g. “I was going to—”).
        const dialogueTail = ending.slice(-100);
        const interruptedQuotedSpeech = /(?:—|–|-|\.\.\.|…)["”’]\s*$/u.test(dialogueTail);
        // Detect unfinished grammar before whitespace and terminal punctuation.
        // A trailing connector is incomplete even with a space or ellipsis after it.
        if (trailingConnector) return { status: 'likely', reason: `The final clause ends with the unfinished connector "${trailingConnector}"; the same sentence/thought needs to be completed before a new one begins.`, tail, finalSentence, trailingConnector };
        if (unfinishedWord) return { status: 'likely', reason: 'The final word appears unfinished.', tail, finalSentence };
        if (orphanSubject) return { status: 'likely', reason: `The final sentence contains only "${finalSentence}"; it starts a thought but does not complete it.`, tail, finalSentence };
        if (danglingWord) return { status: 'likely', reason: `The final sentence ends with "${lastWord}", which usually needs more words to complete the thought.`, tail, finalSentence };
        if (straightQuoteOpen || smartQuoteOpen || singleSmartOpen) return { status: 'likely', reason: 'An opening quotation mark has no matching closing quotation mark; dialogue or quoted thought may still be unfinished.', tail, finalSentence };
        if (interruptedQuotedSpeech) return { status: 'possible', reason: 'The final quoted dialogue appears to stop at a dash or ellipsis; the spoken thought may be unfinished even though the quotation mark is closed.', tail, finalSentence };
        // Otherwise, terminal punctuation closes the sentence; turn completion is separate.
        if (hasTerminal) return { status: 'complete', reason: 'The sentence has terminal punctuation; conversational context still determines whether a response is expected.', tail, finalSentence };
        if (hasTrailingSpace) return { status: 'possible', reason: 'The message ends with a space or tab, but no specific unfinished word or connector was detected.', tail, finalSentence };
        if (incompleteClause) return { status: 'possible', reason: 'The final sentence appears to stop inside a dependent clause.', tail, finalSentence };
        if (adjectiveOnlyTail) return { status: 'likely', reason: 'The final sentence appears to end with an adjective where a noun or further phrase is still needed.', tail, finalSentence };

        // Punctuation at the exact end is reported distinctly. Commas, colons,
        // semicolons, opening brackets, and dashes commonly signal continuation;
        // full stops, question marks, exclamation marks and closing delimiters do not.
        const unfinishedSeparator = ending.match(/(?:[,;:—–-]|[([{])$/)?.[0] || (/[\"”’»]+$/.test(ending) && /[,;:—–-][\"”’»]+$/.test(ending) ? ending.match(/[,;:—–-]/)?.[0] : '');
        if (unfinishedSeparator) return { status: 'likely', reason: `The message ends with the continuation marker "${unfinishedSeparator}", which commonly indicates an unfinished clause, list, interruption, or bracketed thought.`, tail, finalSentence };
        if (!hasTerminal) {
            return { status: 'possible', reason: punctuationEnd ? `The final character is "${visibleEnd}"; it was checked as punctuation/symbol rather than treated as a normal sentence ending.` : 'The message has no final punctuation; that alone does not prove truncation.', tail, finalSentence };
        }
        return { status: 'complete', reason: 'No obvious incomplete ending was detected.', tail, finalSentence };
    }

    // Inspect every paragraph, not just the final paragraph of the whole message.
    // An open *** wrapper is meaningful: it marks prose that has not been closed yet.
    function analyzeParagraphBoundaries(text) {
        const parts = splitParagraphs(String(text || '').replace(/\r\n/g, '\n'));
        const issues = [];
        parts.forEach((raw, index) => {
            const paragraph = raw.trimEnd();
            if (!paragraph.trim()) return;
            // ***" is a deliberate opening for the next spoken/thought line,
            // not a malformed paragraph wrapper or an unfinished prose paragraph.
            if (/^\*{3}\s*[\"“]\s*$/.test(paragraph.trim())) return;
            const opens = paragraph.startsWith('***');
            const closes = paragraph.endsWith('***') && paragraph.length > 6;
            const unclosedWrapper = opens && !closes;
            const core = paragraph.replace(/^\*{3}/, '').replace(/\*{3}$/, '').trimEnd();
            const hasSentenceEnd = /[.!?…]["'”’»\])}]*$/.test(core);
            const danglingPossessivePhrase = /\b(?:his|her|their|my|your|our|its)\s+(?!(?:and|or|but|because|although|though|while|when|if|unless|until)\b)[\w'-]+$/i.test(core);
            const tail = analyzeEnding(paragraph);
            if (unclosedWrapper && !hasSentenceEnd) {
                issues.push({ paragraph: index + 1, status: 'likely', reason: 'This paragraph opens with *** but has no closing *** and no sentence-ending punctuation; it appears to be an intentionally open narrative passage.' });
            } else if (danglingPossessivePhrase && !hasSentenceEnd) {
                issues.push({ paragraph: index + 1, status: 'possible', reason: 'The paragraph ends on a possessive noun phrase (for example, “his cock”) without visible sentence-ending punctuation; check whether the thought is still in progress.' });
            } else if (tail.status === 'likely' || tail.status === 'possible') {
                issues.push({ paragraph: index + 1, status: tail.status, reason: tail.reason });
            }
        });
        return issues;
    }

    function questionAtEnd(text) {
        const value = String(text || '').trim();
        if (!value) return false;
        const lastLine = value.split(/\n/).filter(x => x.trim()).slice(-1)[0] || value;
        return /\?\s*["'”’»)]*\s*$/.test(lastLine);
    }

    function assessConversation(source, seededFromChat = false) {
        const chat = Array.isArray(SillyTavern.getContext().chat) ? SillyTavern.getContext().chat : [];
        const recent = chat.filter(m => m && !m.is_system && !m.extra?.isSmallSys && typeof m.mes === 'string' && m.mes.trim()).slice(-8);
        const latest = recent[recent.length - 1] || null;
        const latestUser = [...recent].reverse().find(m => m.is_user) || null;
        const latestAssistant = [...recent].reverse().find(m => !m.is_user) || null;
        const src = String(source || '');
        const explicitOpenDialogue = isExplicitOpenDialogueMarker(src);
        const sourceAnalysis = analyzeEnding(src);
        const paragraphIssues = analyzeParagraphBoundaries(src);
        const openTriple = !explicitOpenDialogue && /^\s*\*\*\*/.test(src) && !/\*\*\*\s*$/.test(src);
        const openQuote = !explicitOpenDialogue && /(?:^|[^\\])["“][^"”]*$/.test(src.trimEnd());
        const sourceQuestion = questionAtEnd(src);
        const latestUserQuestion = latestUser ? questionAtEnd(latestUser.mes) : false;
        const userQuestionUnanswered = Boolean(latestUserQuestion && (!latestAssistant || recent.lastIndexOf(latestUser) > recent.lastIndexOf(latestAssistant)));
        const latestAssistantQuestion = Boolean(latestAssistant && recent.lastIndexOf(latestAssistant) === recent.length - 1 && questionAtEnd(latestAssistant.mes));
        const lastSpeaker = latest ? (latest.is_user ? 'user' : 'character/assistant') : 'unknown';
        let handoff = 'No clear question/handoff detected';
        if (sourceQuestion) handoff = 'The active source itself ends with a question; assess whether the scene calls for an in-character answer rather than mechanically extending the question.';
        else if (userQuestionUnanswered) handoff = 'The latest user contribution contains an unanswered question; the next roleplay turn should address it directly.';
        else if (latestAssistantQuestion) handoff = 'The latest assistant/character contribution ends with a question; assess whether the scene expects the user to answer rather than continuing to answer for them.';
        else if (latest?.is_user) handoff = 'The user spoke most recently; respond to their latest contribution and preserve their agency.';
        else if (latestAssistant) handoff = 'The character/assistant spoke most recently; continue that turn only if it is genuinely unfinished, otherwise consider whether a user response is expected.';
        return {
            lastSpeaker,
            sourceEnding: explicitOpenDialogue ? 'intentional-open-dialogue' : sourceAnalysis.status,
            sourceEndingReason: explicitOpenDialogue ? 'The final ***" is an intentional dialogue/thought opening marker.' : sourceAnalysis.reason,
            paragraphIssues,
            openTriple,
            openQuote,
            sourceQuestion,
            userQuestionUnanswered,
            latestAssistantQuestion,
            handoff,
            recentTurns: recent.map(m => `${m.is_user ? 'USER' : 'CHARACTER'}: ${String(m.mes).slice(-500)}`).join('\n')
        };
    }

    function getAnalysis(text, role = 'assistant') {
        const rawText = String(text || '');
        const clean = rawText.trimEnd();
        const paragraphs = splitParagraphs(clean).map(p => p.trim()).filter(Boolean);
        // Pass the untrimmed original so analyzeEnding can detect trailing spaces/tabs.
        const ending = analyzeEnding(rawText);
        const paragraphIssues = analyzeParagraphBoundaries(rawText);
        // Report the issue nearest the actual end of the text. Earlier open
        // paragraphs remain visible in the paragraph list, but must not mask a
        // newer unfinished sentence at the message tail.
        const boundaryIssue = [...paragraphIssues].reverse().find(x => x.status === 'likely')
            || paragraphIssues[paragraphIssues.length - 1]
            || null;
        const repeated = [];
        const crossMessageRepeated = [];
        const previousTexts = settings.detectCrossMessageRepetition ? getRecentMessageTexts(6, role === 'user').slice(1) : [];
        const previousParagraphs = new Set(previousTexts.flatMap(t => splitParagraphs(t).map(normalizedForCompare)).filter(x => x.length >= 80));
        const seen = new Map();
        paragraphs.forEach((p, i) => {
            const n = normalizedForCompare(p);
            if (n.length < 80) return;
            if (seen.has(n)) repeated.push({ first: seen.get(n) + 1, again: i + 1 });
            else seen.set(n, i);
            if (previousParagraphs.has(n)) crossMessageRepeated.push(i + 1);
        });
        return {
            suspicious: ending.status === 'likely' || Boolean(boundaryIssue?.status === 'likely'),
            possibleEndingIssue: ending.status === 'possible' || Boolean(boundaryIssue),
            // Keep the actual final-character analysis authoritative. Paragraph
            // wrapper warnings are reported separately and must never hide a more
            // specific unfinished quote, comma, semicolon, colon, dash, or connector.
            endingStatus: ending.status === 'likely' ? 'likely' : (boundaryIssue?.status || ending.status),
            endingReason: ending.reason,
            noTerminal: ending.status === 'possible' && /no final punctuation/i.test(ending.reason),
            repeated, crossMessageRepeated, paragraphIssues, tail: ending.tail, finalSentence: ending.finalSentence || '', paragraphs: paragraphs.length
        };
    }

    function getRecentMessageTexts(count = 5, userMessages = false) {
        const chat = SillyTavern.getContext().chat || [];
        const found = [];
        for (let i = chat.length - 1; i >= 0 && found.length < count; i--) {
            const m = chat[i];
            if (m && !!m.is_user === userMessages && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) found.push(m.mes);
        }
        return found;
    }

    function getRecentAssistantTexts(count = 5, excludeMessage = null) {
        const chat = SillyTavern.getContext().chat || [];
        const found = [];
        for (let i = chat.length - 1; i >= 0 && found.length < count; i--) {
            const m = chat[i];
            if (m && m !== excludeMessage && !m.is_user && !m.is_system && !m.extra?.isSmallSys
                && typeof m.mes === 'string' && m.mes.trim()) found.push(m.mes);
        }
        return found;
    }

    // Lightweight local motif scan. This is not a semantic classifier: it spots
    // repeated surface motifs across recent assistant turns and gives the model
    // a compact, concrete reminder to change the scene beat rather than synonym-swap.
    const DIVERSITY_MOTIFS = [
        ['body-position / shifting posture', /\b(?:shift(?:ed|ing)?|adjust(?:ed|ing)?|settle(?:d|s|ing)?|lean(?:ed|ing)?|squirm(?:ed|ing)?|reposition(?:ed|ing)?)\b/gi],
        ['legs / knees / thighs', /\b(?:legs?|knees?|thighs?|calves?)\b/gi],
        ['breathing / sighs', /\b(?:breath(?:e|ed|ing)?|inhale[ds]?|exhale[ds]?|sigh(?:ed|s)?|gasp(?:ed|s|ing)?)\b/gi],
        ['heartbeat / pulse', /\b(?:heart(?:beat)?|pulse|throb(?:bed|bing|s)?)\b/gi],
        ['trembling / shivering', /\b(?:trembl(?:e|ed|es|ing)|shiver(?:ed|s|ing)?|quiver(?:ed|s|ing)?)\b/gi],
        ['warmth / heat', /\b(?:warm(?:th|er|ed)?|heat(?:ed)?|hotter|cool(?:ed|ing)?)\b/gi],
        ['scent / smell', /\b(?:scent|smell|fragrance|aroma|perfume)\b/gi],
        ['vibrations / ripples', /\b(?:vibrat(?:e|ed|es|ing|ion|ions)|ripple[ds]?|quak(?:e|ed|ing))\b/gi],
        ['gaze / looking', /\b(?:look(?:ed|s|ing)?|gaze[ds]?|stare[ds]?|glance[ds]?|eye[ds]?)\b/gi],
        ['smiles / laughter', /\b(?:smil(?:e|ed|es|ing)|grin(?:ned|s|ning)?|laugh(?:ed|s|ing)?|chuckl(?:e|ed|es|ing))\b/gi],
        ['touch / contact', /\b(?:touch(?:ed|es|ing)?|brush(?:ed|es|ing)?|stroke[ds]?|caress(?:ed|es|ing)?|press(?:ed|es|ing)?)\b/gi],
        ['hair / clothing adjustment', /\b(?:hair|dress|skirt|shirt|clothing|fabric|hem)\b/gi],
        ['voice / tone', /\b(?:voice|tone|whisper(?:ed|s|ing)?|murmur(?:ed|s|ing)?|mutter(?:ed|s|ing)?)\b/gi],
    ];

    // Classify the *function* of recent scene beats as well as repeated words.
    // These are deliberately broad signals: they guide generation but never edit output.
    const DIVERSITY_BEATS = [
        ['physical movement / posture', /\b(?:walk(?:ed|s|ing)?|move[ds]?|step(?:ped|s|ping)?|turn(?:ed|s|ing)?|shift(?:ed|s|ing)?|lean(?:ed|s|ing)?|sit(?:s|ting)?|stand(?:s|ing)?|reach(?:ed|es|ing)?|kneel(?:ed|s|ing)?)\b/gi],
        ['body sensation / reaction', /\b(?:felt|feel(?:s|ing)?|warmth|heat|cold|tingl(?:e|ed|es|ing)|pulse|heartbeat|breath(?:e|ed|ing)?|shiver(?:ed|s|ing)?|trembl(?:e|ed|es|ing)|scent|smell|vibration|ripple)\b/gi],
        ['dialogue / verbal exchange', /(?:[“"].{2,}[”"]|\b(?:said|asked|replied|answered|whispered|muttered|called|told|questioned)\b)/gi],
        ['looking / attention', /\b(?:look(?:ed|s|ing)?|watch(?:ed|es|ing)?|gaze[ds]?|stare[ds]?|glance[ds]?|notice[ds]?|focus(?:ed|es|ing)?)\b/gi],
        ['environment / object interaction', /\b(?:door|window|chair|table|phone|screen|cup|glass|book|floor|wall|room|light|lamp|music|weather|rain|wind|object|picked up|put down|opened|closed)\b/gi],
        ['decision / intention / planning', /\b(?:decid(?:e|ed|es|ing)|cho(?:ose|se|sen|osing)|plan(?:ned|s|ning)?|intend(?:ed|s)?|wonder(?:ed|s|ing)?|consider(?:ed|s|ing)?|realiz(?:e|ed|es|ing)|understood|thought|remember(?:ed|s|ing)?)\b/gi],
        ['emotional reflection', /\b(?:afraid|nervous|curious|annoyed|amused|relieved|uncertain|confident|embarrassed|frustrated|pleased|disappointed|hesitat(?:e|ed|es|ing)|smil(?:e|ed|es|ing)|laugh(?:ed|s|ing)?)\b/gi],
    ];

    function getNarrativeDiversityBrief() {
        if (!settings?.narrativeDiversity) return '';
        const recent = getRecentAssistantTexts(Math.max(3, Math.min(8, Number(settings.diversityLookback) || 5)));
        if (!recent.length) return '';
        const counts = DIVERSITY_MOTIFS.map(([label, pattern]) => {
            let turns = 0, total = 0;
            for (const message of recent) {
                const matches = message.match(pattern);
                if (matches?.length) { turns++; total += matches.length; }
            }
            return { label, turns, total };
        }).filter(x => x.turns >= 2 || x.total >= 4)
          .sort((a, b) => (b.turns * 3 + b.total) - (a.turns * 3 + a.total))
          .slice(0, 5);
        const beatCounts = DIVERSITY_BEATS.map(([label, pattern]) => {
            let turns = 0;
            for (const message of recent) if (message.match(pattern)?.length) turns++;
            pattern.lastIndex = 0;
            return { label, turns };
        }).filter(x => x.turns >= Math.max(2, Math.ceil(recent.length * 0.6)))
          .sort((a, b) => b.turns - a.turns)
          .slice(0, 3);
        const avoid = counts.length ? counts.map(x => `${x.label} (${x.turns}/${recent.length})`).join('; ') : 'no repeated surface motif stands out';
        const beatAvoid = beatCounts.length ? beatCounts.map(x => `${x.label} (${x.turns}/${recent.length})`).join('; ') : 'no single beat category dominates';
        return ` RECENT-SCENE DIVERSITY ENGINE (last ${recent.length} assistant replies): Recurring motifs noticed: ${avoid}. Repeated beat categories: ${beatAvoid}. These are NOT forbidden topics: retain a recurring detail, image, or motif when it is meaningful and intentional. However, do not reuse the same descriptive passage or make the same event/reaction happen again without a new cause or changed consequence. Do not merely synonym-swap. Let the next paragraph serve the actual next beat: dialogue with a purpose, a decision, a consequence, an interaction, a relevant observation, or a purposeful pause may be more appropriate than another physical sensation. Do not force novelty, a new event, props, discoveries, character awareness, or plot facts that are not established. Each paragraph should add information, intention, consequence, or meaningful interaction; it need not add a bodily sensation or movement. Preserve current scene state, character knowledge, and speaker continuity.`;
    }


    function overlapLength(a, b) {
        const max = Math.min(a.length, b.length, 600);
        for (let n = max; n >= 18; n--) {
            if (a.slice(-n).toLowerCase() === b.slice(0, n).toLowerCase()) return n;
        }
        return 0;
    }

    function stripContinuationOverlap(original, continuation) {
        let c = String(continuation || '').trim();
        if (!c) return '';
        // Strip accidental outer paragraph wrappers from the generated continuation.
        c = c.replace(/^\*{3}\s*/, '').replace(/\s*\*{3}$/, '');
        const overlap = overlapLength(original.replace(/\*{3}\s*$/, '').trimEnd(), c);
        if (overlap) c = c.slice(overlap).replace(/^\s+/, '');
        return c;
    }

    function looksLikeWholeRepeat(original, continuation) {
        const origParas = splitParagraphs(original).map(normalizedForCompare).filter(x => x.length >= 80);
        const contParas = splitParagraphs(continuation).map(normalizedForCompare).filter(x => x.length >= 80);
        return contParas.some(p => origParas.includes(p));
    }

    // Repetition repair distinguishes an exact passage replay from a recurring motif.
    // A motif (e.g. a recurring visual detail) is not enough to delete anything;
    // only a substantial, verbatim narrative paragraph is eligible for removal.
    // Near-copies are reported separately so Smart Impersonate can retry rather
    // than silently rewriting potentially intentional callbacks.
    function removeRepeatedGeneratedContent(source, continuation, excludeMessage = null) {
        const normalize = value => String(value || '')
            .replace(/\*{1,3}/g, '')
            .replace(/[“”]/g, '"')
            .replace(/[’]/g, "'")
            .replace(/[\s\u00a0]+/g, ' ')
            .trim().toLocaleLowerCase();
        const isDialogue = value => /[“"][^”"]{2,}[”"]/.test(String(value || ''));
        const historySources = [String(source || ''), ...getRecentAssistantTexts(5, excludeMessage)];
        const sourceParas = historySources.flatMap(message => splitParagraphs(message))
            .map(p => ({ raw: p, n: normalize(p) }))
            .filter(p => p.n.length >= 100 && !isDialogue(p.raw));
        const sourceExact = new Set(sourceParas.map(p => p.n));
        const sourceShingles = sourceParas.map(p => wordShingles(p.n));

        let removedParagraphs = 0;
        let removedDialogue = 0; // Retained for UI compatibility; dialogue is never removed.
        let removedSentences = 0;
        let removedHistoricalParagraphs = 0;
        let nearDuplicateParagraphs = 0;
        let strongNearDuplicateParagraphs = 0;
        const keptParagraphs = [];
        const seenParagraphs = new Set();
        const seenLongSentences = new Set();
        const keptShingles = [];

        for (const paragraph of splitParagraphs(continuation)) {
            const n = normalize(paragraph);
            const dialogue = isDialogue(paragraph);
            if (!n) { keptParagraphs.push(paragraph); continue; }

            // Exact repeats of a substantial narrative paragraph are loops, even
            // when separated by several other paragraphs. Preserve quoted dialogue.
            if (n.length >= 100 && !dialogue && (seenParagraphs.has(n) || sourceExact.has(n))) {
                removedParagraphs++;
                if (sourceExact.has(n)) removedHistoricalParagraphs++;
                continue;
            }
            if (n.length >= 100 && !dialogue) seenParagraphs.add(n);

            // High-overlap four-word phrase shingles identify near-verbatim paraphrases.
            // They are NOT deleted: they trigger a bounded retry for Impersonate.
            if (n.length >= 180 && !dialogue) {
                const shingles = wordShingles(n);
                const candidates = [...sourceShingles, ...keptShingles];
                const bestSimilarity = candidates.reduce((best, other) => Math.max(best, shingleSimilarity(shingles, other)), 0);
                if (bestSimilarity >= 0.72) nearDuplicateParagraphs++;
                if (bestSimilarity >= 0.90) strongNearDuplicateParagraphs++;
                keptShingles.push(shingles);
            }

            // Exact long sentence repeats inside the generated portion are safe to
            // remove only outside quoted dialogue. Historical sentence callbacks stay.
            const cleaned = dialogue ? paragraph : paragraph.replace(/[^.!?…]+[.!?…]+/g, sentence => {
                const normalizedSentence = normalize(sentence);
                if (normalizedSentence.length >= 100 && seenLongSentences.has(normalizedSentence)) {
                    removedSentences++;
                    return '';
                }
                if (normalizedSentence.length >= 100) seenLongSentences.add(normalizedSentence);
                return sentence;
            });
            if (cleaned.trim()) keptParagraphs.push(cleaned);
        }
        return {
            text: keptParagraphs.join('\n\n'),
            removedParagraphs,
            removedDialogue,
            removedSentences,
            removedHistoricalParagraphs,
            nearDuplicateParagraphs,
            strongNearDuplicateParagraphs,
            total: removedParagraphs + removedSentences,
        };
    }

    function wordShingles(normalizedText) {
        const words = String(normalizedText || '').match(/[a-z0-9']+/g) || [];
        const shingles = new Set();
        if (words.length < 4) return shingles;
        for (let i = 0; i <= words.length - 4; i++) shingles.add(words.slice(i, i + 4).join(' '));
        return shingles;
    }

    function shingleSimilarity(a, b) {
        if (!a?.size || !b?.size) return 0;
        let intersection = 0;
        const smaller = a.size <= b.size ? a : b;
        const larger = smaller === a ? b : a;
        for (const item of smaller) if (larger.has(item)) intersection++;
        // Dice coefficient is more tolerant of a short revision to a paragraph
        // while still requiring substantial phrase-level identity.
        return (2 * intersection) / (a.size + b.size);
    }

    // Build a comparison string while retaining the raw character position for each
    // comparable character. This lets us remove a repeated prefix even when Gemma
    // changes Markdown asterisks or whitespace in the repeated portion.
    function comparableWithMap(text) {
        const raw = String(text || '');
        let value = '';
        const positions = [];
        let pendingSpace = false;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (ch === '*') continue; // ignore paragraph/emphasis markers for matching only
            if (/\s/.test(ch)) {
                pendingSpace = value.length > 0;
                continue;
            }
            if (pendingSpace) {
                value += ' ';
                positions.push(i - 1);
                pendingSpace = false;
            }
            value += ch.toLowerCase();
            positions.push(i);
        }
        return { value, positions };
    }

    function removeRepeatedContinuationPrefix(original, appended) {
        const next = String(appended || '');
        if (!next) return { text: next, removed: 0 };
        const a = comparableWithMap(original);
        const b = comparableWithMap(next);
        const max = Math.min(a.value.length, b.value.length, 12000);
        // Catch short echoed openings as well as long copied passages. For
        // shorter matches, require a natural boundary after the match so we
        // never cut a word in half or strip an ordinary shared word fragment.
        for (let n = max; n >= 24; n--) {
            if (!a.value.endsWith(b.value.slice(0, n))) continue;
            const rawEnd = b.positions[n - 1] + 1;
            const nextChar = next[rawEnd] || '';
            if (n < 80 && nextChar && !/[\s.,!?;:…—–\-"'“”‘’)}\]]/.test(nextChar)) continue;
            const remainder = next.slice(rawEnd).replace(/^\s+/, '');
            if (!remainder.trim()) continue;
            return { text: remainder, removed: rawEnd };
        }
        return { text: next, removed: 0 };
    }

    function repairNativeContinueOverlap(latest) {
        const snap = generationSnapshot;
        generationSnapshot = null;
        if (!snap || !latest || !String(lastGenerationType).toLowerCase().includes('continue')) return false;
        const current = String(latest.message.mes || '');
        const sameMessage = latest.message === snap.message;
        let appended;
        if (sameMessage) {
            if (!current.startsWith(snap.text) || current.length <= snap.text.length) return false;
            appended = current.slice(snap.text.length);
        } else {
            // Some SillyTavern paths store Continue as a new adjacent assistant message.
            if (latest.index !== snap.index + 1 || !current.trim()) return false;
            appended = current;
        }
        const repaired = removeRepeatedContinuationPrefix(snap.text, appended);
        if (!repaired.removed) return false;
        latest.message.mes = sameMessage ? snap.text + repaired.text : repaired.text;
        toast('info', `Removed ${repaired.removed} characters of repeated continuation text.`);
        return true;
    }

    function renderStatus(message = '') {
        const status = $('#sc_status');
        if (!status) return;
        const interceptorStatus = $('#sc_interceptor_status');
        if (interceptorStatus) interceptorStatus.textContent = `Prompt interceptor: ${lastInterceptorInfo}`;
        if (!message) {
            const composer = $('#send_textarea');
            const draft = String(composer?.value || '');
            const latest = lastChatMessage();
            if (!latest && !draft.trim()) { status.textContent = 'Waiting for a chat message or composer draft.'; return; }
            const targetText = draft.trim() ? draft : latest.message.mes;
            const targetRole = draft.trim() ? 'user' : (latest.message.is_user ? 'user' : 'assistant');
            const a = getAnalysis(targetText, targetRole);
            const flags = [];
            if (a.suspicious) flags.push('likely incomplete ending');
            else if (a.possibleEndingIssue) flags.push('ending worth checking');
            if (a.repeated.length) flags.push(`${a.repeated.length} repeated paragraph(s)`);
            status.textContent = `${draft.trim() ? 'Composer draft' : 'Latest chat message'}: ` + (flags.length ? `check recommended: ${flags.join('; ')}.` : `no obvious issue detected. ${a.paragraphs} paragraph(s).`);
        } else status.textContent = message;
    }

    function analyzeLatest() {
        const latest = lastChatMessage();
        const composer = $('#send_textarea');
        const draft = String(composer?.value || '');
        if (!latest && !draft.trim()) { toast('warning', 'There is no chat message or composer draft to analyze.'); return; }
        const targets = [];
        if (draft.trim()) targets.push({ label: 'current composer draft', text: draft, role: 'user' });
        if (latest) targets.push({ label: latest.message.is_user ? 'latest user message' : 'latest assistant message', text: latest.message.mes, role: latest.message.is_user ? 'user' : 'assistant' });
        const items = [];
        for (const target of targets) {
            const a = getAnalysis(target.text, target.role);
            items.push(`Analyzing ${target.label}.`);
            if (a.endingStatus === 'likely') items.push(`Likely incomplete ending: ${a.endingReason}`);
            else if (a.endingStatus === 'possible') items.push(`Possibly incomplete ending: ${a.endingReason}`);
            else items.push(`Final-ending check: ${a.endingReason}`);
            if (a.paragraphIssues?.length) items.push(`Paragraph boundary checks: ${a.paragraphIssues.map(x => `paragraph ${x.paragraph}: ${x.reason}`).join(' | ')}`);
            if (a.repeated.length) items.push(`Repeated paragraph(s): ${a.repeated.map(x => `paragraph ${x.again} repeats paragraph ${x.first}`).join('; ')}.`);
            items.push(`Final sentence/tail: ${a.finalSentence || a.tail || '(not detected)'}`);
        }
        const report = `Smart Continuation analysis\n\n${items.join('\n')}\n\nThis is a heuristic report. It checks the composer and latest chat message separately. A trailing comma, semicolon, colon, dash, opening bracket, or unmatched opening quote is treated as evidence that the text may need continuation; punctuation alone does not decide whether a conversational turn is complete.`;
        renderStatus(items.join(' '));
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(report).then(() => toast('success', 'Analysis copied to clipboard.')).catch(() => toast('info', report));
        else toast('info', report);
    }

    function setComposerValue(composer, value) {
        if (!composer) return;
        composer.value = value;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function countMatches(text, regex) {
        return (String(text || '').match(regex) || []).length;
    }

    // Infer which participant the continuation should foreground. This is a
    // narrative-focus heuristic, not an identity lock: both user and character
    // remain available in every mode.
    function analyzeNarrativeFocus(source, seededFromChat = false) {
        const st = SillyTavern.getContext();
        const chat = Array.isArray(st.chat) ? st.chat : [];
        const latest = lastChatMessage();
        const userName = String(st.name1 || '').trim();
        const charName = String(st.name2 || '').trim();
        const recent = chat.slice(-8).filter(m => m && !m.is_system && !m.extra?.isSmallSys && typeof m.mes === 'string');
        const contextText = recent.map(m => String(m.mes || '')).join('\n');
        const text = `${contextText}\n${source}`;
        const tail = String(source || '').slice(-420);

        const firstPerson = countMatches(text, /\b(?:I|me|my|mine|myself|we|us|our|ours|ourselves)\b/gi);
        const secondPerson = countMatches(text, /\b(?:you|your|yours|yourself)\b/gi);
        const thirdPerson = countMatches(text, /\b(?:he|him|his|himself|she|her|hers|herself|they|them|their|theirs|it|its)\b/gi);
        const charNameHits = charName ? countMatches(text, new RegExp(`\\b${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) : 0;
        const userNameHits = userName ? countMatches(text, new RegExp(`\\b${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) : 0;

        const userScore = firstPerson * 2 + secondPerson * 0.65 + userNameHits * 1.4;
        const charScore = thirdPerson * 0.8 + charNameHits * 2;
        // The unfinished tail matters more than old context when identifying
        // whose action or sentence is currently in progress.
        const tailUser = countMatches(tail, /\b(?:I|me|my|mine|myself|we|us|our)\b/gi);
        const tailChar = countMatches(tail, /\b(?:he|him|his|she|her|hers|they|them|their|it|its)\b/gi) + (charName ? countMatches(tail, new RegExp(`\\b${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) : 0);
        const latestIsUser = Boolean(latest?.message?.is_user);

        let mode;
        // Smart Continue launched from a sent user message should continue the
        // user's contribution first. Third-person narration often mentions the
        // character as "her/him", so pronoun counts must not flip it to char-led.
        if (seededFromChat && latestIsUser) mode = 'user-led';
        else if (tailUser > tailChar && tailUser > 0 && userScore >= charScore * 0.7) mode = 'user-led';
        else if (tailChar > tailUser && tailChar > 0 && charScore >= userScore * 0.7) mode = 'character-led';
        else if (userScore > charScore * 1.35) mode = 'user-led';
        else if (charScore > userScore * 1.35) mode = 'character-led';
        else if (firstPerson > 0 || secondPerson > 1 || latestIsUser || seededFromChat) mode = 'balanced, with user priority';
        else mode = 'balanced';

        const conversationAssessment = assessConversation(source, seededFromChat);
        return {
            mode,
            conversationAssessment,
            userScore: Number(userScore.toFixed(2)),
            charScore: Number(charScore.toFixed(2)),
            firstPerson,
            secondPerson,
            thirdPerson,
            charNameHits,
            userNameHits,
            latestAuthor: latestIsUser ? 'user' : (latest ? 'character' : 'unknown'),
            sourceLength: String(source || '').length,
        };
    }

    function isLikelyUnfinished(text) {
        // A reply can abandon an unfinished dialogue/sentence in an earlier
        // paragraph and then continue with a reaction in a later paragraph.
        // Looking only at the final message ending misses exactly that case.
        // Treat a likely paragraph-level fragment as unfinished even when a
        // later paragraph happens to end with normal punctuation.
        const paragraphIssues = analyzeParagraphBoundaries(text);
        if (paragraphIssues.some(issue => issue.status === 'likely')) return true;

        const ending = analyzeEnding(text);
        if (ending.status === 'likely') return true;
        if (ending.status !== 'possible') return false;
        // A final Markdown marker or other non-terminal symbol must not suppress
        // the bounded follow-up. Analyze the visible prose tail after closing
        // formatting delimiters have been ignored. Terminal punctuation still
        // prevents an unnecessary extra generation pass.
        const tail = String(text || '').replace(/\r\n/g, '\n').trimEnd()
            .replace(/\*{3}\s*$/g, '')
            .replace(/(?:\*\*|__|~~|`|\*|_)+$/g, '')
            .trimEnd();
        const hasTerminal = /[.!?…](?:[\"'”’»)}]|\])*$/.test(tail);
        return !hasTerminal;
    }

    function ensureContinuationBoundary(source, completed) {
        const original = String(source || '');
        const full = String(completed || '');
        if (!full.startsWith(original)) return full;
        const tail = full.slice(original.length);
        if (!tail.trim()) return full;

        // If a *** wrapper was placed after an unfinished sentence, it is a
        // paragraph delimiter, not the end of the thought. Move that same closing
        // delimiter after the new continuation so the sentence stays in one paragraph.
        const wrapper = original.match(/(\*{3})([ \t\u00a0]*)$/);
        if (wrapper) {
            const core = original.slice(0, wrapper.index);
            if (isLikelyUnfinished(core)) {
                const continuation = tail.replace(/^\s*\*{3}/, '');
                return core + continuation + wrapper[1] + wrapper[2];
            }
            // A genuinely completed wrapped paragraph is followed by a new one.
            return original + '\n\n' + (tail.startsWith('***') ? tail : `***${tail}`);
        }
        // For a complete sentence, separate a new generated paragraph. Do not
        // split an unfinished sentence or a mid-word continuation.
        if (/[.!?…][\"'”’»\])}]*$/.test(original.trimEnd())) {
            return original + '\n\n' + tail;
        }
        return full;
    }

    function runSmartImpersonate(autoPass = 0) {
        if (smartImpersonateBusy || pendingSmartImpersonate) {
            toast('warning', 'Smart Impersonate is already running.');
            return;
        }
        const composer = $('#send_textarea');
        const impersonate = $('#option_impersonate');
        if (!composer || !impersonate) {
            toast('error', 'Could not find SillyTavern’s composer or native Impersonate action. Nothing was changed.');
            return;
        }

        // Prefer text the user is currently drafting. If the composer is blank,
        // use the latest user message as the source draft instead of impersonating
        // from an empty box. This action lives only in the extension panel, not
        // in the chat message context menu.
        const typedDraft = String(composer.value || '');
        let source = typedDraft;
        let seededFromChat = false;
        let sourceMessage = null;
        if (!source.trim()) {
            const latest = lastChatMessage();
            if (!latest || !latest.message.is_user) {
                toast('warning', 'The input box is empty and your latest chat message is not yours. Type a draft first, or use Smart Impersonate immediately after sending your own message.');
                return;
            }
            source = String(latest.message.mes || '');
            sourceMessage = latest.message;
            if (!source.trim()) {
                toast('warning', 'Your latest message is empty, so there is no draft to continue.');
                return;
            }
            seededFromChat = true;
            setComposerValue(composer, source);
        }

        if (settings.impersonateAttemptOriginal !== source) {
            settings.impersonateAttemptOriginal = source;
            settings.impersonateAttemptCount = 0;
            settings.recentImpersonateAttempts = [];
        }
        settings.impersonateAttemptCount = Number(settings.impersonateAttemptCount || 0) + 1;
        SillyTavern.getContext().saveSettingsDebounced?.();

        pendingFocusAnalysis = analyzeNarrativeFocus(source, seededFromChat);
        pendingSmartImpersonate = {
            source,
            composer,
            seededFromChat,
            sourceMessage,
            originalComposer: typedDraft,
            focusAnalysis: pendingFocusAnalysis,
            startedAt: Date.now(),
            autoPass,
            generationStarted: false,
            startTimer: null,
        };
        smartImpersonateBusy = true;
        renderStatus('Smart Impersonate: starting SillyTavern generation…');
        toast('info', `Smart Impersonate is starting. Narrative focus: ${pendingFocusAnalysis.mode}. ${seededFromChat ? 'The completed text will update the same sent message.' : 'The completed text will return to the input box for review.'}`);
        pendingSmartImpersonate.startTimer = setTimeout(() => {
            const pending = pendingSmartImpersonate;
            if (!pending || pending.generationStarted) return;
            pendingSmartImpersonate = null;
            pendingFocusAnalysis = null;
            smartImpersonateBusy = false;
            setComposerValue(pending.composer || $('#send_textarea'), pending.originalComposer);
            renderStatus('Smart Impersonate: SillyTavern did not start generation. The original draft was restored.');
            toast('error', 'SillyTavern did not start Impersonate generation. The original draft was restored unchanged. Check whether another generation is running or the native Impersonate action is disabled.');
        }, 5000);
        // Generate continuation-only output. Keep the exact source in
        // pendingSmartImpersonate, but clear the native composer before clicking
        // Impersonate so the model is not asked to reproduce the entire draft
        // within its limited completion budget. The interceptor below still uses
        // pendingSmartImpersonate.source as the authoritative continuation context.
        setComposerValue(composer, '');
        try {
            impersonate.click();
        } catch (error) {
            const pending = pendingSmartImpersonate;
            if (pending?.startTimer) clearTimeout(pending.startTimer);
            pendingSmartImpersonate = null;
            pendingFocusAnalysis = null;
            smartImpersonateBusy = false;
            setComposerValue(composer, pending?.originalComposer ?? typedDraft);
            console.error('[Smart Continuation] Native Impersonate click failed:', error);
            renderStatus('Smart Impersonate could not start. The original draft was restored.');
            toast('error', 'Could not start native Impersonate. Your original draft was restored unchanged.');
        }
    }

    // A draft can end in the middle of a spoken sentence, e.g. `"...not ads, but`.
    // In that case a continuation that jumps straight to another character's
    // reaction is not a valid continuation, even if the generated prose itself
    // looks complete. Keep this guard deliberately narrow: it only applies when
    // the source ends with an unmatched dialogue quote AND a dangling connector.
    function getOpenDialogueConnector(source) {
        const raw = String(source || '').replace(/[ \t\u00a0]+$/g, '');
        const ending = raw.replace(/\*{3}\s*$/g, '').replace(/[ \t\u00a0]+$/g, '');
        const analysis = analyzeEnding(ending);
        const straightOpen = (ending.match(/"/g) || []).length % 2 === 1;
        const curlyOpen = (ending.match(/“/g) || []).length > (ending.match(/”/g) || []).length;
        const singleCurlyOpen = (ending.match(/‘/g) || []).length > (ending.match(/’/g) || []).length;
        const connector = analysis.trailingConnector || '';
        if (!connector || !(straightOpen || curlyOpen || singleCurlyOpen)) return null;
        return { quotes: straightOpen ? ['"', '”'] : (curlyOpen ? ['”'] : ['’']), connector, tail: analysis.tail || ending.slice(-180) };
    }

    function continuationFinishesOpenDialogue(source, continuation) {
        const requirement = getOpenDialogueConnector(source);
        if (!requirement) return { required: false, valid: true };
        const text = String(continuation || '');
        const closePositions = requirement.quotes.map(q => text.indexOf(q)).filter(i => i >= 0);
        const closeAt = closePositions.length ? Math.min(...closePositions) : -1;
        if (closeAt < 0) {
            return { required: true, valid: false, reason: `The draft ends inside an open quotation after "${requirement.connector}", but the generated continuation never closes that dialogue.` };
        }
        const spokenContinuation = text.slice(0, closeAt);
        if (!spokenContinuation.trim()) {
            return { required: true, valid: false, reason: 'The generated continuation closes the quotation without adding the missing dialogue.' };
        }
        // A paragraph break or *** wrapper before the closing quote is a strong
        // signal that the model started a new narration beat before finishing
        // the speaker's sentence. Reject that rather than silently accepting it.
        const boundaryAt = spokenContinuation.search(/\n\s*\n|\*{3}/);
        if (boundaryAt >= 0) {
            return { required: true, valid: false, reason: 'The generated continuation started a new paragraph before completing the open dialogue.' };
        }
        // Also reject obvious action-first continuations. The opening quote is
        // still active, so new physical narration cannot replace the missing words.
        const firstLine = spokenContinuation.trim().slice(0, 180);
        if (/^(?:\*{1,3}\s*)?(?:[A-Z][\w’'-]+\s+(?:\w+\s+){0,3}(?:body|eyes|face|hands?|shoulders?|breath|lips?|head|voice|expression)\b|(?:he|she|they|it)\s+(?:jerked|moved|turned|looked|gasped|laughed|smiled|flinched|convulsed|reacted)\b)/i.test(firstLine)) {
            return { required: true, valid: false, reason: 'The generated continuation begins with narration or another character’s reaction instead of finishing the open dialogue.' };
        }
        return { required: true, valid: true };
    }

    function retryOpenDialogueCompletion(pending, composer, reason) {
        const limit = Math.max(0, Math.min(3, Number(settings.maxAutoContinues ?? 1) || 0));
        if (pending.autoPass >= limit) {
            setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
            renderStatus('Smart Continuation: unfinished dialogue was protected; the original draft was restored.');
            toast('warning', `The model skipped your unfinished dialogue. I rejected that continuation and restored your original draft. Retry limit reached. ${reason}`);
            return false;
        }
        // Remember the rejected output so the next attempt is explicitly told
        // not to repeat the narration-first failure. The user's source is restored
        // exactly before the next generation starts.
        const attempts = Array.isArray(settings.recentImpersonateAttempts) ? settings.recentImpersonateAttempts : [];
        if (pending.rejectedContinuation) attempts.push(String(pending.rejectedContinuation).slice(-900));
        settings.recentImpersonateAttempts = attempts.slice(-3);
        SillyTavern.getContext().saveSettingsDebounced?.();
        setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
        toast('warning', `The model skipped your unfinished dialogue. Rejecting that attempt and retrying the dialogue first. ${reason}`);
        setTimeout(() => runSmartImpersonate(pending.autoPass + 1), 350);
        return true;
    }

    async function finishSmartImpersonate(interrupted = false) {
        const pending = pendingSmartImpersonate;
        if (!pending) return;
        pendingSmartImpersonate = null;
        if (pending.startTimer) clearTimeout(pending.startTimer);
        pendingFocusAnalysis = null;
        smartImpersonateBusy = false;
        const composer = pending.composer || $('#send_textarea');
        if (!composer) {
            toast('error', 'Smart Impersonate finished, but SillyTavern’s input box is unavailable.');
            return;
        }
        const generated = String(composer.value || '');
        if (!generated.trim()) {
            // If the source is already a sent chat message, do not put a second
            // copy back into the composer when generation returns nothing.
            setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
            toast('warning', interrupted
                ? 'Generation was interrupted before any continuation was returned. Your original text was preserved.'
                : (pending.seededFromChat
                    ? 'Model returned an empty response. Your original sent message is unchanged, and the input box was cleared to prevent a duplicate.'
                    : 'Model returned an empty response. Your original draft has been restored in the input box.'));
            return;
        }

        if (generated === pending.source) {
            setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
            toast('warning', pending.seededFromChat
                ? 'Impersonate did not add any text. Your original sent message is unchanged.'
                : 'Model repeated existing text and produced no new continuation. Your draft is preserved unchanged.');
            renderStatus('Smart Impersonate ended without adding continuation text.');
            return;
        }

        // Never let an imperfect model echo overwrite the user's original draft.
        // Accept an exact full-draft echo, or a formatting-normalized full echo and
        // append only the genuinely new tail. A partial echo means the model spent
        // its output budget copying the draft; restore the exact source unchanged.
        // If the model returns continuation-only text, append it to the exact source.
        let completed;
        const comparableSource = comparableEcho(pending.source);
        const comparableGenerated = comparableEcho(generated);
        if (generated.startsWith(pending.source)) {
            // Exact full echo: preserve it as returned, then normal boundary checks apply.
            completed = generated;
        } else if (comparableGenerated.startsWith(comparableSource) && comparableSource.length) {
            // Full draft echoed with altered punctuation/quotes/Markdown. Locate
            // the end of that echo and append only the genuinely new words to the
            // byte-for-byte original draft. Discard punctuation changed inside
            // the echoed copy so it cannot rewrite the user's final dash/quote.
            const echoEnd = rawOffsetAfterComparableEchoPrefix(generated, comparableSource);
            let novelTail = echoEnd >= 0 ? generated.slice(echoEnd) : '';
            novelTail = novelTail.replace(/^[\s*\"'“”‘’.,;:!?…—–-]+/, '');
            completed = pending.source + (novelTail ? (/[\s]$/.test(pending.source) ? '' : ' ') + novelTail : '');
        } else {
            // HARD SAFETY: some models return only the beginning of the draft,
            // truncated at the output-token limit. That is not a continuation.
            // Never let such a prefix replace or shorten the user's source.
            // Detect it before the more permissive partial-echo recovery below.
            const generatedIsSourcePrefix = comparableGenerated.length >= 40
                && comparableSource.startsWith(comparableGenerated);
            if (generatedIsSourcePrefix) {
                setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
                renderStatus('Smart Impersonate: the model returned a truncated copy of the draft; the original was restored unchanged.');
                toast('warning', 'The model copied only the beginning of your draft and ran out of output tokens. Nothing was removed: your complete original draft and all *** markers have been restored.');
                return;
            }

            // Some models echo the beginning of the draft and then continue
            // with new text. Find the longest normalized prefix shared with the
            // source, map it back to the raw output, and keep only what follows.
            // The user's source remains byte-for-byte intact.
            let commonPrefixLength = 0;
            const maxPrefix = Math.min(comparableGenerated.length, comparableSource.length);
            while (
                commonPrefixLength < maxPrefix &&
                comparableGenerated[commonPrefixLength] === comparableSource[commonPrefixLength]
            ) commonPrefixLength++;

            const echoThreshold = Math.min(120, Math.floor(comparableSource.length * 0.35));
            if (commonPrefixLength >= echoThreshold && echoThreshold > 0) {
                const echoedPrefix = comparableGenerated.slice(0, commonPrefixLength);
                const echoEnd = rawOffsetAfterComparableEchoPrefix(generated, echoedPrefix);
                let novelTail = echoEnd >= 0 ? generated.slice(echoEnd) : '';
                novelTail = novelTail.replace(/^[\s*\"'“”‘’.,;:!?…—–-]+/, '');
                if (!novelTail.trim()) {
                    setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
                    toast('warning', 'Model repeated existing text and produced no usable continuation. Your original formatting and draft were restored unchanged.');
                    return;
                }
                completed = pending.source + (/\s$/.test(pending.source) ? '' : ' ') + novelTail;
            } else {
                // The composer is intentionally empty during generation, so
                // this is continuation-only output. Append it verbatim.
                completed = pending.source + generated;
            }
        }

        let appendedText = completed.startsWith(pending.source)
            ? completed.slice(pending.source.length)
            : '';
        const repetitionRepair = removeRepeatedGeneratedContent(pending.source, appendedText);
        if (repetitionRepair.total > 0) {
            appendedText = repetitionRepair.text;
            completed = pending.source + appendedText;
            toast('info', `Removed repeated generated content: ${repetitionRepair.removedParagraphs} paragraph(s), ${repetitionRepair.removedDialogue} dialogue line(s), ${repetitionRepair.removedSentences} sentence(s).`);
        }
        if (!appendedText.trim()) {
            setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
            toast('warning', 'Output contained no usable continuation. Your original text was preserved unchanged.');
            return;
        }

        const dialogueCheck = continuationFinishesOpenDialogue(pending.source, appendedText);
        const loopCheck = removeRepeatedGeneratedContent(pending.source, appendedText);
        const repetitionRetryNeeded = loopCheck.strongNearDuplicateParagraphs > 0 || loopCheck.nearDuplicateParagraphs >= 2;
        if (repetitionRetryNeeded && pending.autoPass < Math.max(0, Math.min(3, Number(settings.maxAutoContinues ?? 1) || 0))) {
            pending.rejectedContinuation = appendedText;
            const attempts = Array.isArray(settings.recentImpersonateAttempts) ? settings.recentImpersonateAttempts : [];
            attempts.push(String(appendedText).slice(-900));
            settings.recentImpersonateAttempts = attempts.slice(-3);
            SillyTavern.getContext().saveSettingsDebounced?.();
            setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
            toast('warning', 'The continuation closely rephrased an earlier narrative paragraph. Rejecting that attempt and retrying from your unchanged original draft.');
            setTimeout(() => runSmartImpersonate(pending.autoPass + 1), 350);
            return;
        }
        if (repetitionRetryNeeded) {
            toast('warning', 'A near-duplicate passage was detected, but the retry limit has been reached. It was left intact rather than silently deleting a potentially intentional callback.');
        }
        if (dialogueCheck.required && !dialogueCheck.valid) {
            pending.rejectedContinuation = appendedText;
            retryOpenDialogueCompletion(pending, composer, dialogueCheck.reason);
            return;
        }

        completed = ensureContinuationBoundary(pending.source, completed);

        // Refuse obvious instruction/prompt leakage rather than mixing it into
        // the user's story. Restore the source so it remains safe to retry.
        const leakedInstruction = /<\/?USER_DRAFT_ENDING>|continue immediately after the final character|need output only new text|existing draft ending:/i.test(completed);
        if (leakedInstruction) {
            setComposerValue(composer, pending.seededFromChat ? '' : pending.source);
            toast('error', pending.seededFromChat
                ? 'The model returned instructions instead of story text. Your original sent message was left unchanged, and the input box was cleared to prevent a duplicate.'
                : 'The model returned continuation instructions instead of story text. Your original draft was restored in the input box; nothing was sent.');
            return;
        }

        if (settings.rememberImpersonateAttempts && completed.length > pending.source.length) {
            const continuation = completed.slice(pending.source.length).trim();
            if (continuation) {
                const attempts = Array.isArray(settings.recentImpersonateAttempts) ? settings.recentImpersonateAttempts : [];
                attempts.push(continuation.slice(-900));
                settings.recentImpersonateAttempts = attempts.slice(-3);
                SillyTavern.getContext().saveSettingsDebounced?.();
            }
        }
        // When Smart Continue started from an already-sent user message (blank
        // composer), update that exact chat message in place. Leaving the completed
        // version in the composer as well would create the user's reported duplicate:
        // one sent original plus one completed copy waiting to be sent.
        if (pending.seededFromChat && pending.sourceMessage) {
            const liveChat = SillyTavern.getContext().chat || [];
            const stillPresent = liveChat.includes(pending.sourceMessage);
            const unchanged = String(pending.sourceMessage.mes || '') === pending.source;
            if (!stillPresent || !unchanged) {
                setComposerValue(composer, completed);
                composer.focus();
                toast('warning', 'Your original chat message changed while Smart Impersonate was running. I left the completed draft in the input box instead of overwriting a changed message.');
                return;
            }
            if (completed === pending.source) {
                setComposerValue(composer, '');
                toast('warning', 'No continuation was added. Your original message remains unchanged, and the input box was cleared to prevent a duplicate.');
                return;
            }
            try {
                pending.sourceMessage.mes = completed;
                await SillyTavern.getContext().saveChat?.();
                await SillyTavern.getContext().printMessages?.();
                setComposerValue(composer, '');
                toast('success', interrupted ? 'Generation was interrupted; usable new continuation was appended to your original message.' : 'Continuation was successfully appended to your original sent message; its formatting was preserved.');
                const limit = Math.max(0, Math.min(3, Number(settings.maxAutoContinues ?? 1) || 0));
                if (!interrupted && isLikelyUnfinished(completed) && pending.autoPass < limit) {
                    toast('info', `The sentence still appears unfinished. Running one more ${512}-token continuation pass; nothing will be sent as a new message.`);
                    setTimeout(() => runSmartImpersonate(pending.autoPass + 1), 350);
                } else if (isLikelyUnfinished(completed)) {
                    toast('warning', 'The continuation still appears unfinished after the extra pass. You can use Smart Continue again to finish it.');
                }
            } catch (error) {
                // If persistence/rendering fails, preserve the generated text in the
                // composer and restore the original chat message where possible.
                pending.sourceMessage.mes = pending.source;
                setComposerValue(composer, completed);
                composer.focus();
                console.error('[Smart Continuation] Could not update the original user message:', error);
                toast('error', 'Could not save the continuation into your original chat message. The completed draft is in the input box instead; it has not been sent.');
            }
            return;
        }

        // A draft that was already in the composer has not been sent, so keep its
        // completed version there for review rather than modifying chat history.
        setComposerValue(composer, completed);
        composer.focus();
        toast('success', 'Smart Impersonate finished. The completed draft is in the input box for you to review or edit. It has not been sent.');
        const limit = Math.max(0, Math.min(3, Number(settings.maxAutoContinues ?? 1) || 0));
        if (!interrupted && isLikelyUnfinished(completed) && pending.autoPass < limit) {
            toast('info', 'The draft still appears unfinished. Running one more 512-token continuation pass; it will remain in the input box for review.');
            setTimeout(() => runSmartImpersonate(pending.autoPass + 1), 350);
        } else if (isLikelyUnfinished(completed)) {
            toast('warning', 'The draft still appears unfinished after the extra pass. You can use Smart Impersonate again to finish it.');
        }
    }

    function nativeContinue() {
        // Smart Continue is role-aware, not punctuation-aware. If the user has
        // text in the composer, treat it as a draft even when it ends with a
        // period. If the latest chat message is the user's, continue that draft
        // through Smart Impersonate even when the composer is blank. This avoids
        // native Continue's sequence-template issue on user-authored messages.
        const composer = $('#send_textarea');
        const composerHasDraft = Boolean(String(composer?.value || '').trim());
        const latest = lastChatMessage();
        if (!latest) return toast('warning', 'There is no message to continue.');

        if (composerHasDraft || latest.message.is_user) {
            runSmartImpersonate();
            return;
        }

        const original = document.querySelector('#option_continue');
        if (!original) return toast('error', 'Could not find SillyTavern’s built-in Continue action. No generation was sent.');
        // Only use native Continue when the latest chat message is the
        // assistant's and the composer is empty. Remember the exact pre-pass
        // message so a bounded extra pass only runs when this generation added text.
        const limit = Math.max(0, Math.min(3, Number(settings.maxAutoContinues ?? 1) || 0));
        pendingAssistantContinue = limit > 0 ? { passes: 0, limit, lastMessage: null, lastText: '' } : null;
        if (pendingAssistantContinue) {
            pendingAssistantContinue.lastMessage = latest.message;
            pendingAssistantContinue.lastText = String(latest.message.mes || '');
        }
        original.click();
    }

    function handleAssistantContinueEnded() {
        const chain = pendingAssistantContinue;
        if (!chain) return;
        const latest = lastAssistantMessage();
        if (!latest || (latest.message === chain.lastMessage && String(latest.message.mes || '') === chain.lastText)) {
            pendingAssistantContinue = null;
            toast('warning', 'Smart Continue received no new assistant text, so it stopped without another request.');
            return;
        }
        const ending = analyzeEnding(latest.message.mes);
        if (!isLikelyUnfinished(latest.message.mes)) {
            pendingAssistantContinue = null;
            return;
        }
        if (chain.passes >= chain.limit) {
            pendingAssistantContinue = null;
            toast('warning', 'The reply still appears unfinished after the extra 512-token pass. Use Smart Continue again to continue it.');
            return;
        }
        const original = document.querySelector('#option_continue');
        if (!original) {
            pendingAssistantContinue = null;
            toast('error', 'The reply appears unfinished, but SillyTavern’s Continue action is unavailable.');
            return;
        }
        chain.passes++;
        chain.lastMessage = latest.message;
        chain.lastText = String(latest.message.mes || '');
        toast('info', `The reply still ends mid-thought (${ending.reason}). Running one more 512-token continuation pass.`);
        setTimeout(() => {
            if (pendingAssistantContinue !== chain) return;
            original.click();
        }, 350);
    }

    function processIncomingMessage() {
        const latest = lastAssistantMessage();
        if (!latest || latest.message === lastHandledMessage) return;
        lastHandledMessage = latest.message;
        const priorGeneration = generationSnapshot;
        const isRegenerate = /regenerate|swipe/i.test(String(lastGenerationType));
        const overlapRepaired = repairNativeContinueOverlap(latest);
        const original = latest.message.mes;
        let changed = original;
        let removed = 0;
        if (priorGeneration?.text && changed !== priorGeneration.text && (isRegenerate || /continue/i.test(String(lastGenerationType)))) {
            // For native Continue, inspect ONLY the newly appended portion against
            // the complete previous assistant message and recent assistant turns.
            // This catches full paragraphs replayed from earlier in the scene, not
            // merely a duplicated suffix at the generation seam.
            const isContinue = /continue/i.test(String(lastGenerationType));
            const sameMessage = latest.message === priorGeneration.message;
            const appended = isContinue && sameMessage && changed.startsWith(priorGeneration.text)
                ? changed.slice(priorGeneration.text.length)
                : (isContinue && !sameMessage ? changed : changed);
            const repeatRepair = removeRepeatedGeneratedContent(priorGeneration.text, appended, latest.message);
            removed += repeatRepair.total;
            if (repeatRepair.nearDuplicateParagraphs > 0) {
                toast('warning', `Detected ${repeatRepair.nearDuplicateParagraphs} near-duplicate narrative paragraph(s). The wording was not automatically deleted; the next continuation will be instructed to move beyond the repeated scene beat.`);
            }
            if (repeatRepair.total && repeatRepair.text.trim()) {
                changed = isContinue && sameMessage && changed.startsWith(priorGeneration.text)
                    ? priorGeneration.text + repeatRepair.text
                    : repeatRepair.text;
                toast('info', `${isContinue ? 'Smart Continue' : 'Smart Regenerate'} removed exact repeated content: ${repeatRepair.removedParagraphs} paragraph(s), ${repeatRepair.removedDialogue} dialogue line(s), ${repeatRepair.removedSentences} sentence(s).`);
            } else if (repeatRepair.total) {
                // Never blank an entire reply; preserve the generated output and warn.
                toast('warning', 'The generated continuation repeated almost entirely existing text. It was kept intact rather than risking deletion of the whole reply.');
            }
        }
        const deduped = removeExactAdjacentDuplicateParagraphs(changed);
        changed = deduped.text;
        removed += deduped.removed;
        // Do not reformat the entire message after native Continue: doing so can
        // rewrite existing *** wrappers and join Markdown markers at the seam.
        if (settings.autoFormat && !overlapRepaired) changed = normalizeFormatting(changed);
        if (changed !== original) {
            latest.message.mes = changed;
            // MESSAGE_RECEIVED is emitted before the message is rendered; persist the corrected text.
            Promise.resolve(SillyTavern.getContext().saveChat?.()).catch(err => console.warn('[Smart Continuation] Could not save repaired message:', err));
        }
        renderStatus();
        if (removed) toast('info', `Removed ${removed} exact adjacent duplicate paragraph(s).`);

        // Extra generation passes are launched only from an explicit Smart Continue action and are bounded by maxAutoContinues.
    }
    let lastAutoKey = '';

    function injectGenerationGuidance(chat, contextSize, abort, type) {
        lastGenerationType = String(type ?? 'undefined');
        const generationType = String(type ?? '').toLowerCase();
        // Arm the bounded follow-up for BOTH the extension's Smart Continue
        // action and SillyTavern's ordinary Continue button. The latter used to
        // receive continuation guidance but never got a follow-up pass because
        // its click did not pass through nativeContinue().
        if (settings?.enabled && generationType.includes('continue') && !pendingAssistantContinue) {
            const latestChat = lastChatMessage();
            const latestAssistant = lastAssistantMessage();
            const limit = Math.max(0, Math.min(3, Number(settings.maxAutoContinues ?? 1) || 0));
            if (limit > 0 && latestChat?.message && !latestChat.message.is_user
                && latestAssistant?.message === latestChat.message) {
                pendingAssistantContinue = {
                    passes: 0,
                    limit,
                    lastMessage: latestAssistant.message,
                    lastText: String(latestAssistant.message.mes || ''),
                };
            }
        }
        if (!settings?.enabled || !settings.injectGuidance || !Array.isArray(chat) || !chat.length) {
            lastInterceptorInfo = `Interceptor called (${lastGenerationType}); guidance disabled or no prompt chat.`;
            renderStatus();
            return;
        }
        let instruction = 'CONTINUITY AND LOOP CONTROL: Treat everything already established in the recent scene as completed history and current state. Do not replay an event, reaction, exchange, movement, or descriptive passage as though it is happening for the first time. Before writing, identify the immediate unresolved point and continue from there. Each new paragraph must perform a distinct useful function or develop the current beat; do not circle back to the same beat with slightly different wording. If a recurring detail or motif is intentionally relevant, it may return naturally, but do not reproduce the same paragraph or repeat the same descriptive purpose. A callback should add a changed perspective, consequence, new detail, or deliberate emphasis; otherwise leave the established detail alone. Do not force novelty, invent events, or add unrelated developments. Keep character knowledge and physical positions consistent. Follow the established formatting exactly: double-quoted dialogue, existing *** paragraph wrappers, and no inline asterisk emphasis. Never invent {{user}} actions, dialogue, thoughts, feelings, or decisions. Aim for at least four substantial paragraphs only when the scene supports them; never pad.';
        instruction += ' ROLEPLAY-ONLY OUTPUT (ALL GENERATION TYPES): This is an in-character fictional roleplay, not a planning or task-execution response. Output only the next in-world narration and/or character dialogue. Never expose an internal checklist, response plan, writing process, reminders, pointers, obligations, or commentary about what should happen next. Do not narrate that a character needs to do something merely because the response needs to progress; do not announce whose turn it is, describe what the model must do, or explain what you are about to write. Do not turn author notes, system instructions, character-card directions, or out-of-character steering text into story events or spoken dialogue. Treat such material silently as guidance. This does not prohibit natural in-character thoughts or dialogue such as a character genuinely saying they need something or cannot do something; it prohibits authorial self-instructions and task-list language. Stay immersed in the scene and simply write the character.';
        instruction += getNarrativeDiversityBrief();
        if (generationType.includes('continue')) {
            const precedingMessage = [...chat].reverse().find(m => m && !m.is_system && !m.extra?.isSmallSys && typeof m.mes === 'string' && m.mes.trim());
            const precedingText = String(precedingMessage?.mes || '');
            const precedingEnding = analyzeEnding(precedingText);
            instruction += ' CONTINUATION: This is a continuation of the immediately preceding assistant message, not a new reply. Start at its exact ending. If the final word is incomplete, continue that word if the context makes it clear; then complete the same interrupted sentence before starting a new sentence. Do not repeat any preceding text. Do not add punctuation merely to make a fragment look complete. Output only text that belongs after the existing final character.';
            if (precedingEnding.status === 'likely' || precedingEnding.status === 'possible') {
                instruction += ` FINISH THE EXISTING THOUGHT FIRST (HIGH PRIORITY): The preceding message currently ends with ${JSON.stringify(precedingEnding.tail)}. The final prose fragment, ignoring closing Markdown markers, is ${JSON.stringify(precedingEnding.finalSentence || precedingEnding.tail)}. Treat trailing formatting such as **_, _**, **, *, _, or *** as formatting only, not as part of the sentence. The ending check is: ${precedingEnding.reason} Treat this as an unfinished sentence or dialogue, not as a completed turn. Continue with the exact next words needed to complete that same grammatical thought. If it ends with a connector such as but, and, or, because, do not start a new sentence, new paragraph, fresh action, or new speaker response yet. If dialogue is open, remain in that same quoted utterance and close it naturally only after the thought is complete. Never skip the unfinished words or leave the connector dangling.`;
            }
        } else if (generationType.includes('impersonate')) {
            const focus = pendingFocusAnalysis || analyzeNarrativeFocus($('#send_textarea')?.value || '', false);
            const activeDraft = String(pendingSmartImpersonate?.source ?? $('#send_textarea')?.value ?? '');
            const opensDialogue = /\*{3}\s*[\"“]\s*$/.test(activeDraft);
            const assessment = assessConversation(activeDraft, Boolean(pendingSmartImpersonate?.seededFromChat));
            const draftEnding = analyzeEnding(activeDraft);
            // Keep the original draft only in extension memory. Sending the whole draft
            // inside the instruction makes small/local models echo it, consuming the
            // 512-token completion budget before they reach the actual continuation.
            // Give the model only a compact tail excerpt; the full source is restored
            // locally after generation and is never sent as a prompt payload here.
            const sourceTail = activeDraft.slice(-700);
            instruction += ` HIGHEST PRIORITY — CONTINUE THE ACTIVE DRAFT. The exact original draft is retained locally by the extension and will be restored byte-for-byte after generation. It is NOT included in full in this prompt: do not try to reconstruct or repeat it. Your only task is to write new text that starts immediately after the final character shown in the ending excerpt below. Use the chat history for character identity, scene meaning, voice, and continuity. Finish the final unfinished sentence, clause, or spoken utterance first; do not skip ahead to a new scene beat. Preserve POV, tense, agency, and the established *** paragraph formatting. If the excerpt ends inside an open *** paragraph, stay inside that paragraph until the thought is complete. If it ends with an open dialogue quote, continue the words inside that quote. After completing the draft's unfinished thought, continue the user's contribution only as far as the scene naturally requires. Do not invent the user's unprovided actions, thoughts, feelings, decisions, or dialogue. Recent turn assessment: last speaker=${assessment.lastSpeaker}; ${assessment.handoff} Recent scene turns (continuity only): ${assessment.recentTurns.slice(-1000)} Narrative focus=${focus.mode}. ACTIVE DRAFT ENDING EXCERPT (context only; these characters already exist and must not be output again): ${JSON.stringify(sourceTail)}. The extension will prepend the complete original draft exactly. Output ONLY new continuation text after the excerpt's final character; never echo any part of the excerpt.`;
            if (draftEnding.status === 'likely' || draftEnding.status === 'possible') {
                instruction += ` ACTIVE-DRAFT SENTENCE COMPLETION PRIORITY: The exact user-authored draft currently ends with ${JSON.stringify(draftEnding.tail)}. ${draftEnding.reason} Continue by completing that same sentence, clause, or spoken utterance first. A trailing comma followed by but/and/or, with or without spaces and even when followed by an ellipsis, is an unfinished grammatical connector—not a stopping point. Do not jump to a new response or scene beat until this thought is complete.`;
            }
            if (assessment.openTriple) {
                instruction += ` OPEN NARRATIVE WRAPPER: The active source begins a ***-wrapped prose paragraph but the closing *** has deliberately not been supplied. This is intentional unfinished formatting, not a completed paragraph. Continue the existing sentence/thought inside that same open paragraph. Do NOT add the closing *** yet, do NOT insert a new opening ***, and do NOT start a fresh sentence/paragraph until the unfinished phrase and its grammatical thought have been completed. Do not treat the open marker as permission to begin unrelated narration. Preserve the exact existing prefix and finish the fragment in context.`;
            }
            if (assessment.paragraphIssues?.length && !opensDialogue) {
                instruction += ` PARAGRAPH-LEVEL INCOMPLETE FRAGMENTS: Check all flagged paragraph endings in the active source, not merely the end of the whole message: ${assessment.paragraphIssues.map(x => `paragraph ${x.paragraph}: ${x.reason}`).join(' | ')}. Complete the currently active unfinished paragraph before moving on.`;
            }
            if (opensDialogue) {
                instruction += ` EXPLICIT OPEN-DIALOGUE PREFILL: The user's draft ends with ***\". This is an intentional opening marker for a new spoken line, not an incomplete sentence or formatting error. Continue immediately with the spoken words inside this open quotation, in the voice of the entity/THING that was just heard in the scene. Do not add narration, an action, a speaker label, or another character’s unfinished dialogue before the spoken words. Do not close or remove the opening marker yourself; continue the text after it naturally and let the dialogue close when appropriate. The open quotation in the user draft takes priority over the previous assistant message’s trailing words.`;
            }
            // Impersonate has a finite completion budget. Never spend it copying
            // the composer: generate only the continuation and let the extension
            // append it to the immutable source draft after generation.
            instruction += ' OUTPUT CONTRACT (CRITICAL): Return ONLY newly generated continuation text that belongs after the final character of the active composer draft. Do NOT reproduce, quote, paraphrase, summarize, or rewrite ANY part of the draft. Do NOT output the ***" marker again. For an open ***" marker, the very first generated characters must be the THING’s spoken words. The extension will preserve and prepend the complete original draft itself. The response budget is limited; spend it entirely on new continuation, not on copying existing text.';
            const openDialogueConnector = getOpenDialogueConnector(activeDraft);
            if (openDialogueConnector) {
                instruction += ` ABSOLUTE DIALOGUE-FIRST LOCK: The user's exact draft ends inside an open spoken quotation, immediately after the unfinished connector ${JSON.stringify(openDialogueConnector.connector)}. Your first job is to continue the SAME speaker's dialogue with the missing words after that connector. Do not write narration, a physical reaction, a new speaker, a new paragraph, or any other scene beat before the original speaker's thought is complete and the matching closing quotation mark has been supplied. The extension will reject your output if it skips this dialogue. Do not pretend the open dialogue was already completed.`;
            }
            if (settings.varyImpersonateRetries) {
                const attempt = Math.max(1, Number(settings.impersonateAttemptCount || 1));
                const approaches = [
                    'After completing the interrupted sentence, advance with a concrete physical action and its immediate consequence.',
                    'After completing the interrupted sentence, use fresh dialogue or a meaningful reaction rather than another description of the same emotion.',
                    'After completing the interrupted sentence, introduce a new decision, discovery, or change in the situation.',
                    'After completing the interrupted sentence, move the scene forward through interaction with the environment or another character.',
                    'After completing the interrupted sentence, use concise, specific prose and avoid repeating familiar metaphors or bodily reactions.'
                ];
                instruction += ` RETRY ${attempt}: This is another attempt on the same draft. It must be materially different from earlier attempts. ${approaches[(attempt - 1) % approaches.length]} Do not reuse the same opening, sentence structure, metaphors, emotional beats, or paragraph progression from earlier attempts.`;
                const previous = Array.isArray(settings.recentImpersonateAttempts) ? settings.recentImpersonateAttempts.slice(-2) : [];
                if (previous.length) {
                    instruction += ' PREVIOUS FAILED/REJECTED ATTEMPTS — do not copy or paraphrase these; choose a genuinely different continuation after completing the unfinished sentence:\n' + previous.map((x, i) => `Attempt ${i + 1}: ${String(x).slice(-650)}`).join('\n');
                }
            }
        } else if (generationType.includes('regenerate') || generationType.includes('swipe')) {
            if (settings.sceneFocusRegenerate) {
                const previousSwipe = String(generationSnapshot?.text || '').slice(-1800);
                instruction = [
                    'SMART REGENERATE — SCENE-FIRST ALTERNATIVE.',
                    'The recent conversation is the source of current events. Respond to the latest user contribution and the immediate preceding scene.',
                    'Use character descriptions, personality, lore, scenario, example messages, Author’s Note, and post-history instructions only as background for identity, style, world facts, and constraints.',
                    'Do not quote, reproduce, summarize, enumerate, or turn those reference materials into events. Example dialogue is not dialogue that has just happened.',
                    'Do not output system prompts, author instructions, formatting rules, extension instructions, analysis, headings about the task, or explanations of what you are doing.',
                    'Do not restart the scene, reintroduce established facts, replay earlier actions, or reuse the previous swipe’s opening, action sequence, metaphors, or dialogue.',
                    'Write one in-character alternative that reacts causally to what is happening now and advances the scene with a fresh but continuity-consistent choice.',
                    'Respect the user’s agency. Do not invent the user’s actions, dialogue, feelings, or decisions.',
                    'Follow the requested output format silently. Output only the roleplay response.',
                    previousSwipe ? `The previous swipe is included only as a do-not-repeat reference. Create a genuinely different alternative; do not reuse its opening, dialogue, sentence patterns, or descriptive passages: ${JSON.stringify(previousSwipe)}` : 'Do not reuse the previous response or repeat established scene details.'
                ].join(' ');
            } else {
                instruction += ' REGENERATION/SWIPE: Produce a genuinely different alternative for the same scene; do not reproduce the previous swipe or recent paragraphs.';
            }
        }
        // For Impersonate, the composer draft is newer than every saved chat
        // message. Put the instruction AFTER the saved history so an old, open
        // fragment at the end of the last sent message cannot remain the model's
        // strongest/last continuation cue. The instruction itself repeats the
        // exact active composer draft as the sole continuation target. For other
        // generation types, retain the original before-last-message placement.
        if (generationType.includes('impersonate')) {
            instruction += ' FINAL SOURCE PRIORITY OVERRIDE: The current composer draft is newer than the entire saved chat history. Any old message ending in an unfinished word, sentence, quote, or wrapper (including a trailing word such as “And”) is historical context only. Do NOT continue, complete, quote, or respond to that old trailing fragment as the generation starting point. The only text to continue is the active composer draft held locally by the extension; use the short ending excerpt in the instruction to identify its exact continuation point. Read the old message only to understand what the draft is replying to. The active draft supersedes the chronological end of the saved chat for continuation purposes.';
        }
        const note = {
            is_user: false,
            is_system: true,
            name: 'Smart Continuation (temporary instruction)',
            mes: instruction,
            send_date: Date.now(),
            extra: { smart_continuation_temporary: true },
        };
        if (generationType.includes('impersonate')) {
            chat.push(note);
        } else {
            // Keep existing behaviour for Continue/Regenerate: place guidance
            // before the final story message so native continuation semantics stay intact.
            const at = Math.max(0, chat.length - 1);
            chat.splice(at, 0, note);
        }
        pendingInjected.push({ array: chat, note });
        if (injectedCleanupTimer) clearTimeout(injectedCleanupTimer);
        injectedCleanupTimer = setTimeout(removeTemporaryInstructions, 120000);
        lastInterceptorInfo = `Guidance injected; type: ${lastGenerationType}; focus: ${lastGenerationType.toLowerCase().includes('impersonate') ? (pendingFocusAnalysis?.mode || 'balanced') : 'not applicable'}; prompt context: ${contextSize} tokens.`;
        renderStatus();
    }

    function removeTemporaryInstructions() {
        if (injectedCleanupTimer) { clearTimeout(injectedCleanupTimer); injectedCleanupTimer = null; }
        if (!pendingInjected.length) return;
        for (const entry of pendingInjected) {
            const array = entry?.array;
            const note = entry?.note;
            if (!Array.isArray(array) || !note) continue;
            const index = array.indexOf(note);
            if (index >= 0) array.splice(index, 1);
        }
        pendingInjected = [];
    }

    function addUI() {
        if (uiReady || !$('#extensions_settings2')) return;
        uiReady = true;
        const html = `
        <div id="smart_continuation_panel" class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>Smart Continuation &amp; Regenerate v${VERSION}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content">
            <div id="sc_status" class="sc-status">Waiting for an assistant response.</div>
            <div id="sc_interceptor_status" class="sc-status">Prompt interceptor: Not yet observed.</div>
            <div class="sc-actions">
              <button id="sc_analyze" class="menu_button">Analyze latest</button>
              <button id="sc_continue" class="menu_button">Run native Continue</button>
              <button id="sc_impersonate" class="menu_button">Smart Impersonate (draft)</button>
              <button id="sc_format" class="menu_button">Repair formatting</button>
            </div>
            <label class="checkbox_label"><input id="sc_enabled" type="checkbox"> Enable extension</label>
            <label class="checkbox_label"><input id="sc_inject" type="checkbox"> Add temporary anti-repetition / continuation guidance</label>
            <label class="checkbox_label"><input id="sc_autoformat" type="checkbox"> Automatically repair paragraph formatting</label>
            <label class="checkbox_label"><input id="sc_wrappers" type="checkbox"> Wrap each prose paragraph in ***</label>
            <label class="checkbox_label"><input id="sc_inline" type="checkbox"> Remove inline *word* and **word** emphasis</label>
            <label class="checkbox_label"><input id="sc_dedup" type="checkbox"> Remove unmistakable repeated narrative paragraphs (exact long matches only)</label>
            <label class="checkbox_label"><input id="sc_replace_continue" type="checkbox"> Add Smart Continue beside the original Continue option</label>
            <label class="checkbox_label"><input id="sc_smart_regenerate" type="checkbox"> Add Smart Regenerate beside the original Regenerate option</label>
            <label class="checkbox_label"><input id="sc_scene_focus_regen" type="checkbox"> Scene-first instructions for Smart Regenerate (avoid prompt/example regurgitation)</label>
            <label class="checkbox_label"><input id="sc_vary_impersonate" type="checkbox"> Make repeated Impersonate attempts produce different continuations</label>
            <label class="checkbox_label"><input id="sc_remember_attempts" type="checkbox"> Remember the last 3 attempts to avoid repeating them</label>
            <label class="checkbox_label"><input id="sc_narrative_diversity" type="checkbox"> Narrative Diversity Engine (track repeated motifs and scene-beat patterns across recent replies)</label>
            <p class="sc-note"><b>Important:</b> Smart Impersonate is a separate button in this extension panel; it does not add an item to the chat message menu. It continues text already in the input box, or uses your latest user message if the input box is blank. Its result is returned to the input box for review and is never sent automatically. Smart Continue automatically routes user-authored messages through Smart Impersonate. If it starts from an already-sent user message, the completed text replaces that same message in chat and the composer is cleared to prevent duplicates; if it starts from unsent composer text, the result stays in the composer for review. Automatic formatting and duplicate deletion start OFF. Exact repeated narrative paragraphs can be removed; recurring motifs and quoted dialogue are preserved. No extension can guarantee that Gemma reconstructs missing words.</p>
          </div>
        </div>`;
        $('#extensions_settings2').insertAdjacentHTML('beforeend', html);
        const bind = (id, key, type = 'checked') => {
            const el = $(`#${id}`);
            if (!el) return;
            el[type] = settings[key];
            el.addEventListener('change', () => {
                settings[key] = type === 'checked' ? el.checked : Number(el.value);
                SillyTavern.getContext().saveSettingsDebounced?.();
            });
        };
        bind('sc_enabled', 'enabled');
        bind('sc_inject', 'injectGuidance');
        bind('sc_autoformat', 'autoFormat');
        bind('sc_wrappers', 'paragraphWrappers');
        bind('sc_inline', 'removeInlineAsteriskEmphasis');
        bind('sc_dedup', 'removeExactAdjacentDuplicates');
        bind('sc_replace_continue', 'replaceContinueMenuItem');
        bind('sc_smart_regenerate', 'addSmartRegenerateMenuItem');
        bind('sc_scene_focus_regen', 'sceneFocusRegenerate');
        bind('sc_vary_impersonate', 'varyImpersonateRetries');
        bind('sc_remember_attempts', 'rememberImpersonateAttempts');
        bind('sc_narrative_diversity', 'narrativeDiversity');
        $('#sc_enabled').addEventListener('change', () => { updateContinueMenuItem(); updateRegenerateMenuItem(); });
        $('#sc_replace_continue').addEventListener('change', updateContinueMenuItem);
        $('#sc_smart_regenerate').addEventListener('change', updateRegenerateMenuItem);
        $('#sc_analyze').addEventListener('click', analyzeLatest);
        $('#sc_continue').addEventListener('click', nativeContinue);
        $('#sc_impersonate').addEventListener('click', runSmartImpersonate);
        $('#sc_format').addEventListener('click', async () => {
            const latest = lastAssistantMessage();
            if (!latest) return toast('warning', 'There is no assistant message to repair.');
            const before = latest.message.mes;
            const deduped = removeExactAdjacentDuplicateParagraphs(before);
            latest.message.mes = normalizeFormatting(deduped.text);
            await SillyTavern.getContext().saveChat?.();
            await SillyTavern.getContext().printMessages?.();
            toast('success', 'Formatting repair applied to the latest assistant message.');
            renderStatus();
        });
        renderStatus();
        installContinueMenuIntegration();
    }

    // Add a separate Smart Continue entry next to the native Continue item.
    // Cloning preserves the real SillyTavern icon markup; the original remains untouched.
    function updateContinueMenuItem() {
        const original = $('#option_continue');
        if (!original) return;
        const existing = $('#option_smart_continue');
        const enabled = settings?.enabled && settings?.replaceContinueMenuItem;
        if (!enabled) { existing?.remove(); return; }
        if (existing) return;
        const clone = original.cloneNode(true);
        clone.id = 'option_smart_continue';
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        let node;
        let renamed = false;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() === 'Continue') {
                node.nodeValue = node.nodeValue.replace('Continue', 'Smart Continue');
                renamed = true;
                break;
            }
        }
        if (!renamed) clone.setAttribute('aria-label', 'Smart Continue');
        clone.title = 'Smart Continue (uses SillyTavern native Continue)';
        original.insertAdjacentElement('afterend', clone);
    }

    function updateRegenerateMenuItem() {
        const original = $('#option_regenerate');
        if (!original) return;
        const existing = $('#option_smart_regenerate');
        const enabled = settings?.enabled && settings?.addSmartRegenerateMenuItem;
        if (!enabled) { existing?.remove(); return; }
        if (existing) return;
        const clone = original.cloneNode(true);
        clone.id = 'option_smart_regenerate';
        clone.title = 'Smart Regenerate (scene-first; uses native Regenerate)';
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        let node;
        let renamed = false;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() === 'Regenerate') {
                node.nodeValue = node.nodeValue.replace('Regenerate', 'Smart Regenerate');
                renamed = true;
                break;
            }
        }
        if (!renamed) clone.setAttribute('aria-label', 'Smart Regenerate');
        original.insertAdjacentElement('afterend', clone);
    }

    function installContinueMenuIntegration() {
        if (!menuClickHandlerInstalled) {
            document.addEventListener('click', (event) => {
                const smartContinue = event.target?.closest?.('#option_smart_continue');
                const smartRegenerate = event.target?.closest?.('#option_smart_regenerate');
                if (!smartContinue && !smartRegenerate) return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                if (smartContinue) nativeContinue();
                if (smartRegenerate) {
                    const native = $('#option_regenerate');
                    if (native) native.click();
                    else toast('error', 'Could not find SillyTavern’s built-in Regenerate action. No generation was sent.');
                }
            }, true);
            menuClickHandlerInstalled = true;
        }
        updateContinueMenuItem();
        updateRegenerateMenuItem();
        if (!menuObserver) {
            menuObserver = new MutationObserver(() => {
                updateContinueMenuItem();
                updateRegenerateMenuItem();
            });
            menuObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    function initialize() {
        ctx = SillyTavern.getContext();
        getSettings();
        const { eventSource, event_types } = ctx;
        eventSource.on(event_types.MESSAGE_RECEIVED, processIncomingMessage);
        eventSource.on(event_types.MESSAGE_SWIPED, processIncomingMessage);
        eventSource.on(event_types.GENERATION_STARTED, () => {
            if (pendingSmartImpersonate) {
                pendingSmartImpersonate.generationStarted = true;
                if (pendingSmartImpersonate.startTimer) { clearTimeout(pendingSmartImpersonate.startTimer); pendingSmartImpersonate.startTimer = null; }
                renderStatus('Smart Impersonate: generation started…');
            }
            lastGenerationType = 'Generation started; awaiting interceptor';
            lastHandledMessage = null;
            const latest = lastAssistantMessage();
            generationSnapshot = latest ? { message: latest.message, text: String(latest.message.mes || ''), index: latest.index } : null;
        });
        eventSource.on(event_types.GENERATION_ENDED, () => {
            removeTemporaryInstructions();
            if (pendingSmartImpersonate?.generationStarted) setTimeout(finishSmartImpersonate, 180);
            setTimeout(handleAssistantContinueEnded, 260);
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            removeTemporaryInstructions();
            // A token-limit stop can leave a partial assistant continuation.
            // Keep the bounded Smart Continue chain alive and inspect the text;
            // if an earlier paragraph still contains an unfinished quote/clause,
            // handleAssistantContinueEnded will launch the next pass.
            if (pendingAssistantContinue) {
                setTimeout(handleAssistantContinueEnded, 260);
            }
            if (pendingSmartImpersonate?.generationStarted) setTimeout(() => finishSmartImpersonate(true), 180);
        });
        eventSource.on(event_types.CHAT_CHANGED, () => {
            removeTemporaryInstructions();
            lastHandledMessage = null;
            generationSnapshot = null;
            pendingSmartImpersonate = null;
            smartImpersonateBusy = false;
            pendingAssistantContinue = null;
            lastAutoKey = '';
            renderStatus();
        });
        addUI();
        renderStatus();
        installContinueMenuIntegration();
    }

    globalThis.smartContinuationInterceptor = injectGenerationGuidance;

    // APP_READY is re-emitted for late listeners, so this is safe for normal extension loading.
    const boot = () => {
        try { initialize(); }
        catch (error) { console.error('[Smart Continuation] Initialization failed:', error); }
    };
    const earlyContext = SillyTavern.getContext();
    earlyContext.eventSource.on(earlyContext.event_types.APP_READY, boot);
})();
