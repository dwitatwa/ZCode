id: zcode-silent-snapshot-upload-audit
type: incident
title: ZCode v3.12.3 silently uploaded full git history; v3.14.3 source verified clean
status: active
claim: The closed-source ZCode desktop client (≤ v3.12.3) silently packaged entire workspaces — including full `.git` history, LFS caches, and reflogs — encrypted them with a server-controlled RSA key, and uploaded them to Alibaba Cloud OSS whenever the user was logged in, with no opt-out. In the current open-source checkout (v3.14.3, commit 29628c9) the entire upload pipeline is verifiably absent: checkpoints are pure local Git, code indexing is local ripgrep/bfs/ugrep, and the only outbound data flows are model-inference context, aggregated ARMS network metrics, user-initiated feedback attachments, and the official auto-update feed. Building the desktop app from this source removes the exposed behavior, provided the auto-update feed is disabled or self-hosted so the audited binary is not silently replaced by official builds.
scope.paths:
  - https://github.com/zai-org/ZCode (upstream)
  - packages/desktop
  - packages/services/src/git
  - apps/zcode-cli/packages/adapters/src/auth
evidence:
  - Snapshot upload pipeline absent: grep across repo at 29628c9 finds no `/api/v1/snapshot/upload-credential`, no `repoSnapshot`, no `captureBeforePrompt`, no `repo-wiki`, no `repo_snapshot_extra_manifest`, no `settings.behavior.json` hashing. Only benign matches: `packages/services/src/feedback/feedbackHttpClient.ts` (user-initiated feedback ticket attachment upload) and a route-segment allowlist entry in `packages/desktop/src/main/networkTelemetryAggregator.ts`.
  - Envelope-encryption upload code absent: no `rsa-oaep`, `publicKeySpkiPem`, `x-oss-signature`, or AES-256-CTR workspace encryption outside `feedbackHttpClient.ts` (feedback attachments only).
  - Checkpoints are local-only: `packages/services/src/git/gitCheckpointService.ts`, `createGitCheckpointService()` uses local Git CLI via `gitCheckpointRepo`/`gitCheckpointStore`, metadata saved as local JSON, no network calls.
  - Code indexing is local: native search tools (ripgrep 14.1.1, bfs 4.1.1, ugrep) bundled with SHA256 checksums in `apps/zcode-cli/dependencies/native-search/SHA256SUMS`; all search runs as local processes.
  - No workspace packaging for upload: all tar.gz/zip code paths are build/release tooling (`scripts/`, `packages/zcode-server-cli`) or remote-server deployment to the user's own SSH hosts (`packages/server/src/remote/`).
  - Outbound telemetry is metrics-only: `packages/desktop/src/main/networkTelemetryAggregator.ts` aggregates latency/error counters with a static route-segment allowlist (comment at line 63 explains it prevents leaking user paths/slug/email); sends device_mid, platform, app_version — no file content.
  - Auto-update feed points to official CDN: `packages/desktop/src/main/autoUpdater.ts` (default `autoUpdater.autoDownload = false` at line 1501, but polls official feed; `autoUpdaterDisabledForProductFlavor` hook at line 1464 can disable it).
  - Fork HEAD matches upstream: local HEAD 29628c9acdb81b703bbd4080c207a0e7ce5e276e confirmed identical to current zai-org/ZCode HEAD via GitHub API on 2026-09-26.
confidence: high
related: []
last_verified: 2026-09-26
