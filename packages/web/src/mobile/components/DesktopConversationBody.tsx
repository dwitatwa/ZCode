/**
 * 桌面会话渲染器的懒加载外壳。
 *
 * 为什么需要这一层：手机要和桌面**完全一致**地渲染会话，唯一可靠的做法是用桌面那棵
 * ConversationTimeline，而不是在手机上再抄一遍。代价是它会把 streamdown + shiki +
 * katex 以及桌面的 UI 面一起带进来 —— 实测首屏 gzip 从 226KB 涨到 1.6MB。
 *
 * 因此整块（含 provider 栈与 code-preview 默认值）都在一个动态 import 里，
 * 任务列表、项目选择器、任务信息屏都不加载它，只有真正打开一个任务时才拉。
 *
 * ⚠ 两条会让这个拆分失效的写法，都踩过：
 *   1. 从同一模块静态 import 任何**值**（如 DEFAULT_CODE_PREVIEW_SETTINGS）——
 *      打包器会把这个模块拉回入口 chunk，懒加载白做。所以下面那个常量改成在
 *      lazy 内部取。类型 import 不受影响（编译期擦除）。
 *   2. 从 "@zcode/ui" 根 barrel 导入 —— 会带出整个桌面 app shell
 *      （工作台、会话面板、全部 shiki 语法包），实测多付约 1MB gzip。
 */
import { Suspense, lazy, useMemo } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { createMobilePlatform } from "../lib/platform.js";

/**
 * 手机平台能力只构造一次：渲染器把它当稳定引用读（部分 hook 以它为依赖），
 * 每次渲染换新对象会让下游 memo 全部失效。
 */
const mobilePlatform = createMobilePlatform();

/** 懒加载出来的渲染器组件，连同它需要的上下文值。 */
const LazyConversation = lazy(async () => {
  const mod = await import("@zcode/ui/conversation-timeline");
  return { default: mod.ConversationTimeline };
});

/**
 * provider 栈：渲染器向上取 Service / Platform / Store / TabStore / Intl / Tooltip，
 * 缺任一层都会在渲染时抛错（实测报 "useServices 必须在 ServiceProvider 内使用"，
 * 整屏白掉）。整层都跟着渲染器一起懒加载。
 */
const LazyHostProviders = lazy(async () => {
  const mod = await import("@zcode/ui/conversation-host-providers");
  return { default: mod.ConversationHostProviders };
});

export interface DesktopConversationBodyProps {
  rows: readonly ConversationRow[];
  totalCount: number;
  sessionKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  /** 渲染器读它来决定是否显示"打开文件管理器"这类宿主入口。 */
  services: IServiceAccessor;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

/**
 * 会话正文：直接用桌面的行渲染器。
 *
 * rowContext 只填手机真正拥有的能力。桌面专属回调（fork / retry / feedback / edit、
 * 侧栏、预览 tab、代码查看器）一律不传 —— 行渲染器按回调是否存在决定是否显示入口，
 * 手机没有这些命令通路，传了只会出现点了没反应的按钮。
 */
export function DesktopConversationBody({
  rows,
  totalCount,
  sessionKey,
  workspacePath,
  workspaceIdentity,
  sessionId,
  services,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
}: DesktopConversationBodyProps) {
  // rowContext 在本地构造，不依赖懒加载模块，因此引用稳定且不把模块拉回入口。
  const rowContext = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      theme: "zai-dark" as const,
      // 与 DEFAULT_CODE_PREVIEW_SETTINGS 同值。不 import 它是为了让上面那条
      // 动态 import 真正成为唯一入口（见文件头注释第 1 条）。
      codePreviewSettings: {
        lightTheme: "github-light" as const,
        darkTheme: "github-dark" as const,
        showLineNumbers: true,
        wrapLongLines: false,
        fontSizePx: 12,
      },
      sessionId,
      compactForRemoteControl: true,
    }),
    [workspacePath, workspaceIdentity, sessionId],
  );

  return (
    <Suspense fallback={<div className="cs-loading">Loading conversation…</div>}>
      <LazyHostProviders services={services} platform={mobilePlatform}>
        <LazyConversation
          rows={rows}
          totalCount={totalCount}
          sessionKey={sessionKey}
          rowContext={rowContext}
          compactForRemoteControl
          canLoadOlder={canLoadOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlder}
        />
      </LazyHostProviders>
    </Suspense>
  );
}
