/**
 * ZCode Mobile — 自定义手机端薄页面（/mobile.html）。
 *
 * 架构：不引入桌面 shell，直接用 @zcode/client 的 connectViaWebSocket 拿到
 * 类型安全的 service 代理，只消费手机真正需要的子集：
 *   - zcodeTaskService.listTasks / getTaskSnapshot / sendPrompt / stopGeneration / createTask
 * 会话渲染 v1 用 getTaskSnapshot 轮询（持久化快照），后续可升级到 v4 流订阅。
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectViaWebSocket } from "@zcode/client";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodePersistedMessage, ZCodeTaskMeta } from "@zcode/shared";

// ---- 连接与全局状态 ----

const token =
  new URLSearchParams(window.location.search).get("token") ??
  sessionStorage.getItem("zcode-m-token") ??
  "";
if (token) sessionStorage.setItem("zcode-m-token", token);

const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;

type ConnectionState = "connecting" | "ready" | "error";

const servicesRef: { current: import("@zcode/services").IServiceAccessor | null } = { current: null };

// ---- 工具 ----

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function newTraceId(): string {
  return crypto.randomUUID();
}

// ---- 消息渲染 ----

function MessageBubble({ message }: { message: ZCodePersistedMessage }) {
  const isUser = message.role === "user";
  const parts = Array.isArray(message.parts) ? message.parts : null;

  const body = parts && parts.length > 0
    ? parts.map((part, index) => {
        if (part.type === "thought") {
          return (
            <details key={index} className="thought">
              <summary>thought</summary>
              <div className="thought-body">{part.content}</div>
            </details>
          );
        }
        if (part.type === "tool-call") {
          return (
            <div key={index} className="tool-line">
              ⚙ tool #{part.toolIndex}
            </div>
          );
        }
        return <p key={index}>{part.content}</p>;
      })
    : <p>{message.content}</p>;

  return (
    <div className={`bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className={`bubble ${isUser ? "bubble-user" : "bubble-assistant"}`}>{body}</div>
    </div>
  );
}

// ---- 会话视图 ----

function ChatView({
  service,
  meta,
  onBack,
}: {
  service: IZCodeTaskService;
  meta: ZCodeTaskMeta;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ZCodePersistedMessage[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<
    Array<{ id?: string; title?: string }>
  >([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // 快照轮询：v1 用持久化快照渲染（后续可升级 v4 流订阅）
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const snap = await service.getTaskSnapshot({
          taskId: meta.taskId,
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
          clientMode: "web-remote-replayable",
        });
        if (cancelled || !snap) return;
        setMessages(snap.messages ?? []);
        const runtimePerms = (snap as { runtime?: { pendingPermissions?: Array<{ id?: string; title?: string }> } })
          .runtime?.pendingPermissions;
        setPendingPermissions(runtimePerms ?? []);
      } catch {
        // 轮询失败静默，下一轮重试
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service, meta]);

  // 自动滚动：仅当用户停留在底部附近
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setDraft("");
    try {
      await service.sendPrompt({
        taskId: meta.taskId,
        traceId: newTraceId(),
        content,
        clientMode: "web-remote-replayable",
        clientLabel: "zcode-mobile",
      });
      stickToBottomRef.current = true;
    } catch (error) {
      alert(`Send failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    try {
      await service.stopGeneration({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
    } catch {
      // 静默
    }
  };

  return (
    <>
      <header className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back to tasks">
          ←
        </button>
        <div className="topbar-title">
          <span className="folder">📁</span>
          <span className="title-text">{meta.title}</span>
        </div>
      </header>

      {pendingPermissions.length > 0 && (
        <div className="perm-banner">
          ⚠ {pendingPermissions.length} permission request(s) pending — approve in the desktop app
        </div>
      )}

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && <div className="empty">Loading conversation…</div>}
        {messages.map((message, index) => (
          <MessageBubble key={message.id ?? index} message={message} />
        ))}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder="Ask for follow-up changes…"
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="send-btn stop" onClick={() => void stop()} aria-label="Stop generation">
          ■
        </button>
        <button
          className="send-btn"
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </>
  );
}

// ---- 任务列表 ----

function TaskList({
  tasks,
  onOpen,
  onNewTask,
}: {
  tasks: ZCodeTaskMeta[];
  onOpen: (meta: ZCodeTaskMeta) => void;
  onNewTask: () => void;
}) {
  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <span className="brand">ZCode</span>
          <span className="brand-sub">mobile</span>
        </div>
        <button className="icon-btn new-task" onClick={onNewTask} aria-label="New task">
          ＋
        </button>
      </header>
      <div className="list-scroll">
        {sorted.length === 0 && <div className="empty">No tasks yet — create one.</div>}
        {sorted.map((task) => (
          <button key={task.taskId} className="task-row" onClick={() => onOpen(task)}>
            <div className="task-row-main">
              <div className="task-title">{task.title}</div>
              <div className="task-sub">
                {task.status ? <span className="task-status">{task.status}</span> : null}
                <span>{relativeTime(task.updatedAt)}</span>
              </div>
            </div>
            <span className="chev">›</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ---- 根组件 ----

function MobileApp() {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<ZCodeTaskMeta[]>([]);
  const [workspace, setWorkspace] = useState<{ path: string; identity?: string } | null>(null);
  const [active, setActive] = useState<ZCodeTaskMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const services = servicesRef.current;

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        // workspace 来自 server-info；token 可能已通过 URL/cookie 处理
        let workspacePath = "";
        let workspaceIdentity: string | undefined;
        try {
          const res = await fetch("/api/server-info", { cache: "no-store" });
          if (res.ok) {
            const info = (await res.json()) as {
              workspaces?: Array<{ path: string; workspaceIdentity?: string }>;
            };
            workspacePath = info.workspaces?.[0]?.path ?? "";
            workspaceIdentity = info.workspaces?.[0]?.workspaceIdentity;
          }
        } catch {
          // server-info 失败时仍尝试用空 workspace 连接
        }
        if (!workspacePath) {
          // 兜底：让用户至少看到连接状态
        }
        const accessor = await connectViaWebSocket(wsUrl);
        if (disposed) return;
        servicesRef.current = accessor;
        setState("ready");
        if (workspacePath) {
          setWorkspace({ path: workspacePath, identity: workspaceIdentity });
        }
      } catch (error) {
        if (disposed) return;
        setState("error");
        setError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // 任务列表轮询
  useEffect(() => {
    if (state !== "ready" || !workspace || active) return;
    const service = servicesRef.current?.zcodeTaskService;
    if (!service) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await service.listTasks({
          workspacePath: workspace.path,
          workspaceIdentity: workspace.identity,
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
  }, [state, workspace, active]);

  const createTask = async () => {
    if (!workspace || !servicesRef.current || creating) return;
    setCreating(true);
    try {
      const service = servicesRef.current.zcodeTaskService;
      // 返回值本身即 ZCodeTaskCreateResult（extends ZCodeTaskMeta）
      const created = await service.createTask({
        workspacePath: workspace.path,
        workspaceIdentity: workspace.identity,
      });
      setTasks((current) => [created, ...current]);
      setActive(created);
    } catch (error) {
      alert(`Create failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreating(false);
    }
  };

  if (state === "connecting") {
    return <div className="empty">Connecting…</div>;
  }
  if (state === "error") {
    return (
      <div className="empty">
        <p>Connection failed.</p>
        <p className="error-detail">{error}</p>
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
  if (!service || !workspace) {
    return <div className="empty">No workspace configured on the server.</div>;
  }

  return active ? (
    <ChatView service={service} meta={active} onBack={() => setActive(null)} />
  ) : (
    <TaskList tasks={tasks} onOpen={setActive} onNewTask={() => void createTask()} />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
