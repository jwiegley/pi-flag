# pi-flag

`pi-flag` is a standalone [Pi](https://pi.dev) extension for user-selected, session-scoped significance flags. `/flag` opens a filterable terminal selector; active flags are sent losslessly as persistent model focus on every later run in the same session, including runs that extensions start with custom messages on Pi 1.2 or later.

The package is private and `UNLICENSED`. It has no remote or published npm release.

## Compatibility

pi-flag 0.1.x supports Pi `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` versions `>=0.84.4 <0.85.0`; tested against 0.84.4. pi-flag also needs Pi's bounded session-history reads (`getHistorySummary`, `getEntriesPage` and `getRecentActiveEntries`), which the jwiegley/pi fork provides and neither upstream package has; the tests install a stand-in for them. With that stand-in, the suite also runs pi-flag inside upstream Pi 1.4.0 through the npm alias `pi-coding-agent-1x`, which exercises Pi 1.x's run, steering, follow-up and abort behavior but not the fork's own history code. Other Pi minor lines are unsupported until tested.

Node.js 22.19.0 or newer is required. The package ships erasable TypeScript directly and has no build step and no runtime dependencies. Pi loads `index.ts` through its TypeScript loader.

## Installation

The currently supported installation is a reviewed local checkout:

```bash
pi install /absolute/path/to/pi-flag
pi list
```

Once a remote or npm release is separately authorized, Pi also accepts `pi install git:<url>@<ref>` and `pi install npm:pi-flag@<version>`. No such release source is currently provided.

## Using `/flag`

Run `/flag` in Pi's interactive TUI. The command is unavailable in print, JSON, and RPC modes, and it refuses to open while an agent run or manual compaction is active.

The selector lists the 256 most recent active-branch entries plus the sources named by flag records among the 256 newest session entries, newest first. Rows remain understandable without color:

```text
> [flagged] assistant a1b2c3d4 [off-branch] [length] Keep the calibration knob...
  [ ] user       e5f6a7b8 [active] Refactor this without compatibility...
```

Type to fuzzy-filter full message text, role, entry ID, branch state, and flagged state. `Tab` cycles these modes:

1. all entries;
2. user prompts;
3. assistant responses;
4. flagged only.

Controls use Pi's configured TUI actions rather than fixed key checks:

| Action | Default | Purpose |
|---|---|---|
| `tui.select.up` / `tui.select.down` | arrows | Move the selected row |
| `tui.select.pageUp` / `tui.select.pageDown` | Page Up / Page Down | Move by a page |
| `tui.select.confirm` | Enter | Flag or unflag the row |
| `tui.select.cancel` | Escape / Ctrl+C | Decline confirmation or close |
| `tui.input.tab` | Tab | Cycle modes |
| ordinary `Input` editing actions | configured defaults | Edit the query, including Unicode and paste |

A toggle remains selected while it completes. Duplicate confirms are ignored. Errors stay inside the selector. Active dangling records appear as `[!]` rows and can be unflagged even when runs are blocked.

### First flag and provider changes

Before the first activation in a session, the selector requires this acknowledgement:

> pi-flag resends flagged text in full on future model runs in this session and their continuations, including runs that extensions start and runs after provider changes. Unflagging stops future projection but does not erase session history or prior provider requests.

Declining performs no toggle. After acknowledgement, several entries can be managed without closing the selector. If the terminal is too small to display the complete notice and configured controls, the selector shows `[resize required]` and ignores confirmation until the full disclosure is visible.

When active flags cross to a different model provider, pi-flag emits a content-free warning containing only the flag count, estimated token cost, and new provider. Same-provider model changes and sessions without flags do not warn.

## Eligible content

Version 1 flags whole persisted messages, never substrings:

- user string or text-block prompts are eligible and preserve every text block exactly;
- any user image makes that prompt ineligible because a text system prompt cannot reproduce it losslessly;
- assistant `stop`, `length`, `toolUse`, `error`, and `aborted` results are eligible only when they contain nonempty visible text;
- assistant `pending` and `deferred` results are ineligible;
- empty separator text blocks are preserved around visible assistant text;
- thinking, tool calls, tool results, provider `errorMessage`, bash output, custom messages, summaries, labels, model changes, and other metadata are excluded.

Whitespace, newlines, Unicode, block boundaries, and visible partial text are not normalized. `length`, `toolUse`, `error`, and `aborted` provenance remains visible in the selector and projection.

## Session, branch, and persistence semantics

Flag operations append validated `pi-flag/marker` custom records containing the owning session ID, target entry ID, and active state. Flagged text is not copied into the journal; original message entries remain authoritative.

Restore reads flag records only among the 256 newest session entries of any kind, so marker records eventually leave that window. While at least one flag is active, pi-flag checks at the start of every model turn and when a run settles whether the 128 newest entries alone would still restore the same flags; when they would not, it appends one hidden `pi-flag/checkpoint` custom record holding the owning session ID and, in activation order, each active target entry ID and its flag time. Restore starts from the newest checkpoint in the window and applies the marker records after it, so a later unflag wins and the projected block stays byte-identical. Nothing is checkpointed while no flag is active, a session without checkpoints restores as before, and builds that predate checkpoints ignore them. A flag can still drop out if more than 128 entries arrive between two checks, as from one turn with more than 127 tool calls or from many entries added between runs.

- Flags are global within one session ID, including abandoned branches and rewinds.
- An off-branch source is still projected and is labeled `[off-branch]`.
- Rewinding before a marker does not undo it; use `/flag` to unflag.
- Reopening or importing a file with the same session header ID restores flags.
- `/new`, `/fork`, `/clone`, and CLI `--fork` create a new ID. Copied old-ID marker records and checkpoints are inert.
- `--no-session` works only for the process lifetime and is labeled `ephemeral`.
- A persisted session before its first assistant flush is labeled `not-yet-saved`; it becomes `durable` after the session file exists.
- A `/flag` toggle may complete while branch summarization is pending because it is a synchronous append-only, session-global metadata event. It neither cancels nor rewrites the summary; the next input replays the flag records. No sticky tree-busy flag is used because a tree operation can be cancelled before a terminal tree event.

Malformed marker records and checkpoints produce diagnostics and no invented state. A valid active record whose source is missing or no longer eligible blocks every new run, whether user input or a custom message starts it, without silently omitting the flag; `/flag` remains available to append its inactive tombstone.

## Model projection and compaction

Active observations are rebuilt from original full-log entries in activation order and serialized as fresh JSON-domain objects. One deterministic block is appended to the chained system prompt. Assistant text is explicitly quoted as observation data, not promoted to an instruction. New direct instructions may revise old flags, and the model is asked to report conflicts.

The block is byte-stable while flag content/order is unchanged. A SHA-256 sentinel lets the final context guard require exactly one canonical block. Cooperative prompt middleware may add text before or after it; removal, alteration, or duplication aborts visibly. Mutation after the context hook and providers that disregard an already-aborted signal remain trusted extension/provider boundaries.

Ordinary conversation history can be compacted. Original entries and marker records remain in the full session log, so repeated manual/automatic compaction, tool/retry continuations, and steering or follow-up messages queued during a run receive the same complete block. pi-flag never summarizes, trims, samples, partially injects, or automatically unflags selected text.

Since Pi 1.2, a `sendCustomMessage({ triggerTurn: true })` run, such as a goal continuation or a subagent or MCP result, emits `before_agent_start` with `messageType: "custom"` and no prompt (some builds send an empty one); no input event precedes it. pi-flag admits such a run there with the same dangling-record and focus-limit checks as user input, projects the same block, and counts no input tokens for the custom message. That hook cannot refuse a run, so pi-flag aborts a refused one before its first request. The custom message stays in session history, followed by an error response ("This operation was aborted"); the reason appears only in pi-flag's notification, which begins "pi-flag refused an extension-started run."

Stable base-prompt-first ordering preserves the largest provider cache prefix. Actual cache hits remain provider-specific.

## Finite context and refusal

Finite model windows make unbounded lossless flags impossible. pi-flag refuses instead of degrading:

```text
focus limit = min(32,768 tokens, floor(context window / 4))
response reserve = max(4,096, min(16,384, model.maxTokens))
```

Before a run, focus-only admission checks the current model without reading Pi's previous effective system prompt: at user input, and in `before_agent_start` for a run that a custom message starts. Immediately before conversion, the context guard verifies the final chained prompt contains one exact block and checks the mandatory system prompt, expanded text/images, and response reserve. Steering or follow-up input queued during a run counts at least its own estimated size there, since it is not expanded yet. A failure says that nothing was truncated and directs the user to `/flag` or a larger model.

Changing to a smaller model never changes flag state. If the set no longer fits, new runs are refused and `/flag` remains the recovery path.

## Accessibility and terminal behavior

The selector is keyboard-only, retains an ASCII `>` focus cursor, and uses textual state labels rather than color alone. It routes editing, Unicode, grapheme deletion, bracketed paste, legacy terminal keys, Kitty CSI-u keys, navigation, confirmation, and cancellation through Pi/TUI facilities. Narrow and short terminals drop detail first while retaining query, list state, and configured-key help.

This is a terminal component. Version 1 makes no operating-system screen-reader API claim beyond the plain text exposed by the host terminal. Platform/terminal behavior must be verified before making a portability claim.

## Unsupported behavior

- No live transcript marker, shortcut, widget, label integration, or built-in `/tree` modification is installed.
- On Pi 0.84, `sendCustomMessage({ triggerTurn: true })` starts a turn without `before_agent_start`, so pi-flag cannot project the focus; while flags are active such turns are visibly aborted, and cooperating extensions must use `sendUserMessage`.
- Provider-payload mutation after Pi's context hook is outside pi-flag's integrity boundary.

## Removal

Remove the same source recorded by `pi list`, for example:

```bash
pi remove /absolute/path/to/pi-flag
```

Removal stops the extension from loading. Existing `pi-flag/marker` and `pi-flag/checkpoint` custom entries remain inert in session JSONL; uninstalling does not rewrite or erase session history or prior provider requests.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run check
npm pack --dry-run --json
```

Development dependencies are exact-pinned; `pi-coding-agent-1x` aliases `@earendil-works/pi-coding-agent@1.4.0` for `test/pi-1x.test.ts` only. Installation lifecycle scripts are disabled and the package defines none. Tests use Pi's native faux provider, isolated session/package roots, and no real credentials or paid provider calls.
