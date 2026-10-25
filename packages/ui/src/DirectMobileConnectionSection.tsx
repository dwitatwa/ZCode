import { useCallback, useEffect, useState } from "react";
import type { MobileDirectBindMode, MobileDirectConnectionStatus } from "@zcode/shared";
import { Check, Copy, Link2, Loader2, QrCode, Radio, Square } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

const BIND_MODES: Array<{ mode: MobileDirectBindMode; titleId: string; descriptionId: string }> = [
  {
    mode: "loopback",
    titleId: "webRemoteControl.direct.bindMode.loopback",
    descriptionId: "webRemoteControl.direct.bindMode.loopbackDescription",
  },
  {
    mode: "tailnet",
    titleId: "webRemoteControl.direct.bindMode.tailnet",
    descriptionId: "webRemoteControl.direct.bindMode.tailnetDescription",
  },
];

const STOPPED_STATUS: MobileDirectConnectionStatus = {
  state: "stopped",
  bindMode: "loopback",
  connectedClients: 0,
};

/**
 * 直连远控 —— 不经过任何聊天渠道,直接在 Desktop Main 起一个 HTTP/WS 监听,
 * 手机扫码即可接到「当前窗口」的 Host(项目/会话与桌面完全一致)。
 */
export function DirectMobileConnectionSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const supported = typeof platform.startMobileDirectConnection === "function";

  const [status, setStatus] = useState<MobileDirectConnectionStatus>(STOPPED_STATUS);
  const [bindMode, setBindMode] = useState<MobileDirectBindMode>("loopback");
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void platform.getMobileDirectConnectionStatus?.().then((next) => {
      if (!cancelled && next) {
        setStatus(next);
        setBindMode(next.bindMode);
      }
    });
    const dispose = platform.onMobileDirectConnectionChanged?.((next) => {
      if (!cancelled) {
        setStatus(next);
        if (next.state !== "stopped") setBindMode(next.bindMode);
      }
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [platform, supported]);

  const pairingUrl = status.state === "running" ? status.pairingUrl : undefined;

  useEffect(() => {
    if (!pairingUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairingUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((error: unknown) => {
        logger.warn("[DirectMobileConnectionSection] 生成二维码失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [pairingUrl]);

  const handleStart = useCallback(async () => {
    if (!platform.startMobileDirectConnection) return;
    setBusy(true);
    try {
      const next = await platform.startMobileDirectConnection({ bindMode });
      setStatus(next);
    } finally {
      setBusy(false);
    }
  }, [bindMode, platform]);

  const handleStop = useCallback(async () => {
    if (!platform.stopMobileDirectConnection) return;
    setBusy(true);
    try {
      const next = await platform.stopMobileDirectConnection();
      setStatus(next);
    } finally {
      setBusy(false);
    }
  }, [platform]);

  const handleCopy = useCallback(async () => {
    if (!pairingUrl) return;
    try {
      await globalThis.navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1600);
    } catch (error: unknown) {
      logger.warn("[DirectMobileConnectionSection] 复制配对链接失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [pairingUrl]);

  const isRunning = status.state === "running";
  const isStarting = status.state === "starting" || busy;

  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-4 flex items-start gap-2">
        <Radio className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "webRemoteControl.direct.title" })}
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.direct.description" })}
          </p>
        </div>
      </div>

      {!supported ? (
        <p className="text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.direct.unavailable" })}
        </p>
      ) : (
        <div className="grid min-w-0 gap-3">
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {BIND_MODES.map((entry) => {
              const selected = bindMode === entry.mode;
              return (
                <button
                  key={entry.mode}
                  type="button"
                  disabled={isRunning || isStarting}
                  className={cn(
                    "flex min-w-0 flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors enabled:cursor-pointer",
                    selected
                      ? "border-input-border-focused bg-surface-hover"
                      : "border-border bg-surface hover:border-input-border-focused",
                    (isRunning || isStarting) && "opacity-60",
                  )}
                  onClick={() => setBindMode(entry.mode)}
                >
                  <span className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
                    {selected ? <Check className="size-3.5 text-primary" /> : null}
                    {intl.formatMessage({ id: entry.titleId })}
                  </span>
                  <span className="text-ui-base/relaxed text-foreground-subtle">
                    {intl.formatMessage({ id: entry.descriptionId })}
                  </span>
                </button>
              );
            })}
          </div>

          {isRunning ? (
            <div className="grid min-w-0 gap-3">
              {qrDataUrl ? (
                // Bugfix: 二维码面板是 grid 项,self-center 只做纵向居中,横向会被拉伸到整条轨道,
                // 220px 的二维码外面就会出现一个大白框。justify-self-center 让面板按内容定宽并水平居中。
                <div className="flex flex-col items-center gap-2 justify-self-center rounded-xl border border-border bg-white p-3">
                  <img src={qrDataUrl} alt="" className="size-[220px]" />
                  <span className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "webRemoteControl.direct.scanHint" })}
                  </span>
                </div>
              ) : (
                <div className="flex h-[252px] items-center justify-center justify-self-center">
                  <QrCode className="size-8 animate-pulse text-foreground-subtle" />
                </div>
              )}

              {pairingUrl ? (
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                  <Link2 className="size-3.5 shrink-0 text-foreground-subtle" />
                  <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground-subtle">
                    {pairingUrl}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5 enabled:cursor-pointer"
                    onClick={() => void handleCopy()}
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {intl.formatMessage({
                      id: copied
                        ? "webRemoteControl.direct.copied"
                        : "webRemoteControl.direct.copyLink",
                    })}
                  </Button>
                </div>
              ) : null}

              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="text-ui-base/relaxed text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "webRemoteControl.direct.connectedClients" },
                    { count: status.connectedClients },
                  )}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 enabled:cursor-pointer"
                  disabled={busy}
                  onClick={() => void handleStop()}
                >
                  <Square className="size-3.5" />
                  {intl.formatMessage({ id: "webRemoteControl.direct.stop" })}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full justify-center gap-2 enabled:cursor-pointer"
              disabled={isStarting}
              onClick={() => void handleStart()}
            >
              {isStarting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <QrCode className="size-3.5" />
              )}
              {intl.formatMessage({
                id: isStarting
                  ? "webRemoteControl.direct.starting"
                  : "webRemoteControl.direct.start",
              })}
            </Button>
          )}

          {status.state === "error" && status.error ? (
            <p className="text-ui-base/relaxed text-danger">{status.error}</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
