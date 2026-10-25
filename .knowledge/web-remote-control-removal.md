id: web-remote-control-removal
type: decision
title: Cloud-relay Web Remote Control deleted from the fork (upstream v3.15.1 feature)
status: active
claim: Upstream v3.15.1 merged the full "Web Remote Control" cloud relay into this repo (desktop device connects out to `wss://zcode.z.ai/ws`, QR encodes `https://zcode.z.ai/remote/...`, passHash HMAC pairing). This fork DELETED that device side. The desktop no longer opens any outbound relay socket, no QR points at zcode.z.ai, and the relay IPC/i18n/UI are gone. KEPT on purpose: (a) the mobile-direct connection (`mobileDirectServer.ts`, `mobileDirectConnectionManager.ts`, `mobileDirectBridge.ts`, `DirectMobileConnectionSection.tsx`); (b) the custom `/mobile.html` (`packages/web/src/mobile/*`); (c) the phone-side controller and shared types (`packages/web/src/webRemoteControl*.ts`, `packages/shared/src/web-remote-control*.ts`, `@zcode/client` relay protocol) because the self-hosted remote mode (`packages/server` `/ws/remote-control/window/:id` + built-in `index.html`) still uses them; (d) the `SyncWebRemoteControlWorkspaces` channel, reused by the Bot remote-session binding. On 2026-10-25 the Bot Channel configuration UI was deleted as well — the dialog column, `BotsDialog` and its cards, their i18n keys and their tests — so the dialog now shows only the direct connection panel. The bot service layer, shared bot types and bot IPC channels were deliberately kept and are now unreachable from the UI.
scope.paths:
  - packages/desktop/src/main/webRemoteControlManager.ts (deleted)
  - packages/desktop/src/main/webRemoteControlTransport.ts (deleted)
  - packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts (deleted)
  - packages/desktop/src/main/webRemoteControlRelayAuthStorageProvider.ts (deleted)
  - packages/desktop/src/main/webRemoteControlFeatureGate.ts (deleted)
  - packages/desktop/src/main/webRemoteControlStatusEvents.ts (deleted)
  - packages/desktop/src/main/desktopWebRemoteControlIpc.ts (deleted)
  - packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts (deleted)
  - packages/desktop/src/main/webRemoteControlRendererReconnect.ts (deleted)
  - packages/desktop/src/main/index.ts
  - packages/desktop/src/main/desktopMainIpcRemote.ts
  - packages/desktop/src/main/desktopRemoteSessions.ts
  - packages/desktop/src/main/desktopWindowLifecycle.ts
  - packages/desktop/src/main/desktopMainIpcPlatform.ts
  - packages/desktop/src/main/logger.ts
  - packages/desktop/src/preload/index.ts
  - packages/desktop/src/renderer/src/desktopPlatform.ts
  - packages/shared/src/channels.ts
  - packages/ui/src/WebRemoteControlDialog.tsx
  - packages/ui/src/WorkspaceWebRemoteControlTrigger.tsx
  - packages/ui/src/Root.tsx
  - packages/ui/src/WorkspaceSidebar.tsx
  - packages/ui/src/root/useRootPlatformEffects.ts
  - packages/ui/src/hooks/useWebRemoteControlStatus.ts (deleted)
