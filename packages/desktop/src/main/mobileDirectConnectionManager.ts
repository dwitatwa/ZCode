import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { app, BrowserWindow, MessageChannelMain } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  createStoppedMobileDirectConnectionStatus,
  type MobileDirectConnectionStatus,
  type ServerRemoteWorkspaceInfo,
  type StartMobileDirectConnectionRequest,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { attachMobileDirectClient, type MobileDirectAttachHandle } from "./mobileDirectBridge.js";
import { startMobileDirectServer, type MobileDirectServerHandle } from "./mobileDirectServer.js";

/**
 * 直连移动远控的生命周期编排。
 *
 * 一个 Desktop 进程同时只允许一条直连监听(避免多窗口各自开端口导致 token/二维码歧义);
 * 监听归属于「启动它的那个窗口」的 Host,窗口关闭即停止。
 */

export interface MobileDirectConnectionManagerOptions {
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  /** 窗口当前打开的 workspace 路径集合(renderer 通过 SyncWindowTabs 同步)。 */
  windowWorkspaceMap: Map<number, Set<string>>;
  /** 解析已构建的 @zcode/web dist 目录(含 mobile.html)。找不到时返回 null。 */
  resolveMobileDistRoot: () => string | null;
  onStatusChanged?: (status: MobileDirectConnectionStatus) => void;
}

export interface MobileDirectConnectionManager {
  start(request: StartMobileDirectConnectionRequest): Promise<MobileDirectConnectionStatus>;
  stop(): Promise<MobileDirectConnectionStatus>;
  getStatus(): MobileDirectConnectionStatus;
  /** 窗口关闭时调用;只有当监听属于该窗口时才停止。 */
  handleWindowClosed(webContentsId: number): void;
  disposeAll(): Promise<void>;
}

/**
 * 解析移动端静态资源目录。
 *
 * 打包态由 electron-builder 把 web dist 放进 resources/mobile-web;
 * 开发态 app.getAppPath() 指向 packages/desktop(dev.mjs 以 "." 启动),所以要回到
 * packages/web/dist。两个布局(仓库根/packages/desktop)都枚举,任一存在即用,
 * 都不存在则明确报错而不是静默返回空页面。
 */
export function resolveDefaultMobileDistRoot(overrides?: {
  resourcesPath?: string | undefined;
  appPath?: string;
  cwd?: string;
}): string | null {
  const resourcesRoot =
    overrides?.resourcesPath ??
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const appPath = overrides?.appPath ?? app.getAppPath();
  const cwd = overrides?.cwd ?? process.cwd();

  const candidates: string[] = [];
  if (resourcesRoot) {
    candidates.push(join(resourcesRoot, "mobile-web"));
  }
  // 开发态:appPath=packages/desktop → packages/web/dist;再从仓库根兜底。
  candidates.push(join(appPath, "..", "web", "dist"));
  candidates.push(join(appPath, "..", "..", "packages", "web", "dist"));
  candidates.push(join(cwd, "packages", "web", "dist"));
  candidates.push(join(cwd, "..", "web", "dist"));
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, "mobile.html"))) {
        return candidate;
      }
    } catch {
      /* 继续下一个候选 */
    }
  }
  return null;
}

/**
 * 解析窗口当前打开的全部 workspace。
 *
 * 旧实现只取集合里的第一个路径,于是手机端无论桌面开了几个项目都只看到一个 ——
 * 这正是「为什么只显示一个项目」的根因。现在把整个集合暴露出去,顺序保持插入序
 * (renderer 通过 SyncWindowTabs 同步的就是这个顺序),第一项即手机端默认选中项。
 *
 * 取不到任何路径时回退到进程目录,保证至少有一个可用的 workspace,手机不会白屏。
 */
function resolveWindowWorkspaces(
  win: BrowserWindow,
  windowWorkspaceMap: Map<number, Set<string>>,
): ServerRemoteWorkspaceInfo[] {
  const paths = windowWorkspaceMap.get(win.id);
  const usable = paths
    ? Array.from(paths)
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
    : [];
  if (usable.length === 0) {
    const fallback = process.cwd();
    return [{ path: fallback, label: basename(fallback) || fallback }];
  }
  return usable.map((path) => ({
    path,
    label: basename(path) || path,
  }));
}

