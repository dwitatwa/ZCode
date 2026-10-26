/**
 * ZCode Mobile — 应用外壳（/mobile.html）。
 *
 * 结构：一个 WS 连接承载全部 RPC；任务列表与任务视图常驻，用 display 切换以保留
 * 滚动位置与 composer 草稿状态。
 *
 * 任务视图内部再分两层（chat / info）：Info 全是「这个任务」的运行信息，所以它属于
 * 任务内部，而不是全局导航。底部导航因此只剩任务列表一层 —— 任务信息只可能在打开
 * 任务时才有数据。
 *
 * 刷新节奏：
 *   任务列表 8s（有打开的任务时暂停）
 *   任务快照 3s（打开任务时）
 *   流式事件：即时增量更新（不等轮询）
 *
 * 屏幕数量刻意压到最少：手机上每多一层导航，回到原处就多一次点击。
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import "./mobile.css";
// 会话正文由桌面的 ConversationTimeline 渲染（与桌面同一套行渲染器），
// 它整棵是 Tailwind 写的，因此手机入口必须带上 @zcode/ui 的样式表。
// 该样式表含未作用域的 html/body/#root 规则，由 mobile.css 在其后覆盖；
// 两者的加载顺序由 vite 的 import 顺序保证。
import "@zcode/ui/styles.css";
import { applyTheme } from "@zcode/ui/useTheme";
import { connectMobile, fetchServerInfo, type MobileWorkspaceInfo } from "./lib/connection.js";
import {
  nextAvailableWorkspaceIndex,
  resolveWorkspaceIndex,
  unavailableNote,
  workspaceLabel,
  workspaceScope,
} from "./lib/workspaces.js";
import { useConversationLive } from "./lib/live.js";
import { ToastProvider, useToast } from "./components/Overlays.js";
import { ExplorerScreen } from "./screens/ExplorerScreen.js";
import { ChatScreen } from "./screens/ChatScreen.js";
import { InfoScreen } from "./screens/InfoScreen.js";

type Phase = "connecting" | "ready" | "error" | "unavailable";
/** 任务视图内部的两层；只在有打开的任务时有意义。 */
type TaskView = "chat" | "info";

const TASK_POLL_MS = 8000;

const servicesRef: { current: IServiceAccessor | null } = { current: null };

