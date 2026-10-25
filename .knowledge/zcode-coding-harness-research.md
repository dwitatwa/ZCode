# ZCode Coding Harness — Research Notes

Date: 2026-10-14
Scope: `C:\Users\dwitatwa\Fork\ZCode` (monorepo `zcode` v3.15.1; harness = `apps/zcode-cli`, v0.16.9)
Method: read design specs + source. Read-only. Line counts are approximate.

---

## 0. TL;DR

ZCode is a full coding-agent harness built as a **pnpm monorepo** with a strict four-layer
architecture: `contracts` → `core` → `adapters` → `bootstrap`. The agent harness itself lives
in `apps/zcode-cli/packages/`, not in the root `packages/` (which holds the Electron desktop,
web client, UI, RPC, services, and the model/provider registry).

The five design decisions that shape everything else:

1. **Session events are the fact source; projections are rebuildable.** In-memory event store
   per session, monotonic `sequenceNumber`, reducer builds the UI/status projection.
2. **No hard stop on tool-call count.** The turn loop ends when the model stops asking for
   tools. Bounds are resource-based: cancellation, permission denial, tool timeout, output
   truncation, provider retry limit, context compaction.
3. **Tools are contracts, not functions.** Every tool declares input/output schema, read-only
   flag, destructive flag, concurrency safety, timeout, cancellation semantics, permission
   requirement, result budget, and side-effect scope. The permission system and sandbox read
   those declarations; they never guess.
4. **Core never touches the outside world.** No `fs`, `http`, `child_process`, or `process.env`
   in `core`. All I/O goes through ports implemented by adapters.
5. **Every action carries one `traceId`.** Session, turn, message, tool call, model request,
   permission, subagent, and I/O all hang off the same root trace.

---

## 1. Repo shape

```
C:\Users\dwitatwa\Fork\ZCode\
├── apps/
│   ├── zcode-cli/          <- THE HARNESS (agent CLI + runtime)
│   │   ├── packages/
│   │   │   ├── contracts/   layer 1: ports, events, errors, capabilities
│   │   │   ├── core/        layer 2: agent loop, tools, permission, compact, memory
│   │   │   ├── adapters/    layer 3: fs, exec, http, sqlite, model, mcp, plugins, skills
│   │   │   ├── bootstrap/   layer 4: composition root, protocol server
│   │   │   ├── cli/         arg parsing, command routing
│   │   │   ├── tui/         terminal UI (OpenTUI)
│   │   │   ├── dynamic-workflow/ + dynamic-workflow-runtime/   TS workflow engine
│   │   │   ├── bundled-skills/
│   │   │   └── <plugin packages>  (browser-use, documents, pdf, pptx, xlsx, cua, ...)
│   │   └── docs/design/v2/  <- the normative specs (Chinese)
│   └── dev-docs/
├── packages/               <- DESKTOP APP + WEB, not the harness
│   ├── desktop/  (Electron main/host/renderer)
│   ├── ui/       (shared React + Zustand)
│   ├── services/ (ZCodeAgentProcessManager, protocol client)
│   ├── rpc/      (7-layer RPC framework)
│   ├── client/   (transport-level service SDK)
│   ├── provider/ provider-node/ model-option-map/  (model registry + capability rules)
│   ├── shared/   (protocol schemas, model types, workspace identity)
│   └── server/ web/ android/ ...
├── docs/                   <- cross-cutting specs (protocol, dynamic-workflow, security)
└── .knowledge/             <- this file
```

**Dependency rule (compile-time, enforced):**
`bootstrap → {contracts, core, adapters, cli, tui}` · `core → contracts` · `adapters → contracts` · `contracts → nothing`.

Runtime dependency injection lets `core` call adapter capabilities, but the compile-time
graph stays one-directional. `core` must be testable alone.

---

## 2. Agent loop and turn lifecycle

### 2.1 The loop

Two nested loops. Outer = turn lifecycle; inner = the model/tool loop.

| Concern | File | ~Lines |
|---|---|---|
| Turn entry / lifecycle / termination | `core/src/runtime/methods/turn.ts` | 923 |
| One model step | `core/src/runtime/methods/turn-model-step.ts` | 850 |
| **The actual loop** (`runRegularTurnLoop`) | `core/src/runtime/methods/turn-loop.ts` | 234 |
| Loop mutable state | `core/src/runtime/methods/turn-loop-state.ts` | 203 |
| Tool scheduling/execution per step | `core/src/runtime/methods/turn-tools.ts` | 291 |
| Termination + Stop hooks | `core/src/runtime/methods/turn-stop.ts` | 237 |
| Turn state machine | `core/src/agent/turn-state.ts` / `turn-machine.ts` | 264 / 344 |
| Provider-visible message history | `core/src/agent/message-history.ts` | 531 |

Each inner iteration does:

1. Abort check (`throwIfTurnAborted`).
2. **Mid-loop command drain** — pull queued `task-notification` / `subagent-message`
   into the current turn as user-role entries.
3. `microcompactIfNeeded` → `autoCompactIfNeeded` (context pressure).
4. Initialize MCP, refresh tool list, compute `getTurnTools`.
5. Build request entries: agent listing, plan-mode reminder, runtime-mode reminder,
   todo reminder, output-style reminder, pending memory update.
6. `buildRuntimeProviderRequestMessages(...)`.
7. `turnMachine.startModelRequest(...)`.
8. `runModelBackedTurnStep(...)` — the model call + tool execution.
9. Return `"break"` → exit loop; else loop again.

### 2.2 Termination

- **Normal:** a model step with zero executable tool calls ends the turn
  (`finishModelStepWithoutToolCalls`), unless a Stop hook or inline guide forces continuation.
- **Tool-driven:** a tool result can set `toolControl.stopTurnAfterResult`.
- **Cancellation/error:** `TurnCancelled` is treated as **normal completion**, not an error.
- **Guardrails:** rapid-refill breaker (`MAX_CONSECUTIVE_RAPID_REFILLS = 3`,
  `RAPID_REFILL_TOOL_TURN_THRESHOLD = 3`); output-token continuation max 3.

**There is no global max-iteration cap and no max-tool-call cap.** This is explicit:
`toolCallCount` is telemetry only, and `maxToolCalls` was removed from runtime config.
The spec states long tasks are bounded by cancellation, permissions, tool contracts,
provider retry limits, and context compaction instead.

### 2.3 Streaming and the commit boundary

The **commit boundary is the completed model step, not individual stream deltas.**

- Only read-only, concurrency-safe, non-destructive, no-approval, `sideEffectScope:"none"`
  tools may execute *during* the stream (`streaming-tool-coordinator.ts`).
  Everything else waits for `model_complete`.
