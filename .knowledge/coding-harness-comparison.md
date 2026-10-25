# Coding Harness Comparison — ZCode vs opencode vs OpenAI Codex

Date: 2026-10-14
Method: shallow clone + source reading of all three. Read-only.
Companion to `zcode-coding-harness-research.md`.

---

## 0. At a glance

| | **ZCode** | **opencode** | **OpenAI Codex** |
|---|---|---|---|
| Repo | `apps/zcode-cli` in a private monorepo | `anomalyco/opencode` | `openai/codex` |
| Language | TypeScript | TypeScript | **Rust** |
| Runtime | Node 24 | **Bun** | native binary |
| License | Apache-2.0 | MIT | Apache-2.0 |
| Version at study | zcode-cli 0.16.9 | 2.0.29 | HEAD (Oct 2026) |
| Stars (GitHub API) | private | 213,434 | 129,191 |
| Default branch | — | `dev` | `main` |
| Scale | ~130k lines (contracts+core), ~778k total | ~40 packages | **~150 crates** |
| Signature library | none (plain TS) | **Effect v4** | tokio/async Rust |
| TUI | OpenTUI | OpenTUI + SolidJS | **ratatui** |
| **OS sandbox** | ❌ no-op placeholder | ❌ none | ✅ **all 3 platforms** |

---

## 1. opencode (anomalyco/opencode)

### 1.1 Shape

Bun workspace monorepo + Turborepo, infra on SST. ~40 packages. The load-bearing ones:

- `packages/schema` — dependency-free Effect Schema contract root (events, session, tool, model, provider, config).
- `packages/core` — the harness: session, agent, tool, permission, provider, model, MCP, plugin, database.
- `packages/protocol` — an Effect `HttpApi` (REST + SSE), ~139 endpoints, OpenAPI at `/openapi.json`.
- `packages/server` — the HTTP server that mounts the API and wires the service graph.
- `packages/client` — **generated** clients (Promise + Effect) from the `HttpApi`.
- `packages/sdk` — composes Client + Core + Server.
- `packages/tui` — OpenTUI + SolidJS, an HTTP client.
- `packages/codemode` — a confined JS interpreter.
- `packages/ai` — a from-scratch replacement for the Vercel AI SDK.

Enforced dependency direction: `Schema → Core/Protocol → Server`. Client runtime may use Schema and Protocol but **never** Core or Server.

### 1.2 The agent loop — the most distinctive design

`packages/core/src/session/runner/llm.ts`. The root `AGENTS.md` states the rule outright:

> **"Each step is one explicit `llm.stream` call that continues from reloaded history. Do not add an in-memory tool loop."**

So the loop is:

1. `drain()` — outer loop over a durable **inbox**. `advanceToStep()` promotes inbox work (user input, steer, compaction, move) and rebuilds context from the database.
2. `runStep()` — one `llm.stream` call. Tool calls are executed **inline in parallel fibers during the stream**.
3. After the step, history is **reloaded from SQLite** and the next step starts. There is no in-memory conversation.

Termination: the step returns `needsContinuation`, true only when a locally-executed tool was called. **No max-iteration cap** unless an agent sets `steps`. Output-limit continuations capped at 2. Retry: exponential 2s→10s, ~10 attempts.

**Prompt admission is separated from execution.** `Session.prompt` writes a durable `session_inbox` row and rings an advisory "doorbell"; a separate `SessionExecution` fiber consumes it. This is a cleaner separation than ZCode's in-memory steering state — opencode's queued input survives a restart, ZCode's does not.

### 1.3 Agents as permission presets

An agent is not a tool list. `Agent.Info` = `{ model, system, mode, steps, permissions: Ruleset }`. Tools come from the registry filtered by `merge(agent.permissions, session.permissions)`.

Built-ins are registered by **plugins**, not config files: `build` (default, full access), `plan` (read-only: denies `edit` except under `~/.opencode/plan`), plus hidden `compaction`, `title`, `summary`, and subagents `general` and `explore` (deny-all then allow shell/grep/glob/webfetch/websearch/read).

Mode switching publishes `session.agent.selected`; the Plan plugin injects an enter/leave `<system-reminder>` and **reconciles it per request** because compaction or revert can strip it.

### 1.4 Tool contract

