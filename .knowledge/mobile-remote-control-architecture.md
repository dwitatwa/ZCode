id: mobile-remote-control-architecture
type: pattern
title: Phone remote control in OSS v3.14.3 is Bot Channels, not the QR web relay
status: active
claim: The QR-scan-to-open-web remote control (phone browser → cloud relay WS → desktop Host) is not present end-to-end in the open-source v3.14.3 checkout — only plumbing remnants remain (web env vars, i18n strings, RPC relay roles); the actual mobile entry is "移动端远程控制" via Bot Channels (WeChat/Feishu/Lark/Telegram), where agent prompts and replies flow through third-party chat platforms, plus a self-hosted Web client (`packages/server` `/ws/remote/:id` + `packages/web`) that involves no ZCode cloud. The closed-source hosted remote UI and its relay are not auditable from this repo.
scope.paths:
  - packages/ui/src/WebRemoteControlDialog.tsx
  - packages/services/src/bots
  - packages/server/src/http.ts
  - packages/web/src
evidence:
  - Mobile remote UI = Bot Channels: `packages/ui/src/WebRemoteControlDialog.tsx` and i18n key `webRemoteControl.description` ("通过聊天机器人控制 ZCode 工作区") list Weixin/Feishu/Lark/Telegram channels; trigger rendered in `packages/ui/src/WorkspaceSidebarFooter.tsx`.
  - QR codes in the app are bot registration flows, not remote pairing: `packages/ui/src/BotsDialog.tsx` renders WeChat iLink `get_bot_qrcode` scan-login and Feishu app-creation QRs (`packages/services/src/bots/providers/weixinRegistration.ts`), saving bot credentials locally (encrypted via cipher in `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts`).
  - Relay web remote is a remnant: `packages/web/src/env.d.ts` declares `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` and comments about `/remote` + `/remote/v3` build bases, but `packages/web/src/main.tsx` contains no `/remote` route (only share + OAuth callback + main client); desktop main/host have no outbound WebSocket relay client (only Chrome-CDP local WebSocket). NOTICE.md's external-request table lists no cloud relay for phone control.
  - Bot replies flow to third-party platforms: reply granularity (标准/完整/摘要) and truncation in `packages/services/src/bots/replyFormatter.ts` and `statusFormatting.ts` — assistant text, tool summaries, and file-change lists are sent via the channel providers (`weixinProvider.ts`, `feishuProvider.ts`, `telegramProvider.ts`).
  - Self-hosted web path: `packages/server/src/http.ts` route `/ws/remote/:id` (line 419) bridges one-time remote connections to a browser with `web-remote-replayable` client mode; consumed by `packages/web/src/main.tsx` `resolveWebBootstrap()`.
  - Production CLI web mode (no Electron needed): `pnpm build:zcode` (requires a `--base-url`/`ZCODE_DIST_BASE_URL`, only baked into the installer script) produces `dist/zcode/releases/<v>/zcode-<v>.tar.gz`; run with Node ≥24 via `node .../bin/zcode.mjs --web --workspace <path> --port 3030`. Loopback by default with no token; `--host 0.0.0.0` auto-generates an access token; `--token`/`--no-token` override. CLI update source is only the self-configured distribution URL (`manifestUrl` in `packages/zcode-server-cli/src/runtime/updatePreparation.ts`) — no official CDN phone-home by default. Token auth flow (query param → HttpOnly SameSite=Lax cookie) in `packages/server/src/http.ts` `hasValidLiteToken()`; `/ws` and `/api/*` protected, static files open. No built-in TLS.
  - RPC layer supports relay attachments via role `trusted-host-relay` and desktop Host accepts Renderer/Mobile attachments via MessagePort (`packages/desktop/src/host/index.ts` header comment), but the hosted relay side is not in the OSS repo.
confidence: high
related:
  - zcode-silent-snapshot-upload-audit
  - self-built-desktop-security-rules
last_verified: 2026-09-26