- On commit: assistant tool_use block is written to canonical `MessageHistory` **paired with
  all its results**.
- **Invariant:** every provider-returned tool call gets exactly one tool result — even on
  cancel, deny, or skip, the executor injects a synthetic skipped/error result. The provider
  never sees a dangling `tool_use`.

### 2.4 State machine

`TurnPhase`: `idle → processing_input → awaiting_model_response → streaming →
scheduling_tools → executing_tools → aggregating_results → awaiting_permission →
completing → error`. `TurnMachineImpl` validates transitions and throws
`CoreErrorType.InvalidTurnPhase` on an illegal one. The runtime drives it by replacing the
machine at each step; the machine is a passive validator + state holder.

Known gaps (documented, not bugs): the permission phase is driven by the tool executor, not
strictly by `TurnMachine`, so turn phase does not always reflect `awaiting_permission`; the
runtime passes empty `dependsOn` to the scheduler (no model-declarable tool dependencies yet).

### 2.5 Cancellation and recovery

One `turnAbortSignal` threads through the model adapter, tool executor, and every tool context.
Recovery fallbacks inside a model step, in order: execution-selection fallback →
stream recovery with budget → start-plan admission-busy retry with backoff → reactive compact
on context-exceeded (at most once per model step) → persist cancelled stream snapshot.
Streaming tools drain with a 250 ms timeout on abandon and still produce synthetic results.

### 2.6 Steering (input during a running turn)

Two serialization layers:

- **Runtime command queue** — instance-scoped, priorities `now | next | later`, single drain
  gate set synchronously before any `await`. Modes: `prompt`, `target-continuation`,
  `target-continuation-loop`, `task-notification`, `subagent-message`, `control-only-turn`.
  `task-notification` commands coalesce into one model round.
- **Active-turn steering** — `steerTurn` admits into `activeTurn.pendingInputs`. Two lanes:
  `guide` (inline, current turn) and `queue` (future turn).

**Drain boundary rule:** pending input may only be drained after all tool results of the
current batch are injected and before the next model request. User input must never land
between an assistant tool call and its results. Steered input is **volatile** — session resume
does not restore queued-but-undrained input.

### 2.7 System prompt assembly

`core/src/context/builder.ts` builds four ordered buckets:
`system/stable → system/dynamic → meta_user/stable → meta_user/dynamic`.

- `system[0]` — fixed CLI prefix: `You are ZCode, an interactive coding agent`.
- `system[1]` — stable identity block (cache-marked ephemeral).
- `system[2]` — dynamic block: communicating-with-user, session guidance, memory,
  environment, output style, context management, git status.
- `meta_user` attachments — skills listing, resolved `AGENTS.md` / `CLAUDE.md`, project
  memory index, current date.

Tool descriptions are **not** in the prompt — they ride the request `tools` field.

---

## 3. Tool system

### 3.1 The contract

Every tool declares (shared types in `contracts/src/tools/contract.ts`, runtime entry in
`core/src/tool/types.ts`):

```
inputSchema, outputSchema, capability, strict?,
readOnly, destructive, concurrentSafe, requiresUserInteraction,
sideEffectScope, riskLevel, needsApproval,
permission {permission, reason, riskLevel, sideEffectScope, needsApproval,
            patternSources[], alwaysAllowPatternSources?, denyPriority, alwaysAsk?},
resultBudget {maxInlineBytes, maxModelBytes, strategy: inline|truncate|artifact, preview?, artifact?},
timeout {kind: none|timed, defaultMs, maxMs?, allowCallOverride, cleanupGraceMs?},
cancellation {supported, cleanup: none|bestEffort|required, userVisibleMessage},
trace {required, propagateToAdapters, recordInput, recordOutput}
```

`ToolSideEffectScope = "none" | "workspace" | "git" | "network" | "system" | "session" | "userInteraction"`.

Schemas are **derived from Zod** via `contracts/src/tools/json-schema.ts`; JSON Schema is never
hand-maintained. Zod is the only runtime schema source. External/MCP JSON Schema passes the same
normalization.

Business failures return a structured `ToolHandlerFailure` (`{result:false, errorCode, message}`)
rather than throwing.

### 3.2 Built-in tools

Read-only, `sideEffectScope:"none"`: `Read`, `Glob`, `Grep`, `TodoRead`.
Read-only, other scope: `WebFetch` (network, needs approval), `WebSearch` (network),
`AskUserQuestion` (userInteraction), `Agent`/`Task` (session), `Skill` (session),
`TodoWrite` (session), `CronList`.
Side-effecting: `Write` (workspace), `Edit` (workspace), `Bash` (system, risk `high`),
`CronCreate/Update/Delete`, `EnterPlanMode`/`ExitPlanMode` (session),
`OffPeakCreate`, `js`/node_repl (system), `Workflow` (workspace).
Communication: `SendMessage`, `RespondToCoordinator`, `submit_result`, `escalate`.
Dynamic-workflow cluster: `CreateWorkflow`, `AmendWorkflow`, `SaveWorkflow`,
`ListSavedWorkflows`, `ListWorkflowRuns`, `GetWorkflowRun`, `ResumeWorkflowRun`,
`EvalWorkflowSnippet`, `FillWorkflowHole`, `ResolveWorkflowQuestion`, `ListModels`.
Background/task: `TaskOutput`, `TaskStop`. `ApplyPatch` and legacy `Workflow` are declared but
commented out of the default registry.

### 3.3 The tool change chain

The master spec is `docs/design/v2/tool/00-tool-change-chain.md` (1622 lines). Actual executor
order in `core/src/tool/executor/call-runner.ts`:

1. Telemetry span + registry lookup (alias resolution; miss → error result + event).
2. `retainExecution` lifetime lease; merge abort signals.
3. Input normalization (handles stringified-JSON tool input).
4. Initial schema validation.
5. `entry.validateInput` — tool-specific semantic checks (before hooks/permission).
6. `entry.resolveInput` — normalize model input into the execution fact.
7. **`PreToolUse` hooks** — can deny, or rewrite input (then re-normalize + re-validate).
8. **Permission flow** — `resolveToolPermission` → `PermissionService.checkPermission` →
   project rules → memory-file exception → approval gate → permission broker (async client
   negotiation) → `PermissionRequested`/`PermissionResolved` events → persist granted updates.
9. `ToolCallStarted` event with resolved capability flags.
10. Timeout/deadline setup (pausable `ToolDeadline`).
11. **Handler execution** under timeout.
12. **Output validation** — against `runtimeOutputSchema` then `outputSchema`. **Fail-closed**:
    illegal output throws `ToolExecutionFailed`, it is never injected into context.
