// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  DialogContent: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement("section", { className }, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    createElement("p", null, children),
  DialogHeader: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement("header", { className }, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") },
}));

const platformMock = vi.hoisted(() => ({
  getMobileDirectConnectionStatus: vi.fn(),
  onMobileDirectConnectionChanged: vi.fn(() => () => {}),
  startMobileDirectConnection: vi.fn(),
  stopMobileDirectConnection: vi.fn(),
}));

vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => platformMock }));

const RUNNING_STATUS = {
  state: "running",
  bindMode: "tailnet",
  baseUrl: "http://127.0.0.1:65105",
  pairingUrl: "http://127.0.0.1:65105/mobile.html?token=test-token",
  token: "test-token",
  connectedClients: 1,
};

const STOPPED_STATUS = { state: "stopped", bindMode: "loopback", connectedClients: 0 };

function renderDialog() {
  return render(
    createElement(WebRemoteControlDialog, {
      open: true,
      onOpenChange: () => {},
      workspacePath: "/tmp/workspace",
    }),
  );
}

describe("WebRemoteControlDialog panel integration", () => {
  afterEach(() => {
    cleanup();
    platformMock.getMobileDirectConnectionStatus.mockReset();
    platformMock.onMobileDirectConnectionChanged.mockClear();
  });

  it("shows one full-width panel with the start control while the listener is stopped", async () => {
    platformMock.getMobileDirectConnectionStatus.mockResolvedValue(STOPPED_STATUS);

    const view = renderDialog();
    await waitFor(() => expect(view.container.textContent).toContain("webRemoteControl.direct"));

    // 单一面板:全文只出现一次面板容器,且不再有第二列。
    expect(view.container.innerHTML.match(/data-testid="web-remote-control-panel"/g)).toHaveLength(1);
    expect(view.container.textContent).toContain("webRemoteControl.direct.start");
    expect(view.container.textContent).toContain("webRemoteControl.direct.bindMode.loopback");
    expect(view.container.textContent).toContain("webRemoteControl.direct.bindMode.tailnet");
    expect(view.container.textContent).not.toContain("webRemoteControl.botChannel");
  });

  it("shows the QR panel, pairing link, and stop control while the listener is running", async () => {
    platformMock.getMobileDirectConnectionStatus.mockResolvedValue(RUNNING_STATUS);

    const view = renderDialog();
    await waitFor(() =>
      expect(view.container.querySelector("img")).not.toBeNull(),
    );

    expect(view.container.innerHTML.match(/data-testid="web-remote-control-panel"/g)).toHaveLength(1);

    // 二维码面板必须按内容定宽并水平居中,否则会横跨整条轨道形成大白框。
    const qrImage = view.container.querySelector("img");
    const qrPanel = qrImage?.parentElement;
    expect(qrPanel?.className).toContain("justify-self-center");
    expect(qrPanel?.className).not.toContain("gap-2 self-center");

    // 配对链接整行、复制按钮、停止按钮与已连接数量都在,没有被裁掉。
    expect(view.container.textContent).toContain("webRemoteControl.direct.copyLink");
    expect(view.container.textContent).toContain("webRemoteControl.direct.stop");
    expect(view.container.textContent).toContain("webRemoteControl.direct.connectedClients");
    expect(view.container.textContent).toContain(RUNNING_STATUS.pairingUrl);
  });

  it("keeps the containment guards on the rendered panel and its wide rows", async () => {
    platformMock.getMobileDirectConnectionStatus.mockResolvedValue(RUNNING_STATUS);

    const view = renderDialog();
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());

    const html = view.container.innerHTML;
    expect(html).toContain("flex min-w-0 flex-col rounded-xl border border-border bg-card p-4");
    expect(html).toContain("flex min-w-0 items-center justify-between gap-2");
    expect(html).toContain("grid min-w-0 gap-2 sm:grid-cols-2");
  });

  it("offers no chat provider entry in either state", async () => {
    for (const status of [STOPPED_STATUS, RUNNING_STATUS]) {
      platformMock.getMobileDirectConnectionStatus.mockResolvedValue(status);

      const view = renderDialog();
      await waitFor(() => expect(view.container.textContent).toContain("webRemoteControl.direct"));

      const text = view.container.textContent ?? "";
      for (const forbidden of [
        "webRemoteControl.botChannel",
        "web-remote-control-open-bots",
        "Telegram",
        "Feishu",
        "Lark",
        "Weixin",
      ]) {
        expect(text).not.toContain(forbidden);
      }

      cleanup();
    }
  });
});
