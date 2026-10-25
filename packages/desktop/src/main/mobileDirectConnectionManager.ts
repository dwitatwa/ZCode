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
import type { WindowWorkspaceEntryMap } from "./windowWorkspaceEntries.js";

/**
 * 直连移动远控的生命周期编排。
 *
 * 一个 Desktop 进程同时只允许一条直连监听(避免多窗口各自开端口导致 token/二维码歧义);
 * 监听归属于「启动它的那个窗口」的 Host,窗口关闭即停止。
 */

export interface MobileDirectConnectionManagerOptions {
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  /** 窗口当前打开的 workspace 条目(renderer 通过 SyncWindowTabs 同步,含远端身份)。 */
  windowWorkspaceEntryMap: WindowWorkspaceEntryMap;
  /** 把远端 workspace 条目解析成可 attach 的 logical session;不可用时给出拒绝原因。 */
  resolveRemoteSessionForWorkspace: (
    win: BrowserWindow,
    params: { workspacePath: string; workspaceIdentity: string },
  ) => RemoteSessionResolution;
  /** 解析已构建的 @zcode/web dist 目录(含 mobile.html)。找不到时返回 null。 */
  resolveMobileDistRoot: () => string | null;
  onStatusChanged?: (status: MobileDirectConnectionStatus) => void;
}

/** 远端 workspace 的解析结果:成功给出 sessionId,失败给出可读原因。 */
export type RemoteSessionResolution =
  | { ok: true; remoteSessionId: string; workspacePath: string; workspaceIdentity: string }
  | { ok: false; code: "REMOTE_SESSION_MISSING" | "REMOTE_SESSION_OFFLINE"; message: string };

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
 * 远端条目带上 workspaceIdentity,手机才能请求到对应的 runtime;没有可用条目时
 * 返回空列表 —— 之前回退到进程目录会让手机显示一个并不属于用户的「项目」。
 *
 * 远端条目同时带上不可用原因:WSL 会话按空闲回收,所以「列出来时还在、点它时已经断了」
 * 是常态。把状态一起发出去,手机才能在选择器里就把它标成不可用,而不是先连上、
 * 再在 socket 已 open 之后收到拒绝(那时客户端已经把连接当成成功了)。
 */
function resolveWindowWorkspaces(
  win: BrowserWindow,
  options: Pick<
    MobileDirectConnectionManagerOptions,
    "windowWorkspaceEntryMap" | "resolveRemoteSessionForWorkspace"
  >,
): ServerRemoteWorkspaceInfo[] {
  const entries = options.windowWorkspaceEntryMap.get(win.id) ?? [];
  return entries
    .filter((entry) => entry.path.trim().length > 0)
    .map((entry) => {
      const base = {
        path: entry.path,
        label: entry.label || basename(entry.path) || entry.path,
      };
      if (!entry.workspaceIdentity) return base;
      const resolved = options.resolveRemoteSessionForWorkspace(win, {
        workspacePath: entry.path,
        workspaceIdentity: entry.workspaceIdentity,
      });
      return {
        ...base,
        workspaceIdentity: entry.workspaceIdentity,
        ...(resolved.ok ? {} : { unavailableCode: resolved.code }),
      };
    });
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
          // 每次请求现取窗口的 workspace 条目,桌面新开的项目手机刷新即可见。
          resolveWorkspaces: () => resolveWindowWorkspaces(win, options),
          serverName: "ZCode Desktop",
          // 手机只报 workspace identity;这里解析成 remote scope,解析不了就拒绝连接。
          resolveSocketScope: (workspaceIdentity) => {
            if (!workspaceIdentity) return { ok: true, scope: { kind: "local" } };
            const entry = (options.windowWorkspaceEntryMap.get(win.id) ?? []).find(
              (candidate) => candidate.workspaceIdentity === workspaceIdentity,
            );
            if (!entry) {
              return {
                ok: false,
                message: "请求的 workspace 不在当前窗口中。",
              };
            }
            const resolved = options.resolveRemoteSessionForWorkspace(win, {
              workspacePath: entry.path,
              workspaceIdentity,
            });
            if (!resolved.ok) return { ok: false, message: resolved.message };
            return {
              ok: true,
              scope: {
                kind: "remote",
                remoteSessionId: resolved.remoteSessionId,
                workspacePath: resolved.workspacePath,
                workspaceIdentity: resolved.workspaceIdentity,
              },
            };
          },
          onSocket: (socket, scope) => attachHandle.connectSocket(socket, scope),
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