13. Result serialization / budget / artifact spillover.
14. **`PostToolUse` hooks** (or `PostToolUseFailure` on error).
15. Display projection.
16. Result assembly (`stopTurnOnSuccess` → terminal tool turn-stop).
17. `ToolCallResult` event.
18. Background task tracking.

### 3.4 Registry, scheduler, executor

- `registry.toContracts()` is the model projection. It filters `providerVisible !== false` and
  emits model-facing fields only. Runtime-only fields (timeout details, cancellation, trace,
  result budget internals) stay server-side.
- `ToolScheduler.schedule()` produces `{items, parallelGroups, executionOrder}`. Parallel if
  `concurrentSafe`, or read-only, or `sideEffectScope === "none"`; `destructive` never parallel.
  `DEFAULT_MAX_CONCURRENCY = 10`.
- Timeout is a **pausable wall-clock deadline** — it pauses while the tool's internal model
  request waits at the admission gate.
- **Result budget / artifact spillover:** when serialized output exceeds `maxModelBytes` and
  strategy is `artifact`, the full result is written to the artifact store and the model gets a
  `<persisted-output>` preview. Write failure degrades to truncation — it never fails the tool.

### 3.5 MCP / plugin / subagent tools

All enter the **same** pipeline. MCP tools are built into full `ToolEntry` objects
(`core/src/mcp/index.ts`), named `mcp__<server>__<tool>`, default `sideEffectScope:"network"`,
`needsApproval:true`. Plugin tools arrive only via plugin MCP servers. Subagent child tools run
in their own child executor and mirror `source:"subagent"` events to the parent.

### 3.6 Key constraints

- Large tool results must not go directly into model context — tools self-limit, and
  `resultBudget` is the last backstop. Bash/WebFetch return summary/tail/head or artifact refs.
- Structured media (image/PDF/video) stays structured for the provider; never JSON-stringified
  base64. Aggregate media budget 40 MiB per request.
- Provider-native tools never enter the client executor.
- Tool denylist is fail-closed: removes the tool from both the model-visible list and the
  executable registry.

---

## 4. Context engineering

### 4.1 Compaction

Policy in `core/src/compact/policy.ts`:

- `DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000`
- `DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000`; preflight reserve `21_000`
- `AUTOCOMPACT_BUFFER_TOKENS = 13_000`
- `effectiveContextWindow = contextWindow − min(maxOutputTokens ?? 32k, 21k)`
- `threshold = effectiveContextWindow − 13_000`
- Circuit breaker after 3 consecutive auto-compact failures.

**Yes, it auto-compacts at the context limit** — before *every* model request
(`microcompactIfNeeded` then `autoCompactIfNeeded`), plus a reactive compact after a real
provider overflow (at most once per model step).

Two levels:
- **Microcompact** — clears old tool results only (placeholder `[Old tool result content cleared]`),
  triggers on `time_based` (>60 min idle) or `token_pressure`. Writes a `microcompact_boundary`.
- **Full compact** — model-driven summary. The summary prompt uses **no tools**, requires
  `<analysis>` + `<summary>`, and rejects tool calls. `formatCompactSummary` strips analysis and
  extracts the summary.

Canonical post-compact order:
`compact boundary → compact summary → messages to keep → attachments → hook results`.

**Auditable and persisted.** The summary is stored as a hidden user message with
`semantics.kind = "compact_summary"`; the boundary is a `CompactBoundaryPayload` carrying
`preCompactTokenCount`, `postCompactTokenCount`, `truePostCompactTokenCount`,
`autoCompactThreshold`, `willRetriggerNextTurn`, `lastSummarizedMessageId`, and a
`preservedSegment` (head/anchor/tail). `persistCompactSummary` rolls back every written message
on failure. Interrupted compact timelines are repaired on resume.

Rapid-refill breaker: 3 compactions that refill within fewer than 3 tool turns trips
`model_context_exceeded`.

### 4.2 Memory

Cross-session long-term memory, separate from compact. Root:
`<storage>/memories/projects/<slug>-<sha256[:16]>/memory/`, keyed on
`workspaceIdentity?.trim() || normalizedWorkspacePath`.

Files: `MEMORY.md` (index, no frontmatter) + one `<fact-name>.md` per fact with frontmatter
`name`, `description`, `metadata.node_type: memory`, `metadata.type ∈ user|feedback|project|reference`,
`metadata.originSessionId`.

Retrieval has two branches; a single internal constant selects the active one:
`PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false` → **`default-index`** is active
(reads `MEMORY.md` once at session init, 200 lines / 25k chars, injected as a `# agentsMd`
meta_user reminder). The `semantic-recall` branch (Lite-model selector, top-5) is retained in
code but inactive.

Extraction is **fire-and-forget after a successful Main turn**, skipped for headless
(`-p`/`--target`), remote workspaces, and non-Main task types. One running slot + one latest
pending; cursor is a durable message UUID. The extraction agent loop is capped at 5 model turns
and its tool policy allows only Read/Grep/Glob, read-only Bash, and Write/Edit of `.md` inside
the memory root — MCP/Agent/network are denied.

Consolidation ("Dream") exists (`memory/dream.ts`) but **has no product trigger yet** — no
`/dream` command. Gate would be: 10-min scan throttle, ≥24h since last consolidation, ≥5 newer
transcript sessions, lock file, max 50 turns.

### 4.3 System reminders

Registry: `core/src/system-reminder/source.ts`. All are provider-visible, wrapped as
`<system-reminder>...</system-reminder>` with nested tags escaped.

Three groups: **prefix** (`context_prefix`, `skills_listing`), **persisted** (agent listing
delta, todo reminder, task status, tool-result warning, resume context, plan file reference,
goal state, plugin reference, rewind notice, conversation fork, shell environment change, …),
and **per-request** (incoming message, hook context, memory update, relevant memory,
runtime mode, plan-mode exit, output style, date change, model anomaly, prompt attachment,
diagnostics).

`incoming_message` carries exact texts for `user_steer`, `coordinator_steer`,
`subagent_reply`, and `task_notification` (prefixed `[SYSTEM NOTIFICATION - NOT USER INPUT]`).

### 4.4 Token accounting

- Provider usage is canonical: `ModelUsage {inputTokens, outputTokens, totalTokens,
  cacheReadTokens, cacheWriteTokens, reasoningTokens, serverToolUse}`.
- Local estimate only for planning: `ceil((chinese*2 + other)/3)`.
- Context usage snapshot categorizes `system_prompt | meta_user_context | skills | tool_prompt |
  system_tool_schemas | mcp_tool_schemas | messages`, each with `chars/tokens/tokenMethod/
  confidence/tokenizer`.
