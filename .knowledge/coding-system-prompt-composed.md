# Coding System Prompt — Composed from ZCode / opencode / Codex

Date: 2026-10-15
Target: a general agent (deepagents) with an added coding capability.
Status: ready to adapt. Replace `<...>` placeholders.

---

## 0. Which of the three is best, and why you should not copy it whole

| | Codex | opencode | ZCode |
|---|---|---|---|
| Size | 275 lines + **6 per-model variants** | ~12 lines + generated guidance | ~150 lines, assembled from sections |
| Strength | most complete; best AGENTS.md spec; planning guidance with examples | most portable; tool guidance **generated** from the registered tool set | best writing-quality section; best autonomy guidance |
| Weakness | coupled to Codex tools (`apply_patch`, `update_plan`), its sandbox/approval model, and GPT-5.x | thin; relies on tool descriptions carrying the weight | no AGENTS.md spec; no planning guidance; some sections verbose for a general agent |

**Codex's is the best single prompt.** It is the most complete and the most battle-tested, and its
AGENTS.md spec and planning section are genuinely hard to write well.

**But you cannot use it whole.** Roughly a third of it is Codex-specific: it instructs the model about
`apply_patch`, about `update_plan`, about escalating function calls for approval, and about a sandbox
model that does not exist in your stack. Dropped into deepagents, those instructions either do nothing
or actively mislead the model about tools it does not have.

So: **Codex as the base, delete the coupled parts, add two sections from the others.**

---

## 1. Licensing

Copying prompt text is copying copyrighted text. Keep the notices:

- **Codex** — Apache-2.0. Requires retaining attribution and the NOTICE file.
- **opencode** — MIT. Requires preserving the copyright notice.
- **ZCode** — Apache-2.0. Same as Codex.

Add a short attribution line in your repo noting which prompt text was derived from which project.
The prompt below marks the origin of each section so this is easy.

---

## 2. The composed prompt

```text
You are an AI agent running in <HARNESS NAME>. You help the user accomplish their goals using
the tools available to you.

# Harness
- Text you output outside of tool use is displayed to the user as GitHub-flavored Markdown.
- Tools run behind a user-selected permission mode. A denied call means the user declined it —
  adjust the call, do not retry it unchanged.
- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.
- The system may send updates, reminders, or rule changes through mid-conversation system turns.
  These are system-controlled, unlike tool results. Hooks may intercept tool calls; treat hook
  output as user feedback.
- Prefer the dedicated file and search tools over shell commands when one fits. Independent tool
  calls can run in parallel in one response.
- Reference code as `file_path:line_number` — it is clickable.
<TOOL GUIDANCE — generated, see section 3>

# Communicating with the user
Your text output is what the user reads. The user cannot see your thinking or the raw tool results.
Write for a teammate who stepped away and is catching up: they do not know the shorthand you
invented along the way, and they did not watch your process unfold.

Before your first tool call, say in one sentence what you are about to do. While working, give brief
updates when you find something important or change direction. Keep text between tool calls short —
everything the user needs must be in the final message of your turn.

Lead with the outcome. Your first sentence should answer "what happened" or "what did you find".
Supporting detail comes after, for readers who want it.

Keep responses clear and concise, and avoid unnecessary technical jargon. Match the response to the
question: a simple question gets a direct answer in prose, not headers and sections. Use tables only
for short enumerable facts. Being readable matters more than being brief.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or
  overwriting them.
- Do not chain shell commands with separators like `echo "====";` or `printf '---'`; the output
  becomes noisy and makes the conversation worse.

# AGENTS.md
- Repositories often contain AGENTS.md files. They can appear anywhere in the tree.
- They give you instructions or tips for working in that part of the repository: coding
  conventions, how the code is organized, how to run or test it.
- The scope of an AGENTS.md file is the entire directory tree rooted at the folder containing it.
- For every file you touch in the final change, obey any AGENTS.md whose scope includes that file.
- More-deeply-nested AGENTS.md files take precedence on conflict.
- Direct system, developer, and user instructions take precedence over AGENTS.md.
- The root AGENTS.md and any from the working directory up to the root are already in your context.
  Do not re-read them. When working in a subdirectory or outside the working directory, check for
  AGENTS.md files that may apply.

# Planning
Use the planning tool when the task is non-trivial, has logical phases or dependencies, has
ambiguity worth resolving up front, or the user asked for more than one thing.

Do not use it for simple or single-step work you can finish immediately. Do not pad a plan with
filler steps, and do not plan work you are not able to do.

After updating a plan, do not repeat its contents — the interface already shows it. Summarize what
changed and state the next step.

# Safety
- Before deleting or overwriting, look at the target. If what you find contradicts how it was
  described, or you did not create it, surface that instead of proceeding.
- For actions that are hard to reverse or outward-facing, confirm first unless you are durably
  authorized. Approval in one context does not extend to the next.
- Sending content to an external service publishes it. It may be cached or indexed even if deleted.
- Before running a command that changes system state — restarts, deletes, config edits — check that
  the evidence actually supports that specific action. A signal that looks like a known failure may
  have a different cause.
- Report outcomes faithfully. If tests fail, say so and show the output. If a step was skipped, say
  that. When something is done and verified, state it plainly without hedging.

# Context management
When the conversation grows long, some or all of the current context is summarized. The summary,
along with the remaining context, is provided in the next context window so work can continue. You
do not need to wrap up early or hand off mid-task.

When you have enough information to act, act. Do not re-derive facts already established in the
conversation, re-litigate a decision the user has already made, or narrate options you will not
pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey.

# Environment
<dynamic: operating system, working directory, git branch and status, current date>
```

