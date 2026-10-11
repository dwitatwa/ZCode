/**
 * 时间线投影：把持久化消息摊平成一条有序的"活动流"。
 *
 * ⚠ 这是 legacy 快照投影，不是手机当前读路径 —— 现网走 v4 会话投影
 * （lib/projection.ts）。本文件保留两类资产：
 *   - 渲染层共用的展示助手（toolDisplayName / toolSummary / toolStatusTone /
 *     formatToolPayload / 状态字形 / dividerLabel / dividerTone），投影适配器也复用；
 *   - buildTimeline 作为 v4 投影的语义参照与 verify:timeline 的被测对象。
 *
 * 为什么要投影而不是直接渲染 messages：
 * 一条 assistant 消息里 parts 记录的是 content / thought / tool-call 的交错顺序，
 * 而 tools 是独立数组、part 里只存 toolIndex。直接渲染 messages 会得到
 * "整段文字 + 一堆工具行" 的错误布局。这里按 parts 顺序摊平成一个数组，
 * 每一段文字/思考/工具调用都是一个独立条目，并按 turnIndex 分组。
 *
 * 数据来源的坑（都在这里兜住）：
 * 1. tools 可能被服务端按条数裁剪 —— message.toolSlice 给出窗口范围。
 *    关键：窗口存在时快照里的 tools 数组到底是不是那个窗口，各宿主不一致
 *    （桌面远控给的是全量 + 窗口元数据，直连宿主给的是真切片）。因此不能
 *    用 "toolIndex - startToolIndex" 盲算，必须按工具身份去快照里找。
 * 2. content / thought 可能被首屏预算裁剪 —— message.bodyRefs 指向可按 ref
 *    拉取的完整正文。
 * 3. 合成分隔条（goal_verification / context_compaction）在持久化里是独立
 *    message，但带 anchorAssistantMessageId 时要贴回被锚定的那条 assistant。
 *    旧实现把它们一律追加到列表末尾，长会话里就堆成一堵 "GOAL VERIFICATION"
 *    分隔条墙 —— 表格里每个 turn 末尾本来就有一条。
 */
import type {
  ZCodePersistedMessage,
  ZCodePersistedToolCall,
  ZCodeTaskSnapshot,
  ZCodeTimelineMeta,
} from "@zcode/shared";

export type TimelineItem =
  | { kind: "user"; id: string; text: string; timestamp: number }
  | { kind: "assistant-text"; id: string; text: string; timestamp: number; message: ZCodePersistedMessage }
  | {
      kind: "thinking";
      id: string;
      text: string;
      timestamp: number;
      /** 正文被裁剪时给出可补拉的 refId；未裁剪为 null。 */
      bodyRefId: string | null;
    }
  | {
      kind: "tool";
      id: string;
      tool: ZCodePersistedToolCall | null;
      /** 仅在无法解析出快照条目时才有意义，用于兜底文案。 */
      unresolvedIndex: number | null;
      messageIndex: number;
      timestamp: number;
      /**
       * 该工具调用仍在进行中。
       *
       * 不能靠"是不是最后一行"推断：v4 投影里运行中的工具后面可能已经跟了
       * 正文行。ZCodePersistedToolCall.status 只有终态枚举，所以进行中必须
       * 单独带一个标志，否则会被判成 neutral。
       */
      live?: boolean;
    }
  | {
      kind: "tool-slice-notice";
      id: string;
      messageIndex: number;
      shown: number;
      total: number;
      startToolIndex: number;
      endToolIndexExclusive: number;
    }
  | { kind: "divider"; id: string; meta: ZCodeTimelineMeta; label: string };

export interface TimelineTurn {
  /** turnIndex；快照缺失时用消息序号兜底。 */
  key: string;
  turnIndex: number | null;
  items: TimelineItem[];
}

let syntheticCounter = 0;

function syntheticId(prefix: string): string {
  syntheticCounter += 1;
  return `${prefix}-${syntheticCounter}`;
}

/**
 * 取工具调用的"真名"。旧快照可能把展示标题写在 toolName 里，
 * 因此只把像工具标识符的值当作 name，否则回退 title / kind。
 */
export function toolDisplayName(tool: ZCodePersistedToolCall | null, fallbackIndex: number): string {
  if (!tool) return `tool #${fallbackIndex}`;
  const candidates = [tool.toolName, tool.title, tool.kind];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return `tool #${fallbackIndex}`;
}