- Note: AI SDK v6 Anthropic `inputTokens` already includes cache read/write — compact and
  context accounting must not add cache tokens again.

---

## 5. Permission, modes, sandbox

### 5.1 Two-stage decision

**Stage 1 — synchronous `PermissionService.checkPermission`** (`core/src/permission/service.ts`, 732 lines).
Input: `{toolName, input, riskLevel, mode, planEnabled?, prePlanMode?, workingDirectory?}`.
Output: `{decision: allow|ask|deny, allowed, reason, modifiedInput?, escalated, mode, ruleId,
riskLevel, sideEffectScope?, alwaysAsk?}`. Every decision carries a machine `ruleId`
(e.g. `mode.yolo`, `mode.plan.readOnly`, `rule.project.deny`) plus a human `reason`.

**Stage 2 — asynchronous broker** (`contracts/src/interfaces/permission.port.ts`).
`PermissionBrokerRequest` → `PermissionBrokerResult` with `decision: allow|deny|escalate|modify`.

Evaluation order: plan-mode transition tools → `requiresUserInteraction` → guarded dangerous
command → `alwaysAsk` → yolo/guarded allow → auto deny → disallowed/project rules → plan mode →
project allow / preapproved → edit/build mode.

### 5.2 Modes

| Mode | Behavior |
|---|---|
| `plan` | Allow read-only non-destructive; allow non-destructive MCP; allow `allowedInPlanMode && sideEffectScope==="session" && !destructive && !needsApproval`. Deny everything else. Temporary overlay; `prePlanMode` restored on exit. |
| `build` | Default. Read-only → allow. `critical`/`high` risk → ask. `needsApproval || destructive || sideEffectScope!=="none"` → ask. Session-scope low-risk → allow. |
| `edit` | Legacy/compat: tool `permission==="edit" && sideEffectScope==="workspace"` → allow; else falls back to build. The menu now offers `guarded` instead. |
| `yolo` | Bypasses permission prompts (allow). Still does NOT skip `requiresUserInteraction`, the plan overlay, `alwaysAsk` gates, or plan-mode transitions. Note: yolo's allow precedes `disallowedTools` and project deny for ordinary tools, so it does bypass those. |
| `guarded` | "Autonomous mode": yolo base policy + explicit single approval for dangerous commands. `approvalMode:"user-once"`, not eligible for persistent grant. Subagents inherit parent guarded; `yolo` children are tightened to guarded. |
| `auto` | Reserved, **not implemented** — denies everything with `mode.auto.unimplemented`. |

### 5.3 Request/response and the responder race

Flow: `resolveToolPermission` → `ask` → generate `requestId = "perm_" + uuid` →
`requestPermissionResponse` → `racePermissionResponders`. The broker channel registers
**first** and synchronously; the hook chain runs concurrently. First responder wins; the loser
is aborted immediately.

The race exists because of a **real 2026-08-26 incident**: a synchronous `PermissionRequest`
hook forwarded the request to an external UI and blocked. The broker's deferred response was
registered only after the hook returned, so all clicks during that window were silently dropped
and the turn hung forever. Fix: concurrent race with a single settled latch; hook failure is a
"forfeit" (warn and keep waiting for the broker), not a deny.

**Consequence:** an un-bypassable denial must use a `PreToolUse` hook deny or a permission deny
rule. `PermissionRequest` hooks no longer guarantee precedence over the user's answer.

### 5.4 Bash permission

Real AST parsing via the pure-TS `unbash` parser (`bash-command-parser.ts`, 305 lines).
`isBashCommandPermissionSafe()` requires no parse errors, no unsupported syntax (background,
functions, loops, conditionals, case, here-docs), and no dynamic words (command/process
substitution, parameter/brace/arithmetic expansion). Rationale: `ls $(touch out.txt)` must not
be treated as read-only.

Two independent layers: (a) read-only auto-allow policy, (b) project command-prefix registry
for "always allow". A prefix-registry hit can never promote a command to read-only.

Read-only allowlist v1 is deliberately narrow: `pwd`, `ls`, `tree`, `cat/head/tail/wc/stat/file/strings`,
`rg/grep`. Explicitly **not** `find/sed/awk/jq/yq/git`.

Dangerous-command detection (`handlers/guarded/`): rules for `remove-critical-path`,
`system-storage` (dd/mount/umount/mkfs), `rsync-delete`, git rules (`git-reset-hard`,
`git-clean-force`, `git-push-force`, `git-discard-tree`, `git-stash-clear`,
`git-worktree-force-remove`), `cmd-remove-tree`/`cmd-delete-files`, `find-delete`,
`robocopy-delete`. `HIGH_RISK_ROOT_COMMANDS` never get a prefix rule. Unparseable commands
fail closed to ask.

### 5.5 Approval persistence

Project approvals persist to `local_setting` key `permission/ruleset` (no SQL migration).
Session-scoped rules live only in memory (`PermissionService.sessionRules`). If persisting an
"always allow" fails, the tool fails — the grant cannot be silently forgotten.

### 5.6 Sandbox — NOT implemented

`ExecutionSandboxPolicy {enabled, profile?, dangerouslyDisableSandbox?}` exists on the exec
request, and `Bash` passes it through, but **no adapter consumes it**. A repo-wide grep finds
only comments referring to removal ("after sandbox removal"). It is effectively a no-op
placeholder retained for trace/audit. `sandbox_violation` as a failure type is unused.
(Separately, `core/src/repl/node-repl-session.ts` has a Node `vm` context sandbox — unrelated
to OS command sandboxing.)

### 5.7 Workspace hook trust

Fully specified in `docs/specs/workspace-hook-trust.md` (2757 lines). Project/workspace hooks
are discovered but stripped from the executable config until admitted. Trust is
**per-declaration persistent**, key = `workspace identity + sha256 of canonicalized execution
semantics`. Store: `~/.zcode/security/workspace-hook-trust.json` (never written into the repo).
Soft gate: a pending hook does not block the turn; it is skipped with a persistent banner.
Policy priority: `managed deny > user trust > default deny`. Explicitly **not** an OS sandbox
and **not** merged with tool permission prompts.

---

## 6. Model / provider layer

### 6.1 Important: the docs are stale

`apps/zcode-cli/docs/design/v2/model/*` carries a 2026-08-24 banner stating the mutable AI SDK
Registry, Model Catalog, `models.dev` source, per-`modelId` capability inference, and
`providerOptionsByLevel` projection are **retired**. The authoritative design now lives in
`docs/working-memory/provider-refactor/design/`. The implementation is in
`apps/zcode-cli/packages/adapters/src/model/` (61 files, ~12,880 lines) plus root packages
`packages/provider/`, `packages/provider-node/`, `packages/model-option-map/`.
`core/src/model/` contains only a 14-line helper.

