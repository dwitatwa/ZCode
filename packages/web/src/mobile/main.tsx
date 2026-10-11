/**
 * ZCode Mobile — 应用外壳（/mobile.html）。
 *
 * 结构：一个 WS 连接承载全部 RPC；三个屏常驻，用 display 切换以保留滚动位置
 * 与 composer 草稿状态。底部导航只有两项（Tasks / Info），因为任务是主体，
 * 会话视图本身就在 Tasks 的下一层。
 *
 * 刷新节奏：
 *   任务列表 8s（有打开的任务时暂停）
 *   任务快照 3s（打开任务时）
 *   流式事件：即时增量更新（不等轮询）
 *
 * 屏幕数量刻意压到最少：手机上每多一层导航，回到原处就多一次点击。
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ListTodo, Activity } from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import "./mobile.css";
import {
  connectMobile,
  fetchServerInfo,
  type MobileWorkspaceInfo,
} from "./lib/connection.js";
import { emptyDraft, type ComposerDraft } from "./lib/types.js";
import { useConversationLive } from "./lib/live.js";
import { ToastProvider, useToast } from "./components/Overlays.js";
import { ExplorerScreen } from "./screens/ExplorerScreen.js";
import { ChatScreen } from "./screens/ChatScreen.js";
import { InfoScreen } from "./screens/InfoScreen.js";

type Phase = "connecting" | "ready" | "error";
type Tab = "tasks" | "info";

const TASK_POLL_MS = 8000;
/** composer 配置目录的刷新节奏；不参与时间线渲染。 */
const CONFIG_POLL_MS = 6000;

const servicesRef: { current: IServiceAccessor | null } = { current: null };