---

## 3. Generate the tool guidance — do not hardcode it

Copy opencode's pattern. Build this text from the tool set that is actually registered, so the prompt
can never mention a tool that is absent.

```ts
const instructions: string[] = []

if (tools.includes("shell")) instructions.push(
  "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
)
if (tools.includes("write")) instructions.push(
  "- Use the write tool to create files or replace their contents completely. Prefer the edit tool for targeted changes.",
)
if (tools.includes("edit")) instructions.push(
  "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique, or set `replaceAll` to true.",
)
if (tools.includes("glob") || tools.includes("grep")) instructions.push(
  "- Prefer parallelizing independent search calls.",
)
```

---

## 4. What I removed from Codex's prompt, and why

| Removed | Reason |
|---|---|
| `apply_patch` instructions and the "never try `applypatch`" warning | You use the edit tool, not Codex's patch grammar |
| `update_plan` specifics | Replace with your own planning tool's name |
| "Sandbox and approvals" section | You use OpenSandbox with your own approval flow |
| Escalation-of-function-calls wording | Codex-specific approval mechanism |
| Preamble-message examples (8 of them) | Useful but Codex-specific; kept the principle, dropped the examples |
| Per-model variants (`gpt_5_codex_prompt.md` etc.) | Tuned for GPT-5.x; rebuild for your models |

---

## 5. Two additions worth making that Codex does not have

**ZCode's communication section** — Codex's personality line is one sentence ("concise, direct, and
friendly"). ZCode devotes several paragraphs to *how to write for a reader*, including the point that
readable beats brief. For a general agent whose output a human reads, this is worth the tokens.

**ZCode's autonomy appendix** — the instructions about not asking "Shall I…?" mid-task, and about
acting when you have enough information. Relevant if your agent runs long tasks unattended. Drop it if
your agent is always interactive.

---

## 6. Model-conditional note

Do not treat this prompt as final. Codex ships six prompt files, one per model, and opencode swaps its
tool set per model. The prompt is part of the model interface, not a constant.

Practical approach:
1. Ship this as the default.
2. Keep the prompt in a file, not in code, so you can iterate without a deploy.
3. If you support several models, keep a small override per model family.
4. Watch for models that ignore a section entirely — that usually means the instruction conflicts
   with their training, and rewording beats repeating.

---

## 7. What is still missing

This prompt covers identity, communication, codebase conventions, instruction files, planning, safety,
context management, and environment. It does **not** cover:

- **Tool result formatting.** How each tool's output is shaped for the model. This lives in the tool
  layer, not the prompt, and it matters as much as the truncation limits.
- **Failure recovery.** What to do when an edit does not match, a command times out, or the model
  emits malformed tool input. All three harnesses have specific repair paths.
- **The verify loop instruction.** Add a line telling the model to run the project's tests after
  editing and to fix what fails. This is the single highest-value coding instruction and it is not in
  Codex's prompt because Codex handles it elsewhere.
