/**
 * Explorer 屏：项目（workspace）选择、任务列表、新建 / 归档 / 删除。
 * antd-mobile 组件 + lucide 图标；归档相关走 zcodeTaskService 既有 RPC。
 * 任务行：点按打开，左滑（或 ··· 菜单）归档 / 删除。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActionSheet,
  CapsuleTabs,
  Collapse,
  DotLoading,
  NavBar,
  Popover,
  SwipeAction,
  Tag,
  Toast,
} from "antd-mobile";
import {
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { MobileWorkspaceInfo } from "../lib/connection.js";
import { confirmAction } from "../components/Sheet.js";

interface PickerSheetState {
  task: ZCodeTaskMeta;
  archived: boolean;
}

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

function failToast(error: unknown, prefix: string): void {
  Toast.show({ icon: "fail", content: `${prefix}: ${error instanceof Error ? error.message : String(error)}` });
}

function TaskRow({
  task,
  active,
  archived,
  onOpen,
}: {
  task: ZCodeTaskMeta;
  active: boolean;
  archived: boolean;
  onOpen: () => void;
}) {
  return (
    <div className={`task-row${active ? " active" : ""}`} onClick={onOpen}>
      <div className="task-row-main">
        <div className="task-title">{task.title}</div>
        <div className="task-sub">
          {task.status ? (
            <Tag color="success" fill="outline" style={{ fontSize: 10 }}>
              {task.status}
            </Tag>
          ) : null}
          <span>{relativeTime(task.updatedAt)}</span>
          {archived ? (
            <Tag color="warning" fill="outline" style={{ fontSize: 10 }}>
              archived
            </Tag>
          ) : null}
        </div>
      </div>
      <ChevronRight size={16} className="chev" />
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
  const [picker, setPicker] = useState<PickerSheetState | null>(null);

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
      // 静默：下次展开/操作后重试
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

  const archiveTask = async (task: ZCodeTaskMeta) => {
    try {
      await service.archiveTask({
        taskId: task.taskId,
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
      });
      if (task.taskId === activeTaskId) onTaskUnavailable(task.taskId);
      if (archivedOpen) void loadArchived();
      onMutated();
      Toast.show({ content: "Task archived", icon: "ok" });
    } catch (error) {
      failToast(error, "Archive failed");
    }
  };

  const unarchiveTask = async (task: ZCodeTaskMeta) => {
    try {
      await service.unarchiveTask({
        taskId: task.taskId,
        workspacePath: workspace.path,
        workspaceIdentity: workspace.workspaceIdentity,
      });
      await loadArchived();
      onMutated();
      Toast.show({ content: "Task unarchived", icon: "ok" });
    } catch (error) {
      failToast(error, "Unarchive failed");
    }
  };

  const deleteTask = (task: ZCodeTaskMeta, archived: boolean) => {
    confirmAction({
      title: archived ? "Delete archived task?" : "Delete task?",
      message: task.title,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          if (archived) {
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
          Toast.show({ content: "Task deleted", icon: "ok" });
        } catch (error) {
          failToast(error, "Delete failed");
        }
      },
    });
  };

  const swipeActions = (task: ZCodeTaskMeta) => [
    {
      key: "archive",
      text: "Archive",
      color: "warning" as const,
      onClick: () => void archiveTask(task),
    },
    {
      key: "delete",
      text: "Delete",
      color: "danger" as const,
      onClick: () => deleteTask(task, false),
    },
  ];

  const rowMenu = (task: ZCodeTaskMeta, archived: boolean) => (
    <Popover.Menu
      actions={
        archived
          ? [
              { key: "unarchive", text: "Unarchive" },
              { key: "delete", text: "Delete" },
            ]
          : [
              { key: "archive", text: "Archive" },
              { key: "delete", text: "Delete" },
            ]
      }
      onAction={(node) => {
        if (node.key === "archive") void archiveTask(task);
        if (node.key === "unarchive") void unarchiveTask(task);
        if (node.key === "delete") deleteTask(task, archived);
      }}
      trigger="click"
    >
      <button className="row-actions" aria-label="Task actions">
        <MoreHorizontal size={16} />
      </button>
    </Popover.Menu>
  );

  return (
    <>
      <NavBar
        back={null}
        left={
          <span className="brand">
            ZCode <span className="brand-sub">mobile</span>
          </span>
        }
        right={
          <button className="icon-btn new-task" onClick={onCreateTask} aria-label="New task">
            <Plus size={18} />
          </button>
        }
      >
        {" "}
      </NavBar>

      {workspaces.length > 1 ? (
        <div className="ws-capsule">
          <CapsuleTabs
            activeKey={String(workspaceIndex)}
            onChange={(key) => onWorkspaceIndexChange(Number(key))}
          >
            {workspaces.map((item, index) => (
              <CapsuleTabs.Tab key={String(index)} title={workspaceLabel(item)} />
            ))}
          </CapsuleTabs>
        </div>
      ) : (
        <div className="ws-line">
          <FolderOpen size={14} />
          {workspaceLabel(workspace)}
        </div>
      )}

      <div className="list-scroll">
        {sorted.length === 0 && <div className="empty">No tasks yet — create one.</div>}
        {sorted.map((task) => (
          <SwipeAction key={task.taskId} className="task-swipe" rightActions={swipeActions(task)}>
            <div style={{ display: "flex", alignItems: "stretch" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TaskRow
                  task={task}
                  active={task.taskId === activeTaskId}
                  archived={false}
                  onOpen={() => onOpenTask(task)}
                />
              </div>
              {rowMenu(task, false)}
            </div>
          </SwipeAction>
        ))}

        <Collapse
          activeKey={archivedOpen ? ["archived"] : []}
          onChange={(keys) => setArchivedOpen(keys.includes("archived"))}
          style={{ marginTop: 8 }}
        >
          <Collapse.Panel key="archived" title={`Archived${archived.length > 0 ? ` (${archived.length})` : ""}`}>
            {archivedLoading && archived.length === 0 && <div className="info-note">Loading…</div>}
            {!archivedLoading && sortedArchived.length === 0 && (
              <div className="info-note">Nothing archived.</div>
            )}
            {sortedArchived.map((task) => (
              <div key={task.taskId} className="task-swipe">
                <div style={{ display: "flex", alignItems: "stretch" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <TaskRow
                      task={task}
                      active={false}
                      archived
                      onOpen={() => setPicker({ task, archived: true })}
                    />
                  </div>
                  {rowMenu(task, true)}
                </div>
              </div>
            ))}
            {sortedArchived.length > 0 && (
              <button
                className="delete-all-btn"
                onClick={() =>
                  confirmAction({
                    title: "Delete ALL archived tasks?",
                    message: `${sortedArchived.length} task(s) will be removed permanently.`,
                    confirmLabel: "Delete all",
                    onConfirm: async () => {
                      try {
                        await service.deleteArchivedTasks({
                          workspacePath: workspace.path,
                          workspaceIdentity: workspace.workspaceIdentity,
                          taskIds: sortedArchived.map((item) => item.taskId),
                        });
                        await loadArchived();
                        Toast.show({ content: "Archived tasks deleted", icon: "ok" });
                      } catch (error) {
                        failToast(error, "Delete failed");
                      }
                    },
                  })
                }
              >
                <span className="archived-extra">
                  <Trash2 size={13} /> Delete all archived
                </span>
              </button>
            )}
          </Collapse.Panel>
        </Collapse>
      </div>

      {picker && (
        <ActionSheet
          visible
          extra={picker.task.title}
          cancelText="Cancel"
          closeOnAction
          actions={
            picker.archived
              ? [
                  { key: "unarchive", text: "Unarchive" },
                  { key: "delete", text: "Delete" },
                ]
              : [
                  { key: "open", text: "Open" },
                  { key: "archive", text: "Archive" },
                  { key: "delete", text: "Delete" },
                ]
          }
          onAction={(action) => {
            const { task, archived: wasArchived } = picker;
            setPicker(null);
            if (wasArchived) {
              if (action.key === "unarchive") void unarchiveTask(task);
              if (action.key === "delete") deleteTask(task, true);
              return;
            }
            if (action.key === "open") onOpenTask(task);
            if (action.key === "archive") void archiveTask(task);
            if (action.key === "delete") deleteTask(task, false);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {archivedLoading && archivedOpen ? (
        <div className="empty">
          <DotLoading color="primary" />
        </div>
      ) : null}
    </>
  );
}
