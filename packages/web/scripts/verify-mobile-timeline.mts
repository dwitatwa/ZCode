/**
 * 验证移动端时间线投影的正确性。
 *
 * 覆盖四条容易错的路径：
 * 1. 工具下标：parts 里的 toolIndex 是 message.tools 的全局下标，而快照会把
 *    tools 裁成窗口切片（toolSlice）。必须按 startToolIndex 平移才命中。
 * 2. 合成分隔条归位：goal_verification 带 anchorAssistantMessageId 时要贴回
 *    被锚定的 assistant 所在轮，而不是堆到列表末尾（旧版长会话里的"分隔条墙"）。
 * 3. 分隔条去重：同轮相邻的 started + completed 只保留一条。
 * 4. 导航刻度：一问一档，预览文案与 running 标记正确。
 *
 * 运行:pnpm --filter @zcode/web verify:timeline
 */
import assert from "node:assert/strict";
import type { ZCodePersistedMessage, ZCodeTaskSnapshot } from "@zcode/shared";
import {
  buildTimeline,
  timelineIsEmpty,
  toolDisplayName,
  toolStatusTone,
  type TimelineItem,
} from "../src/mobile/lib/timeline.ts";
import { buildTimelineNav } from "../src/mobile/lib/navigation.ts";

function snapshotWith(messages: ZCodePersistedMessage[]): ZCodeTaskSnapshot {
  return {
    meta: {
      taskId: "t1",
      traceId: "tr1",
      title: "demo",
      workspacePath: "/w",
      createdAt: 0,
      updatedAt: 0,
      mode: "build",
    },
    messages,
  } as ZCodeTaskSnapshot;
}

function itemsOf(turns: ReturnType<typeof buildTimeline>): TimelineItem[] {
  return turns.flatMap((turn) => turn.items);
}

function toolNames(turns: ReturnType<typeof buildTimeline>): string[] {
  return itemsOf(turns)
    .filter((item): item is Extract<TimelineItem, { kind: "tool" }> => item.kind === "tool")
    .map((item) => toolDisplayName(item.tool, item.unresolvedIndex ?? 0));
}

