/**
 * ZCode Mobile — 三屏结构（/mobile.html）：
 *   Explorer：项目选择 + 任务列表（新建 / 归档 / 删除 / 归档区管理）
 *   Chat：快照轮询会话 + composer（Access / Model / Thinking 选择器）
 *   Info：上下文 / 缓存 / 子代理 / workflow / 用量 / 诊断
 * 单条 WS（connectViaWebSocket）承载全部 RPC；三屏常驻，用 display 切换以保留
 * 滚动位置与 composer 草稿。轮询节奏：任务列表 8s、快照 3s、Info 专属 RPC 5s（仅可见时）。
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { connectMobile, fetchServerInfo, type MobileWorkspaceInfo } from "./lib/connection.js";
import { emptyDraft, type ComposerDraft, type MobileTaskSnapshot } from "./lib/types.js";
import { ExplorerScreen } from "./screens/ExplorerScreen.js";
import { ChatScreen } from "./screens/ChatScreen.js";
import { InfoScreen } from "./screens/InfoScreen.js";

const servicesRef: { current: IServiceAccessor | null } = { current: null };

type Phase = "connecting" | "ready" | "error";
type Tab = "explorer" | "chat" | "info";

function TabBar({
  tab,
  onTab,
  hasTask,
  pendingCount,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  hasTask: boolean;
  pendingCount: number;
}) {
  const item = (id: Tab, icon: string, label: string, disabled: boolean, dot = false) => (
    <button
      className={`tab${tab === id ? " active" : ""}`}
      disabled={disabled}
      onClick={() => onTab(id)}
    >
      <span className="tab-icon">
        {icon}
        {dot ? <span className="tab-dot" /> : null}
      </span>
      <span className="tab-label">{label}</span>
    </button>
  );
  return (
    <nav className="tabbar">
      {item("explorer", "📁", "Explorer", false)}
      {item("chat", "💬", "Chat", !hasTask)}
      {item("info", "ℹ️", "Info", !hasTask, pendingCount > 0)}
    </nav>
  );
}

function MobileApp() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const [workspaces, setWorkspaces] = useState<MobileWorkspaceInfo[]>([]);
  const [workspaceIndex, setWorkspaceIndex] = useState(0);
  const [tasks, setTasks] = useState<ZCodeTaskMeta[]>([]);
  const [activeTask, setActiveTask] = useState<ZCodeTaskMeta | null>(null);
  const [snapshot, setSnapshot] = useState<MobileTaskSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("explorer");
  const [draft, setDraft] = useState<ComposerDraft>(emptyDraft());
  const [creating, setCreating] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // 启动：server-info 与 WS 连接并行；server-info 失败不阻塞连接（ready 后会重试）。
  useEffect(() => {
    let disposed = false;
    void fetchServerInfo()
      .then((info) => {
        if (!disposed && info.workspaces?.length) setWorkspaces(info.workspaces);
      })
      .catch(() => {
        // ready 后的重试循环会兜底
      });
    connectMobile()
      .then((accessor) => {
        if (disposed) return;
        servicesRef.current = accessor;
        setPhase("ready");
      })
      .catch((error) => {
        if (disposed) return;
        setPhase("error");
        setErrorMsg(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
    };
  }, []);

  // server-info 兜底重试：连上了但还没拿到 workspace 时每 5s 拉一次。
  useEffect(() => {
    if (phase !== "ready" || workspaces.length > 0) return;
    const timer = setInterval(() => {
      void fetchServerInfo()
        .then((info) => {
          if (info.workspaces?.length) setWorkspaces(info.workspaces);
        })
        .catch(() => {
          // 下一轮重试
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [phase, workspaces.length]);

  const workspace = workspaces[workspaceIndex] ?? null;

  // 任务列表轮询（8s）；有打开的任务时暂停。
  useEffect(() => {
    if (phase !== "ready" || !workspace || activeTask) return;
    const service = servicesRef.current?.zcodeTaskService;
    if (!service) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await service.listTasks({
          workspacePath: workspace.path,
          workspaceIdentity: workspace.workspaceIdentity,
        });
        if (!cancelled) setTasks(list);
      } catch {
        // 静默重试
      }
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, workspace, activeTask, reloadTick]);

  // 活动任务快照轮询（3s）；Chat 与 Info 共用这一份。
  useEffect(() => {
    if (phase !== "ready" || !activeTask) return;
    const service = servicesRef.current?.zcodeTaskService;
    if (!service) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const snap = await service.getTaskSnapshot({
          taskId: activeTask.taskId,
          workspacePath: activeTask.workspacePath,
          workspaceIdentity: activeTask.workspaceIdentity,
          clientMode: "web-remote-replayable",
        });
        if (!cancelled && snap) setSnapshot(snap);
      } catch {
        // 静默，下一轮重试
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, activeTask]);

  // 切换任务时清空 composer 草稿覆盖。
  useEffect(() => {
    setDraft(emptyDraft());
    setSnapshot(null);
  }, [activeTask?.taskId]);

  const openTask = (meta: ZCodeTaskMeta) => {
    setActiveTask(meta);
    setTab("chat");
  };

  const createTask = async () => {
    if (!workspace || !servicesRef.current || creating) return;
    setCreating(true);
    try {
      const service = servicesRef.current.zcodeTaskService;
      const created = await service.createTask({
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
        // 首发前的空 session 不落库，session_input 有 session 外键；deferred 让 V4
        // admission 在首发时先持久化 session 主记录，否则首条 prompt 稳定触发
        // FOREIGN KEY constraint failed（与 automation / 闲时任务同款修复）。
        deferPersistenceUntilFirstPrompt: true,
      });
      setTasks((current) => [created, ...current]);
      openTask(created);
    } catch (error) {
      alert(`Create failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreating(false);
    }
  };

  const switchWorkspace = (index: number) => {
    setWorkspaceIndex(index);
    setTasks([]);
    setActiveTask(null);
    setSnapshot(null);
    setTab("explorer");
  };

  const pendingCount = snapshot?.runtime?.pendingPermissions?.length ?? 0;

  if (phase === "connecting") {
    return <div className="empty">Connecting…</div>;
  }
  if (phase === "error") {
    return (
      <div className="empty">
        <p>Connection failed.</p>
        <p className="error-detail">{errorMsg}</p>
        <p className="error-detail">
          Open the token link from the server console once, then reload this page.
        </p>
        <button className="retry-btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  const service = servicesRef.current?.zcodeTaskService;
  const agentService = servicesRef.current?.zcodeAgentService ?? null;
  if (!service || !workspace) {
    return (
      <div className="empty">
        <p>No workspace configured on the server.</p>
        <button className="retry-btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="screen-wrap" style={{ display: tab === "explorer" ? "flex" : "none" }}>
        <ExplorerScreen
          service={service}
          workspaces={workspaces}
          workspaceIndex={workspaceIndex}
          onWorkspaceIndexChange={switchWorkspace}
          tasks={tasks}
          activeTaskId={activeTask?.taskId ?? null}
          onOpenTask={openTask}
          onCreateTask={() => void createTask()}
          onMutated={() => setReloadTick((tick) => tick + 1)}
          onTaskUnavailable={(taskId) => {
            if (taskId === activeTask?.taskId) {
              setActiveTask(null);
              setSnapshot(null);
            }
          }}
        />
      </div>
      <div className="screen-wrap" style={{ display: tab === "chat" ? "flex" : "none" }}>
        {activeTask && (
          <ChatScreen
            service={service}
            meta={activeTask}
            snapshot={snapshot}
            draft={draft}
            onDraftChange={setDraft}
            onBack={() => setTab("explorer")}
          />
        )}
      </div>
      <div className="screen-wrap" style={{ display: tab === "info" ? "flex" : "none" }}>
        {activeTask && (
          <InfoScreen
            service={service}
            agentService={agentService}
            meta={activeTask}
            snapshot={snapshot}
            visible={tab === "info"}
          />
        )}
      </div>
      <TabBar tab={tab} onTab={setTab} hasTask={activeTask !== null} pendingCount={pendingCount} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