### 6.2 Provider-neutral contract

`contracts/src/model/index.ts` (1078 lines) is the central contract: branded `ModelProviderId` /
`ModelId`, `ModelInputMessage`, content blocks (text/reasoning/image/video/file/resource-link),
`ModelTextRequest`, `ModelTextResult`, `ModelStreamEvent` (discriminated union), `ModelUsage`,
`ModelErrorCode`, `ModelFailureReason`, `ModelRetryReason`.

The public `Model` interface (`contracts/src/model/model.ts`): `generateText`, `streamText`,
frozen `properties` + `optionSpecs`, `bind(options)`.

Model identity is now **`ModelSelection {providerId, modelId, options?}`** (zod, strict) in
`packages/shared/src/model-selection.ts`. Picker value format: `provider/model$reasoningLevel`.
The old free-form `ModelRef` is retired.

### 6.3 Capabilities are declarative rules, not inference

`ModelPropertiesData`: `contextWindow`, `inputFormat {text,image,video,audio,pdf}`,
`outputFormat {text}`, `supportsToolCall`, `supportsJsonSchemaOutput`,
`supportsNativeWebSearch`, `supportsMidConversationSystem`, `requiresMfjsToolSchema`.
`ModelOptionSpecsData`: `reasoningLevel` (ordered enum + map) and `maxOutputTokens`
(limit + map). The `map` is a restricted-CEL expression compiled at schema time.

`ModelConfigRules.resolve()` merges ordered rules: `provider-model` (exact), `manual-provider-model`,
`template-model`, `model` (regex), `model-api` (regex + apiType), `provider-site`
(regex + baseUrl + optional apiType). Built-in rules are data in
`config/provider/zcode-builtin.json` (6391 lines). **Runtime and adapters are forbidden from
re-inferring these fields from a model ID.**

Option maps are applied to the **final serialized JSON body** at the HTTP boundary
(`model-option-map-fetch.ts`) as ordered RFC-7396 merge patches.

### 6.4 Providers

Vercel AI SDK. Three kinds: `openai` (`createOpenAI`), `anthropic` (`createAnthropic`),
`openai-compatible` (`createOpenAICompatible`). `api.type` maps:
`anthropic-messages → anthropic`, `openai-responses → openai`,
`openai-chat-completions → openai-compatible`.

Fetch middleware chain, in order: network proxy → endpoint routing → request security →
business-error detection → option-map patch → kind-specific compat.

Access types are orthogonal to api types: `api-key`, `zhipu-coding-plan-api-key`,
`zhipu-account` (zai/bigmodel with modes start-plan, individual-coding-plan, team-coding-plan,
off-peak, highspeed).

### 6.5 Streaming

- Event-interval idle timeout, default 600 s, +30 s per retry.
- `StreamingToolCallAssembler` assembles `tool_input_start/delta/end` → one normalized
  `tool_call`, deduped by id.
- **Retry-safe prelude:** `start`, `text_start/end`, `reasoning_start/end`,
  `tool_input_start/delta/end`, and zero-length deltas are buffered and discarded on a
  pre-output retry. Once non-empty text/reasoning, a complete `tool_call`, or `finish` is
  emitted, the adapter does not auto-replay — recovery moves to core (`stream_recovery_*`).
- Retry: `maxRetries = 10` → `maxAttempts = 11`, base 2 s, factor 2, max 60 s, jitter.
  **AI SDK internal retries are disabled**; the adapter owns the retry loop.
- HTTP 200 SSE business errors are detected at the frame level (`event: error`, `success:false`,
  non-zero `code`).
- Empty-completion retry: one retry for a zero-output `finish`.

### 6.6 Reasoning

- **Anthropic:** `normalizeReasoningHistory` removes cross-model signed/redacted reasoning,
  orphan reasoning-only assistants, trailing reasoning, whitespace-only assistants. A one-shot
  signature-repair retry handles HTTP 400 "signature in thinking block". `anthropic-stream-compat.ts`
  synthesizes a `signature_delta` when a compat backend puts the signature on
  `content_block_start`.
- **GLM:** reasoning depth now lives entirely in built-in model config rules
  (`optionSpecs.reasoningLevel.map`), not in code branches.
- **OpenRouter:** template uses `api.type: anthropic-messages`; models resolve to
  `thinking: {type:"adaptive"}` + `output_config.effort`; disabled → `thinking.type:"disabled"`.

### 6.7 Attribution headers

`x-request-id`, `x-zcode-trace-id`, `x-session-id`, `x-query-id`, `x-zcode-session-type`
(`main|subagent|side_chat|other`), `x-zcode-query-source`. `turnId`/`spanId`/`parentSpanId`
never go into provider headers.

---

## 7. Sessions, events, persistence, rewind, artifacts

### 7.1 Event sourcing — with a twist

**`SessionEvent` is an in-memory, append-only envelope, NOT a SQLite table.** There is no
`session_event` table in any migration. Only `message`/`part`/`session`/`session_entry`/`todo`/
`permission`/`input_history`/usage tables persist.

- `SessionEvent {id, sessionId, turnId?, type, timestamp, traceId, sequenceNumber, payload}`.
- Implementation: `InMemorySessionEventStore` — per-session state, and `append` assigns the
  authoritative monotonic `sequenceNumber` (never regresses, even after eviction).
- **Retention:** transient types (`model_streaming`, `tool_call_progress`,
  `streaming_tool_ledger_updated`, `model_network_status`) are evicted one turn later
  (sealed on `turn_complete`/`turn_error`, evicted on the next `turn_started`), with a 120 s
  time fallback. Retained `model_request` events have `payload.messages` stripped and replaced
  with `messageCount` (measured ~150 MB linear growth otherwise).
- **Projection:** `EventReducer` maps events → `SessionProjection` (status, turnCount,
  contextUsed, pendingPermissions, activeToolCalls, backgroundTasks, lastCompact,
  lastCheckpoint, lastRewind, target). Projections are rebuildable; they are not the source of
  truth for model context.

**The real source of truth split:**
- Session events → ordering, live updates, projections.
- `message` + `part` tables → **model context**.
- `session_entry` → lightweight durable projection/index. The spec explicitly says: *do not
  restore model context from `session_entry`; restore from `message + part`.*

### 7.2 Storage

Default DB: `~/.zcode/cli/db/db.sqlite` (overridable via `storage.sessionDbPath` /
`ZCODE_SESSION_DB_PATH`). `SqliteSessionStore` (1022 lines), 22 migrations.

