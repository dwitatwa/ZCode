import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,") },
}));

// 视觉回归守卫:jsdom 不做布局,所以用源码断言锁住决定布局的那几个类名。
// 上一轮远控弹窗变形就是因为这类守卫随云端 relay 一起被删掉了。
function readSource(relativePath: string) {
  return readFileSync(relativePath, "utf8");
}

function renderDialog() {
  return renderToStaticMarkup(
    createElement(WebRemoteControlDialog, {
      open: true,
      onOpenChange: () => {},
      workspacePath: "/tmp/workspace",
    }),
  );
}

describe("WebRemoteControlDialog single-panel layout", () => {
  it("renders exactly one panel and keeps the direct connection section", () => {
    const html = renderDialog();

    expect(html.match(/data-testid="web-remote-control-panel"/g)).toHaveLength(1);
    expect(html).toContain("webRemoteControl.direct.title");
  });

  it("renders no bot channel entry, description, or management control", () => {
    const html = renderDialog();

    expect(html).not.toContain("webRemoteControl.botChannel");
    expect(html).not.toContain("web-remote-control-open-bots");
  });

  it("does not lay the dialog out as a two-column grid", () => {
    const source = readSource("packages/ui/src/WebRemoteControlDialog.tsx");

    expect(source).not.toContain("grid-cols-2");
    expect(source).not.toContain("botChannel");
  });

  it("keeps the QR panel content-sized and horizontally centered", () => {
    const source = readSource("packages/ui/src/DirectMobileConnectionSection.tsx");

    expect(source).toContain(
      "items-center gap-2 justify-self-center rounded-xl border border-border bg-white p-3",
    );
    // self-center 在 grid 项上是 align-self,只做纵向居中,横向仍会被拉伸到整条轨道。
    expect(source).not.toContain("items-center gap-2 self-center");
    expect(source).not.toContain("justify-center self-center");
  });

  it("guards the panel and its wide rows against overflow", () => {
    const source = readSource("packages/ui/src/DirectMobileConnectionSection.tsx");

    expect(source).toContain("flex min-w-0 flex-col rounded-xl border border-border bg-card p-4");
    expect(source).toContain(
      "flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2",
    );
    expect(source).toContain("flex min-w-0 items-center justify-between gap-2");
    expect(source).toContain("grid min-w-0 gap-2 sm:grid-cols-2");
  });
});