/** 工具调用的一行摘要：命令 / 文件路径 / 搜索词，尽量取最有信息量的那个。 */
export function toolSummary(tool: ZCodePersistedToolCall | null): string | null {
  if (!tool?.input || typeof tool.input !== "object") return null;
  const input = tool.input as Record<string, unknown>;
  const priority = [
    "command",
    "file_path",
    "filePath",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "description",
    "task_id",
    "workflow_name",
  ];
  for (const key of priority) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().split("\n")[0] ?? value.trim();
    }
  }
  // 没有已知字段时，退到第一个字符串字段，避免整行空白。
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().split("\n")[0] ?? value.trim();
    }
  }
  return null;
}

/** 工具结果的一行摘要。 */
export function toolResultPreview(tool: ZCodePersistedToolCall | null): string | null {
  if (!tool) return null;
  if (typeof tool.error === "string" && tool.error.trim().length > 0) return tool.error.trim();
  const output = tool.output;
  if (typeof output === "string" && output.trim().length > 0) return output.trim();
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    for (const key of ["content", "stdout", "text", "message", "output"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    try {
      const encoded = JSON.stringify(output);
      return encoded === "{}" ? null : encoded;
    } catch {
      return null;
    }
  }
  return null;
}

/** 格式化任意值为可读正文（工具 input/output 展开用）。 */
export function formatToolPayload(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type ToolStatusTone = "running" | "ok" | "failed" | "neutral";

export function toolStatusTone(tool: ZCodePersistedToolCall | null, isLive: boolean): ToolStatusTone {
  if (isLive) return "running";
  if (!tool) return "neutral";
  switch (tool.status) {
    case "completed":
      return "ok";
    case "failed":
    case "denied":
      return "failed";
    case "stopped":
      return "neutral";
    default:
      return "neutral";
  }
}

export const TOOL_STATUS_GLYPH: Record<ToolStatusTone, string> = {
  running: "◐",
  ok: "✓",
  failed: "✕",
  neutral: "·",
};

function bodyRefId(message: ZCodePersistedMessage, field: "content" | "thought"): string | null {
  return (message.bodyRefs ?? []).find((ref) => ref.field === field)?.refId ?? null;
}

/* --------------------------- 合成分隔条 --------------------------- */

/** 中性化后的分隔条语义，避免把三种 meta 变体泄漏进渲染层。 */
export interface DividerInfo {
  label: string;
  tone: "neutral" | "running" | "failed";
}

/**
 * 把 syntheticTimeline meta 转成一行可读文案。
 *
 * 桌面端（packages/ui）会显示 "Iteration N · Goal complete, ending task" 并保留
 * icon；手机端空间只有一行，因此压成 "Goal 2 · complete" 这种最短可辨识形式。
 */
export function dividerLabel(meta: ZCodeTimelineMeta): string {
  switch (meta.type) {
    case "goal_verification": {
      const iteration = meta.goalIteration !== undefined ? ` ${meta.goalIteration}` : "";
      switch (meta.status) {
        case "started":
          return `Goal${iteration} · verifying`;
        case "completed":
          return `Goal${iteration} · complete`;
        case "failed_closed":
          return `Goal${iteration} · incomplete`;
        case "cancelled":
          return `Goal${iteration} · interrupted`;
        default:
          return `Goal${iteration}`;
      }
    }
    case "context_compaction": {
      switch (meta.status) {
        case "started":
          return "Compact · started";
        case "retrying":
          return `Compact · retry ${meta.attempt ?? 1}/${meta.maxAttempts ?? 1}`;
        case "skipped":
          return "Compact · skipped";
        case "completed":
          return "Compact · done";
        case "failed":
          return "Compact · failed";
        case "interrupted":
          return "Compact · interrupted";
        default:
          return "Compact";
      }
    }
    case "session_fork":
      return "Forked session";
    default:
      return "Divider";
  }
}

export function dividerTone(meta: ZCodeTimelineMeta): DividerInfo["tone"] {
  const status = "status" in meta ? meta.status : undefined;
  if (status === "started" || status === "retrying") return "running";
  if (status === "failed" || status === "failed_closed") return "failed";
  return "neutral";
}

function isSyntheticMessage(message: ZCodePersistedMessage): boolean {
  return Boolean(message.syntheticTimeline);
}

/**
 * 分隔条的生命周期身份：同一身份的多条状态只该显示一条。
 *
 * goal_verification 用 targetId + goalIteration（与桌面端 goalVerifyLifecycleKey 一致，
 * 同一次校验的重试复用同一行）；context_compaction 用 operationId。
 */
function dividerIdentity(meta: ZCodeTimelineMeta): string {
  switch (meta.type) {
    case "goal_verification":
      return `goal:${meta.targetId}:${meta.goalIteration ?? 0}`;
    case "context_compaction":
      return `compact:${meta.operationId}`;
    case "session_fork":
      return `fork:${meta.parentSessionId}:${meta.targetMessageId}`;
    default:
      return "divider";
  }
}

/**
 * 同一块上下文里、身份相同的合成分隔条只保留最后一条。
 *
 * 为什么需要：一次 goal iteration 会先落一条 status=started、收尾再落一条
 * completed/failed_closed（targetId + goalIteration 相同）。两条都渲染就会在
 * 每个 turn 末尾留下 "verifying" + "complete" 双行，长会话视觉上就是那堵墙。
 * 保留最后一条即保留终态（快照按时间序返回）。身份不同的分隔条各自保留 ——
 * 不同 iteration / 不同 operation 各有一条是正确语义，桌面端也是这么显示的。
 */
function dedupeDividers(metas: readonly ZCodeTimelineMeta[]): ZCodeTimelineMeta[] {
  const order: string[] = [];
  const byIdentity = new Map<string, ZCodeTimelineMeta>();
  for (const meta of metas) {
    const identity = dividerIdentity(meta);
    if (!byIdentity.has(identity)) order.push(identity);
    // 后到者覆盖先到者：终态优先于 started/retrying。
    byIdentity.set(identity, meta);
  }
  return order.map((identity) => byIdentity.get(identity) as ZCodeTimelineMeta);
}

/* ---------------------------- 投影主体 ---------------------------- */

/**
 * 把 legacy 快照消息摊平成按 turn 分组的时间线。
 *
 * ⚠ 已不是手机端的读路径。手机现在消费 v4 会话投影（lib/projection.ts 的
 * buildTimelineFromRows），文本/思考/工具行到达即渲染。保留本函数是因为：
 *   1. 它仍是 v4 投影缺失时的语义参照（toolSlice 平移、分隔条锚定与去重）；
 *   2. verify:timeline 用它锁住这些规则，防止适配器改动时无声回归。
 * 新功能一律走投影适配器，不要在此继续加逻辑。
 *
 * 合成分隔条（goal_verification / context_compaction）按 anchorAssistantMessageId
 * 贴回被锚定的 assistant 消息所在 turn 的末尾；没有锚点的才追加在最后。
 */
export function buildTimeline(snapshot: ZCodeTaskSnapshot | null): TimelineTurn[] {
  if (!snapshot) return [];

  const turns: TimelineTurn[] = [];
  const byKey = new Map<string, TimelineTurn>();
  // anchorAssistantMessageId -> 该 assistant 所在 turn 的 key
  const anchorTurnKeys = new Map<string, string[]>();
  // 尚未确定归属的合成分隔条（锚点 message 可能还没被遍历到）。
  const pendingDividers: { meta: ZCodeTimelineMeta; anchorId: string | null }[] = [];

  const turnFor = (key: string, turnIndex: number | null): TimelineTurn => {
    let turn = byKey.get(key);
    if (!turn) {
      turn = { key, turnIndex, items: [] };
      byKey.set(key, turn);
      turns.push(turn);
    }
    return turn;
  };

  const all = snapshot.messages;

  all.forEach((message, messageIndex) => {
    if (isSyntheticMessage(message)) {
      const meta = message.syntheticTimeline as ZCodeTimelineMeta;
      const anchor =
        meta.type === "goal_verification" && meta.anchorAssistantMessageId
          ? meta.anchorAssistantMessageId
          : null;
      pendingDividers.push({ meta, anchorId: anchor });
      return;
    }

    const turnKey =
      message.turnIndex === undefined ? `msg-${messageIndex}` : `turn-${message.turnIndex}`;
    const turn = turnFor(turnKey, message.turnIndex ?? null);
    if (message.id) {
      const keys = anchorTurnKeys.get(message.id) ?? [];
      keys.push(turnKey);
      anchorTurnKeys.set(message.id, keys);
    }
    const items = turn.items;

    if (message.role === "user") {
      items.push({
        kind: "user",
        id: `u-${message.id ?? messageIndex}`,
        text: message.content,
        timestamp: message.timestamp,
      });
      return;
    }

    const parts = Array.isArray(message.parts) ? message.parts : null;
    const tools = message.tools ?? [];
    const slice = message.toolSlice;

    if (slice) {
      items.push({
        kind: "tool-slice-notice",
        id: `slice-${message.id ?? messageIndex}`,
        messageIndex,
        shown: slice.endToolIndexExclusive - slice.startToolIndex,
        total: slice.totalTools,
        startToolIndex: slice.startToolIndex,
        endToolIndexExclusive: slice.endToolIndexExclusive,
      });
    }

    /**
     * 解析 part.toolIndex -> 快照工具条目。
     *
     * part.toolIndex 是 message.tools 的「全局」下标，而 tools 可能是被裁剪后的
     * 窗口切片，因此不能无条件用 tools[toolIndex]。
     *
     * 判断依据用 totalTools 而不是「有没有 toolSlice」：两种宿主行为都见过 ——
     * 一种给全量 tools 但附带切片元数据，一种给真窗口。用长度自证最稳：
     *   tools.length === totalTools → 数组完整，toolIndex 直接可用；
     *   tools.length <  totalTools → 数组是窗口，需按 startToolIndex 平移。
     * 平移后仍越界说明该条不在窗口内，返回 null 让 UI 明说「不在本次快照里」，
     * 不要退回全量下标 —— 那会命中另一个工具，比缺失更糟。
     */
    const toolsComplete = !slice || tools.length >= slice.totalTools;
    const toolAt = (toolIndex: number): ZCodePersistedToolCall | null => {
      if (!slice || toolsComplete) return tools[toolIndex] ?? null;
      return tools[toolIndex - slice.startToolIndex] ?? null;
    };

    if (parts && parts.length > 0) {
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];
        if (!part) continue;
        if (part.type === "thought") {
          if (!part.content) continue;
          items.push({
            kind: "thinking",
            id: `t-${message.id ?? messageIndex}-${partIndex}`,
            text: part.content,
            timestamp: message.timestamp,
            bodyRefId: bodyRefId(message, "thought"),
          });
          continue;
        }
        if (part.type === "tool-call") {
          const tool = toolAt(part.toolIndex);
          items.push({
            kind: "tool",
            id: `x-${message.id ?? messageIndex}-${partIndex}`,
            tool,
            unresolvedIndex: tool ? null : part.toolIndex,
            messageIndex,
            timestamp: message.timestamp,
          });
          continue;
        }
        if (part.content) {
          items.push({
            kind: "assistant-text",
            id: `a-${message.id ?? messageIndex}-${partIndex}`,
            text: part.content,
            timestamp: message.timestamp,
            message,
          });
        }
      }
      return;
    }

    // 没有 parts 的旧数据：思考 → 正文 → 工具，顺序回退。
    if (message.thought) {
      items.push({
        kind: "thinking",
        id: `t-${message.id ?? messageIndex}`,
        text: message.thought,
        timestamp: message.timestamp,
        bodyRefId: bodyRefId(message, "thought"),
      });
    }
    if (message.content) {
      items.push({
        kind: "assistant-text",
        id: `a-${message.id ?? messageIndex}`,
        text: message.content,
        timestamp: message.timestamp,
        message,
      });
    }
    tools.forEach((tool, localIndex) => {
      const globalIndex = slice ? slice.startToolIndex + localIndex : localIndex;
      items.push({
        kind: "tool",
        id: `x-${message.id ?? messageIndex}-${globalIndex}`,
        tool,
        unresolvedIndex: null,
        messageIndex,
        timestamp: message.timestamp,
      });
    });
  });

  /* ---------------------- 合成分隔条归位 ---------------------- */

  // 先按 anchor 分组，方便逐 turn 去重；无锚点的单独成条追加在末尾。
  const anchored = new Map<string, ZCodeTimelineMeta[]>();
  const orphans: ZCodeTimelineMeta[] = [];
  for (const entry of pendingDividers) {
    const turnKeys = entry.anchorId ? anchorTurnKeys.get(entry.anchorId) : undefined;
    // 锚点存在但该消息没有 turnIndex（旧数据）时，退化成无锚点。
    const turnKey = turnKeys && turnKeys.length > 0 ? turnKeys[turnKeys.length - 1] : undefined;
    if (turnKey) {
      const list = anchored.get(turnKey) ?? [];
      list.push(entry.meta);
      anchored.set(turnKey, list);
    } else {
      orphans.push(entry.meta);
    }
  }

  for (const [turnKey, metas] of anchored) {
    const turn = byKey.get(turnKey);
    if (!turn) continue;
    for (const meta of dedupeDividers(metas)) {
      turn.items.push({
        kind: "divider",
        id: syntheticId("divider"),
        meta,
        label: dividerLabel(meta),
      });
    }
  }

  for (const meta of dedupeDividers(orphans)) {
    turns.push({
      key: syntheticId("synthetic"),
      turnIndex: null,
      items: [
        {
          kind: "divider",
          id: syntheticId("divider"),
          meta,
          label: dividerLabel(meta),
        },
      ],
    });
  }

  return turns;
}

/** 空 timeline 判定：只有分隔条/裁剪提示不算有内容。 */
export function timelineIsEmpty(turns: readonly TimelineTurn[]): boolean {
  return turns.every((turn) =>
    turn.items.every((item) => item.kind === "divider" || item.kind === "tool-slice-notice"),
  );
}