```ts
Info = {
  name: string
  input: ValueSchema      // Effect Schema | Standard Schema (zod v4) | raw JSON Schema
  output?: ValueSchema
  description: string
  execute: (input, context) => Effect<Result, Error>
  options?: { namespace?, permission?, codemode?, pinned? }
}
```

Notable: the schema is **polymorphic** — you may declare with Effect Schema, zod, or plain JSON Schema. `read`, `edit`, `write`, `patch`, `shell`, `grep`, `glob`, `subagent`, `question`, `skill`, `webfetch`, `websearch` are pinned native; everything else is wrapped behind a single CodeMode `execute` tool.

**CodeMode** is a genuine differentiator: `packages/codemode` is a pure interpreter for a JS-like language (2334-line interpreter). The model writes one program that calls many tools, instead of one tool call per round trip. It has no network, filesystem, process, or import access — only the declared tools plus a `fetch` extension.

### 1.5 Permission

Ruleset = `[{ action, resource, effect: allow|deny|ask }]`, matched last-wins by wildcard. **Default when unmatched is `ask`.** Deny short-circuits. `assert()` awaits a `Deferred` for `ask`.

A sharp detail: a **user decline travels as an Effect defect** (`Effect.die`), not a typed error, so that a leaf tool's `mapError` cannot accidentally convert "the user said no" into a model-visible tool result. A decline *with feedback* becomes a typed `CorrectedError` so the model can continue.

### 1.6 Snapshots and undo

`snapshot.ts` + `git.ts` (1403 lines). opencode creates a **separate content-addressed git repository** at `~/.opencode data/snapshot/<projectID>/<hash>` and captures git tree hashes of the worktree. Undo restores selected paths from a tree. This is a cleaner undo model than ZCode's per-file checkpoint artifacts.

### 1.7 Persistence

Drizzle ORM over SQLite (WAL). **Event-sourced**: durable events in an `event` table keyed `(aggregate_id, seq)`, projected into `session_message` / `session_inbox` read models. Streaming deltas are `ephemeral`; terminal events are `durable`. The `AGENTS.md` rule: *"durable events record only irreducible new facts and do not repeat state derivable by folding."*

### 1.8 Compaction

`session/compaction.ts` (963 lines). Ceiling = `window − max(floor(window*0.1), 16000)`. Triggers: `auto`, `overflow`, `manual`. Keeps the newest ~15,000 tokens **verbatim** as `<recent-context>` and splits the rest into a structured summary (Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important Context). Supports **native provider compaction** (opaque encrypted window, replay-only) for providers that offer it.

**No long-term memory system.** Instruction files (AGENTS.md) tracked with hashed blobs and epochs play that role.

### 1.9 No OS sandbox

Confirmed absent. What exists instead: path containment (anything outside the location is "external" and needs approval), CodeMode confinement, protected-path lists, and remote workspace containers. Locking is explicitly process-local with a comment admitting external writes can race.

---

## 2. OpenAI Codex

### 2.1 Shape

A Rust workspace of ~150 crates under `codex-rs/`. There is no small portable core — the harness is spread across `core`, `tools`, `protocol`, `sandboxing`, `execpolicy`, `shell-command`, `network-proxy`, `rollout`, `history`, `thread-store`, `tui`, `app-server*`, `codex-mcp`, `rmcp-client`, `skills`, `memories`, `plugin`, `core-plugins`, `otel`, `cloud-*`.

### 2.2 The agent loop

Three nested loops:

- **Task loop** (`tasks/regular.rs`) — restarts a turn only if the user steered input.
- **Turn loop** (`session/turn.rs`, **3330 lines**) — pre-sampling compaction, then `loop { build input → sample → if needs_follow_up continue else break }`. Token-limit rollover is a **loop continuation, not a termination**.
- **Sampling loop** (`try_run_sampling_request`) — consumes the response stream, pushes each tool call onto a `FuturesOrdered` set, then `drain_in_flight` awaits them in order.

Termination is purely `needs_follow_up` plus token budget. The comment at `turn.rs:675` is explicit:

> *"as long as compaction works well in getting us way below the token limit, we shouldn't worry about being in an infinite loop."*

Same stance as ZCode and opencode: **no max-iteration cap**.

### 2.3 Tool system

Traits, not enums:

