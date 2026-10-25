/**
 * 手机宿主的 IPlatformService 实现。
 *
 * 会话行渲染器从桌面 app 树里长出来，它按需读 `usePlatform()` 决定是否显示
 * "在文件管理器中打开""用编辑器打开""查看反馈"这类入口。手机没有这些能力，
 * 所以这里每个方法都回答"做不到"，渲染器据此不显示对应按钮 —— 这正是我们要的：
 * 不是假装能做然后点了没反应。
 *
 * 只有两件事手机真能做：
 *   - openExternal：交给浏览器开新标签（正文里的链接）；
 *   - showTaskNotification：用浏览器通知，与 web 版同一做法。
 *
 * 任何新增方法都先问一句"手机能实现吗"。不能就返回空结果，别抛错 ——
 * 渲染器在渲染期读这些能力，抛错会让整屏白掉。
 */
import type {
  ArmsCustomEventPayload,
  IPlatformService,
  Locale,
  RendererTelemetryEventPayload,
} from "@zcode/shared";

const NO_SUBSCRIPTION = () => () => {};
const unsupported = (what: string) => Promise.resolve({ success: false, error: what });

export function createMobilePlatform(): IPlatformService {
  return {
    // 手机没有系统文件选择框：选不了路径，也不该出现"选择文件"的入口。
    canSelectFilePath: false,
    selectDirectory: () => Promise.resolve(null),
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,

    // 手机没有本机 shell，这些都做不到。
    openInFileManager: () => unsupported("Not supported on mobile"),
    openExternalFile: () => unsupported("Not supported on mobile"),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => unsupported("Not supported on mobile"),

    // 正文里的链接交给浏览器新标签打开。
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },

    // 反馈与社群入口在手机上不提供：手机是远控界面，不是主客户端。
    openFeedback: () => Promise.resolve(),
    openCommunity: () => Promise.resolve(),
    canOpenCommunity: () => Promise.resolve(false),

    // 浏览器通知：与 web 版同一套判断，页面在前台就不打扰。
    showTaskNotification: (payload) => {
      if (document.hasFocus()) return;
      if (typeof window.Notification === "undefined") return;
      if (window.Notification.permission !== "granted") return;
      try {
        new window.Notification(payload.title, { body: payload.body, silent: true });
      } catch {
        // 通知不可用时静默忽略，不打断主流程
      }
    },

    // 手机不承担任何宿主侧上报：这些事件属于桌面 renderer 的角色。
    reportTelemetryEvent: (_payload: RendererTelemetryEventPayload) => Promise.resolve(),
    reportArmsCustomEvent: (_payload: ArmsCustomEventPayload) => Promise.resolve(),

    // 远程 workspace 的连接由手机自己的 WS 连接层负责，不经过 platform。
    onRemoteConnectionLog: NO_SUBSCRIPTION,
    onRemoteSessionClosed: NO_SUBSCRIPTION,
    onBotRemoteWorkspaceReconnected: NO_SUBSCRIPTION,
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote: () => Promise.resolve({ success: false, error: "Not supported on mobile" }),
    cancelPendingRemoteConnection: () => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),

    // 手机不作为远控发起端。
    startWebRemoteControl: () =>
      Promise.reject(new Error("Web remote control can only be started from desktop")),
    refreshWebRemoteControlPairing: () =>
      Promise.reject(new Error("Web remote control pairing can only be refreshed from desktop")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () => Promise.resolve({ status: "idle" as const }),

    // 手机看不到宿主机器的容器与 SSH 配置。
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),

    // OAuth / 支付 deep link 只存在于桌面壳；手机走普通网页登录。
    registerOAuthState: () => {},
    onOAuthCallback: NO_SUBSCRIPTION,
    onPaymentCallback: NO_SUBSCRIPTION,
    onShareImport: NO_SUBSCRIPTION,
    notifyRendererReady: () => {},

    // 跨窗口 tab 同步与任务栏徽标是桌面窗口概念，手机没有。
    syncWindowTabs: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},

    // 以下都是桌面 main 进程推来的事件，手机没有那条通道。
    onFocusTab: NO_SUBSCRIPTION,
    onNewTab: NO_SUBSCRIPTION,
    onNewTask: NO_SUBSCRIPTION,
    onOpenWorkspace: NO_SUBSCRIPTION,
    onWindowFullscreenChanged: NO_SUBSCRIPTION,
    onTaskNotificationClick: NO_SUBSCRIPTION,

    // 更新器属于桌面壳。
    onUpdateReady: NO_SUBSCRIPTION,
    onUpdateCheckResult: NO_SUBSCRIPTION,
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    onPostUpdateReleaseNotes: NO_SUBSCRIPTION,
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),

    // 桌面命令面板与标题栏主题都只在桌面壳里有意义。
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale: Locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),

    // 日志导出写的是桌面本机目录，手机没有这个落点。
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported on mobile" }),

    // 设备标识沿用浏览器可见的硬件信息，与 web 版一致。
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const parts = [
        nav?.platform ?? "",
        globalThis.screen?.width !== undefined ? String(globalThis.screen.width) : "",
        globalThis.screen?.height !== undefined ? String(globalThis.screen.height) : "",
        globalThis.screen?.colorDepth !== undefined ? String(globalThis.screen.colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}