function MobileApp() {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const [workspaces, setWorkspaces] = useState<MobileWorkspaceInfo[]>([]);
  const [workspaceIndex, setWorkspaceIndex] = useState(0);
  const [tasks, setTasks] = useState<ZCodeTaskMeta[]>([]);
  const [activeTask, setActiveTask] = useState<ZCodeTaskMeta | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [draft, setDraft] = useState<ComposerDraft>(emptyDraft());
  const [reloadTick, setReloadTick] = useState(0);

  const workspace = workspaces[workspaceIndex] ?? null;
  const service = servicesRef.current?.zcodeTaskService;
  const agentService = servicesRef.current?.zcodeAgentService ?? null;

  /* ------------------------------ 连接 ------------------------------ */

  useEffect(() => {
    let disposed = false;
    // server-info 与 WS 并行；server-info 失败不阻塞连接，ready 后由重试兜底。
    void fetchServerInfo()
      .then((info) => {
        if (!disposed && info.workspaces?.length) setWorkspaces(info.workspaces);
      })
      .catch(() => {
        // 重试循环兜底
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

  // 连上但没拿到 workspace 时每 5s 重试一次 server-info。
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

  /* --------------------------- 任务列表轮询 --------------------------- */

  useEffect(() => {
    if (phase !== "ready" || !workspace || !service || activeTask) return;
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
    const timer = setInterval(poll, TASK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, workspace, service, activeTask, reloadTick]);

  /* --------------------------- 实时会话投影 --------------------------- */
  //
  // 取代原先的「3s 轮询快照 + 过滤流式事件」：那条路径会把 agent_message_chunk /
  // agent_thought_chunk 直接丢掉（isTimelineRelevantEvent 只放行少数结构性事件），
  // 且在事件放行后也只是当作"该重拉快照"的信号。现在直接复用桌面的
  // SessionDataLayer + ConversationProjectionStore，文本/思考/工具行到达即渲染。
  const live = useConversationLive({
    accessor: servicesRef.current,
    workspacePath: activeTask?.workspacePath ?? null,
    workspaceIdentity: activeTask?.workspaceIdentity,
    sessionId: activeTask?.taskId ?? null,
  });

  /* --------------------------- 配置目录（仅 composer 用） --------------------------- */
  //
  // 模型/思考档位的"可选清单"目前只有 legacy task snapshot 携带（v4 投影只给
  // 当前 effective 的 model/provider/thought 与档位，不给跨供应商的模型目录）。
  // 这条轮询只喂 composer 的选择器，不再参与时间线渲染 —— 时间线走上面的投影链路。
  // 6s 足够：清单只在用户切换模型或服务端目录变化时改变。
  const [configOptions, setConfigOptions] = useState<ZCodeConfigOption[] | undefined>(undefined);

  useEffect(() => {
    if (phase !== "ready" || !activeTask || !service) {
      setConfigOptions(undefined);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const snap = await service.getTaskSnapshot({
          taskId: activeTask.taskId,
          workspacePath: activeTask.workspacePath,
          workspaceIdentity: activeTask.workspaceIdentity,
          clientMode: "web-remote-replayable",
        });
        if (!cancelled && snap) setConfigOptions(snap.configOptions);
      } catch {
        // 静默：下一轮重试
      }
    };
    void poll();
    const timer = setInterval(poll, CONFIG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, activeTask, service, reloadTick]);

  // 切换任务时清空草稿（投影租约由 useConversationLive 按 sessionId 自行切换）。
  useEffect(() => {
    setDraft(emptyDraft());
  }, [activeTask?.taskId]);

  /* ------------------------------ 动作 ------------------------------ */

  const openTask = useCallback((meta: ZCodeTaskMeta) => {
    setActiveTask(meta);
  }, []);

  const createTask = useCallback(async () => {
    if (!workspace || !servicesRef.current) return;
    try {
      const created = await servicesRef.current.zcodeTaskService.createTask({
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
        // 首发前的空 session 不落库，session_input 有 session 外键；deferred 让 V4
        // admission 在首发时先持久化 session 主记录，否则首条 prompt 稳定触发
        // FOREIGN KEY constraint failed（与 automation / 闲时任务同款修复）。
        deferPersistenceUntilFirstPrompt: true,
      });
      setTasks((current) => [created, ...current]);
      setActiveTask(created);
    } catch (error) {
      toast.show(`Create failed: ${error instanceof Error ? error.message : String(error)}`, {
        tone: "fail",
      });
    }
  }, [workspace, toast]);

  const switchWorkspace = useCallback((index: number) => {
    setWorkspaceIndex(index);
    setTasks([]);
    setActiveTask(null);
    setTab("tasks");
  }, []);

  const refresh = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const pendingCount = live.state?.snapshot?.pendingInteractions?.length ?? 0;
  const hasTask = activeTask !== null;

  const navItems = useMemo(
    () =>
      [
        { key: "tasks" as const, label: "Tasks", icon: <ListTodo size={19} /> },
        { key: "info" as const, label: "Info", icon: <Activity size={19} /> },
      ] satisfies { key: Tab; label: string; icon: React.ReactNode }[],
    [],
  );

  if (phase === "connecting") {
    return <div className="boot">Connecting…</div>;
  }

  if (phase === "error") {
    return (
      <div className="boot">
        <p>Connection failed.</p>
        <p className="note">{errorMsg}</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  if (!service || !workspace) {
    return (
      <div className="boot">
        <p>No workspace configured on the server.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="app-main">
        <div className="pane" style={{ display: activeTask ? "none" : "flex" }}>
          <ExplorerScreen
            service={service}
            workspaces={workspaces}
            workspaceIndex={workspaceIndex}
            onWorkspaceIndexChange={switchWorkspace}
            tasks={tasks}
            activeTaskId={activeTask?.taskId ?? null}
            onOpenTask={openTask}
            onCreateTask={() => void createTask()}
            onMutated={refresh}
            onTaskUnavailable={(taskId) => {
              if (taskId === activeTask?.taskId) {
                setActiveTask(null);
              }
            }}
          />
        </div>

        <div className="pane" style={{ display: activeTask ? "flex" : "none" }}>
          {activeTask ? (
            <ChatScreen
              service={service}
              live={live}
              meta={activeTask}
              configOptions={configOptions}
              draft={draft}
              onDraftChange={setDraft}
              onBack={() => setActiveTask(null)}
              onMutated={refresh}
            />
          ) : null}
        </div>

        <div className="pane" style={{ display: tab === "info" ? "flex" : "none" }}>
          {activeTask ? (
            <InfoScreen
              service={service}
              agentService={agentService}
              taskId={activeTask.taskId}
              workspacePath={activeTask.workspacePath}
              workspaceIdentity={activeTask.workspaceIdentity}
              snapshot={live.state?.snapshot ?? null}
              visible={tab === "info"}
            />
          ) : null}
        </div>
      </main>

      {/* 会话视图内部已经有返回条，不在会话时隐藏底部导航，避免双重导航。 */}
      <nav className="tabbar" style={{ display: hasTask ? "none" : undefined }}>
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`tab${tab === item.key ? " active" : ""}`}
            onClick={() => setTab(item.key)}
          >
            <span className="tab-icon">
              {item.icon}
              {item.key === "info" && pendingCount > 0 ? <span className="tab-dot" /> : null}
            </span>
            <span className="tab-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <MobileApp />
    </ToastProvider>
  </StrictMode>,
);
