# Coding Harness — Implementation Spec for a deepagents-based Agent

Derived from source-level reading of ZCode, opencode, and OpenAI Codex.
Target stack: LangGraph deepagents + AG-UI/CopilotKit + Hindsight + OpenSandbox.
No benchmarking required — every number below is copied from working production code.

Reference clones:
- `C:/Users/dwitatwa/AppData/Local/Temp/oc-probe` (opencode 2.0.29)
- `C:/Users/dwitatwa/AppData/Local/Temp/codex-probe` (openai/codex HEAD)

---

## 1. The tool set — build exactly these seven

Do not build forty tools. All three harnesses converge on a small set, and the leaderboard-topping
scaffold (mini-swe-agent) has **one**. Ranked by leverage.

### 1.1 `bash` — the primary tool

This is the highest-leverage tool. Get it right before anything else.

| Behaviour | Value | Source |
|---|---|---|
| Default timeout | 120_000 ms | opencode `shell.ts` `DEFAULT_TIMEOUT_MS` |
| Timeout override | allow per call; `0` disables | opencode, Codex |
| Background jobs | yes, for long commands | all three |
| cwd persistence | track `cd` across calls | opencode `shell/parse.ts` CWD set; ZCode bash-cwd-persistence |
| Output bound | head + tail, full output to file | Codex `TruncationPolicy::{Bytes,Tokens}` |
| Resumable process | stdin handle for interactive programs | Codex `write_stdin` under `Feature::UnifiedExec` |

Implementation notes:
- Run inside OpenSandbox. Pass the sandbox policy per call.
- Truncate the **middle**, keep head and tail. Codex's `formatted_truncate_text` inserts an elision
  marker rather than cutting one end.
- Return the full output as a file path plus a preview. Never return megabytes.
- Expose the exit code, wall time, and total line count. Codex's `format_exec_output_for_model`
  emits `Exit code / Wall time / Total output lines / Output`.

### 1.2 `read`

| Behaviour | Value | Source |
|---|---|---|
| Max lines per call | 2_000 | opencode `read-filesystem.ts` `MAX_READ_LINES` |
| Max bytes per call | 50 KiB | opencode `MAX_READ_BYTES` |
| Media ingest cap | 20 MiB | opencode `MAX_MEDIA_INGEST_BYTES` |
| Media types | png, jpeg, gif, webp, pdf | opencode `MEDIA_MIMES` |
| Line prefix | 1-based line numbers | opencode |
| Long line handling | truncate a single line at ~2_000 chars | opencode |

Always paginate. Never load a whole large file into context.

### 1.3 `edit` — pick the string-replace design

Two designs exist. Take the simpler one.

**Recommended — exact string replace (ZCode, opencode):**
- Require a unique match unless `replaceAll` is set. Fail loudly on ambiguity.
- Fuzzy fallback for typographic quotes, dashes, and trailing whitespace. opencode does this and it
  measurably reduces failed edits caused by copy-paste artifacts.
- **Preserve CRLF vs LF and the BOM.** opencode has `writeTextPreservingBom`. Getting this wrong
  produces diffs the user did not ask for.
- Read the file first to compute the match. opencode does this.

**Alternative — Codex's `apply_patch`:** a FREEFORM tool with its own Lark grammar, multi-file,
context-anchored hunks, pre-computable unified diff. It is more token-efficient and more verifiable.
It also requires the model to be prompted into the grammar, and Codex's prompt has to say *"NEVER try
`applypatch` or `apply-patch`, only `apply_patch`."* Take this only if you are willing to own the
prompt work.

### 1.4 `write`

Create or overwrite. Preserve BOM. Read the current content first so you can show a diff in the
approval prompt (opencode does this).

### 1.5 `glob` and `grep`

Both ripgrep-backed. Do not implement your own walker.
- opencode has a timeout on search: `FileSystem.DEFAULT_SEARCH_TIMEOUT_MS`.
- ZCode and opencode both treat these as read-only, concurrency-safe, `sideEffectScope: "none"`,
  so they can run in parallel without approval.

### 1.6 `todo` / plan

All three have it (`TodoWrite`, `update_plan`). It matters for long tasks because it keeps the model
from losing the thread. Keep it session-scoped and cheap.

### 1.7 What you do not need

No subagent tool — deepagents has it. No skill tool — deepagents has it. No memory tool — you have
Hindsight.

---

## 2. Context rules

### 2.1 Truncate at the tool boundary, not in the prompt

Every harness caps tool output at the source and spills the rest to disk. Copy this.