Tables from `0001`: `session`, `message`, `part`, `todo`, `session_entry`, `permission`,
`input_history`. Later migrations add title provenance, `session_target`, `session_input` ledger,
`model_usage`/`turn_usage`/`tool_usage`, `trace_id`, `dwf_run/actor/node/event`, provider model
selection.

### 7.3 Session lifecycle

- **Create:** `ensureSessionPersisted` → `sessionStore.createSession` with `directory` =
  `workspacePath ?? workingDirectory`, `workspaceID` = `workspaceIdentity`.
- **Resume** (`resume.ts`, 459 lines): reject archived/missing; load messages; read
  `session.revert` (branch cut); switch cwd; hydrate read-file state + message history
  (branch cut **then** compact boundary); restore workspace checkpoints; append `session_resumed`.
  `--continue/-c` = latest non-archived root session in cwd. Running state (busy/cancel/shell)
  is **not** persisted.
- **Fork** (`session-fork.ts`, 1498 lines): builds a message prefix and commits atomically via
  `sessionStore.commitForkBundle` (child session + messages + entries + goal + initial input +
  command fact, all-or-nothing). Child copies regenerate message/part IDs to avoid PK collision.
- **Idle deactivation** (`SessionResidentPool`): target 8 resident, high-water 16, idle 10 min.
  Invariant: `DEACTIVATED` ≡ "this CLI process never loaded the session". No `session.removed`
  event. Rebalance runs on lease release and the existing 60 s sampler.
- **Crash recovery by replay:** assistant messages without `time.completed` → interrupted;
  `running` tool parts → stale. On resume, dangling tool parts become a failed
  `INTERRUPTED_TOOL_RESULT` so the provider never sees a dangling `tool_use`.

### 7.4 Rewind

**History is never deleted.** Conversation rewind writes a session-level branch cut instead.

- `RewindScope = conversation | workspace | both`.
- `RewindStrategy = active_chain | file_only | fork_required | unavailable`.
- `applyConversationRewindPlan` cancels removed-branch background tasks (fail-closed), calls
  `setRevert({keptMessageIDs, branchCutAfterMessageID, branchGeneration, kind:"conversation_rewind"})`,
  rebuilds derived state, appends `rewind_triggered`. No message rows are deleted.
- **File rewind is safe-by-hash:** the plan reads each file's current SHA-256 and compares to
  the checkpoint's `afterContent` hash. Any mismatch → `external_modified` → nothing is applied.
  Unsafe reasons: `checkpoint_missing | checkpoint_unreadable | external_modified |
  file_read_failed | unsupported_checkpoint`. Multi-file writes are journaled and compensated in
  reverse on failure. Bash/shell checkpoints are ignored.
- `evaluateRewindTarget` returns `file_only` for compact-covered workspace targets, and
  `active_chain` for conversation targets (append-only history means the branch cut can rebuild
  compact scope — no forced fork).

### 7.5 Artifacts

`ToolArtifactStorePort`. Retention: `session | project | temporary`. Files at
`<storage>/cli/artifacts/<sessionId>/<toolCallId>-tool-result-<uuid><ext>`, URI scheme
`zcode-artifact://`. Binary read exists specifically so office files (`.xlsx/.docx/.pptx`) are
not corrupted by text decoding.

Workspace checkpoints are artifacts too, content type
`application/vnd.zcode.workspace-checkpoint+json`.

Media: DB stores only `FilePart` references + `AttachmentStorageMetadata` (sizeBytes, sha256,
storageKind, recoverability, artifactUri). **`FilePart + artifact` is the cross-provider source
of truth; base64 is request-local only.**

### 7.6 Workspace identity vs path

`workspaceIdentity` = opaque isolation key. `workspacePath` = filesystem path, command cwd, git.
Identity key everywhere: `workspaceIdentity?.trim() || workspacePath`.

Remote identity formats:
`remote:ssh:<host>:<port>:<user>:<posixPath>`, `remote:wsl:<distro>[:<user>]:<posixPath>`,
`remote:docker:<container>:<posixPath>`, `remote:server:<serverId>:<posixPath>`.
The `remote:` namespace is fail-closed.

**Multi-workspace is NOT shipped** — `multi-workspace.md` is a Phase 0–4 draft proposing
`WorkspaceScope`/`WorkspaceRoot` and `--add-dir`; `arguments.ts` has no `--add-dir` and the
runtime still uses a single `workingDirectory`. Process-level isolation *is* real via
`workspaceKey`.

---

## 8. Extensibility

### 8.1 Subagents

Model-visible tool name is **`Agent`** (alias `Task`). A subagent is **not an OS subprocess** —
it is a new in-process child execution context with its own query loop.

- Execution forms: fresh, fork (byte-identical inherited history/system prompt/tool array for
  prompt-cache reuse), background, worktree, remote (unsupported), teammate spawn.
- Lifecycle: `core/src/subagent/runner.ts` (2145 lines). `agentId = agent_<uuid>`,
  `childSessionId = subagent_<agentId>`, artifact dir `<tmpdir>/zcode-agents/<sessionId>/<agentId>/`.
- Guardrails: an **activity watchdog** reuses the model-stream idle timeout; an **abort guard**
  listens to the parent signal so `Agent` cannot hang; sync→background auto-background timer.
- **Recursion is structurally blocked:** the child runtime is constructed with
  `subagents: { enabled: false }`. Plan-mode tools are forced out of every child. Fork children
  additionally check `querySource` + a fork boilerplate tag.
- **Mailbox is point-to-point, not a global bus:** `SendMessage` (parent/main only, targets an
  addressable `local_agent`) and `RespondToCoordinator` (child only). Pending messages drain at
  the next tool-round boundary.
- **Wake** = enqueue `<task-notification>` into the parent command queue; the parent drains
  before the next model request — never between an assistant tool call and its result.
- Child MCP access is a **fixed startup snapshot** borrowed from the parent.

### 8.2 MCP

Transports `stdio | http | sse`. Names `mcp__<server>__<tool>`. Config merge:
system < user `~/.zcode/cli/config.json` < discovered project configs (root→cwd) < explicit
project path < `ZCODE_*` env < CLI/session.

**Trust gate:** project-origin servers are marked `untrusted` and excluded from startup
auto-connect; headless fails closed; `/mcp connect <server>` is the per-process approval. This
is separate from per-tool-call permission.

OAuth supported: `client_credentials` and `authorization_code`. Official CUA trust requires
unforgeable product authority — the reserved rule key alone cannot be forged by a same-named MCP
tool.