evidence:
  - Deleted modules: manager/transport/relay-auth/feature-gate/status-events/IPC/shared-host-attachments/renderer-reconnect. They were imported only by `main/index.ts`, `main/desktopMainIpcRemote.ts`, and each other (verified by import grep).
  - Kept by boundary check: `mobileDirectBridge.ts` imports only `@zcode/rpc` + `HostMessageTypes`; `packages/web/src/mobile/*` connects to `/ws?token=` and does not import any `webRemoteControl*`; `createAcknowledgedWebRemoteControlRelayProtocol` / `WebRemoteControlRelayPayloadSerializer` are used by `packages/web/src/main.tsx` + `webRemoteControlTransport.ts` (self-hosted controller) so they stay; `resolveWebRemoteControlRelayWsUrl` is used by `packages/web/src/main.tsx` so it stays.
  - Removed IPC channels: StartWebRemoteControl, ResetWebRemoteControlPairing, StopWebRemoteControl, GetWebRemoteControlStatus, WebRemoteControlStatusChanged, SyncWebRemoteControlTasks, WebRemoteControlReconnectWorkspace (enum + request/response map + preload + renderer bridge).
  - `SyncWebRemoteControlWorkspaces` KEPT: `packages/ui/src/root/useRootPlatformEffects.ts` also uses it to bind `remoteSessionId -> workspaceIdentity` for Bot remote-connection status (comment at the call site). Main's handler is now a no-op.
  - UI: `WebRemoteControlDialog.tsx` rewritten to keep only `<DirectMobileConnectionSection/>` + Bot Channel entries; `WorkspaceWebRemoteControlTrigger.tsx` drops the relay status polling; `useWebRemoteControlStatus.ts` deleted; `WorkspaceSidebar.tsx` `mobileActiveTaskKey` is now constant `null`. SUPERSEDED 2026-10-25: the Bot Channel entries were then deleted along with the whole bot configuration UI.
  - Bot channel configuration UI deleted 2026-10-25: `packages/ui/src/BotsDialog.tsx`, `packages/ui/src/BotsDialog/*` (six files), `packages/ui/src/botsUi.ts`, `packages/ui/src/hooks/useBotBoundGroups.ts`, `packages/ui/src/hooks/useBotPrivateDeliveryRetry.ts`, the 12 `webRemoteControl.botChannel.*` keys in both locales, and 5 config-only test files. The dialog now renders one full-width `<DirectMobileConnectionSection/>` panel and offers no bot channel entry or control. `WebRemoteControlDialog.tsx` was the only importer of `BotsDialog.js`. Kept and now dormant: `packages/services/src/bots` (~20k lines), `packages/shared/src/bots.ts`, the `BotRemoteWorkspace*` channels, `submitBotGroupInput`, and the in-conversation bot surfaces.
  - Two desktop e2e specs reached the bot dialog only through the deleted `web-remote-control-open-bots` button: `packages/desktop/test/e2e/bots/feishu-bound-groups-ui.test.ts` and `feishu-runtime-error-ui.test.ts`. Both were DELETED on 2026-10-25 along with the fixture `packages/desktop/test/e2e/fixtures/bots/feishu-runtime-error-ui.json`, because their subject (the bot configuration UI) is unreachable and they could never pass again. The two bot coverage docs carry a dated retirement note for BOT-E2E-CF-01 and GR-UI-01. The remaining six bot e2e specs are unaffected.
  - i18n: relay-only `webRemoteControl.*` keys (mobileQr/refreshQr/copyLink/status/statusDetail/statusTag/failure/triggerStatus/singlePageNote/qrAlt/generating/linkLabel/linkPending/startFailed/stopFailed/stopSuccess/stop/switchWorkspace/noSwitchableWorkspaces) removed from en-US + zh-CN.
  - Residual (inert on desktop, kept for the phone/web platform): the `WebRemoteControlTaskSync` component in `Root.tsx` (gated by `webRemoteControlFeatureEnabled && platform.syncWebRemoteControlTasks`, and the desktop no longer provides that method) and the `platform.onWebRemoteControlReconnectWorkspace` effect (method now absent so it no-ops).
  - Verification: `pnpm typecheck` clean; `pnpm lint` 0 errors; `pnpm --filter @zcode/web build` succeeds; ui+desktop unit suites show only pre-existing failures (confirmed by `git stash` baseline: Windows file-URL openPath tests, Windows symlink EPERM, locale number formatting).
confidence: high
related:
  - mobile-remote-control-architecture
  - custom-mobile-web-page
  - self-built-desktop-security-rules
last_verified: 2026-10-25