export function createMobileDirectConnectionManager(
  options: MobileDirectConnectionManagerOptions,
): MobileDirectConnectionManager {
  let server: MobileDirectServerHandle | null = null;
  let attach: MobileDirectAttachHandle | null = null;
  let ownerWebContentsId: number | null = null;
  let currentStatus: MobileDirectConnectionStatus = createStoppedMobileDirectConnectionStatus();
  let startInFlight: Promise<MobileDirectConnectionStatus> | null = null;

  const publish = (next: MobileDirectConnectionStatus): void => {
    currentStatus = next;
    options.onStatusChanged?.(next);
  };

  const refreshConnectedClients = (): void => {
    if (!attach || currentStatus.state !== "running") return;
    const connectedClients = attach.attachment.connectionCount;
    if (connectedClients === currentStatus.connectedClients) return;
    publish({ ...currentStatus, connectedClients });
  };

  const teardown = async (): Promise<void> => {
    const stoppingServer = server;
    const stoppingAttach = attach;
    server = null;
    attach = null;
    ownerWebContentsId = null;

    stoppingAttach?.attachment.dispose();
    if (stoppingServer) {
      await stoppingServer.close().catch((error: unknown) => {
        logger.warn("failed to close mobile direct server", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const stop = async (): Promise<MobileDirectConnectionStatus> => {
    // 若启动仍在进行,先等它落定再拆,避免拿到半个 server 句柄。
    if (startInFlight) {
      await startInFlight.catch(() => undefined);
    }
    await teardown();
    publish(createStoppedMobileDirectConnectionStatus(currentStatus.bindMode));
    return currentStatus;
  };

  const start = async (
    request: StartMobileDirectConnectionRequest,
  ): Promise<MobileDirectConnectionStatus> => {
    if (startInFlight) {
      return startInFlight;
    }
    if (currentStatus.state === "running" && server) {
      return currentStatus;
    }

    const run = async (): Promise<MobileDirectConnectionStatus> => {
      const distRoot = options.resolveMobileDistRoot();
      if (!distRoot) {
        const status: MobileDirectConnectionStatus = {
          state: "error",
          bindMode: request.bindMode,
          connectedClients: 0,
          error: "未找到移动端界面资源(web/dist/mobile.html)。请先构建 @zcode/web。",
        };
        publish(status);
        return status;
      }

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      if (!win || win.isDestroyed()) {
        const status: MobileDirectConnectionStatus = {
          state: "error",
          bindMode: request.bindMode,
          connectedClients: 0,
          error: "没有可用窗口,无法建立直连。",
        };
        publish(status);
        return status;
      }

      const hostProcess = options.windowHostProcessMap.get(win.webContents.id);
      if (!hostProcess || hostProcess.pid == null) {
        const status: MobileDirectConnectionStatus = {
          state: "error",
          bindMode: request.bindMode,
          connectedClients: 0,
          error: "当前窗口的 Host 尚未就绪,请稍后重试。",
        };
        publish(status);
        return status;
      }

      publish({ state: "starting", bindMode: request.bindMode, connectedClients: 0 });

      const attachHandle = attachMobileDirectClient({
        win,
        hostProcess,
        createMessageChannel: () => new MessageChannelMain(),
        logger: {
          info: (message, meta) => logger.info(message, meta),
          warn: (message, meta) => logger.warn(message, meta),
        },
        onClosed: refreshConnectedClients,
      });

      let startedServer: MobileDirectServerHandle;
      try {
        startedServer = await startMobileDirectServer({
          staticRoot: distRoot,
          bindMode: request.bindMode,
          ...(request.port ? { port: request.port } : {}),
          // 每次请求现取窗口的 workspace 集合,桌面新开的项目手机刷新即可见。
          resolveWorkspaces: () => resolveWindowWorkspaces(win, options.windowWorkspaceMap),
          serverName: "ZCode Desktop",
          onSocket: (socket) => attachHandle.connectSocket(socket),
          logger: {
            info: (message, meta) => logger.info(message, meta),
            warn: (message, meta) => logger.warn(message, meta),
          },
        });
      } catch (error) {
        attachHandle.attachment.dispose();
        const status: MobileDirectConnectionStatus = {
          state: "error",
          bindMode: request.bindMode,
          connectedClients: 0,
          error: error instanceof Error ? error.message : String(error),
        };
        publish(status);
        return status;
      }

      server = startedServer;
      attach = attachHandle;
      ownerWebContentsId = win.webContents.id;

      const status: MobileDirectConnectionStatus = {
        state: "running",
        bindMode: request.bindMode,
        baseUrl: startedServer.baseUrl,
        pairingUrl: startedServer.pairingUrl,
        token: startedServer.token,
        connectedClients: 0,
      };
      publish(status);
      return status;
    };

    startInFlight = run().finally(() => {
      startInFlight = null;
    });
    return startInFlight;
  };

  return {
    start,
    stop,
    getStatus: () => currentStatus,
    handleWindowClosed: (webContentsId: number) => {
      if (ownerWebContentsId !== webContentsId) return;
      void stop();
    },
    disposeAll: async () => {
      await teardown();
      publish(createStoppedMobileDirectConnectionStatus(currentStatus.bindMode));
    },
  };
}