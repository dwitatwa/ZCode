id: self-built-desktop-security-rules
type: rule
title: Rules for keeping the self-built ZCode desktop app trustworthy
status: active
claim: Building the desktop app from source only stays safer than the official binary if three maintenance rules are followed: (1) the official auto-update feed must be disabled or repointed to self-hosted updates, because accepting an official update replaces the audited binary with a closed-source one that could reintroduce removed behavior; (2) every upstream sync must be re-audited with a targeted diff for snapshot/upload code before merging, because the upstream repo has wiped history (3 commits, locked PRs/issues) and can change anything in a single push; (3) model-inference context is the remaining trust boundary — code sent to the GLM API during agent runs goes to Z.ai regardless of build provenance, so repos containing secrets or keys must not be opened in the app unless that content is acceptable to share.
scope.paths:
  - packages/desktop/src/main/autoUpdater.ts
  - packages/desktop/src/main/index.ts
  - scripts/build-zcode.mjs
  - https://github.com/zai-org/ZCode (upstream)
evidence:
  - Applied in this fork, commit 1ec25c6: `packages/desktop/src/main/index.ts`, `initAutoUpdater()` call now passes `enabled: false` (upstream ships `enabled: ZCODE_PRODUCT_FLAVOR === "production"`), with Chinese comment explaining the self-build rationale; verified with `pnpm typecheck` (clean) and `pnpm lint` (no new warnings vs baseline) on 2026-09-26.
  - Update feed points at official CDN and updater polls it; default `autoDownload = false` but user-confirmed installs still swap in official binaries — `packages/desktop/src/main/autoUpdater.ts`, `registerAutoUpdater()`, as of 29628c9.
  - `autoUpdaterDisabledForProductFlavor` hook exists for disabling updates entirely — `packages/desktop/src/main/autoUpdater.ts` line 1464, as of 29628c9.
  - Re-audit method verified fast and effective: grep the repo for `snapshot/upload-credential`, `repoSnapshot`, `captureBeforePrompt`, `rsa-oaep`, `publicKeySpkiPem`, `repo_snapshot_extra_manifest` — all absent at 29628c9.
  - Upstream history is wiped (3 commits total) so diffs between syncs are the only change-control — confirmed via GitHub API on 2026-09-26.
  - Rebuild path for upgrades (required because the updater is disabled): `pnpm bundle:desktop -- --os win --arch x64` runs runtime-asset prep, bundle build, and electron-builder NSIS packaging; the installer lands in `packages/desktop/dist/` — `packages/desktop/scripts/bundle.mjs` and `packages/desktop/electron-builder.config.js`, as of 29628c9. Toolchain pinned in `mise.toml` (Node 24.14.0, pnpm 10.33.2).
  - Windows fix applied in this fork, commit 16c5c35: `scripts/build-zcode.mjs` `run()` now spawns with `shell: true` on win32 — `spawnSync("pnpm")` fails with ENOENT because pnpm is a `.CMD`/`.ps1` shim here (nvm4w install) and Node refuses `.cmd` without shell (CVE-2024-27980); verified by successful `pnpm build:zcode` run on 2026-09-26 (tarball sha256 a204156f). CLI web server smoke-tested bound to the Tailscale IP: 401 without token, 200 with token, web UI serves.
  - Mobile access surfaces in this fork (2026-09-26): phone entry is `/mobile.html` (custom thin page, see custom-mobile-web-page) and the full desktop web UI carries a CSS mobile takeover inline in `packages/web/index.html` (sidebar → overlay drawer with injected ☰ toggle, task nav ← → hidden on web via `hideTaskNavigationButtons`, workspace chip shifted right, second `v4-pane-shell-*` session pane → fullscreen overlay below the 48px header). React changes in `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` and `packages/ui/src/DesktopTopOverlay.tsx`; verified via headless-Chrome 390px DOM measurement (overlap: false, visibleOverflow: 0) — the running-subagent pane state itself was not reproducible headlessly (workflow run entries only exist while the run is active) and is pending a live phone check.
confidence: high
related:
  - zcode-silent-snapshot-upload-audit
  - mobile-remote-control-architecture
last_verified: 2026-09-26
