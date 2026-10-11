/**
 * Explorer 屏：工作区切换 + 任务列表 + 归档区。
 *
 * 交互相对旧版的改动：
 * - 去掉 antd-mobile 的 SwipeAction/Popover/CapsuleTabs，改成本项目自己的
 *   行内 ··· 菜单与胶囊切换器，视觉与时间线保持一致。
 * - 点击任务 = 打开；长按/··· = 归档 / 删除，避免误触。
 * - 归档区默认收起，放在列表底部。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  FolderGit2,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { MobileWorkspaceInfo } from "../lib/connection.js";
import { ConfirmSheet, Sheet, useToast } from "../components/Overlays.js";

function workspaceLabel(workspace: MobileWorkspaceInfo): string {
  if (workspace.label) return workspace.label;
  const parts = workspace.path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || workspace.path;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

type ConfirmState =
  | { kind: "delete"; task: ZCodeTaskMeta; archived: boolean }
  | { kind: "delete-all"; count: number };

function TaskRow({
  task,
  active,
  archived,
  onOpen,
  onMenu,
}: {
  task: ZCodeTaskMeta;
  active: boolean;
  archived: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  return (
    <div className={`task-row${active ? " active" : ""}${archived ? " archived" : ""}`}>
      <button className="task-open" onClick={onOpen}>
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          <span>{relativeTime(task.updatedAt)}</span>
          {task.status ? (
            <>
              <span className="task-sep">·</span>
              {task.status === "running" ? <span className="run-cursor" /> : null}
              <span className={`task-status ${task.status}`}>{task.status}</span>
            </>
          ) : null}
          {archived ? (
            <>
              <span className="task-sep">·</span>
              <span>archived</span>
            </>
          ) : null}
        </div>
      </button>
      <button className="task-menu" onClick={onMenu} aria-label="Task actions">
        <MoreHorizontal size={17} />
      </button>
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
  onMutated: () => void;
  onTaskUnavailable: (taskId: string) => void;
}) {
  const workspace = workspaces[workspaceIndex];
  const toast = useToast();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<ZCodeTaskMeta[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [menuTask, setMenuTask] = useState<{ task: ZCodeTaskMeta; archived: boolean } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadArchived = useCallback(async () => {
    if (!workspace) return;
    setArchivedLoading(true);
    try {
      const list = await service.listArchivedTasks({
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
      });
      if (mounted.current) setArchived(list);
    } catch {
      // 静默：下次展开或操作后重试
    } finally {
      if (mounted.current) setArchivedLoading(false);
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

  const runArchive = async (task: ZCodeTaskMeta) => {
    try {
      await service.archiveTask({
        taskId: task.taskId,
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
      });
      if (task.taskId === activeTaskId) onTaskUnavailable(task.taskId);
      if (archivedOpen) void loadArchived();
      onMutated();
      toast.show("Task archived", { tone: "ok" });
    } catch (error) {
      toast.show(`Archive failed: ${error instanceof Error ? error.message : String(error)}`, {
        tone: "fail",
      });
    }
  };

  const runUnarchive = async (task: ZCodeTaskMeta) => {
    try {
      await service.unarchiveTask({
        taskId: task.taskId,
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
      });
      await loadArchived();
      onMutated();
      toast.show("Task unarchived", { tone: "ok" });
    } catch (error) {
      toast.show(`Unarchive failed: ${error instanceof Error ? error.message : String(error)}`, {
        tone: "fail",
      });
    }
  };

  const runDelete = async (task: ZCodeTaskMeta, wasArchived: boolean) => {
    try {
      if (wasArchived) {
        await service.deleteArchivedTask({
          taskId: task.taskId,
          workspacePath: workspace.path,
          workspaceIdentity: workspace.workspaceIdentity,
        });
        await loadArchived();
      } else {
        await service.deleteTask({
          taskId: task.taskId,
          workspacePath: workspace.path,
          workspaceIdentity: workspace.workspaceIdentity,
        });
      }
      if (task.taskId === activeTaskId) onTaskUnavailable(task.taskId);
      onMutated();
      toast.show("Task deleted", { tone: "ok" });
    } catch (error) {
      toast.show(`Delete failed: ${error instanceof Error ? error.message : String(error)}`, {
        tone: "fail",
      });
    }
  };

  const runDeleteAll = async () => {
    try {
      await service.deleteArchivedTasks({
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
        taskIds: sortedArchived.map((item) => item.taskId),
      });
      await loadArchived();
      onMutated();
      toast.show("Archived tasks deleted", { tone: "ok" });
    } catch (error) {
      toast.show(`Delete failed: ${error instanceof Error ? error.message : String(error)}`, {
        tone: "fail",
      });
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-brand">
          ZCode<span className="topbar-brand-sub">mobile</span>
        </div>
        <button className="topbar-action" onClick={onCreateTask} aria-label="New task">
          <Plus size={18} />
        </button>
      </header>

      {workspaces.length > 1 ? (
        <button className="ws-picker" onClick={() => setWsOpen(true)}>
          <FolderGit2 size={13} />
          <span className="ws-picker-label">{workspaceLabel(workspace)}</span>
          <ChevronDown size={13} />
        </button>
      ) : (
        <div className="ws-static">
          <FolderGit2 size={12} />
          <span>{workspaceLabel(workspace)}</span>
        </div>
      )}

      <div className="list-scroll">
        {sorted.length === 0 ? (
          <div className="empty explorer-empty">
            <p>No tasks.</p>
            <span>tap + to start one</span>
          </div>
        ) : null}

        {sorted.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            active={task.taskId === activeTaskId}
            archived={false}
            onOpen={() => onOpenTask(task)}
            onMenu={() => setMenuTask({ task, archived: false })}
          />
        ))}

        <div className="archived-block">
          <button
            className="archived-toggle"
            onClick={() => setArchivedOpen((open) => !open)}
            aria-expanded={archivedOpen}
          >
            <ChevronDown size={13} className={`chev${archivedOpen ? " open" : ""}`} />
            <span>Archived</span>
            {archived.length > 0 ? <span className="archived-count">{archived.length}</span> : null}
          </button>

          {archivedOpen ? (
            <div className="archived-list">
              {archivedLoading && sortedArchived.length === 0 ? (
                <div className="note">Loading…</div>
              ) : null}
              {!archivedLoading && sortedArchived.length === 0 ? (
                <div className="note">Nothing archived.</div>
              ) : null}
              {sortedArchived.map((task) => (
                <TaskRow
                  key={task.taskId}
                  task={task}
                  active={false}
                  archived
                  onOpen={() => onOpenTask(task)}
                  onMenu={() => setMenuTask({ task, archived: true })}
                />
              ))}
              {sortedArchived.length > 0 ? (
                <button
                  className="archived-clear"
                  onClick={() => setConfirm({ kind: "delete-all", count: sortedArchived.length })}
                >
                  <Trash2 size={13} /> Delete all archived
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {wsOpen ? (
        <Sheet title="Workspace" onClose={() => setWsOpen(false)}>
          {workspaces.map((item, index) => (
            <button
              key={`${item.path}-${index}`}
              className={`option-row${index === workspaceIndex ? " selected" : ""}`}
              onClick={() => {
                setWsOpen(false);
                onWorkspaceIndexChange(index);
              }}
            >
              <span className="option-row-main">
                <span className="option-row-label">{workspaceLabel(item)}</span>
                <span className="option-row-sub">{item.path}</span>
              </span>
              {index === workspaceIndex ? <span className="option-check">✓</span> : null}
            </button>
          ))}
        </Sheet>
      ) : null}

      {menuTask ? (
        <Sheet title={menuTask.task.title} onClose={() => setMenuTask(null)}>
          {menuTask.archived ? (
            <button
              className="option-row"
              onClick={() => {
                const { task } = menuTask;
                setMenuTask(null);
                void runUnarchive(task);
              }}
            >
              <span className="option-row-main">
                <span className="option-row-label">
                  <ArchiveRestore size={14} /> Unarchive
                </span>
              </span>
            </button>
          ) : (
            <button
              className="option-row"
              onClick={() => {
                const { task } = menuTask;
                setMenuTask(null);
                void runArchive(task);
              }}
            >
              <span className="option-row-main">
                <span className="option-row-label">
                  <Archive size={14} /> Archive
                </span>
              </span>
            </button>
          )}
          <button
            className="option-row danger"
            onClick={() => {
              const { task, archived: wasArchived } = menuTask;
              setMenuTask(null);
              setConfirm({ kind: "delete", task, archived: wasArchived });
            }}
          >
            <span className="option-row-main">
              <span className="option-row-label">
                <Trash2 size={14} /> Delete
              </span>
            </span>
          </button>
        </Sheet>
      ) : null}

      {confirm?.kind === "delete" ? (
        <ConfirmSheet
          title={confirm.archived ? "Delete archived task?" : "Delete task?"}
          message={confirm.task.title}
          confirmLabel="Delete"
          onConfirm={() => void runDelete(confirm.task, confirm.archived)}
          onClose={() => setConfirm(null)}
        />
      ) : null}

      {confirm?.kind === "delete-all" ? (
        <ConfirmSheet
          title="Delete ALL archived tasks?"
          message={`${confirm.count} task(s) will be removed permanently.`}
          confirmLabel="Delete all"
          onConfirm={() => void runDeleteAll()}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
