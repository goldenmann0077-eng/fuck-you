# Smart Continuation & Smart Regenerate v0.5.20

## v0.5.20 — roleplay-only output guard

- **Universal roleplay-only guard:** every intercepted generation type now receives a concise instruction to stay inside the fictional scene and output only in-world narration/dialogue. It explicitly rejects exposed planning notes, checklists, pointers, reminders, turn announcements, and authorial statements about what the model needs to do. Natural in-character thoughts and dialogue remain allowed.
- **No new content filter:** the guard does not ban ordinary words such as “need”, “must”, or “cannot”, and it does not delete generated story text.

## v0.5.19 — scene-loop detection + prompt refinement

This build uses the fuller **v0.5.11 implementation as its base**, retaining its composer-first Smart Continue routing, exact draft preservation, continuation-only Smart Impersonate, prompt-echo detection, open-dialogue connector validation and bounded retry handling, paragraph-boundary analysis, scene-aware Impersonate focus, Regenerate/swipe handling, formatting controls, and SillyTavern menu integration. It does not replace that implementation with the smaller reconstructed 0.5.15/0.5.16 codebase.

### New and strengthened behavior

- **Narrative Diversity Engine:** scans up to five recent assistant replies for overused surface motifs and repeated scene-beat categories. It asks for a change in narrative purpose—not merely synonyms—while preserving established facts, character knowledge, speaker continuity, and user agency.
- **Continue repetition repair:** after native Continue, checks only the newly generated portion against the complete prior assistant message and recent assistant turns. Exact repeated long narrative paragraphs and long sentences are removed from the new continuation; quoted dialogue is preserved and the original prior text is retained byte-for-byte.
- **No fuzzy deletion:** paraphrased similarities are not automatically removed. Diversity detection is prompt guidance only and never deletes prose.
- **Unfinished thought / dialogue handling:** retains the earlier open-dialogue connector lock and validation. A continuation may pause naturally, but it must continue the same speaker's unfinished thought before jumping to another speaker or unrelated narration.
- **Bounded completion:** retains the existing configurable bounded follow-up passes for endings identified as unfinished. It does not run indefinitely. SillyTavern's separate global Auto-Continue setting can still operate independently.


### v0.5.18 changes

- **Callback-safe repetition repair:** historical dialogue and sentence callbacks are not deleted simply because they appeared in earlier turns. Cross-turn recurrence is handled as non-destructive diversity guidance; v0.5.19 adds a separate guard for full verbatim paragraph replays.
- **Narrow duplicate cleanup:** automatic cleanup is limited to exact long sentence repeats inside the same newly generated continuation. Quoted dialogue is preserved.
- **No feature downgrade:** this release is based directly on the saved v0.5.17 build, which itself retained the fuller v0.5.11 continuation foundation.


### v0.5.19 changes

- **Non-adjacent loop cleanup:** removes unmistakable exact repeats of substantial narrative paragraphs even when other paragraphs appear between them, including exact replays from the source draft and recent assistant history.
- **Callback-safe:** quoted dialogue is never removed by this paragraph repair. Recurring motifs, phrases, images, and details are not banned; only full verbatim narrative paragraph replays are eligible for automatic removal.
- **Near-duplicate detection:** uses high-overlap four-word phrase shingles to flag near-verbatim paragraph rewrites. It does not silently delete them. Smart Impersonate rejects a flagged attempt and retries from the unchanged original draft within the existing retry limit. Native Continue reports the detection without rewriting a potentially intentional callback.
- **Scene-loop prompt:** explicitly distinguishes a recurring motif from replaying the same event, reaction, or descriptive passage. It asks the model to identify the immediate unresolved beat and advance causally without forcing unrelated novelty.
- **Revised PC System Note and PHI:** included in `prompts/` as separate copy-ready text files. They reduce duplicated instructions and clarify that callbacks are allowed while scene loops are not.

## Install

Extract the ZIP and copy the included `SmartContinuation` folder into `SillyTavern/public/scripts/extensions/third-party/`, replacing the existing folder. Restart SillyTavern and refresh the browser. Confirm the extension panel shows **v0.5.20**.

## Verification and limitations

JavaScript syntax, manifest JSON, ZIP integrity, and targeted duplicate/near-duplicate logic are checked during packaging. This is not a live SillyTavern / AI Horde integration test. Motif and scene-beat detection are lightweight heuristics; they can miss paraphrases or flag a motif that remains relevant. Exact paragraph cleanup is restricted to substantial verbatim narrative replays; dialogue is preserved and recurring motifs are not banned. Near-duplicate detection is heuristic and may still flag an intentional callback, so strong near-copies, or multiple near-copy paragraphs, are retried only in Smart Impersonate and are never silently deleted. No extension can force a model to produce genuinely novel prose or reconstruct words that were never generated.