```rust
trait ToolExecutor<Invocation> {
    fn tool_name(&self) -> ToolName;
    fn spec(&self) -> ToolSpec;
    fn exposure(&self) -> ToolExposure;   // Direct | Deferred | CodeModeOnly | Hidden
    fn supports_parallel_tool_calls(&self) -> bool;
    fn handle<'a>(&'a self, invocation: Invocation) -> ToolExecutorFuture<'a>;
}

trait ToolRuntime<Req, Out>: Approvable<Req> + Sandboxable {
    async fn run(&mut self, req, attempt: &SandboxAttempt, ctx) -> Result<Out, ToolError>;
}
```

The execution pipeline is one orchestrator (`tools/orchestrator.rs`) with a documented contract: **approval → select sandbox → attempt → retry with an escalated sandbox on denial** (no re-approval, thanks to caching).

Tools include `exec_command` / `write_stdin` (resumable process), MCP resource tools, `apply_patch`, `update_plan`, `request_user_input`, `request_permissions`, `view_image`, `clock`/`sleep`, plugin install, and two generations of multi-agent collaboration tools (`spawn_agent`, `send_message`, `wait_agent`, `interrupt_agent`, `list_agents`).

### 2.4 `apply_patch` — a deliberate non-JSON tool

A **FREEFORM** tool with its own Lark grammar, not JSON. The system prompt says: *"Use the `apply_patch` tool to edit files (NEVER try `applypatch` or `apply-patch`, only `apply_patch`)"* and *"Do not waste tokens by re-reading files after calling `apply_patch`... The tool call will fail if it didn't work."*

Why it exists: atomic multi-file edits, context-anchored hunks, a grammar the model is trained on, and a pre-computable unified diff for approval. There is also a standalone `apply_patch` executable so the model can shell out when the custom tool is not exposed.

### 2.5 Sandboxing — the standout feature

Real, enforced, on all three platforms.

| Platform | Mechanism |
|---|---|
| macOS | **Seatbelt** (`sandbox-exec` with generated SBPL, `(deny default)`) |
| Linux | **bubblewrap** (`--ro-bind / /` by default) + **seccomp** BPF filter |
| Windows | **Restricted token / AppContainer + ACL**, plus a second **MXC** container backend |

Policy is a two-layer model: canonical `PermissionProfile` (`Managed { file_system, network }` | `Disabled` | `External`) projected to a legacy `SandboxPolicy` enum for compatibility. Presets: `:read-only`, `:workspace`, `:danger-full-access`.

Details worth noting:

- **Protected metadata carveouts.** `.git`, `.agents`, `.codex`, `.aws` stay read-only even inside writable roots — this blocks the classic `.git/hooks` privilege escalation.
- **Seccomp** denies network syscalls in Restricted mode, always denies `ptrace`, `process_vm_readv/writev`, and `io_uring_*`.
- **Root-anchor deny** prevents replacing the authority boundary directory itself.
- **Managed-network sessions stay fail-closed even under `DangerFullAccess`.**
- Legacy Landlock is deprecated because it cannot isolate app-server Unix sockets.
- WSL1 is rejected for bubblewrap.

### 2.6 `execpolicy` — Starlark rules for command approval

A standalone crate and CLI. Users write **Starlark** (not a bespoke DSL) declaring command prefixes:

```python
prefix_rule(pattern=["git","reset","--hard"], decision="forbidden",
            justification="destructive operation")
network_rule(host="api.example.com", protocol="https", decision="allow")
host_executable(name="python3", paths=["/usr/bin/python3"])
```

Decision = strictest across all matched rules (`allow < prompt < forbidden`). Resolution order: exact first-token match → host-executable basename fallback → heuristics fallback. `match`/`not_match` fields are load-time unit tests. Approved "remember this" amendments append real rules to `$CODEX_HOME/rules/default.rules`, and **dangerous prefixes (shells, python, node, rm, sudo, powershell) are never suggested as amendments.**

This is the most sophisticated command-approval design of the three.

### 2.7 Network proxy

A local HTTP + SOCKS5 proxy with domain allowlisting (allowlist-first, deny wins, global `*` rejected), private/loopback IP blocking, **HTTPS MITM** with hooks (`strip_auth`, path-prefix matching), and a **credential broker** that injects upstream secrets at the proxy so they never enter the child environment.

### 2.8 Compaction

`compact.rs` (924 lines). Trims from the **beginning** specifically to preserve the prompt-cache prefix and keep recent messages intact. Keeps all user messages up to 20,000 tokens, appends a summary. Phases: PreTurn, MidTurn, PostTurn, StandaloneTurn. Emits a user-facing warning that long threads and multiple compactions reduce accuracy.

