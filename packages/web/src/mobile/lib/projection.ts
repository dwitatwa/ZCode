/**
 * v4 投影行 → 手机时间线条目。
 *
 * 输入是桌面同一条 ConversationProjectionStore 的 rows.window（rowId 升序的尾部窗口），
 * 输出仍是手机原有的 TimelineItem/TimelineTurn，渲染层（Timeline.tsx / MessageNav）
 * 不需要知道 v4 的存在。
 *
 * 与旧快照投影的差别：
 * - 不再有 toolSlice / bodyRefs 这套"快照预算裁剪"补偿 —— v4 行自带完整 inputText
 *   与 output，裁剪由 rowsRange 游标分页承担（loadOlder 往上取窗）。
 * - turn 归属由 row.turnId 直接给出，不需要 anchor 猜测；turnHeader 行给出轮序号。
 * - tool 状态是 v4 的六态枚举，映射到手机的四档 tone。
 */
import type {
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodePersistedToolCall } from "@zcode/shared";
import type { TimelineItem, TimelineTurn } from "./timeline.js";

function headerOrder(rows: readonly ConversationRow[]): {
  order: Map<string, number>;
  headers: Map<string, TurnHeaderRow>;
} {
  const order = new Map<string, number>();
  const headers = new Map<string, TurnHeaderRow>();
  for (const row of rows) {
    if (row.kind !== "turnHeader") continue;
    // turnHeader 的行序即产品轮次序；一个 turnId 只该有一行 header。
    order.set(row.turnId, order.size);
    headers.set(row.turnId, row);
  }
  return { order, headers };
}

/** v4 六态 → 手机展示档位。进行中态没有终态枚举，返回 null 由 live 标志表达。 */
function toolTerminalStatus(status: ToolCallRow["status"]): ZCodePersistedToolCall["status"] | null {
  switch (status) {
    case "success":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      // inputStreaming / pendingApproval / running
      return null;
  }
}

/**
 * v4 ToolCallRow → 既有 ToolCallItem 消费的形状。
 *
 * 复用 ZCodePersistedToolCall 而不是新造类型：渲染层的 toolDisplayName /
 * toolSummary / toolStatusTone 都按这个形状写的，改类型会把整棵工具行组件拖下水。
 */
function toolRowToPersisted(row: ToolCallRow): ZCodePersistedToolCall {
  const status = toolTerminalStatus(row.status);
  return {
    toolName: row.toolName,
    kind: row.toolName,
    ...(status ? { status } : {}),
    input: row.input ?? row.inputText,
    ...(row.output ? { output: row.output.text || row.output } : {}),
    ...(row.error ? { error: row.error.message } : {}),
  };
}

