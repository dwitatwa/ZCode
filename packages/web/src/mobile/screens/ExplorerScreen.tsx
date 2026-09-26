/**
 * Explorer 屏：项目（workspace）选择、任务列表、新建 / 归档 / 删除。
 * 归档相关走 zcodeTaskService 既有 RPC（archiveTask / listArchivedTasks /
 * unarchiveTask / deleteTask / deleteArchivedTasks），无需服务端改动。
 */
import { useCallback, useEffect, useState } from "react";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { MobileWorkspaceInfo } from "../lib/connection.js";
import { ConfirmSheet, OptionSheet, type SheetOption } from "../components/Sheet.js";

function workspaceLabel(workspace: MobileWorkspaceInfo): string {
  if (workspace.label) return workspace.label;
  const parts = workspace.path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || workspace.path;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function TaskRow({
  task,
  active,
  archived,
  onOpen,
  onActions,
}: {
  task: ZCodeTaskMeta;
  active: boolean;
  archived: boolean;
  onOpen: () => void;
  onActions: () => void;
}) {
  return (
    <div className={`task-row-wrap${active ? " active" : ""}`}>
      <button className="task-row" onClick={onOpen}>
        <div className="task-row-main">
          <div className="task-title">{task.title}</div>
          <div className="task-sub">
            {task.status ? <span className="task-status">{task.status}</span> : null}
            <span>{relativeTime(task.updatedAt)}</span>
          </div>
        </div>
        <span className="chev">›</span>
      </button>
      <button className="row-actions" onClick={onActions} aria-label="Task actions">
        ···
      </button>
      {archived ? <span className="archived-tag">archived</span> : null}
    </div>
  );
}

export function ExplorerScreen({
  service,
  workspaces,
  workspaceIndex,
  onWorkspaceIndexChange,
  tasks,
  activeTaskId,
  onOpenTask,
  onCreateTask,
  onMutated,
  onTaskUnavailable,
}: {
  service: IZCodeTaskService;
  workspaces: MobileWorkspaceInfo[];
  workspaceIndex: number;
  onWorkspaceIndexChange: (index: number) => void;
  tasks: ZCodeTaskMeta[];
  activeTaskId: string | null;
  onOpenTask: (meta: ZCodeTaskMeta) => void;
  onCreateTask: () => void;
  /** 任何归档/删除成功后通知 App 立即刷新任务列表。 */
  onMutated: () => void;
  /** 被归档/删除的任务若是当前打开的任务，通知 App 关闭它。 */
  onTaskUnavailable: (taskId: string) => void;
}) {
  const workspace = workspaces[workspaceIndex];
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<ZCodeTaskMeta[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [actionTarget, setActionTarget] = useState<ZCodeTaskMeta | null>(null);
  const [actionArchived, setActionArchived] = useState(false);
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message?: string;
    confirmLabel: string;
    run: () => Promise<void>;
  }>(null);

  const loadArchived = useCallback(async () => {
    if (!workspace) return;
    setArchivedLoading(true);
    try {
      const list = await service.listArchivedTasks({
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
      });
      setArchived(list);
    } catch {
      // 静默：下一轮打开/操作后重试
    } finally {
      setArchivedLoading(false);
    }
  }, [service, workspace]);

  useEffect(() => {
    if (archivedOpen) void loadArchived();
  }, [archivedOpen, loadArchived]);

  if (!workspace) {
    return <div className="empty">No workspace configured on the server.</div>;
  }

  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const sortedArchived = [...archived].sort((a, b) => b.updatedAt - a.updatedAt);

  const runArchivedAction = async (task: ZCodeTaskMeta, action: "unarchive" | "delete") => {
    try {
      if (action === "unarchive") {
        await service.unarchiveTask({
          taskId: task.taskId,
          workspacePath: workspace.path,
          workspaceIdentity: workspace.workspaceIdentity,
        });
      } else {
        await service.deleteArchivedTask({
          taskId: task.taskId,
          workspacePath: workspace.path,
          workspaceIdentity: workspace.workspaceIdentity,
        });
      }
      await loadArchived();
      onMutated();
    } catch (error) {
      alert(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const onTaskActionPick = async (task: ZCodeTaskMeta, value: string) => {
    const wasArchived = actionArchived;
    setActionTarget(null);
    setActionArchived(false);
    if (wasArchived) {
      if (value === "unarchive" || value === "delete") {
        await runArchivedAction(task, value);
      }
      return;
    }
    if (value === "open") {
      onOpenTask(task);
      return;
    }
    if (value === "archive") {
      try {
        await service.archiveTask({
          taskId: task.taskId,
          workspacePath: workspace.path,
          workspaceIdentity: workspace.workspaceIdentity,
        });
        if (task.taskId === activeTaskId) onTaskUnavailable(task.taskId);
        if (archivedOpen) void loadArchived();
        onMutated();
      } catch (error) {
        alert(`Archive failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (value === "delete") {
      setConfirm({
        title: "Delete task?",
        message: task.title,
        confirmLabel: "Delete",
        run: async () => {
          try {
            await service.deleteTask({
              taskId: task.taskId,
              workspacePath: workspace.path,
              workspaceIdentity: workspace.workspaceIdentity,
            });
            if (task.taskId === activeTaskId) onTaskUnavailable(task.taskId);
            onMutated();
          } catch (error) {
            alert(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });
    }
  };

  const taskActionOptions = (archived: boolean): SheetOption[] =>
    archived
      ? [
          { value: "unarchive", label: "Unarchive" },
          { value: "delete", label: "Delete", danger: true },
        ]
      : [
          { value: "open", label: "Open" },
          { value: "archive", label: "Archive" },
          { value: "delete", label: "Delete", danger: true },
        ];

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <span className="brand">ZCode</span>
          <span className="brand-sub">mobile</span>
        </div>
        <button className="icon-btn new-task" onClick={onCreateTask} aria-label="New task">
          ＋
        </button>
      </header>

      {workspaces.length > 1 && (
        <div className="ws-chips">
          {workspaces.map((item, index) => (
            <button
              key={item.path}
              className={`ws-chip${index === workspaceIndex ? " active" : ""}`}
              onClick={() => onWorkspaceIndexChange(index)}
            >
              {workspaceLabel(item)}
            </button>
          ))}
        </div>
      )}
      {workspaces.length <= 1 && (
        <div className="ws-line">
          <span className="folder">📁</span>
          {workspaceLabel(workspace)}
        </div>
      )}

      <div className="list-scroll">
        {sorted.length === 0 && <div className="empty">No tasks yet — create one.</div>}
        {sorted.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            active={task.taskId === activeTaskId}
            archived={false}
            onOpen={() => onOpenTask(task)}
            onActions={() => setActionTarget(task)}
          />
        ))}

        <button className="archived-toggle" onClick={() => setArchivedOpen((open) => !open)}>
          <span>{archivedOpen ? "▾" : "▸"}</span> Archived
          {archived.length > 0 ? <span className="archived-count">{archived.length}</span> : null}
        </button>
        {archivedOpen && (
          <div className="archived-section">
            {archivedLoading && archived.length === 0 && <div className="empty">Loading…</div>}
            {!archivedLoading && sortedArchived.length === 0 && (
              <div className="empty">Nothing archived.</div>
            )}
            {sortedArchived.map((task) => (
              <TaskRow
                key={task.taskId}
                task={task}
                active={false}
                archived
                onOpen={() => {
                  setActionArchived(true);
                  setActionTarget(task);
                }}
                onActions={() => {
                  setActionArchived(true);
                  setActionTarget(task);
                }}
              />
            ))}
            {sortedArchived.length > 0 && (
              <button
                className="delete-all-btn"
                onClick={() =>
                  setConfirm({
                    title: "Delete ALL archived tasks?",
                    message: `${sortedArchived.length} task(s) will be removed permanently.`,
                    confirmLabel: "Delete all",
                    run: async () => {
                      try {
                        await service.deleteArchivedTasks({
                          workspacePath: workspace.path,
                          workspaceIdentity: workspace.workspaceIdentity,
                          taskIds: sortedArchived.map((task) => task.taskId),
                        });
                        await loadArchived();
                      } catch (error) {
                        alert(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
                      }
                    },
                  })
                }
              >
                Delete all archived
              </button>
            )}
          </div>
        )}
      </div>

      {actionTarget && (
        <OptionSheet
          title={actionTarget.title}
          groups={[{ options: taskActionOptions(actionArchived) }]}
          onPick={(value) => void onTaskActionPick(actionTarget, value)}
          onClose={() => {
            setActionTarget(null);
            setActionArchived(false);
          }}
        />
      )}

      {confirm && (
        <ConfirmSheet
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => void confirm.run()}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