### 2.9 Persistence — "rollout"

Sessions are append-only **JSONL rollout files** under `~/.codex/sessions`, with a SQLite index for querying. `RolloutItem` variants include `SessionMeta`, `ResponseItem`, `Compacted`, `TurnContext`, `TokenUsageRecord`, `WorldState`, `SecurityRiskScore`, `EventMsg`, `InterAgentCommunication`. `InitialHistory` = `New | Cleared | Resumed | Forked`. A deliberate quirk: `RolloutLine` does **not** implement `Deserialize`, forcing readers through the canonical parser to survive `arbitrary_precision` decimals.

### 2.10 Protocol and clients

An **app-server** with a line-delimited JSON-RPC-style protocol — deliberately *not* strict JSON-RPC 2.0 (no `jsonrpc` field). Transports: stdio (default), unix socket, websocket. Types are generated to TypeScript and JSON Schema via `ts_rs` + `schemars`. The TUI (ratatui) is a client, not the owner. There is also an **app-server daemon** for detached SSH/desktop/mobile use, and an in-process client that keeps the JSON-RPC envelope to avoid "a second execution contract."

The TypeScript SDK (`sdk/typescript`, `@openai/codex-sdk`) does **not** use app-server: it spawns the CLI and exchanges JSONL over stdin/stdout.

### 2.11 Extras

**Guardian** — a separate reviewer agent with its own context budget that assesses risky actions. **Memories** — a two-phase extraction/consolidation pipeline with a git-baseline workspace. **Process hardening** — a pre-`main` constructor that blocks ptrace and core dumps on every platform. **Skills** (SKILL.md), **plugins** (marketplace with bundles), **hooks** (12 events), **cloud tasks** (Codex Web integration over gRPC).

---

## 3. Three-way comparison

### 3.1 Agent loop

All three converge on the same core shape: call model → stream → execute tool calls → feed results back → repeat until no tool calls. **None has a max-iteration cap.** All three bound the loop with context/token limits, cancellation, retries, and permissions instead.

They differ in how the loop is anchored:

| | Loop anchor |
|---|---|
| ZCode | In-memory message history + turn-local request entries |
| opencode | **Durable inbox row**; each step reloads history from SQLite |
| Codex | `ContextManager` transcript with copy-on-write `Arc` snapshots |

opencode's is the most restart-resilient by construction. ZCode's is the most explicit about the tool_use/tool_result pairing invariant. Codex's is the most optimized for prompt-cache stability.

### 3.2 Tool contract

| | Declaration style |
|---|---|
| ZCode | Zod → derived JSON Schema; declares readOnly/destructive/concurrentSafe/sideEffectScope/riskLevel/resultBudget/timeout/cancellation/trace |
| opencode | Effect Schema **or** zod **or** raw JSON Schema; declares name/input/output/execute/namespace/permission/codemode |
| Codex | Rust trait `ToolExecutor` + `ToolRuntime`; read-only is enforced behaviorally via `Sandboxable::sandbox_preference`, not a flag |

ZCode has the **richest declaration surface**. Codex has the **strongest enforcement** — read-only is a sandbox property, not metadata the permission layer trusts.

### 3.3 Safety — the biggest divergence

| | Permission | OS sandbox | Command analysis |
|---|---|---|---|
| ZCode | 6 modes; two-stage policy + broker race; project/session grants | ❌ none (placeholder) | `unbash` AST + read-only allowlist + dangerous-command rules |
| opencode | Ruleset with wildcard match; default `ask`; declines as defects | ❌ none | tree-sitter bash/PowerShell **and** a 2409-line hand-written scanner |
| Codex | 4 approval modes + Granular; session/persistent/network rules | ✅ **Seatbelt / bubblewrap+seccomp / Windows token+MXC** | tree-sitter AST + **Starlark `execpolicy`** + network proxy + MITM + credential broker |

**Codex is in a different class on safety.** ZCode and opencode both parse commands and ask the user; only Codex actually constrains what a spawned process can do. If your threat model includes a model that writes a bad command and you click "allow", only Codex contains the blast radius.

### 3.4 Context management

