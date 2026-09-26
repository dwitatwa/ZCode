id: custom-mobile-web-page
type: pattern
title: Custom /mobile.html phone page — thin client over existing RPC services
status: active
claim: The self-hosted web server ships a dedicated custom mobile page at `/mobile.html` (built as a second vite entry in `packages/web`), designed to be freely customized by the fork owner instead of patching the desktop shell. It is a thin client: `connectViaWebSocket` → `IServiceAccessor.zcodeTaskService` only — `listTasks` (8s poll), `getTaskSnapshot` (3s poll while viewing, persisted snapshot not live v4 streaming), `sendPrompt` / `stopGeneration` (clientMode `web-remote-replayable`, clientLabel `zcode-mobile`), `createTask`. Auth: open the token link once (HttpOnly cookie covers all paths) or pass `?token=` which is forwarded to the WS handshake. v1 limits: assistant markdown rendered raw, no attachments/diff/terminal/workflow panes — those remain available via the full desktop UI with its CSS mobile takeover (see related). The full-UI CSS mobile takeover (drawer + injected ☰ toggle + hidden task nav + second-pane fullscreen overlay) lives inline in `packages/web/index.html` and stays as the fallback surface.
scope.paths:
  - packages/web/mobile.html
  - packages/web/src/mobile/main.tsx
  - packages/web/vite.config.ts
  - packages/web/index.html
evidence:
  - Entry + app: `packages/web/mobile.html` (dark theme tokens, safe-area insets) and `packages/web/src/mobile/main.tsx` (~330 lines, React + `connectViaWebSocket` from `@zcode/client`).
  - Multi-page build: `packages/web/vite.config.ts` `build.rollupOptions.input` has `main` + `mobile`; `pnpm --filter @zcode/web build` emits both at dist root.
  - Static serving: `packages/server/src/http.ts` `resolveStaticFile()` — unknown paths fall back to index.html only when `isStaticFallbackAllowed`; `/mobile.html` is a real file so no server change was needed.
  - WS auth accepts query token: `packages/server/src/http.ts` `hasValidLiteToken()` accepts `?token=` and sets an HttpOnly cookie; the mobile page forwards its own `?token=` to the WS URL and caches it in sessionStorage.
  - API shapes verified against source: `packages/services/src/session/zcodeTaskService.ts` (`sendPrompt` has NO workspacePath — task is bound at create; `stopGeneration`/`createTask`/`getTaskSnapshot` DO take workspacePath/workspaceIdentity), `packages/shared/src/zcode-task-types.ts` (`ZCodeTaskCreateResult extends ZCodeTaskMeta`), `packages/shared/src/zcode-task-types-core.ts` (`ZCodePersistedMessage` with `parts` of content/thought/tool-call).
  - `packages/web/package.json` gained `@zcode/services` (type-only usage: `IServiceAccessor`, `IZCodeTaskService`); note the file must stay BOM-free — PostCSS config loading fails on a UTF-8 BOM in package.json.
  - Verified 2026-09-26: `pnpm typecheck` clean; headless Chrome at 390px renders task list (2 rows: title/status/relative time) and chat view (user/assistant bubbles, tool lines, collapsible thought); server logs show `getTaskSnapshot` polling returning the expected messages.
  - NOT yet exercised end-to-end: `sendPrompt` and `createTask` from the phone (implemented and typechecked, no live send test); snapshot polling shows persisted state, so in-flight streaming text lags a few seconds vs the desktop UI.
confidence: high
related:
  - mobile-remote-control-architecture
  - self-built-desktop-security-rules
last_verified: 2026-09-26
