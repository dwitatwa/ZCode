/**
 * Chat 屏：会话正文 + 底部单栏 composer。
 *
 * 数据来自 v4 会话投影（useConversationLive），与桌面同一链路：snapshot + delta，
 * 文本/思考/工具行到达即渲染。
 *
 * 正文渲染器就是桌面那一棵（ConversationTimeline，经 DesktopConversationBody 懒加载），
 * 因此行类型、工具卡、代码高亮、流式表现与桌面完全一致。手机只保留自己的外壳：
 * 头部、composer、连接与滚动位置处理。
 */
import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, Info, Lock } from "lucide-react";
import type { IServiceAccessor, IZCodeTaskService } from "@zcode/services";
import type { ModelSelection, ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { anyTurnRunning, rowsAreEmpty } from "../lib/projection.js";
import { folderName, turnCountLabel } from "../lib/chatFormat.js";
import { relativeTime } from "../lib/taskSlot.js";
import type { ComposerDraft } from "../lib/types.js";
import { newTraceId } from "../lib/connection.js";
import { useToast } from "../components/Overlays.js";
import { Composer, type SubmittableMode } from "../components/Composer.js";
import { DesktopConversationBody } from "../components/DesktopConversationBody.js";
import type { ConversationLive } from "../lib/live.js";
import "../chatScreen.css";

export function ChatScreen({
  service,
  accessor,
  live,
  meta,
  configOptions,
  draft,
  onDraftChange,
  onBack,
  onOpenInfo,
  onMutated,
}: {
  service: IZCodeTaskService;
  /** 渲染器向上取的服务面；与 service 同源，但需要整个 accessor。 */
  accessor: IServiceAccessor;
  live: ConversationLive;
  meta: ZCodeTaskMeta;
  configOptions: ZCodeConfigOption[] | undefined;
  draft: ComposerDraft;
  onDraftChange: (next: ComposerDraft) => void;
  onBack: () => void;
  onOpenInfo: () => void;
  onMutated: () => void;
}) {
  const toast = useToast();
  const [sending, setSending] = useState(false);

  const rows = live.state?.snapshot?.rows.window ?? null;
  const totalCount = live.state?.snapshot?.rows.totalCount ?? 0;
  // 运行态取投影的权威 turnHeader.state，不再依赖 3s 任务列表的 meta.status。
  const generating = rows ? anyTurnRunning(rows) : meta.status === "running";
  // 空会话判定只看行，不再先把行投影成手机自有条目 —— 投影层已不参与正文渲染。
  const empty = rows ? rowsAreEmpty(rows) : false;

  const hasEarlier = rows !== null && live.state?.snapshot?.rows.firstRowId !== null &&
    (rows[0]?.rowId ?? 0) > (live.state?.snapshot?.rows.firstRowId ?? 0);

  const loadEarlier = useCallback(() => {
    live.loadOlder();
  }, [live]);

  // 头部显示的是"用户可见的轮数"，不是行数：只有 userInput 行代表一轮问答。
  const turnCount = useMemo(
    () => (rows ? rows.filter((row) => row.kind === "turnHeader").length : 0),
    [rows],
  );

  const send = useCallback(
    async (content: string, modelSelection: ModelSelection | undefined, mode: SubmittableMode) => {
      setSending(true);
      try {
        await service.sendPrompt({
          taskId: meta.taskId,
          traceId: newTraceId(),
          content,
          clientMode: "web-remote-replayable",
          clientLabel: "zcode-mobile",
          ...(modelSelection ? { modelSelection } : {}),
          mode,
        });
        onMutated();
      } catch (error) {
        toast.show(`Send failed: ${error instanceof Error ? error.message : String(error)}`, {
          tone: "fail",
          duration: 4000,
        });
      } finally {
        setSending(false);
      }
    },
    [service, meta, toast, onMutated],
  );

  const stop = useCallback(async () => {
    try {
      await service.stopGeneration({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
    } catch {
      // 静默：投影会反映真实状态
    }
  }, [service, meta]);

  const pending = live.state?.snapshot?.pendingInteractions ?? [];
  const connectError = live.state?.status === "error" ? live.state.lastError : null;

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

        {/* 元数据一行：轮数 · 最后活动 · 项目。运行中整行点亮，头部没有别处放状态。 */}
        <div className={`cs-meta${generating ? " running" : ""}`}>
          <span>{generating ? "running" : turnCountLabel(turnCount)}</span>
          <span className="cs-meta-sep">·</span>
          <span>{relativeTime(meta.updatedAt)}</span>
          <span className="cs-meta-sep">·</span>
          <span className="cs-meta-project">{folderName(meta.workspacePath)}</span>
        </div>
      </header>

      {pending.length > 0 ? (
        <div className="cs-banner">
          <Lock size={11} />
          {pending.length} permission request(s) pending — approve in the desktop app
        </div>
      ) : null}

      {connectError ? (
        <div className="cs-banner">
          Live connection failed —
          <button className="cs-retry" onClick={live.retry}>
            retry
          </button>
        </div>
      ) : null}

      <div className="cs-body-wrap">
        {rows && !empty ? (
          /* 桌面渲染器自带滚动容器与虚拟列表，所以这里不再套 cs-scroll：
             两个滚动所有者会互相抢滚动位置，也会让 sticky-to-bottom 失效。 */
          <DesktopConversationBody
            rows={rows}
            totalCount={totalCount}
            sessionKey={meta.taskId}
            workspacePath={meta.workspacePath}
            workspaceIdentity={meta.workspaceIdentity}
            sessionId={meta.taskId}
            services={accessor}
            canLoadOlder={hasEarlier}
            loadingOlder={live.state?.loadingOlder ?? false}
            onLoadOlder={loadEarlier}
          />
        ) : (
          <div className="cs-empty">
            {rows ? <p>No messages yet.</p> : <p>Loading conversation…</p>}
            {rows ? <span>Send a message to start the first turn</span> : null}
          </div>
        )}
      </div>

      <Composer
        meta={meta}
        configOptions={configOptions}
        draft={draft}
        onDraftChange={onDraftChange}
        generating={generating}
        sending={sending}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
