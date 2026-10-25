/**
 * Explorer 屏：工作区切换 + 任务列表 + 归档区。
 *
 * 视觉走「Obsidian」主屏设计系统（见 mainScreen.css）：暖黑底、单一黄铜强调色、
 * 标题左侧没有任何圆点或竖条。状态只走每行右侧的一个槽位。
 *
 * 交互相对旧版的改动：
 * - 顶部不再分「品牌栏 + 工作区条」两行：workspace 名直接成为标题，多项目时它
 *   就是打开选择器的按钮。新建任务收成标题右侧一个安静的小 +。
 * - 每行右槽只放一件事：运行中/失败放状态词，其余放相对时间。
 * - 点击任务 = 打开；行内 ··· 菜单保留归档 / 删除，避免误触。
 * - 归档区默认收起，放在列表底部。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { MobileWorkspaceInfo } from "../lib/connection.js";
import { workspaceLabel } from "../lib/workspaces.js";
import { relativeTime, taskRightSlot } from "../lib/taskSlot.js";
import { ConfirmSheet, Sheet, useToast } from "../components/Overlays.js";
import { WorkspacePicker } from "../components/WorkspacePicker.js";
import "../mainScreen.css";

type ConfirmState =
  | { kind: "delete"; task: ZCodeTaskMeta; archived: boolean }
  | { kind: "delete-all"; count: number };

function TaskRow({
  task,
  current,
  archived,
  onOpen,
  onMenu,
}: {
  task: ZCodeTaskMeta;
  current: boolean;
  archived: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const slot = taskRightSlot(task.status, relativeTime(task.updatedAt));
  const toneClass =
    archived ? "past" : task.status === "running" ? "running" : task.status === "error" ? "error" : "";

  return (
    <div className={`ms-row${toneClass ? ` ${toneClass}` : ""}${current ? " current" : ""}`}>
      <button className="ms-title" onClick={onOpen} style={{ flex: 1, minWidth: 0 }}>
        {task.title}
      </button>
      <span className={`ms-slot ${slot.tone}`}>{slot.text}</span>
      <button className="ms-row-menu" onClick={onMenu} aria-label="Task actions">
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}

export function ExplorerScreen({
  service,
  workspaces,
  workspaceIndex,
  onWorkspaceIndexChange,
  onRefreshWorkspaces,
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
  /** 打开选择器时重新拉列表:远端项目可能刚在桌面端重新连上。 */
  onRefreshWorkspaces?: () => void;
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

  // 依赖 workspace 的 path/identity 而不是对象本身：刷新列表会重建对象，按对象身份
  // 重建这个回调会让归档区在每次刷新后重新拉一次（并重置 loading 态）。
  const workspacePath = workspace?.path;
  const workspaceIdentity = workspace?.workspaceIdentity;

  const loadArchived = useCallback(async () => {
    if (!workspacePath) return;
    setArchivedLoading(true);
    try {
      const list = await service.listArchivedTasks({
        workspacePath,
        workspaceIdentity,
      });
      if (mounted.current) setArchived(list);
    } catch {
      // 静默：下次展开或操作后重试
    } finally {
      if (mounted.current) setArchivedLoading(false);
    }
  }, [service, workspacePath, workspaceIdentity]);

  useEffect(() => {
    if (archivedOpen) void loadArchived();
  }, [archivedOpen, loadArchived]);

  if (!workspace) {
    return <div className="ms-empty">No workspace configured on the server.</div>;
  }

  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const sortedArchived = [...archived].sort((a, b) => b.updatedAt - a.updatedAt);
  const runningCount = sorted.filter((task) => task.status === "running").length;

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

  // 箭头紧跟在名字后面,而不是被推到行尾:它属于这个名字,不是这一行的装饰。
  // 用图标而不是 ▾ 文字字符 —— 字符的大小、基线和粗细都跟着字体走,在这个字号下
  // 会变成一个小到看不清的游离符号。
  const nameContent = (
    <>
      <span className="ms-name">{workspaceLabel(workspace)}</span>
      {workspaces.length > 1 ? (
        <ChevronDown className="ms-name-chev" size={16} strokeWidth={1.75} aria-hidden="true" />
      ) : null}
      {workspace.workspaceIdentity ? <span className="ws-remote-tag">remote</span> : null}
      {workspace.unavailableCode ? <span className="ws-remote-tag ws-offline-tag">offline</span> : null}
    </>
  );

  return (
    <div className="ms">
      <header className="ms-head">
        <div className="ms-kicker">Workspace</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {workspaces.length > 1 ? (
            <button
              className="ms-name-row"
              onClick={() => {
                setWsOpen(true);
                onRefreshWorkspaces?.();
              }}
              aria-label={`Workspace: ${workspaceLabel(workspace)}`}
            >
              {nameContent}
            </button>
          ) : (
            <div className="ms-name-row">{nameContent}</div>
          )}
          <button className="ms-new" onClick={onCreateTask} aria-label="New task">
            <Plus size={15} />
          </button>
        </div>
      </header>

      <div className="ms-scroll">
        {runningCount > 0 ? (
          <div className="ms-section hot">
            <span>In progress</span>
            <span className="ms-section-count">{runningCount}</span>
          </div>
        ) : null}

        {sorted.length === 0 ? (
          <div className="ms-empty">
            <p>No tasks.</p>
            <span>tap + to start one</span>
          </div>
        ) : null}

        {sorted.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            current={task.taskId === activeTaskId}
            archived={false}
            onOpen={() => onOpenTask(task)}
            onMenu={() => setMenuTask({ task, archived: false })}
          />
        ))}

        <div className="ms-archived">
          <button
            className="ms-archived-toggle"
            onClick={() => setArchivedOpen((open) => !open)}
            aria-expanded={archivedOpen}
          >
            <ChevronDown size={11} className={`ms-chev${archivedOpen ? " open" : ""}`} />
            <span>Archived</span>
            {archived.length > 0 ? <span className="ms-archived-count">{archived.length}</span> : null}
          </button>

          {archivedOpen ? (
            <div className="ms-archived-list">
              {archivedLoading && sortedArchived.length === 0 ? (
                <div className="ms-note">Loading…</div>
              ) : null}
              {!archivedLoading && sortedArchived.length === 0 ? (
                <div className="ms-note">Nothing archived.</div>
              ) : null}
              {sortedArchived.map((task) => (
                <TaskRow
                  key={task.taskId}
                  task={task}
                  current={false}
                  archived
                  onOpen={() => onOpenTask(task)}
                  onMenu={() => setMenuTask({ task, archived: true })}
                />
              ))}
              {sortedArchived.length > 0 ? (
                <button
                  className="ms-archived-clear"
                  onClick={() => setConfirm({ kind: "delete-all", count: sortedArchived.length })}
                >
                  <Trash2 size={11} /> Delete all archived
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {wsOpen ? (
        <WorkspacePicker
          workspaces={workspaces}
          workspaceIndex={workspaceIndex}
          onPick={onWorkspaceIndexChange}
          onClose={() => setWsOpen(false)}
        />
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
    </div>
  );
}