| | Compaction | Long-term memory |
|---|---|---|
| ZCode | Auto at threshold + reactive + microcompact; boundary persisted as an event | Yes — `MEMORY.md` + per-fact files, extraction after each turn (semantic recall currently disabled) |
| opencode | Auto/overflow/manual; keeps ~15k tokens verbatim; supports **native provider compaction** | No memory system; instruction files with hashed epochs |
| Codex | PreTurn/MidTurn/PostTurn; trims from the front to preserve the cache prefix; remote V2 compaction | Yes — two-phase extraction + consolidation with a git baseline |

ZCode and Codex both have real memory systems. opencode deliberately does not. opencode is the only one that supports provider-native opaque compaction.

### 3.5 Extensibility

| | Plugins | Skills | MCP | Hooks | Subagents |
|---|---|---|---|---|---|
| ZCode | `plugin.json` (Claude-compatible), marketplace | SKILL.md, two-layer load | yes, trust-gated | 7 events | in-process, recursion structurally blocked |
| opencode | Effect-native plugin context, ~25 domains | SKILL.md | yes, OAuth | domain-scoped hooks | child session + durable job |
| Codex | marketplace + bundles | SKILL.md | yes, + Codex hosts narrow MCP servers | 12 events | agent graph, roles, message board, guardian |

Codex has the most elaborate multi-agent machinery (agent graph store, roles, message board, a separate reviewer agent). ZCode has the most unusual feature in **dynamic workflows** — the model writes TypeScript that orchestrates subagents. opencode's plugin system is the most integrated with its runtime (plugins can transform provider, model, tool, permission, and session services).

### 3.6 Protocol and clients

| | Transport | Client generation |
|---|---|---|
| ZCode | stdio NDJSON + a V4 conversation protocol with snapshot/delta/seq | hand-written TS types |
| opencode | HTTP REST + SSE from a single Effect `HttpApi` | **codegen** to Promise and Effect clients |
| Codex | line-delimited JSON-RPC over stdio/unix/websocket | **codegen** to TS + JSON Schema |

opencode and Codex both generate clients from a single authoritative schema. ZCode hand-writes them. That is a meaningful maintenance difference.

---

## 4. What each one teaches

**From ZCode:**
- The **tool change chain** as a single documented end-to-end pipeline, with fail-closed output validation.
- **Artifact spillover** for large tool results, with graceful degradation to truncation.
- The **dangling tool_use invariant** stated and enforced everywhere.
- **Dynamic workflows** — the boldest idea of the three: a typed, statically analyzed, journaled program instead of a conversation.

**From opencode:**
- **Durable admission separated from execution** — the inbox/doorbell split. Queued input survives a restart.
- **"One step = one LLM call, reload history from the store."** No in-memory loop means no in-memory divergence.
- **CodeMode** — a confined interpreter so the model writes one program instead of many round trips.
- **Git-tree snapshots** for undo instead of per-file artifacts.
- **Declines travel as defects**, so a leaf's error handling cannot silently swallow a user's "no".

**From Codex:**
- **Real sandboxing is achievable cross-platform** and is the only thing that actually bounds a bad command.
- **Starlark `execpolicy`** — user-authored, testable, version-controlled command rules, with dangerous prefixes never auto-suggested.
- **`apply_patch`** — a freeform, grammar-validated edit tool that is more token-efficient and more verifiable than JSON write calls.
- **Compaction that trims from the front** to preserve the prompt-cache prefix.
- **Network proxy with MITM + credential broker**, so secrets never enter the child environment.
- **Process hardening before `main`** — ptrace and core dumps blocked as defense in depth.

---

## 5. Practical guidance

If you are building your own harness:

- **Copy Codex's safety architecture.** It is the only one of the three that contains a mistake. Even a simplified version — a read-only default plus one writable root — beats a permission prompt with no enforcement behind it.
- **Copy opencode's session split.** Durable admission separate from execution, and one explicit model call per step with history reloaded from the store. It removes a whole class of state divergence.
- **Copy ZCode's tool contract.** The declaration surface (readOnly, destructive, concurrentSafe, sideEffectScope, resultBudget, timeout, cancellation) is the most complete, and it lets permission, scheduling, and auditing read one source of truth.
- **Copy Codex's `apply_patch` idea** if token efficiency matters. A grammar-validated multi-file patch beats a JSON string-replace call.
- **Skip** the marketplace, the cloud integration, the multi-agent message board, and the V4-grade protocol until you actually need them.

If you are choosing one to build on rather than learn from:

