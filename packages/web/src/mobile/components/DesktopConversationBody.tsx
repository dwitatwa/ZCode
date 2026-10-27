/**
 * 桌面聊天区（SessionPane）的懒加载外壳。
 *
 * 手机要和桌面**完全一致**的聊天区 —— 行渲染、composer、触发面板、发送链路 ——
 * 唯一可靠的做法是把桌面那整块 V4ChatPane（V4ConversationProvider + SessionPane）
 * 原样搬过来，而不是只搬行渲染器、composer 再自造外壳。此前只搬渲染器时，手机
 * 自造 composer 壳（配置按钮/模型表/发送键）与桌面双轨并行，触发面板锚点、发送
 * 门禁、模型选择各自一套，反复出布局差异；桌面自己的 web-remote-control 手机壳
 * 用的就是这一块（WorkspaceShellLayout → V4ChatPane compactForRemoteControl），
 * 所以手机页也直接用它，桌面长什么样手机就长什么样。
 *
 * ⚠ 两条会让懒加载失效的写法，都踩过：
 *   1. 从同一模块静态 import 任何**值** —— 打包器会把这个模块拉回入口 chunk。
 *      类型 import 不受影响（编译期擦除）。
 *   2. 从 "@zcode/ui" 根 barrel 导入 —— 会带出整个桌面 app shell
 *      （工作台、会话面板、全部 shiki 语法包），实测多付约 1MB gzip。
 */
import { Suspense, lazy, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeProvider } from "@zcode/shared";
import { createMobilePlatform } from "../lib/platform.js";

/**
 * 手机平台能力只构造一次：渲染器把它当稳定引用读（部分 hook 以它为依赖），
 * 每次渲染换新对象会让下游 memo 全部失效。
 */
const mobilePlatform = createMobilePlatform();

const LazyV4ChatPane = lazy(async () => {
  const mod = await import("@zcode/ui/v4-chat-pane");
  return { default: mod.V4ChatPane };
});

/**
 * provider 栈：pane 内的组件向上取 Service / Platform / Store / TabStore /
 * Intl / Tooltip，缺任一层都会在渲染时抛错（实测报 "useServices 必须在
 * ServiceProvider 内使用"，整屏白掉）。整层都跟着 pane 一起懒加载。
 */
const LazyHostProviders = lazy(async () => {
  const mod = await import("@zcode/ui/conversation-host-providers");
  return { default: mod.ConversationHostProviders };
});

export interface DesktopChatPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 任务 id;null = 草稿首发。 */
  sessionId: string | null;
  provider?: ZCodeProvider;
  /**
   * 连接未就绪(远端目标尚未解析等)时渲染的占位;不传保持桌面原行为(渲染 null)。
   */
  pending?: ReactNode;
  /** 会话首发后由桌面 pane 报告真实 session id。 */
  onSessionCreated?: (sessionId: string) => void;
  onSessionDeleted?: () => void;
}

/**
 * 桌面聊天区。
 *
 * compactForRemoteControl 由本壳固定传入：桌面在手机远控壳里也是这一份，
 * 它把 composer 收进手机友好的紧凑排布（Enter 换行、紧凑 placeholder、
 * 防聚焦放大），与桌面远控壳完全同款。
 */
export function DesktopChatPane({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  pending,
  onSessionCreated,
  onSessionDeleted,
}: DesktopChatPaneProps) {
  return (
    <LazyV4ChatPane
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      sessionId={sessionId}
      provider={provider}
      compactForRemoteControl
      pending={pending}
      onSessionCreated={onSessionCreated}
      onSessionDeleted={onSessionDeleted}
    />
  );
}

/**
 * 会话屏的宿主壳：provider 栈。
 *
 * pane 里所有组件都从 Service / Platform / Store / TabStore / Intl / Tooltip 取
 * context，缺一层就在渲染期抛错整屏白掉。栈与 pane 一起懒加载；Suspense 放这里，
 * ChatScreen 只包一层。
 */
export function ConversationHost({
  services,
  children,
}: {
  services: IServiceAccessor;
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<div className="cs-loading">Loading conversation…</div>}>
      <LazyHostProviders services={services} platform={mobilePlatform}>
        {children}
      </LazyHostProviders>
    </Suspense>
  );
}
