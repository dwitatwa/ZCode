id: insecure-origin-browser-crypto
type: pattern
title: Plain-HTTP LAN/Tailscale origin is an insecure context — browser crypto (subtle/randomUUID) is undefined and must have a fallback
status: active
claim: The debug web server binds only to the LAN/Tailscale IP (`http://100.123.176.44:3030`, plain HTTP, not localhost), so every browser client — desktop Chrome included — runs the UI in an **insecure context**. Browsers gate `crypto.subtle` and `crypto.randomUUID` on secure contexts, so any UI code that touches them unconditionally breaks only in this deployment shape (works in Electron/localhost, fails over LAN IP). This caused: (1) every composer image attachment failing with chip text `Upload failed: fault.attachment.checksumUnavailable` — the v4 upload transaction's first step computes a mandatory SHA-256 checksum (protocol begin schema requires `sha256:<64hex>`, agent verifies at commit, cannot be skipped) and `checksum()` threw the moment `crypto.subtle` was missing, then auto-retried once and failed permanently; (2) PPTX element fingerprints (`sha256Fingerprint`) throwing TypeError; (3) earlier, `newTraceId()`'s `crypto.randomUUID` on the mobile page (fixed with a Math.random fallback). **Rule: any new browser-side crypto in `@zcode/ui` must handle a missing `crypto.subtle`/`crypto.randomUUID` (fallback impl or server-side hashing) — prefer the shared helper `packages/ui/src/lib/sha256.ts`.**
scope.paths:
  - packages/ui/src/lib/sha256.ts
  - packages/ui/src/v4/attachmentUploadTransaction.ts
  - packages/ui/src/lib/pptxElementReference.ts
  - packages/web/src/mobile/lib/connection.ts
evidence:
  - Server binding verified via netstat: port 3030 LISTENING only on `100.123.176.44` (Tailscale CGNAT range), so even same-machine Chrome is non-localhost → insecure.
  - Throw site was `attachmentUploadTransaction.ts` `checksum()` — `if (!globalThis.crypto?.subtle) throw new Error("fault.attachment.checksumUnavailable")`; the error classifier treats it as transient → 1 silent auto-retry → failed chip; nothing reaches the agent (runtime log shows all prompts `attachmentCount: 0`).
  - Checksum cannot be dropped: `v4AttachmentChecksumSchema` (`packages/shared/src/zcode-protocol-v4/transport.ts:827`) and agent-side verify at commit (`attachment-upload-registry.ts:245` `fault.attachment.checksumMismatch`).
  - Fix: `packages/ui/src/lib/sha256.ts` exports `sha256Hex(bytes)` — WebCrypto when available, otherwise a FIPS 180-4 pure-JS SHA-256. Verified byte-for-byte against `node:crypto` for 18 cases (empty, 55/56/57, 63/64/65, 128/129 boundary paddings, 20MiB+13, offset views); 20MiB digests in ~17ms, no perf concern. Both `checksum()` and `sha256Fingerprint` now delegate to it.
  - Same bug class already recorded twice in-repo: `useTaskSessionFilePath.ts` (workspace hash moved server-side because subtle "可能不存在" in http 预览/远程访问) and the mobile page's `newTraceId` randomUUID fallback (see custom-mobile-web-page).
  - Verification after fix: `pnpm typecheck` clean, `pnpm --filter @zcode/ui lint` 0 errors (37 pre-existing warnings, none in changed files), `pnpm architecture:check --changed` 0 violations, web bundle rebuilt (`pnpm --filter @zcode/web build`) and synced to `dist/zcode/debug/zcode/web` (static served from disk, no server restart; the SHA-256 constants are in the served `imeComposition-*` shared chunk).
confidence: high
related:
  - custom-mobile-web-page
  - self-built-desktop-security-rules
last_verified: 2026-09-26
