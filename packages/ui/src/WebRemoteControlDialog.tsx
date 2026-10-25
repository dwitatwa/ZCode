import { memo } from "react";
import { MonitorSmartphone, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DirectMobileConnectionSection } from "@/DirectMobileConnectionSection.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}) {
  const { intl } = useZCodeIntl();

  const handleDialogOpenChange = (nextOpen: boolean) => {
    logger.info("[WebRemoteControlDialog] 弹层开关状态变化", {
      workspacePath,
      nextOpen,
    });
    onOpenChange(nextOpen);
  };

  const handleDismiss = () => {
    logger.info("[WebRemoteControlDialog] 用户点击右上角关闭按钮", {
      workspacePath,
    });
    handleDialogOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Bugfix: 弹窗复用 Remote Connect 的外层尺寸,但不强制撑满高度;内容自适应避免窗口显得空。
        className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // Bugfix: 弹窗贴近窗口顶部显示,默认 close 在 Electron drag 区里容易点不中,
          // 改成显式点击关闭并标成 no-drag;启用态补手指指针。
          className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
          onClick={handleDismiss}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
        <div
          data-testid="web-remote-control-dialog-scroll"
          className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5"
        >
          <DialogHeader className="space-y-2 pr-8">
            <div className="flex items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                <MonitorSmartphone className="size-5" />
              </div>
              <div className="space-y-1">
                <DialogTitle>
                  {intl.formatMessage({ id: "webRemoteControl.title" })}
                </DialogTitle>
                <DialogDescription>
                  {intl.formatMessage({ id: "webRemoteControl.description" })}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div data-testid="web-remote-control-panel" className="mt-5">
            <DirectMobileConnectionSection />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