function toolSummaryFromRow(row: ToolCallRow): string | null {
  if (!row.inputText) return null;
  const first = row.inputText.split("\n")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export function toolRowSummary(row: ToolCallRow): string | null {
  return toolSummaryFromRow(row);
}

function rowToItem(row: ConversationRow): TimelineItem | null {
  switch (row.kind) {
    case "userInput":
      return {
        kind: "user",
        id: `row-${row.rowId}`,
        text: row.text,
        timestamp: row.createdAt,
      };
    case "assistantText":
      return {
        kind: "assistant-text",
        id: `row-${row.rowId}`,
        text: row.text,
        timestamp: row.createdAt,
        // v4 行没有持久化 message 上下文；占位一个空壳，渲染层只读 text。
        message: { role: "assistant" } as never,
      };
    case "reasoning":
      return {
        kind: "thinking",
        id: `row-${row.rowId}`,
        text: row.text,
        timestamp: row.createdAt,
        // v4 行自带完整正文，没有按 ref 补拉的概念。
        bodyRefId: null,
      };
    case "toolCall":
      return {
        kind: "tool",
        id: `row-${row.rowId}`,
        tool: toolRowToPersisted(row),
        unresolvedIndex: null,
        messageIndex: row.rowId,
        timestamp: row.createdAt,
        live: toolTerminalStatus(row.status) === null,
      };
    case "timelineMarker": {
      const marker = row.marker;
      if (marker.type === "goalVerify") {
        return {
          kind: "divider",
          id: `row-${row.rowId}`,
          label: `Goal ${marker.iteration} · ${marker.outcome}`,
          meta: {
            version: 1,
            kind: "synthetic",
            type: "goal_verification",
            display: "separator",
            targetId: row.turnId,
            verificationId: `row-${row.rowId}`,
            status:
              marker.outcome === "pass"
                ? "completed"
                : marker.outcome === "running"
                  ? "started"
                  : "failed_closed",
            goalIteration: marker.iteration,
            updatedAt: row.createdAt,
          },
        };
      }
      if (marker.type === "compact") {
        return {
          kind: "divider",
          id: `row-${row.rowId}`,
          label: `Compact · ${marker.status}`,
          meta: {
            version: 1,
            kind: "synthetic",
            type: "context_compaction",
            operationId: `row-${row.rowId}`,
            status:
              marker.status === "success"
                ? "completed"
                : marker.status === "running"
                  ? "started"
                  : "failed",
            trigger: marker.origin === "manual" ? "manual" : "auto",
            display: "separator",
          },
        };
      }
      if (marker.type === "forkNotice" || marker.type === "forkCreated") {
        return {
          kind: "divider",
          id: `row-${row.rowId}`,
          label: "Forked session",
          meta: {
            version: 1,
            kind: "synthetic",
            type: "session_fork",
            display: "separator",
            parentSessionId: marker.type === "forkNotice" ? marker.parentSessionId : row.turnId,
            targetMessageId: String(row.rowId),
          },
        };
      }
      return null;
    }
    default:
      // artifact / subagent / hookInvocation 暂无手机端呈现，先不占行。
      return null;
  }
}

/**
 * 把投影窗口折成按 turn 分组的时间线。
 *
 * 轮序号取 turnHeader 的出现次序（CLI 权威），没有 header 的 orphan 行用 null，
 * 渲染层会退化成不显示左侧轮标 —— 不猜序号。
 */
export function buildTimelineFromRows(rows: readonly ConversationRow[]): TimelineTurn[] {
  const { order, headers } = headerOrder(rows);
  const turns: TimelineTurn[] = [];
  const byTurn = new Map<string, TimelineTurn>();

  for (const row of rows) {
    if (row.kind === "turnHeader") continue;
    let turn = byTurn.get(row.turnId);
    if (!turn) {
      turn = {
        key: row.turnId,
        turnIndex: order.get(row.turnId) ?? null,
        items: [],
      };
      byTurn.set(row.turnId, turn);
      turns.push(turn);
    }
    const item = rowToItem(row);
    if (item) turn.items.push(item);
  }

  // 只保留有内容的轮：turnHeader 之外全是被过滤行（artifact 等）的轮没有可渲染物。
  void headers;
  return turns.filter((turn) => turn.items.length > 0);
}

/** 首屏是否有可渲染行；用于区分"空会话"与"还在连"。 */
export function rowsAreEmpty(rows: readonly ConversationRow[]): boolean {
  return buildTimelineFromRows(rows).length === 0;
}

/** turn 是否仍在跑：turnHeader.state 是 CLI 给的权威运行态。 */
export function turnIsRunning(rows: readonly ConversationRow[], turnId: string): boolean {
  for (const row of rows) {
    if (row.kind === "turnHeader" && row.turnId === turnId) {
      return row.state === "running";
    }
  }
  return false;
}

/** 窗口里最后一轮是否 running；驱动顶栏/底部 running 指示。 */
export function anyTurnRunning(rows: readonly ConversationRow[]): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "turnHeader") return row.state === "running";
  }
  return false;
}