| Harness | Bound |
|---|---|
| opencode | 2_000 lines / 50 KiB, full output to `~/.opencode data/tool-output/` |
| ZCode | `resultBudget.maxInlineBytes` / `maxModelBytes`, strategy `inline \| truncate \| artifact` |
| Codex | `TruncationPolicy::{Bytes(n), Tokens(n)}` |

ZCode's rule is the one to copy: **if the serialized result exceeds the budget and the strategy is
`artifact`, write the full result to a file and return a preview plus the path.** If the artifact
write fails, degrade to truncation — never fail the tool call.

### 2.2 Keep the recent window verbatim

opencode keeps the newest **15_000 tokens** exactly as written and summarizes everything older.
Do the same. Do not summarize recent turns.

### 2.3 Compaction thresholds

| Harness | Rule |
|---|---|
| ZCode | `effective = window − min(maxOutputTokens ?? 32000, 21000)`; `threshold = effective − 13000` |
| opencode | `ceiling = window − max(floor(window × 0.1), 16000)` |
| Codex | keep all user messages up to 20_000 tokens, then append the summary |

Use opencode's ceiling formula. It scales with the window instead of assuming 200k.

On repeated overflow, opencode shrinks by `[0.7, 0.5, 0.35]` of the first rejected estimate. Copy that
ladder rather than retrying the same size.

Add a circuit breaker: ZCode stops auto-compacting after 3 consecutive failures. Without it, a broken
compaction loop burns the whole budget.

### 2.4 Summary template — copy opencode's

```
Objective
Requirements
Decisions
Work State (Completed / Active / Blocked)
Next Move
Relevant Files (max 15)
Important Context
```

This is better than a free-form summary because it is stable across compactions and it preserves the
user's constraints, which a generic "summarize this" prompt tends to drop.

### 2.5 Preserve the prompt-cache prefix

**Trim from the front, never mutate the head.** Codex does this deliberately:
`compact.rs` removes the first item and retries on overflow, with the comment *"Trim from the beginning
to preserve cache (prefix-based) and keep recent messages intact."*

This is the single biggest cost lever. A mutated prefix invalidates the cache on every turn.

### 2.6 Token estimation

You need a local estimate for planning. Use opencode's constants:
`IMAGE_TOKEN_ESTIMATE = 1500`, `PDF_TOKEN_ESTIMATE = 2000`, `TOOL_OUTPUT_MAX_CHARS = 1250`.
Prefer provider-reported usage when available and fall back to the estimate.

---

## 3. Loop rules

### 3.1 No max-iteration cap

All three refuse one. On a task-completion benchmark, stopping early is failing. Bound the loop with
context limits, cancellation, retries, and permissions instead.

### 3.2 Continue while tools are requested

The loop ends when a model step returns no executable tool calls. That is the whole termination rule.

### 3.3 Every tool call gets exactly one result

**Even on cancel, deny, or crash.** Inject a synthetic skipped or error result. ZCode states this as
an invariant; Codex and opencode both depend on it. Get it wrong and resume and replay break, because
the provider sees a dangling `tool_use`.

### 3.4 Own your retries

Disable any SDK-internal retry and implement your own.

| Parameter | Value | Source |
|---|---|---|
| Max attempts | 11 (10 retries) | ZCode |
| Base delay | 2_000 ms | both |
| Backoff factor | 2 | both |
| Max delay | 60_000 ms | ZCode |
| Jitter | yes | both |
| `retry-after` | honour it, cap at 15 min | opencode `RETRY_AFTER_MAX` |
| Timeout retries | cap at 3 | opencode `MAX_TIMEOUT_RETRIES` |

Normalize provider errors into stable codes. Never branch on error text.

### 3.5 Cancellation is completion, not error

ZCode treats a cancelled turn as a normal completion. This keeps the state machine simple and stops
cancels from poisoning session state.

### 3.6 Cap output-limit continuations

ZCode caps at 3, opencode at 2. Do not loop forever on a model that keeps hitting the output ceiling.

---

## 4. The verify loop — add this first

If you add one thing, add this. It is the biggest coding-specific win and it costs almost nothing.

After the model edits files, automatically run the project's checks and feed failures back:
- detect the test command from the project (package.json scripts, pyproject, Makefile)
- run it in the sandbox
- feed the failure output back as a tool result
- let the model fix and re-run

This is why coding agents work at all. The model needs a signal, and the test suite is the signal.

---

## 5. Approval and sandbox mapping

### 5.1 Declare these fields on every tool

