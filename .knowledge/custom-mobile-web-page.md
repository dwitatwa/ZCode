id: custom-mobile-web-page
type: pattern
title: Custom /mobile.html phone page — three screens (Explorer / Chat / Info) over existing RPC services
status: active
claim: The self-hosted web server ships a dedicated custom mobile page at `/mobile.html` (second vite entry in `packages/web`), freely customizable by the fork owner. v2 structure: bottom tab bar with three persistent screens (display-switched, so scroll + composer draft survive tab changes) — Explorer (workspace chips from server-info `workspaces[]`, task list, create, archive/unarchive/delete with confirm sheets, archived section with `listArchivedTasks`/`deleteArchivedTasks`), Chat (snapshot-polled conversation + composer chips Access/Model/Thinking), Info (context meter, cache hit-rate, `getTaskTokenUsage` cumulative, `listSessionSubagents`, `conversationWorkflowRunsV4`, plan/background jobs/diagnostics). All composer data comes from snapshot `configOptions` server projection (model option id `model` entries carry `modelProviderId`/`modelThoughtLevels`/`modelDefaultThoughtLevel`; `thought_level` option carries per-model levels); `parseModelPickerValue` (`@zcode/shared/model-selection`) turns entry values back into `{providerId, modelId}`. Per-submission draft semantics match desktop: `sendPrompt` now accepts `mode` (build/edit/plan/yolo, facade addition threaded into v4 `sendText` payload) and `modelSelection.options.reasoningLevel`. `taskId` === agent `sessionId` (zcode-task-types-core) so Info-screen v4 queries call it directly with the task id.
scope.paths:
  - packages/web/mobile.html
  - packages/web/src/mobile/main.tsx
  - packages/web/src/mobile/lib/connection.ts
  - packages/web/src/mobile/lib/catalog.ts
  - packages/web/src/mobile/lib/types.ts
  - packages/web/src/mobile/screens/ExplorerScreen.tsx
  - packages/web/src/mobile/screens/ChatScreen.tsx
  - packages/web/src/mobile/screens/InfoScreen.tsx
  - packages/web/src/mobile/components/Sheet.tsx
  - packages/web/vite.config.ts
  - packages/services/src/session/zcodeTaskService.ts
  - packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts
evidence:
  - Screens: `ExplorerScreen` uses existing `archiveTask`/`unarchiveTask`/`deleteTask`/`deleteArchivedTask`/`deleteArchivedTasks`/`listArchivedTasks` (zcodeTaskService.ts:637-655,684-695) — no service change was needed for Explorer.
  - Facade addition (this fork): `sendPrompt` params now include `mode?: CommandPayloadMap["sendText"]["mode"]` (zcodeTaskService.ts:264), threaded in `sendPromptToAgent` (zcodeTaskServiceAdapter.ts:391,457) into the v4 `sendText` payload whose zod schema already had `mode: submissionModeSchema.optional()` (zcode-protocol-v4/command.ts:99). Legacy `session/send` fallback drops mode silently (acceptable).
  - Secure-context fix: `crypto.randomUUID()` is undefined on `http://<tailscale-ip>:3030` (insecure origin); `newTraceId()` in `lib/connection.ts` falls back to a Math.random UUIDv4. The v1 page had this latent bug (sendPrompt was never live-tested from the phone).
  - DEPLOYMENT: the running debug server does NOT serve `packages/web/dist` — the runner (`dist/zcode/debug/zcode/bin/zcode.mjs serve`) sets `ZCODE_WEB_STATIC_ROOT` to a COPY at `dist/zcode/debug/zcode/web`. After `pnpm --filter @zcode/web build`, sync: `rm -rf dist/zcode/debug/zcode/web && cp -r packages/web/dist dist/zcode/debug/zcode/web`. Static files serve from disk, so no server restart is needed for web-only changes.
  - Probe technique (no token needed): start a second instance with known token — `PORT=<p> ZCODE_SERVER_AUTH_TOKEN=<t> ZCODE_WEB_STATIC_ROOT=<web root> ZCODE_SERVER_WORKSPACE=<ws> ZCODE_AGENT_SERVER_COMMAND=<node> ZCODE_AGENT_SERVER_ARGS_JSON='[<agent>/zcode.cjs,"app-server","--stdio"]' node dist/zcode/debug/zcode/server/entry-http.js`; cookie name is `zcode_lite_token` (http.ts:187).
  - Verified 2026-09-26: root `pnpm typecheck` clean (`tsc -b` — REQUIRED after services edits: web resolves `@zcode/services` types via built declarations, so package-local tsc passes while web sees stale types until root build), `pnpm lint` 0/0 on touched files, `pnpm --filter @zcode/web build` ok, headless Chrome 390px renders tab bar (Explorer active; Chat/Info disabled without active task) + explorer empty state with zero console errors; `/api/*` 401 without token, 200 with `?token=` or `zcode_lite_token` cookie; static files open.
  - NOT yet exercised end-to-end from a real phone: sendPrompt (with mode/modelSelection), createTask, archive/delete flows, Info-screen RPCs against a live task. Snapshot polling still shows persisted state (in-flight streaming lags a few seconds vs desktop).
  - `packages/web/package.json` must stay BOM-free — PostCSS config loading fails on a UTF-8 BOM.
confidence: high
related:
  - mobile-remote-control-architecture
  - self-built-desktop-security-rules
last_verified: 2026-09-26