- **Codex** if safety, or Rust, or a single static binary matters.
- **opencode** if you want a TypeScript base with clean session semantics and generated clients, and you are comfortable with Effect.
- **ZCode** if you want the richest tool contract and the dynamic-workflow idea, and you accept that it is Apache-2.0 but coupled to its own protocol and plugin model.

---

## 6. Caveats

1. **Star counts** are from the GitHub API on 2026-10-14: opencode 213,434 / Codex 129,191. opencode's number is unusually high for its age; treat it as reported, not audited.
2. **Codex at HEAD is mid-refactor.** The classic single `codex.rs` engine has been split into `session/`, `tasks/`, and `agent/`. Several `TODO(anp)` notes flag that legacy thread-wide sandbox config still needs reconciling with per-environment sandbox context.
3. **opencode's docs lag the code.** The README still leads with the `build`/`plan`/`@general` story; the v2 rewrite adds the durable inbox, CodeMode, and native AI SDK that the README does not cover.
4. **Both clones are shallow** (`--depth 1`), so history and blame were not available. Findings are from the current tree.
5. **`anomalyco/opencode` vs `opencode-ai/opencode`.** The latter is an older Go implementation (13,806 stars, MIT). They are different projects sharing a name.

---

## 7. Using one as an engine behind your own UI

This is how all three are built internally, so the pattern is proven. Codex ships a TUI, VS Code/Cursor/Windsurf extensions, a desktop app, and Codex Web — all clients of the same app-server. opencode ships a TUI, desktop app, and web app — all HTTP clients. ZCode ships an Electron desktop, a mobile web remote, and a CLI TUI on one protocol.

### 7.1 Headless surface compared

| | Boundary | Streaming | Approvals to your UI | Reconnect | Publishable |
|---|---|---|---|---|---|
| **opencode** | `@opencode/sdk` in-process, or HTTP REST + SSE | SSE deltas, batched ~100 ms | ✅ `permission` group, `permission.asked`/`replied` | ⚠️ **lossy** — see below | ✅ npm, MIT |
| **Codex** | app-server JSON-RPC over stdio/unix/websocket | notifications with `agentMessage/delta`, `reasoning/*Delta`, `commandExecution/outputDelta` | ✅ server→client requests | ✅ refetch + read-state revisions | ✅ binary + TS codegen |
| **ZCode** | stdio NDJSON + V4 conversation protocol | snapshot + delta + sequence numbers | ✅ reverse requests | ✅ seq-based resync designed in | ❌ fork only |

### 7.2 The two things that decide the choice

**Reconnect is the trap.** opencode's SSE stream documents itself as *"Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed."* Capacity is 4,096 and overflow **fails the subscriber** (`SubscriberOverflowError`). There is no replay. Your UI must rebuild state by re-querying REST (`session/*`, message listing with cursor pagination) on every reconnect.

Codex is built for this instead. `thread/read`, `thread/turns/list`, and `thread/items/list` let a client refetch, and `thread/readState/*` gives multi-client read-state revisions as equality tokens. It also emits `serverRequest/resolved` so a second attached UI learns that an approval was answered elsewhere.

**Approvals must round-trip.** This is make-or-break for a custom UI. Codex exposes four distinct server→client approval requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, and `item/permissions/requestApproval` (plus `mcpServer/elicitation/request`). Your UI renders them and replies with a `ReviewDecision`. opencode exposes a `permission` API group with `Reply = once | always | reject`. ZCode uses reverse requests `interaction/requestPermission` and `interaction/requestUserInput`.

### 7.3 Recommendation

**Codex app-server** is the best fit if you want your own UI. It is the only one whose protocol was designed for multiple simultaneous clients from the start, it has a detached daemon for SSH and desktop use, websocket transport, typed codegen to TypeScript and JSON Schema, and the only real sandbox. The cost is that you write a protocol client.

**`@opencode/sdk`** is the best fit if you want the least infrastructure. It runs the whole server router **in process** with no listener and no network hop, so there is no process to manage and no IPC. The costs are Effect v4 as a hard dependency, and the lossy event stream that you must compensate for.

**ZCode** has arguably the nicest protocol design — sequence-numbered snapshot-plus-delta with an explicit resync path, plus a command inbox with idempotency, epoch, and compare-and-swap arbitration. But nothing is published, so using it as an engine means forking the monorepo.

### 7.4 Checklist before committing to any of them