Copy ZCode's declaration surface. It is the richest of the three and it feeds both your approval
policy and your AG-UI rendering from one source of truth.

```
readOnly: boolean
destructive: boolean
concurrentSafe: boolean
sideEffectScope: "none" | "workspace" | "git" | "network" | "system" | "session" | "userInteraction"
riskLevel: "low" | "medium" | "high" | "critical"
needsApproval: boolean
resultBudget: { maxInlineBytes, maxModelBytes, strategy }
timeout: { kind, defaultMs, maxMs }
```

### 5.2 Map Codex's presets onto OpenSandbox

| Preset | Meaning |
|---|---|
| `:read-only` | sandbox may read, may not write, network off |
| `:workspace` | writes confined to workspace roots, network off |
| `:danger-full-access` | no outer sandbox |

Precedence when resolving a path: **deny > write > read.** Codex implements exactly this in
`FileSystemSandboxPolicy`.

### 5.3 Protect metadata paths

Codex keeps `.git`, `.agents`, `.codex`, and `.aws` read-only **even inside writable roots.** This
blocks the classic `.git/hooks` privilege escalation. Add it to your OpenSandbox mounts.

### 5.4 Parse commands before asking

Never string-match a shell command. Use an AST.
- ZCode uses `unbash` (pure TS, `MAX_BASH_PARSE_LENGTH = 10_000`).
- Codex uses tree-sitter-bash and tree-sitter-powershell.
- opencode has both a tree-sitter path and a 2_409-line hand-written scanner.

ZCode's safety test is the one to copy: a command is safe only if it has **no parse errors, no
unsupported syntax, and no dynamic words** (command substitution, parameter expansion, brace
expansion). The rationale is exact: `ls $(touch out.txt)` must never be treated as read-only.

Unparseable commands **fail closed to ask**. They do not fail open.

### 5.5 Never auto-suggest allow-rules for dangerous prefixes

Codex maintains a banned list — shells, `python`, `node`, `rm`, `sudo`, `powershell` — that are never
offered as "always allow" rules. Copy it. A remembered rule for `rm` is a footgun.

---

## 6. Prompt — the layer that shapes behaviour

Two working philosophies, both successful:

| | Codex | opencode |
|---|---|---|
| Size | 275 lines, plus **6 per-model variants** | ~12 lines, plus generated tool guidance |
| Approach | heavy behavioural shaping | minimal, with instructions generated from registered tools |

You do not need 275 lines. But the ~12-line version only works because the guidance is **generated
from which tools are actually registered**, so it never mentions a tool that is absent.

### 6.1 Structure

```
identity        → who you are, what harness you are in
harness rules   → how output is rendered, what <system-reminder> means
tool guidance   → GENERATED from the registered tool set
communication   → brevity, file paths
working rules   → codebase conventions, safety behaviours
environment     → OS, cwd, git branch + status, date   (dynamic)
```

### 6.2 Generate tool guidance from the tool list

opencode's `system-prompt.ts` renders `${OPENCODE_TOOL_GUIDANCE}` by checking which tools exist:

```ts
if (tools.includes("shell")) instructions.push(
  "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
  "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
)
if (tools.includes("write")) instructions.push(
  "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
)
if (tools.includes("edit")) instructions.push(
  "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
)
```

Copy this pattern. It keeps the prompt honest and eliminates stale instructions.

### 6.3 Lines worth copying verbatim

From opencode:

- `Prefer parallelizing independent tool calls.`
- `Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.`
- `Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.`
- `Responses are rendered as GitHub-flavored Markdown.`
- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.`

That fourth-from-last one is a **safety behaviour**, not a style note. It is what stops the agent
from deleting a file the user was editing.

### 6.4 AGENTS.md spec — copy Codex's

Codex's prompt devotes a full section to instruction-file scoping. Copy these rules:

- The scope of an `AGENTS.md` is the entire directory tree rooted where it sits.
- For every file in the final patch, obey any `AGENTS.md` whose scope includes that file.
- More-deeply-nested files take precedence on conflict.
- Direct system/developer/user instructions take precedence over `AGENTS.md`.
- The root and CWD-to-root files are already included in context; do not re-read them.

### 6.5 Planning guidance

Codex's prompt includes high-quality and low-quality plan examples. The rule it teaches:

- Use a plan when the task is non-trivial, has phases or dependencies, has ambiguity, or the user
  asked for more than one thing.
- **Do not** use a plan for simple or single-step queries.
- Do not repeat the plan contents after updating it; the harness already displays it.

### 6.6 Model-conditional behaviour — there is no single "best"

This is the part that undercuts "best of the three" as a fixed target:

- Codex ships **six prompt files**: `gpt_5_codex_prompt.md`, `gpt_5_1_prompt.md`,
  `gpt_5_2_prompt.md`, `gpt-5.1-codex-max_prompt.md`, `gpt-5.2-codex_prompt.md`, plus the generic
  `models-manager/prompt.md`. The prompt is selected per model.
- opencode **swaps the tool set per model**: for `gpt-*` models it removes `edit` and `write` and
  exposes `patch` instead (`tool/plugin/patch.ts`).

So the correct architecture is a **prompt and tool set selected by model**, not one global
configuration. Build the seam for that now even if you only support one model today.

### 6.7 Additional rules

- **Put tool documentation in the tool schemas, not the prompt.** ZCode does this explicitly — tool
  descriptions ride the request `tools` field. The prompt carries only cross-tool rules.
- Split stable from dynamic sections so the cache prefix stays warm.
- Do not re-explain the sandbox or the approval flow in the prompt. The tool schemas carry it.
- Codex asks for a **brief preamble before tool calls** (1–2 sentences, 8–12 words for quick
  updates) so the user sees intent before action. Worth copying if your UI shows a live transcript.

---

## 6b. What a spec cannot give you

Be clear-eyed about the residual gap.

The parameters in this document are copied from working production code, which is a much better
starting point than guessing. But a harness is not a set of constants. The three projects reached
their behaviour by iterating against real usage, and the parts that matter most are the parts that
are hardest to copy:

- **Prompt wording.** The difference between "investigate before deleting" and no such line is a real
  behaviour change, and the exact phrasing was tuned.
- **Tool result formatting.** How a tool's output is presented to the model — preview shape, elision
  markers, what gets summarized — matters as much as the truncation limits.
- **Failure recovery.** What the harness does when an edit fails, a command times out, or the model
  emits malformed tool input. All three have specific repair paths.
- **Model-specific tuning.** See 6.6. There is no model-independent best.

Expect to iterate. Budget for it.

---

## 7. What to ignore

From all three, these are product features, not coding quality. They do not improve task completion
and they cost tokens, latency, and maintenance:

- Session stores, event sourcing, projections
- Plugin marketplaces and manifests
- Protocol versions (V4, app-server)
- Permission brokers with responder races
- TUIs and desktop shells
- Memory systems (you have Hindsight)
- Multi-agent message boards, agent graphs, guardians
- CodeMode interpreters

---

## 8. Build order

1. `bash` in OpenSandbox, with head/tail truncation and a full-output file. **Start here.**
2. `read` with pagination.
3. `edit` with unique-match enforcement, CRLF/BOM preservation, fuzzy fallback.
4. `write`, `glob`, `grep`.
5. **The verify loop.**
6. Output budget and artifact spillover.
7. Compaction with the structured summary template and front-trimming.
8. Tool declaration metadata, wired to AG-UI approval prompts.
9. AST command parsing, fail-closed.
10. Sandbox presets and metadata-path protection.

Steps 1 through 5 give you a working coding agent. Steps 6 through 10 make it safe and affordable.

---

## 9. Reference implementations to read

| What | Where |
|---|---|
| Shell exec + parse | `oc-probe/packages/core/src/shell.ts`, `shell/scan.ts` |
| Read limits | `oc-probe/packages/core/src/tool/read-filesystem.ts` |
| Edit with fuzzy match | `oc-probe/packages/core/src/tool/plugin/edit.ts` |
| Output truncation | `oc-probe/packages/core/src/tool-output.ts` |
| Compaction | `oc-probe/packages/core/src/session/compaction.ts` |
| Patch grammar | `codex-probe/codex-rs/apply-patch/src/parser.rs`, `lib.rs` |
| Output truncation (Rust) | `codex-probe/codex-rs/utils/output-truncation/src/lib.rs` |
| Sandbox policy + presets | `codex-probe/codex-rs/protocol/src/permissions.rs` |
| Command approval rules | `codex-probe/codex-rs/execpolicy/` |
| Command safety | `codex-probe/codex-rs/shell-command/src/command_safety/` |
| Tool contract | `ZCode/apps/zcode-cli/packages/contracts/src/tools/contract.ts` |
| Artifact spillover | `ZCode/apps/zcode-cli/packages/core/src/tool/executor/result-serialization.ts` |
| Command AST safety | `ZCode/apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts` |
