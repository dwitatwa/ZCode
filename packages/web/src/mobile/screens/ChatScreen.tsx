/**
 * Chat 屏：桌面聊天区（SessionPane）整块嵌入。
 *
 * 行渲染、composer、触发面板、发送链路全部是桌面那一套 —— V4ChatPane 就是桌面
 * 自己的手机远控壳在用的组件（WorkspaceShellLayout 同款），所以桌面长什么样
 * 手机就长什么样。手机只保留自己的外壳：头部（标题/元信息/返回/任务信息）。
 *
 * 数据不再由手机轮询快照投影：pane 内部有自己的 v4 订阅（V4ConversationProvider
 * → SessionDataLayer），与桌面同一链路。
 */
import { useCallback } from "react";
import { ChevronLeft, Info } from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { folderName } from "../lib/chatFormat.js";
import { ConversationHost, DesktopChatPane } from "../components/DesktopConversationBody.js";
import "../chatScreen.css";

export function ChatScreen({
  accessor,
  meta,
  onBack,
  onOpenInfo,
  onSessionCreated,
}: {
  accessor: IServiceAccessor;
  meta: ZCodeTaskMeta;
  onBack: () => void;
  onOpenInfo: () => void;
  /** 桌面 pane 首发建成真实 session 后回报；入口用来刷新任务列表。 */
  onSessionCreated: (sessionId: string) => void;
}) {
  const handleSessionCreated = useCallback(
    (sessionId: string) => {
      onSessionCreated(sessionId);
    },
    [onSessionCreated],
  );

  return (
    <div className="cs">
      <header className="cs-head">
        <div className="cs-head-top">
          <button className="cs-back" onClick={onBack} aria-label="Back">
            <ChevronLeft size={19} />
          </button>
          <span className="cs-kicker">Conversation</span>
          <button className="cs-info" onClick={onOpenInfo} aria-label="Task info">
            <Info size={16} />
          </button>
        </div>

        <h1 className="cs-title">{meta.title}</h1>

        {/* 元数据一行：项目。轮数/运行态交给 pane 的正文表达，头部不再重复。 */}
        <div className="cs-meta">
          <span className="cs-meta-project">{folderName(meta.workspacePath)}</span>
        </div>
      </header>

      <ChatScreenBody accessor={accessor} meta={meta} onSessionCreated={handleSessionCreated} />
    </div>
  );
}

/**
 * 会话正文。
 *
 * 宿主 provider 栈与桌面 pane 之间隔一个 ConversationHost：pane 里所有组件都从
 * Service / Platform / Store / TabStore / Intl / Tooltip 取 context，缺一层就在
 * 渲染期抛错整屏白掉。
 */
function ChatScreenBody({
  accessor,
  meta,
  onSessionCreated,
}: {
  accessor: IServiceAccessor;
  meta: ZCodeTaskMeta;
  onSessionCreated: (sessionId: string) => void;
}) {
  return (
    <ConversationHost services={accessor}>
      <div className="cs-body-wrap">
        <DesktopChatPane
          workspacePath={meta.workspacePath}
          workspaceIdentity={meta.workspaceIdentity}
          sessionId={meta.taskId}
          onSessionCreated={onSessionCreated}
        />
      </div>
    </ConversationHost>
  );
}