1. **Prove the approval round-trip end to end** in your UI on day one. If approvals cannot reach your UI, nothing else matters.
2. **Design for reconnect.** Assume you will miss events. Rebuild from authoritative state, never from the event stream. Treat your UI as a projection.
3. **Do not duplicate session state in your UI.** All three state this as a hard rule. Keep only draft, cursor, scroll, focus, and pending overlays locally.
4. **Check streaming granularity.** `@openai/codex-sdk`'s `run()` buffers a whole turn; `runStreamed()` streams. opencode batches deltas at ~100 ms. Codex's app-server emits per-item deltas.
5. **Decide the deployment shape.** In-process (opencode SDK), child process (Codex CLI or SDK), detached daemon (Codex `app-server-daemon`, opencode background server), or remote (Codex websocket, opencode HTTP server).
6. **Confirm multi-client behaviour** if more than one UI can attach to a session, and decide who owns the answer to a pending approval.

---

## 8. Using these when you already have an agent stack

If your stack already contains an agent loop, a UI protocol, a memory system, and a sandbox, then **none of the three should be your engine.** Adopting one creates a second instance of every layer:

| Your layer | Their equivalent | Conflict |
|---|---|---|
| LangGraph / deepagents loop | their agent loop | two loops owning turn state |
| AG-UI + CopilotKit | app-server / HTTP+SSE protocol | bridge required; approvals must be translated |
| Hindsight | Codex `memories`, ZCode memory pipeline | two memory systems |
| OpenSandbox (Docker/K8s) | Codex Seatbelt/bubblewrap/Windows | Codex cannot be told to use your sandbox |

### 8.1 What deepagents already provides

Worth stating plainly: **deepagents is already a coding harness.** From its own documentation it ships:

- Sub-agents with isolated context windows
- Filesystem tools (read, write, edit, search) over pluggable local, sandboxed, or remote backends
- Shell access in a sandbox of your choice
- Context management that summarizes long threads and offloads tool outputs to disk
- Pluggable state and store backends for cross-session recall
- Human-in-the-loop approval to approve, edit, or reject tool calls before they run
- Skills loaded on demand
- Bring-your-own tools and any MCP server

That is the same feature list as ZCode, opencode, and Codex, minus the sandbox implementation and the model-provider registry — both of which you already have via OpenSandbox and LangGraph.

### 8.2 What to take from each, as designs not dependencies

| Take | From | Why |
|---|---|---|
| Tool declaration surface (readOnly, destructive, concurrentSafe, sideEffectScope, riskLevel, resultBudget, timeout, cancellation) | **ZCode** | richest of the three; feeds your approval policy and your UI rendering from one source of truth |
| `apply_patch` freeform grammar | **Codex** | standalone crate + executable; multi-file, context-anchored, token-efficient, verifiable |
| Starlark `execpolicy` prefix rules | **Codex** | user-authored, testable, version-controlled command rules; dangerous prefixes never auto-suggested |
| Sandbox policy presets (`:read-only`, `:workspace`, `:danger-full-access`) and `deny > write > read` precedence | **Codex** | the cleanest way to describe what a sandbox permits; maps directly onto OpenSandbox policy |
| Artifact spillover for large tool output | **ZCode** | offload to a file, return a preview plus a path; keeps context small |
| Verbatim-recent-window + structured summary compaction | **opencode** | keeps the newest N tokens exact and summarizes the rest under fixed headings |
| Git-tree snapshots for undo | **opencode** | content-addressed tree hashes beat per-file artifacts |
| AST-based shell parsing | **ZCode** (`unbash`) or **Codex** (tree-sitter) | string matching on commands is not safe enough |

### 8.3 The two viable paths

**Path A (recommended): extend deepagents, borrow the designs.** Keep one loop, one sandbox, one memory, one protocol. Add a shell tool that runs inside OpenSandbox, gate it with approval metadata modelled on ZCode's tool contract, and use Codex's `apply_patch` grammar for edits. Everything stays native to AG-UI.

**Path B: wrap Codex headless as a specialist tool.** Expose one LangGraph tool that runs `codex exec` on a task and returns the result. Faster to a working demo, and you inherit Codex's sandbox and patch quality. Costs: a nested agent loop, approvals that do not flow through AG-UI, no live streaming of the inner agent, and duplicate token spend.

Choose Path A unless you need a working coding feature this week.