function MobileApp() {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const [workspaces, setWorkspaces] = useState<MobileWorkspaceInfo[]>([]);
  const [workspaceIndex, setWorkspaceIndex] = useState(0);
  const [tasks, setTasks] = useState<ZCodeTaskMeta[]>([]);
  const [activeTask, setActiveTask] = useState<ZCodeTaskMeta | null>(null);
  const [taskView, setTaskView] = useState<TaskView>("chat");
  const [reloadTick, setReloadTick] = useState(0);
  const [listLoaded, setListLoaded] = useState(false);

  const workspace = workspaces[workspaceIndex] ?? null;
  /** 远端 workspace 的稳定身份；本地 workspace 为 undefined，连接窗口本地服务。 */
  const remoteIdentity = workspace?.workspaceIdentity;
  /** 桌面端已判定该远端 workspace 不可用（会话断开或缺失）；不要尝试连接。 */
  const unavailableCode = workspace?.unavailableCode;
  /**
   * 连接的稳定标识：同一 scope 只连一次。
   *
   * 用字符串而不是 workspace 对象，是因为刷新列表会重建对象；对象一变就重连的话，
   * 用户每次打开选择器（会刷新列表）都会看到整屏闪回 "Connecting…"。
   */
  const connectScope = workspaceScope(workspace);
  /** 已经连上的 scope；null 表示当前没有活连接。 */
  const connectedScopeRef = useRef<string | null>(null);
  /**
   * 连接代次。每次真正发起连接才 +1，回调据此判断自己是不是"已被替换的那条"。
   *
   * 为什么不用闭包里的 disposed 变量：列表刷新会触发 effect 清理，清理会把 disposed
   * 置真；若这次刷新并没有换项目（早退分支不重连），那条仍然活着的连接的 onClose
   * 就再也不会生效 —— 桌面端回收会话后，手机会停在 ready 拿着一具死连接。
   */
  const generationRef = useRef(0);
  const service = servicesRef.current?.zcodeTaskService;
  const accessor = servicesRef.current;
  const agentService = servicesRef.current?.zcodeAgentService ?? null;

  /* ------------------------------ 连接 ------------------------------ */

  // 先取 workspace 列表：不知道要接哪个 workspace 就无从建立连接。
  useEffect(() => {
    let disposed = false;
    void fetchServerInfo()
      .then((info) => {
        if (disposed) return;
        if (info.workspaces) setWorkspaces(info.workspaces);
        setListLoaded(true);
      })
      .catch(() => {
        // 失败不阻塞：重试循环兜底，避免把一次 5xx 变成永久错误页。
        if (!disposed) setListLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, [reloadTick]);

  // 每个 workspace 一条连接：attachment 的 scope 是固定的，切换 workspace 必须重连，
  // 不能在同一条连接上换 runtime。远端 identity 变化即触发重连。
  //
  // 桌面端已标记不可用的 workspace 直接跳过连接：连了也会被拒，而握手被拒时浏览器
  // 读不到响应体，只能得到一个没有信息量的网络错误。
  //
  // 依赖只写 scope 的字符串形式，不写 workspace 对象：刷新列表会换掉对象引用，
  // 若照对象身份重连，phase 会先回到 connecting，整屏被换成 "Connecting…"，
  // 主屏连同打开的选择器一起被卸载 —— 表现就是"选择器刚点开就自己关了"。
  useEffect(() => {
    if (!listLoaded || !workspace) return;
    if (unavailableCode) {
      servicesRef.current = null;
      connectedScopeRef.current = null;
      setPhase("unavailable");
      return;
    }
    // 同一个 scope 已经连上就什么都不做。刷新列表不该打断正在用的连接。
    if (connectedScopeRef.current === connectScope && servicesRef.current) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const isCurrent = () => generationRef.current === generation;

    servicesRef.current = null;
    connectedScopeRef.current = null;
    setPhase("connecting");
    connectMobile(remoteIdentity, (event) => {
      // 连接落定后才断开：手机会停在 ready 拿着死连接，任务列表静默失败，
      // 界面看起来就像这个项目没有任务。回到错误态，把原因留给用户。
      if (!isCurrent()) return;
      servicesRef.current = null;
      connectedScopeRef.current = null;
      setPhase("error");
      setErrorMsg(
        event.reason || `Connection closed (${event.code}). Reconnect the project on the desktop.`,
      );
    })
      .then((accessor) => {
        if (!isCurrent()) return;
        servicesRef.current = accessor;
        connectedScopeRef.current = connectScope;
        setPhase("ready");
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setPhase("error");
        setErrorMsg(error instanceof Error ? error.message : String(error));
      });
  }, [listLoaded, connectScope, remoteIdentity, unavailableCode, workspace?.path]);

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

  // 依赖用 workspace?.path 而不是 workspace 对象：刷新列表会重建对象，按对象身份
  // 重启轮询会白白丢掉正在飞的请求和已经取到的列表。
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
  }, [phase, connectScope, service, activeTask, reloadTick]);

  /* --------------------------- 实时会话投影（Info 屏用） --------------------------- */
  //
  // Chat 屏的正文与 composer 现在由桌面 SessionPane 自己订阅（V4ChatPane 内部带
  // V4ConversationProvider），这条 live 订阅只剩 Info 屏在用。同一条链路、同一份
  // store；桌面 layer 自带连接级去重，不会因此开第二条订阅。
  const live = useConversationLive({
    accessor: servicesRef.current,
    workspacePath: activeTask?.workspacePath ?? null,
    workspaceIdentity: activeTask?.workspaceIdentity,
    sessionId: activeTask?.taskId ?? null,
  });

  // Info 是单个任务的运行信息：换任务或退出任务都必须回到会话层，
  // 否则新任务的落地页会是一个上一任务留下的信息屏。
  useEffect(() => {
    setTaskView("chat");
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
    setTaskView("chat");
  }, []);

  /**
   * 重新拉取 workspace 列表。
   *
   * 为什么需要:workspace 列表只在挂载与 reloadTick 时取一次,而远端会话会被桌面端
   * 按空闲回收、也可能被重新连上。没有这条刷新,用户在桌面端把项目重新连好之后,
   * 手机选择器仍然显示 offline,只能整页重载才能看到变化。
   */
  const refreshWorkspaces = useCallback(async () => {
    try {
      const info = await fetchServerInfo();
      const next = info.workspaces;
      if (!next?.length) return;
      const currentPath = workspaces[workspaceIndex]?.path;
      setWorkspaces(next);
      const resolved = resolveWorkspaceIndex(next, currentPath);
      if (resolved !== -1) setWorkspaceIndex(resolved);
    } catch {
      // 刷新失败保留旧列表:清空会让用户失去本来还能用的项目。
    }
  }, [workspaces, workspaceIndex]);

  const refresh = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const closeTask = useCallback(() => setActiveTask(null), []);

  if (phase === "connecting") {
    return <div className="boot">Connecting…</div>;
  }

  if (phase === "error") {
    return (
      <div className="boot">
        <p>Connection failed.</p>
        <p className="note">{errorMsg}</p>
        <button className="btn" onClick={() => setReloadTick((tick) => tick + 1)}>
          Retry
        </button>
      </div>
    );
  }

  // 远端 workspace 已知不可用：明确说出来并给出「重试」与「换一个项目」两条路，
  // 而不是让用户面对一个空的、看起来像「这个项目本来就没有任务」的列表。
  if (phase === "unavailable") {
    const alternativeIndex = nextAvailableWorkspaceIndex(workspaces, workspaceIndex);
    return (
      <div className="boot">
        <p>{workspace ? workspaceLabel(workspace) : "Workspace"} is unavailable.</p>
        <p className="note">{unavailableNote(unavailableCode)}</p>
        <button className="btn" onClick={() => setReloadTick((tick) => tick + 1)}>
          Retry
        </button>
        {alternativeIndex !== -1 ? (
          <button className="btn btn-quiet" onClick={() => switchWorkspace(alternativeIndex)}>
            Use {workspaceLabel(workspaces[alternativeIndex]!)}
          </button>
        ) : null}
      </div>
    );
  }

  // 空列表是真实状态（窗口里没有可服务的 workspace），不再拿桌面进程目录冒充项目。
  if (!workspace) {
    return (
      <div className="boot">
        <p>No workspace available.</p>
        <p className="note">Open a project in the desktop app, then reload this page.</p>
        <button className="btn" onClick={() => setReloadTick((tick) => tick + 1)}>
          Retry
        </button>
      </div>
    );
  }

  // accessor 与 service 同源（都来自 servicesRef）；两个都判一次是为了让 TS 收窄
  // accessor 的类型 —— 渲染器要的是整个 accessor，不只是 task service。
  if (!service || !accessor) {
    return <div className="boot">Connecting…</div>;
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
            onRefreshWorkspaces={() => void refreshWorkspaces()}
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

        {/* 会话与任务信息都只在任务打开时挂载：Info 没有任务就没有数据，
            同时避免「已挂载但空」的 pane 盖在任务列表上吃掉点击。 */}
        <div
          className="pane"
          style={{ display: activeTask && taskView === "chat" ? "flex" : "none" }}
        >
          {activeTask ? (
            <ChatScreen
              accessor={accessor}
              meta={activeTask}
              onBack={closeTask}
              onOpenInfo={() => setTaskView("info")}
              onSessionCreated={() => refresh()}
            />
          ) : null}
        </div>

        <div
          className="pane"
          style={{ display: activeTask && taskView === "info" ? "flex" : "none" }}
        >
          {activeTask ? (
            <InfoScreen
              service={service}
              agentService={agentService}
              taskId={activeTask.taskId}
              workspacePath={activeTask.workspacePath}
              workspaceIdentity={activeTask.workspaceIdentity}
              snapshot={live.state?.snapshot ?? null}
              visible={taskView === "info"}
              onBack={() => setTaskView("chat")}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}



// 桌面渲染器读的是 Tailwind 色板变量，它们挂在 .dark / .theme-zai-dark 上，
// 由 applyTheme 写到 documentElement。必须在首次渲染前执行，否则首帧的行没有颜色。
// 手机是深色终端界面，用桌面同一套 zai-dark，而不是跟随系统。
applyTheme("zai-dark");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <MobileApp />
    </ToastProvider>
  </StrictMode>,
);