### 8.3 Hooks

P0 events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PostToolUseFailure`, `Stop`. (P1 candidates like PreCompact/PostCompact, SubagentStart/Stop,
ModelRequest/Response are **not** implemented.)

Input via stdin JSON; stdout parsed as `HookJSONOutput` (`continue`, `decision`,
`hookSpecificOutput.permissionDecision`, `updatedInput`, `additionalContext`, …).
Decision precedence: **deny/block > ask > allow > passthrough**. `updatedInput` is re-validated
against the schema; last valid wins. Stop continuation capped at 3.

Hook types: `process` (command + args, no shell) and `command` (explicit shell, Claude-compat).
Default `timeoutMs` 60 s, `maxOutputBytes` 32768. **Admission is re-evaluated before each hook
dispatch, never cached** — revoke/policy-tighten takes effect immediately.

### 8.4 Skills

A skill is a directory with `SKILL.md` (YAML frontmatter: `name`, `description` required;
optional `when_to_use`, `license`, `metadata`) plus optional `references/`, `scripts/`, `assets/`.

**Two-layer load:** metadata discovery at turn init (name/description/source/scope/path only) →
content load only when the model calls the `Skill` tool. Bodies are never inlined into context.

Roots: configured → `~/.zcode/skills` → `~/.agents/skills` → project `.zcode/skills` /
`.agents/skills` walking cwd→worktree-root → plugin roots. Same-name resolution: first
discovered wins; user shadows project. Budget: 20 000 chars for the listing, 250 chars per
description, falls back to names-only.

Bundled skill pack: `packages/bundled-skills/skills/` (source `bundled`, cannot be disabled).

### 8.5 Plugins

Plugin id = `<plugin-name>@<marketplace>`. Manifest discovery reads the first existing of
`.zcode-plugin/plugin.json` then `.claude-plugin/plugin.json` (Claude Code field names).

A plugin can contribute: `skills`, `commands`, `mcpServers` (inline or `.mcp.json`), `agents`
(from `agents/*.md`), `hooks` (trusted official/inline only), `userConfig`, and `ui.surfaces[]`
(session-scoped MCP UI panels).

Variable expansion: `${CLAUDE_PLUGIN_ROOT}`, `${ZCODE_PLUGIN_ROOT}`, `${*_PLUGIN_DATA}`,
`${*_PROJECT_DIR}`, `${user_config.KEY}`. A missing value disables only the affected MCP server.

Official bundled plugins are workspace packages seeded into the cache. No hot-reload — the next
session start picks up changes.

### 8.6 Custom commands

Markdown in `.zcode/commands/**/*.md`, `.agents/commands/**/*.md`, `.claude/commands/**/*.md`.
Basename = name; subdirs become colon namespaces (`frontend/review.md` → `/frontend:review`).

Frontmatter: `description`, `argument-hint`, `allowed-tools`, `model` (`main|lite|provider/model`,
one turn), `disable-noninteractive`, `skills`.

Expansion: `$ARGUMENTS` → raw tail; `$1`, `$2`… → positional via an own quote-aware parser
(**never a shell**). If no placeholder is used and args are supplied, they are appended.
Fails closed on `` !`command` `` / fenced shell syntax.

### 8.7 Dynamic workflows (the most unusual feature)

"The model writes a program instead of having a conversation." The model writes TypeScript
against an embedded `.d.ts` facade; the harness recovers types, JSON schemas (from `ask<T>`),
a dependency graph (static analysis), identity (sites), and durability (journal).

Facade: `agent(name?, persona?)` → `Agent.ask<T>(instructions): Node<T>`, `report()`,
`artifact.{file,markdown,chart,table,metrics,board}`, `phase()`, `files.{glob,read,grep}`,
`git.{changedFiles,diff,status,log}`, `world.run(cmd, args?, opts?)`, `log()`, `args`,
`hole()`, `stream`, `model()`.

- Compiler does a virtual-host typecheck against the facade.
- Lowering strips types and instruments `__host` site IDs.
- Engine is a pure `WorkflowEngine` + `AskScheduler` with an in-memory journal and a
  concurrency governor.
- Each `ask` becomes a subagent session turn (FIFO per subagent), journaled **before** display.
- Child process talks NDJSON over a wire protocol; process isolation only — **no sandbox
  security promise**.

Rigor constraints: facade calls must be direct calls; `world.run` cmd must be a compile-time
string literal; the static graph is complete before any node runs; the journal is truth; caps
fail loudly. **No token budget and no node cap.** The confirmation window appears in **every**
permission mode (`alwaysAsk: true`). `CreateWorkflow` requires the `dynamic-workflows` skill to
be loaded first.

---

## 9. Application layer

### 9.1 Entry

`cli/src/main.ts` (122 lines) runs before importing anything heavy: sets process title
`zcode-cli`, sanitizes env, installs a stderr boundary for protocol/TUI invocations so a stray
`console.log` cannot corrupt the JSON frame channel, then dynamically imports `run.js`.

`cli/src/run.ts` (611 lines): `node:util` `parseArgs` strict. Bare `zcode` → TUI.
`--prompt/-p` → headless `runPrompt` (default permission mode **yolo**).
`--target` → headless `/goal` command. `app-server` → the protocol server.
Commands: `doctor`, `login`, `logout`, `commands`, `plugins`, `skills`, `hooks`, `tui`, `help`,
`version`.

`bootstrap/src/app/create-app.ts` (1407 lines) is the composition root: instantiates
`AgentRuntime`, `PermissionService`, and every adapter (exec, fs, http, image, pdf, context
source, skill, mcp, session mailbox, storage, logger).

### 9.2 TUI — OpenTUI, not Ink

**Discrepancy:** `docs/design/v2/ink-tui-renderer.md` mandates Ink, but the shipped renderer
uses `@mbears/opentui-core` + `@mbears/opentui-react` (pinned 0.2.15) with React 19. There is
no `ink` dependency. The *design intent* still holds — presentation-only renderer,
controller-owned state.

The TUI **does not own** session/business state. It owns draft text, cursor, scroll offset,
hover/focus, panel expansion, the approval/clarification queue projection, and optimistic
overlays. Keyboard-first: Enter submits, Shift+Enter newline, Up/Down recall input history,
PageUp/PageDown scroll transcript, Ctrl+C needs two presses, Escape never exits.
`SIGPIPE` is deliberately excluded from exit signals so closing MCP pipes cannot kill the TUI.

### 9.3 Protocol

**Transport:** stdio NDJSON. `Renderer --MessagePort RPC--> Host Process --stdio NDJSON--> zcode-cli app-server`.
Frames split only on LF (`0x0a`); trailing CRLF tolerated but frame content is never rewritten.
(stdout client-side deliberately does not use `readline` because U+2028/U+2029 would split valid
JSON.)

Message shapes: `{id, method, params?, trace?}` request, `{method, params?, trace?}`
notification, `{id, result}` response, `{id, error}` error.

Server processes requests through a **serial queue** except a bypass list — `session/stop`,
`workspace/cancelGenerateText`, and MCP-app methods — so cancel can reach the server while a
model turn holds the queue.

Reverse requests (agent→client) use `requestClient()` with `id: "server-N"`, abort, timeout, and
periodic re-announce (capped at 10 s). **Permissions go over the protocol as reverse requests:**
`interaction/requestPermission` and `interaction/requestUserInput` (the design doc's
`session/request_permission` name is not the wire method).

**Protocol V4** is the conversation product protocol on the same transport: topic subscription
(`conversation/<sessionId>`), `delta(fromSeq, toSeq]` or `snapshot + deltas`, strict seq
application, gaps trigger resubscribe. Writes go through a `v4/command` envelope with stable
`commandId`; the CLI's `CommandInbox` does idempotency/epoch/CAS arbitration; ACK ∈
`accepted|rejected|stale|duplicate|noop|failed`.

Wire limits: frame ≤1 MiB, logical frame assembly ≤16 MiB, attachment ≤20 MiB (chunk ≤512 KiB),
tool output head/tail ≤32 KiB each, rows range ≤200, subscriber buffer ≤1 MiB.

### 9.4 Desktop integration

`ZCodeAgentProcessManager` (1484 lines) owns **one agent process per `workspaceKey`**, spawned
on demand, deduped via `startingByWorkspaceKey`. Command resolution priority:
`ZCODE_AGENT_SERVER_COMMAND` env → monorepo dev → Electron Node runtime
(`ELECTRON_RUN_AS_NODE=1`) → deployed native binary. Args: `[entrypoint, "app-server", "--stdio"]`.

Electron main forks the Host as a `utilityProcess`. `WindowHostAttachmentRegistry` manages
attachments; `clientMode` (`desktop-continuous` | `web-remote-replayable`) is **injected by the
trusted host**, not chosen by the UI. Mobile `/remote` only attaches an existing Host/CLI — it
never creates an independent agent runtime.

### 9.5 Logging and observability

Three layers: Session Event (recoverable fact), Structured Log JSONL (diagnostic index), Trace
Span (timing/call chain).

- Levels are **not** set by env var. `ZCODE_LOG_LEVEL` is explicitly ignored; `NODE_ENV` is
  deliberately not used. Default `debug` in development, `info` otherwise.
- `ZCODE_LOG_DIR` overrides the dir (default `~/.zcode/cli/log`, file `zcode-YYYY-MM-DD.jsonl`,
  local calendar day). Keep last 7 local days.
- Redaction defaults: `apiKey`, `token`, `authorization`, `cookie`, `password`, `secret`,
  `credential`. Error logs preserve the cause chain.
- High-frequency events are aggregated, not written raw. Daily logs must not contain full
  protocol messages, stream deltas, tool input/result, stdout/stderr tails, or headers.
- Debug app: dev-only React+Vite+Hono reading JSONL logs, `db.sqlite`, and session-event JSONL,
  plus a local HTTP(S) MITM proxy. Channels include `context.built` and
  `context_usage_snapshot`.

---

## 10. Design patterns worth studying

1. **Event-first, projection-second.** Facts are append-only; UI state is derived and
   disposable. Sink failure never rolls back a fact.
2. **Resource-bounded, not iteration-bounded.** Refusing a tool-call cap is a deliberate stance
   for long-horizon tasks.
3. **Contract-declared side effects.** Tools declare their blast radius; permission, scheduler,
   and audit read the declaration instead of guessing at call sites.
4. **Fail-closed everywhere.** Deny broker by default, output-schema validation failure is an
   error, unparseable bash → ask, unsafe file rewind → no-op, hook preview failure → ask.
5. **Pausable timeouts.** Tool deadlines pause while waiting on an admission gate — timeouts
   measure work, not queueing.
6. **Dangling-call prohibition.** Every `tool_use` gets exactly one `tool_result`, even on
   cancel/deny, so replay and resume stay valid.
7. **Two-phase permission with a race.** Synchronous policy first, async human/agent negotiation
   second, with concurrent responders and a single settled latch.
8. **Safe-by-hash file rewind.** Content hashes gate destructive restoration.
9. **Two-layer skill loading.** Metadata always in context; bodies only on demand.
10. **Structural recursion prevention.** A child runtime literally cannot spawn children
    (`subagents.enabled = false`), rather than relying on prompt discipline.

---

## 11. Doc-vs-code discrepancies (research findings)

These matter if you plan to trust the specs:

1. **TUI library:** `ink-tui-renderer.md` says Ink; the code uses OpenTUI.
2. **Permission wire method:** docs say `session/request_permission`; the implementation uses
   `interaction/requestPermission`.
3. **Model layer docs are retired** — the whole `docs/design/v2/model/*` set is superseded by
   `docs/working-memory/provider-refactor/design/`.
4. **`multi-workspace.md` is a draft**, not shipped. No `--add-dir`.
5. **Sandbox is a no-op placeholder** despite the contract field and CLI flag.
6. **Memory semantic recall is disabled** by a hardcoded constant; only the index branch runs.
7. **Dream consolidation has no product trigger.**
8. **Session events are in-memory, not persisted as events** — only `message`/`part` and typed
   `session_entry` rows survive a restart.
9. **Legacy and V4 protocols coexist**; `packages/shared/src/zcode-protocol/index.ts` is a
   shrinking compatibility surface.
10. **`auto` collaboration mode is unimplemented** and denies everything.

---

## 12. Where to go deeper

- **Tool change chain** — `docs/design/v2/tool/00-tool-change-chain.md` (1622 lines) is the
  single best document in the repo.
- **Agent loop** — `docs/design/v2/loop/tool-calling-loop.md` and `loop/architecture.md`.
- **Provider refactor** — `docs/working-memory/provider-refactor/design/`.
- **Dynamic workflows** — `docs/dynamic-workflow.md` + `docs/dynamic-workflow/*` (authoring is
  1408 lines, launch is 2833).
- **Protocol V4** — `docs/conversation-product-protocol.md` (840 lines).
- **Hook trust** — `docs/specs/workspace-hook-trust.md` (2757 lines).
- **Open question:** how `core/src/runtime/methods/steering.ts` (1417 lines) interacts with the
  V4 queue ops under concurrent clients is the least-documented high-complexity area found.
