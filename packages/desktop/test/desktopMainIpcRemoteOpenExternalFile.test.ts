import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

type IpcHandler = (...args: unknown[]) => unknown;
type RemoteIpcOptions = Parameters<
  typeof import("../src/main/desktopMainIpcRemote.js").registerRemoteIpcHandlers
>[0];

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  shellOpenExternal: vi.fn(),
  shellOpenPath: vi.fn(),
  configureRemoteUsageArmsTelemetry: vi.fn(),
  reportRemoteConnectResultToArms: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => h.listeners.set(channel, handler)),
  },
  shell: {
    openExternal: h.shellOpenExternal,
    openPath: h.shellOpenPath,
  },
}));

vi.mock("../src/main/desktopNotifications.js", () => ({
  dispatchTaskNotification: vi.fn(),
}));

vi.mock("../src/main/desktopOAuthDeepLink.js", () => ({
  clearOAuthRoutesForWindow: vi.fn(),
  deliverPendingDeepLink: vi.fn(() => false),
  parseOAuthStateRegistration: vi.fn(),
  registerOAuthState: vi.fn(),
}));

vi.mock("../src/main/desktopArmsCustomEvent.js", () => ({
  createFinalArmsCustomEventE2EController: vi.fn(),
  dispatchFinalArmsCustomEvent: vi.fn(),
}));

vi.mock("../src/main/desktopRemoteUsageArmsTelemetry.js", () => ({
  configureRemoteUsageArmsTelemetry: h.configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms: h.reportRemoteConnectResultToArms,
}));

function createOptions(): RemoteIpcOptions {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    appTelemetryRuntime: {
      onRendererReady: vi.fn(),
      syncRendererContext: vi.fn(),
      onOAuthCallbackHandled: vi.fn(),
    },
    appTelemetryCore: {
      reportEvent: vi.fn(async () => {}),
    },
    reportRemoteUsageEvent: vi.fn(),
    armsCustomContext: {
      deviceMid: "device-mid",
      platform: "darwin",
      appVersion: "1.0.0",
      armsEnv: "local",
    },
    createRemoteWorkspaceSession: vi.fn(async () => "remote-session-1"),
    disposeRemoteWorkspaceSession: vi.fn(),
    cancelPendingRemoteWorkspaceSessionsForWindow: vi.fn(),
    bindRemoteWorkspaceSessionContext: vi.fn(),
    confirmRendererAttachmentReady: vi.fn(),
    getRemoteConnectionStats: vi.fn(() => ({
      activeSessionCount: 0,
      activeTargetCount: 0,
    })),
    isDockerDaemonAvailable: vi.fn(async () => true),
    listAvailableWSLDistros: vi.fn(async () => []),
    listAvailableDockerContainers: vi.fn(async () => []),
    listSSHConfigAliases: vi.fn(async () => []),
  };
}

async function registerOpenExternalListener() {
  const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
  const options = createOptions();
  registerRemoteIpcHandlers(options);
  const listener = h.listeners.get(PlatformChannels.OpenExternal);
  expect(listener).toBeDefined();
  return { listener: listener!, options };
}

describe("OpenExternal 对 file URL 的分流", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
    h.shellOpenExternal.mockReset().mockResolvedValue(undefined);
    h.shellOpenPath.mockReset().mockResolvedValue("");
  });

  it("中文与空格的 file URL 走 shell.openPath 且收到解码后的本地路径", async () => {
    const { listener } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    listener({ sender }, "file:///E:/04%20%E7%B4%A0%E6%9D%90/page.html");

    await vi.waitFor(() => expect(h.shellOpenPath).toHaveBeenCalledTimes(1));
    expect(h.shellOpenPath).toHaveBeenCalledWith(expect.stringContaining("04 素材"));
    expect(h.shellOpenPath).toHaveBeenCalledWith(expect.stringContaining("page.html"));
    expect(h.shellOpenPath).not.toHaveBeenCalledWith(expect.stringContaining("%"));
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("带锚点的 file URL 剥掉 hash 后仍走 shell.openPath", async () => {
    const { listener } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };
    // 用真实临时路径构造 file URL：Windows 上 file:///tmp/... 不是绝对路径，
    // fileURLToPath 会抛 "File URL path must be absolute"，用例会落到 warn 分支。
    const target = join(tmpdir(), "report.html");

    listener({ sender }, `${pathToFileURL(target).href}#section`);

    await vi.waitFor(() => expect(h.shellOpenPath).toHaveBeenCalledTimes(1));
    const openedPath = String(h.shellOpenPath.mock.calls[0]?.[0]);
    expect(openedPath).toContain("report.html");
    expect(openedPath).not.toContain("#");
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("http URL 仍走 shell.openExternal", async () => {
    const { listener } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    listener({ sender }, "https://example.com/docs");

    await vi.waitFor(() => expect(h.shellOpenExternal).toHaveBeenCalledTimes(1));
    expect(h.shellOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(h.shellOpenPath).not.toHaveBeenCalled();
  });

  it("file URL 无法转换为本地路径时记录 warn 且不回退到 shell.openExternal", async () => {
    const { listener, options } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    // 相对 file URL 在两个平台都转换失败（"File URL path must be absolute"），用例因此跨平台一致。
    listener({ sender }, "file:relative/page.html");

    await vi.waitFor(() => expect(options.logger.warn).toHaveBeenCalledTimes(1));
    expect(h.shellOpenPath).not.toHaveBeenCalled();
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "带 host 的 file URL 在 POSIX 上无法转换为本地路径并记录 warn",
    async () => {
      const { listener, options } = await registerOpenExternalListener();
      const sender = { getURL: vi.fn(() => "about:blank") };

      // Windows 把带 host 的 file URL 解析为 UNC 路径（\\server\share\...），是可打开的本地路径；
      // 产品内的 realpath 解析不存在的网络主机要阻塞约 21s，无法在用例时限内断言，故只在 POSIX 运行。
      listener({ sender }, "file://server/share/page.html");

      await vi.waitFor(() => expect(options.logger.warn).toHaveBeenCalledTimes(1));
      expect(h.shellOpenPath).not.toHaveBeenCalled();
      expect(h.shellOpenExternal).not.toHaveBeenCalled();
    },
  );
});
