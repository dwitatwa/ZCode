# Knowledge Base Digest

Index of `.knowledge/` docs for the ZCode fork. Regenerate from the corpus; do not hand-edit summaries.

| id | title | claim | last_verified |
|---|---|---|---|
| [zcode-silent-snapshot-upload-audit](zcode-silent-snapshot-upload-audit.md) | ZCode v3.12.3 silently uploaded full git history; v3.14.3 source verified clean | Closed-source ZCode ≤ v3.12.3 silently uploaded whole workspaces (full `.git`, LFS, reflog) to OSS with a server-held key; the open-source v3.14.3 checkout (29628c9) contains no upload pipeline — checkpoints are local Git, indexing is local ripgrep/bfs — so building from this source is safe if the official auto-update feed is disabled or self-hosted. | 2026-09-26 |
| [self-built-desktop-security-rules](self-built-desktop-security-rules.md) | Maintenance rules keeping the self-built desktop app trustworthy | Disable or self-host the auto-update feed (already applied in this fork via `enabled: false` in the desktop main entry), re-grep for snapshot/upload code on every upstream sync (upstream history is wiped, so diffs are the only change control), and treat model-inference context as the standing trust boundary for repos with secrets. | 2026-09-26 |
| [mobile-remote-control-architecture](mobile-remote-control-architecture.md) | Phone remote control in OSS v3.14.3 is Bot Channels, not the QR web relay | The QR web remote + cloud relay exists only as remnants; the working mobile entry is Bot Channels (WeChat/Feishu/Lark/Telegram — agent replies flow through those platforms) and a self-hosted Web client (`/ws/remote/:id`) with no ZCode cloud; the hosted relay UI is closed-source and unauditable. | 2026-09-26 |