function main(): void {
  // 1) parts 顺序保留:正文 → 工具 → 思考 → 正文(验证不再全部堆在上下两端)。
  const interleaved = snapshotWith([
    {
      id: "m1",
      role: "assistant",
      content: "firstsecond",
      timestamp: 1,
      tools: [{ toolName: "Read", input: { file_path: "/a.ts" }, status: "completed" }],
      parts: [
        { type: "content", content: "first" },
        { type: "tool-call", toolIndex: 0 },
        { type: "thought", content: "hmm" },
        { type: "content", content: "second" },
      ],
    },
  ]);
  const kinds = itemsOf(buildTimeline(interleaved)).map((item) => item.kind);
  assert.deepEqual(
    kinds,
    ["assistant-text", "tool", "thinking", "assistant-text"],
    "parts 交错顺序必须保留",
  );

  // 2) 工具真名解析:toolName 优先于 title,并带出 input 里的命令/路径摘要。
  assert.equal(toolDisplayName({ toolName: "Read", input: {} }, 3), "Read");
  assert.equal(
    toolDisplayName({ title: "My label", input: {} }, 3),
    "My label",
    "缺 toolName 时退到 title",
  );
  assert.equal(toolDisplayName(null, 7), "tool #7", "无工具对象时用下标兜底");

  // 3) 【关键】toolSlice 窗口平移:全局 toolIndex 5/6 必须命中本切片的 tools[0]/[1]。
  const sliced = snapshotWith([
    {
      id: "m2",
      role: "assistant",
      content: "",
      timestamp: 2,
      tools: [
        { toolName: "SlicedA", input: {}, status: "completed" },
        { toolName: "SlicedB", input: {}, status: "failed" },
      ],
      toolSlice: {
        persistedMessageIndex: 0,
        totalTools: 12,
        startToolIndex: 5,
        endToolIndexExclusive: 7,
      },
      parts: [
        { type: "tool-call", toolIndex: 5 },
        { type: "tool-call", toolIndex: 6 },
      ],
    },
  ]);
  const slicedTurns = buildTimeline(sliced);
  assert.deepEqual(
    toolNames(slicedTurns),
    ["SlicedA", "SlicedB"],
    "裁剪窗口内 toolIndex 必须按 startToolIndex 平移",
  );
  const notice = itemsOf(slicedTurns).find((item) => item.kind === "tool-slice-notice");
  assert.ok(notice, "存在 toolSlice 时必须给出「已显示 N/M」提示");
  assert.equal(
    (notice as Extract<TimelineItem, { kind: "tool-slice-notice" }>).total,
    12,
    "提示里应带出裁剪前的工具总数",
  );

  // 3b) 未裁剪（startToolIndex = 0）时平移是恒等变换,不能整体错位。
  const unsliced = snapshotWith([
    {
      id: "m2b",
      role: "assistant",
      content: "",
      timestamp: 2,
      tools: [
        { toolName: "First", input: {}, status: "completed" },
        { toolName: "Second", input: {}, status: "completed" },
      ],
      toolSlice: {
        persistedMessageIndex: 0,
        totalTools: 2,
        startToolIndex: 0,
        endToolIndexExclusive: 2,
      },
      parts: [
        { type: "tool-call", toolIndex: 0 },
        { type: "tool-call", toolIndex: 1 },
      ],
    },
  ]);
  assert.deepEqual(
    toolNames(buildTimeline(unsliced)),
    ["First", "Second"],
    "startToolIndex=0 时下标不应偏移",
  );

  // 3c) 宿主给「全量 tools + 切片元数据」时,tools.length === totalTools,
  //     下标必须直接可用。startToolIndex 故意设成 2 让"盲平移"暴露出来:
  //     平移会取到 tools[1]=T1,正确答案是 tools[3]=T3。
  const fullWithSliceMeta = snapshotWith([
    {
      id: "m2c",
      role: "assistant",
      content: "",
      timestamp: 2,
      tools: [
        { toolName: "T0", input: {}, status: "completed" },
        { toolName: "T1", input: {}, status: "completed" },
        { toolName: "T2", input: {}, status: "completed" },
        { toolName: "T3", input: {}, status: "completed" },
        { toolName: "T4", input: {}, status: "completed" },
      ],
      toolSlice: {
        persistedMessageIndex: 0,
        totalTools: 5,
        startToolIndex: 2,
        endToolIndexExclusive: 5,
      },
      parts: [{ type: "tool-call", toolIndex: 3 }],
    },
  ]);
  assert.deepEqual(
    toolNames(buildTimeline(fullWithSliceMeta)),
    ["T3"],
    "tools 完整时下标直接可用,不应按 startToolIndex 平移",
  );

  // 3d) 窗口外的 toolIndex 必须判为缺失。tools[0] 真实存在,所以"退回全量下标"
  //     这条旧回退路径会误命中 A —— 这里正是要锁死不能这么做。
  const partial = snapshotWith([
    {
      id: "m2d",
      role: "assistant",
      content: "",
      timestamp: 2,
      tools: [
        { toolName: "A", input: {}, status: "completed" },
        { toolName: "B", input: {}, status: "completed" },
        { toolName: "C", input: {}, status: "completed" },
      ],
      toolSlice: {
        persistedMessageIndex: 0,
        totalTools: 9,
        startToolIndex: 4,
        endToolIndexExclusive: 7,
      },
      parts: [
        { type: "tool-call", toolIndex: 4 },
        // 全局下标 0 不在窗口 [4,7) 内;tools[0] 虽然存在也不能拿来顶替。
        { type: "tool-call", toolIndex: 0 },
      ],
    },
  ]);
  const partialTools = itemsOf(buildTimeline(partial)).filter(
    (item): item is Extract<TimelineItem, { kind: "tool" }> => item.kind === "tool",
  );
  assert.equal(partialTools[0]?.tool?.toolName, "A", "窗口内的应命中");
  assert.equal(partialTools[1]?.tool, null, "窗口外的必须判为缺失,不得误命中其它工具");

  // 4) 无 parts 的旧数据:思考 → 正文 → 工具。
  const legacy = snapshotWith([
    {
      id: "m3",
      role: "assistant",
      content: "body",
      thought: "reasoning",
      timestamp: 3,
      tools: [{ toolName: "Bash", input: { command: "ls" }, status: "completed" }],
    },
  ]);
  assert.deepEqual(
    itemsOf(buildTimeline(legacy)).map((item) => item.kind),
    ["thinking", "assistant-text", "tool"],
    "缺 parts 时按 思考→正文→工具 回退",
  );

  // 5) 用户消息与其后的助手轮次各自成条。
  const mixed = snapshotWith([
    { id: "u1", role: "user", content: "hi", timestamp: 4 },
    { id: "a1", role: "assistant", content: "hello", timestamp: 5, parts: [{ type: "content", content: "hello" }] },
  ]);
  assert.deepEqual(
    itemsOf(buildTimeline(mixed)).map((item) => item.kind),
    ["user", "assistant-text"],
  );

  // 6) bodyRefs → 思考条目带出可补拉的 refId。
  const truncated = snapshotWith([
    {
      id: "m4",
      role: "assistant",
      content: "",
      timestamp: 6,
      bodyRefs: [{ field: "thought", refId: "ref-9", hash: "h", fullBytes: 900, previewBytes: 10 }],
      parts: [{ type: "thought", content: "preview…" }],
    },
  ]);
  const think = itemsOf(buildTimeline(truncated)).find((item) => item.kind === "thinking");
  assert.equal(
    (think as Extract<TimelineItem, { kind: "thinking" }>).bodyRefId,
    "ref-9",
    "被裁剪的思考应带出 refId",
  );

  // 7) 【关键】合成分隔条按 anchor 归位,而不是堆在列表末尾。
  const anchored = snapshotWith([
    { id: "u1", role: "user", content: "go", timestamp: 10, turnIndex: 0 },
    {
      id: "a1",
      role: "assistant",
      content: "done",
      timestamp: 11,
      turnIndex: 0,
      parts: [{ type: "content", content: "done" }],
    },
    {
      id: "gv1",
      role: "assistant",
      content: "",
      timestamp: 12,
      turnIndex: 1,
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "goal_verification",
        display: "separator",
        targetId: "goal-1",
        verificationId: "v1",
        status: "completed",
        goalIteration: 2,
        anchorAssistantMessageId: "a1",
        updatedAt: 12,
      },
    },
  ]);
  const anchoredTurns = buildTimeline(anchored);
  assert.equal(anchoredTurns.length, 1, "锚定的分隔条不应额外长出一个 turn");
  const anchoredItems = anchoredTurns[0]?.items ?? [];
  assert.equal(anchoredItems[anchoredItems.length - 1]?.kind, "divider", "分隔条应贴在该轮末尾");
  assert.equal(
    (anchoredItems[anchoredItems.length - 1] as Extract<TimelineItem, { kind: "divider" }>).label,
    "Goal 2 · complete",
    "分隔条文案应带出迭代号与状态",
  );

  // 7b) 同一轮相邻的 started + completed 去重成一条终态。
  const duped = snapshotWith([
    { id: "u2", role: "user", content: "go", timestamp: 20, turnIndex: 0 },
    {
      id: "a2",
      role: "assistant",
      content: "x",
      timestamp: 21,
      turnIndex: 0,
      parts: [{ type: "content", content: "x" }],
    },
    {
      id: "gv2a",
      role: "assistant",
      content: "",
      timestamp: 22,
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "goal_verification",
        display: "separator",
        targetId: "goal-2",
        verificationId: "v2",
        status: "started",
        anchorAssistantMessageId: "a2",
        updatedAt: 22,
      },
    },
    {
      id: "gv2b",
      role: "assistant",
      content: "",
      timestamp: 23,
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "goal_verification",
        display: "separator",
        targetId: "goal-2",
        verificationId: "v2",
        status: "failed_closed",
        anchorAssistantMessageId: "a2",
        updatedAt: 23,
      },
    },
  ]);
  const dupedDividers = itemsOf(buildTimeline(duped)).filter((item) => item.kind === "divider");
  assert.equal(dupedDividers.length, 1, "同轮相邻的同类分隔条应合并为一条");

  // 8) 空时间线判定:只有提示条/分隔条不算有内容。
  assert.equal(timelineIsEmpty([]), true, "空数组应判为空");
  assert.equal(timelineIsEmpty(buildTimeline(sliced)), false, "有工具行不应判为空");

  // 9) 状态色映射:无 status 且不在运行 = neutral,不会误标为失败。
  assert.equal(toolStatusTone({ input: {}, status: "completed" }, false), "ok");
  assert.equal(toolStatusTone({ input: {}, status: "failed" }, false), "failed");
  assert.equal(toolStatusTone({ input: {} }, false), "neutral");
  assert.equal(toolStatusTone({ input: {} }, true), "running");

  // 10) 导航刻度:一问一档,预览与 running 标记正确。
  const navTurns = buildTimeline(
    snapshotWith([
      { id: "u1", role: "user", content: "first question", timestamp: 30, turnIndex: 0 },
      {
        id: "a1",
        role: "assistant",
        content: "first answer",
        timestamp: 31,
        turnIndex: 0,
        parts: [{ type: "content", content: "first answer" }],
      },
      { id: "u2", role: "user", content: "second question", timestamp: 32, turnIndex: 1 },
    ]),
  );
  const nav = buildTimelineNav(navTurns, true);
  assert.equal(nav.length, 2, "两条用户提问应出两档刻度");
  assert.equal(nav[0]?.userPreview, "first question");
  assert.equal(nav[0]?.assistantPreview, "first answer");
  assert.equal(nav[0]?.isRunning, false, "只有最后一轮才是 running");
  assert.equal(nav[1]?.assistantPreview, "Assistant is still working");
  assert.equal(nav[1]?.isRunning, true);

  // 10b) 已结束且无正文的轮次,预览退到占位文案。
  const idleNav = buildTimelineNav(
    buildTimeline(snapshotWith([{ id: "u3", role: "user", content: "hi", timestamp: 40, turnIndex: 0 }])),
    false,
  );
  assert.equal(idleNav[0]?.assistantPreview, "No assistant text yet");

  console.log("mobile timeline smoke: OK");
}

main();
