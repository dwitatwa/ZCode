/**
 * Chat 屏：活动时间线 + 底部单栏 composer。
 *
 * 数据来自 v4 会话投影（useConversationLive），与桌面同一链路：snapshot + delta，
 * 文本/思考/工具行到达即渲染。旧版的 3s 快照轮询与流式事件过滤已移除 ——
 * 那两条路一个太慢、一个把 agent_message_chunk 等事件直接丢掉。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Lock } from "lucide-react";
import type { IZCodeTaskService } from "@zcode/services";
import type { ModelSelection, ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { timelineIsEmpty } from "../lib/timeline.js";
import { buildTimelineFromRows, anyTurnRunning } from "../lib/projection.js";
import { buildTimelineNav } from "../lib/navigation.js";
import type { ComposerDraft } from "../lib/types.js";
import { newTraceId } from "../lib/connection.js";
import { useToast } from "../components/Overlays.js";
import { Composer, type SubmittableMode } from "../components/Composer.js";
import { Timeline, turnAnchorId } from "../components/Timeline.js";
import { MessageNav } from "../components/MessageNav.js";
import type { ConversationLive } from "../lib/live.js";

const STICK_THRESHOLD_PX = 90;

export function ChatScreen({
  service,
  live,
  meta,
  configOptions,
  draft,
  onDraftChange,
  onBack,
  onMutated,
}: {
  service: IZCodeTaskService;
  live: ConversationLive;
  meta: ZCodeTaskMeta;
  configOptions: ZCodeConfigOption[] | undefined;
  draft: ComposerDraft;
  onDraftChange: (next: ComposerDraft) => void;
  onBack: () => void;
  onMutated: () => void;
}) {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [activeTurnKey, setActiveTurnKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const activeTurnRef = useRef<string | null>(null);

  const rows = live.state?.snapshot?.rows.window ?? null;
  // 运行态取投影的权威 turnHeader.state，不再依赖 3s 任务列表的 meta.status。
  const generating = rows ? anyTurnRunning(rows) : meta.status === "running";

  const turns = useMemo(() => (rows ? buildTimelineFromRows(rows) : []), [rows]);
  const empty = timelineIsEmpty(turns);
  const navItems = useMemo(() => buildTimelineNav(turns, generating), [turns, generating]);

  /**
   * 更新"当前所在轮"。
   *
   * 判定方式：第一个顶边越过滚动容器上沿的 turn 就是当前轮。不能用 IntersectionObserver
   * 的 ratio —— 长 turn 会长时间占据视口，ratio 判出来的"当前"会落后于用户直觉。
   */
  const syncActiveTurn = useCallback(() => {
    const el = scrollRef.current;
    if (!el || navItems.length === 0) return;
    const containerTop = el.getBoundingClientRect().top;
    let current: string | null = navItems[0]?.turnKey ?? null;
    for (const item of navItems) {
      const node = document.getElementById(turnAnchorId(item.turnKey));
      if (!node) continue;
      if (node.getBoundingClientRect().top - containerTop <= 24) {
        current = item.turnKey;
      } else {
        break;
      }
    }
    if (current !== activeTurnRef.current) {
      activeTurnRef.current = current;
      setActiveTurnKey(current);
    }
  }, [navItems]);

  // 新内容到达且用户没往上翻时贴底。generating 也进依赖，保证流式追加时跟随。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    syncActiveTurn();
  }, [rows, generating, syncActiveTurn]);

  const jumpToTurn = useCallback((turnKey: string) => {
    const el = scrollRef.current;
    const node = document.getElementById(turnAnchorId(turnKey));
    if (!el || !node) return;
    // 跳转后不再贴底，否则下一轮投影更新会把用户弹回末尾。
    stickRef.current = false;
    const top =
      el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    el.scrollTo({ top, behavior: "smooth" });
  }, []);

  const hasEarlier = rows !== null && live.state?.snapshot?.rows.firstRowId !== null &&
    (rows[0]?.rowId ?? 0) > (live.state?.snapshot?.rows.firstRowId ?? 0);

  const loadEarlier = useCallback(() => {
    live.loadOlder();
  }, [live]);

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
        stickRef.current = true;
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

  // 正文不再经过快照预算裁剪；保留入口以兼容旧调用点，直接走补拉接口。
  const loadBodyRef = useCallback(
    async (refId: string) => {
      try {
        const body = await service.getTaskSnapshotBody({
          taskId: meta.taskId,
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
          refId,
        });
        if (body && typeof body.content === "string") {
          toast.show("Loaded full message", { tone: "ok" });
        }
      } catch (error) {
        toast.show(`Load failed: ${error instanceof Error ? error.message : String(error)}`, {
          tone: "fail",
        });
      }
    },
    [service, meta, toast],
  );

  const pending = live.state?.snapshot?.pendingInteractions ?? [];
  const connectError = live.state?.status === "error" ? live.state.lastError : null;

  return (
    <>
      <header className="topbar">
        <button className="topbar-back" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <div className="topbar-title">{meta.title}</div>
        {generating ? (
          <span className="topbar-live" title="Running">
            running
          </span>
        ) : null}
      </header>

      {pending.length > 0 ? (
        <div className="perm-banner">
          <Lock size={12} />
          {pending.length} permission request(s) pending — approve in the desktop app
        </div>
      ) : null}

      {connectError ? (
        <div className="perm-banner">
          Live connection failed — <button className="linklike" onClick={live.retry}>retry</button>
        </div>
      ) : null}

      <div className="chat-body">
        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
            syncActiveTurn();
          }}
        >
          {hasEarlier ? (
            <button className="load-earlier" onClick={loadEarlier}>
              Load earlier messages
            </button>
          ) : null}

          {empty ? (
            <div className="empty">
              {rows ? <span>No messages yet.</span> : <span>Loading conversation…</span>}
            </div>
          ) : (
            <Timeline turns={turns} isGenerating={generating} onLoadBodyRef={loadBodyRef} />
          )}
          {generating ? (
            <div className="tl-working">
              <span className="tl-working-dot" />
              working
            </div>
          ) : null}
        </div>

        {!empty ? (
          <MessageNav items={navItems} activeKey={activeTurnKey} onJump={jumpToTurn} />
        ) : null}
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
    </>
  );
}
