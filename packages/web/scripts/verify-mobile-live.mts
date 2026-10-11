/**
 * 手机端 v4 实时会话链路的集成验证。
 *
 * 目标：证明「agent 事件 → 投影 store → 手机时间线」这条新读路径真的通，
 * 且不再依赖 3s 轮询。这里用生产代码（agentConversationTransport +
 * SessionDataLayer + ConversationProjectionStore + 手机 projection 适配器），
 * 只把 IZCodeAgentService 换成内存替身：
 *   - subscribe 回 ACK；
 *   - 之后按 v4 帧协议推 snapshot 与 delta（row.appended / row.delta /
 *     row.upserted），模拟流式正文、思考与工具状态迁移。
 *
 * 断言重点（都是旧实现做不到的）：
 *   1. 首帧 snapshot 立刻渲染出 user 行（不等轮询）；
 *   2. row.delta 追加正文后，时间线里的 assistant 文本同步变长；
 *   3. 运行中的 toolCall 渲染为 running，而不是 neutral；
 *   4. row.upserted 把工具改为 error 后，渲染为 failed 并带错误文本；
 *   5. turnHeader.state 驱动 generating，不再依赖任务列表 meta。
 *
 * 运行：pnpm exec tsx packages/web/scripts/verify-mobile-live.mts
 */
import assert from "node:assert/strict";
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  conversationTopicFrameSchema,
  type ConversationRow,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { createAgentConversationTransport } from "../../ui/src/v4/agentConversationTransport.js";
import { SessionDataLayer } from "../../ui/src/v4/sessionDataLayer.js";
import {
  anyTurnRunning,
  buildTimelineFromRows,
} from "../src/mobile/lib/projection.js";

const SESSION_ID = "ses_live_test";
const TOPIC = `conversation/${SESSION_ID}`;
const SUB_ID = "sub-1";

/** 轮询等待某个条件成立；store 的订阅是异步的，测试不能假定同步就绪。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 超时");
}

type FrameListener = (frame: ConversationTopicFrame, context?: { deliveryKind: string }) => void;

/** 内存 agent service：只实现本测试触达的方法。 */
function createFakeAgentService() {
  const frameListeners = new Set<FrameListener>();
  let ordinal = 0;
  const service = {
    helloConversationV4: async () => ({
      kind: "hello" as const,
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "conn-1",
      clientMode: "web-remote-replayable" as const,
      deliveryProfile: "replayable" as const,
      serverTime: Date.now(),
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none" as const,
      },
      auth: {},
    }),
    initializeConversationV4: async () => ({ ok: true }),
    subscribeConversationV4: async () => ({ ack: { subscriptionId: SUB_ID } }),
    unsubscribeConversationV4: async () => undefined,
    resyncConversationV4: async () => ({ ack: { subscriptionId: SUB_ID } }),
    onDynamicConversationFrame: () => (listener: FrameListener) => {
      frameListeners.add(listener);
      return { dispose: () => frameListeners.delete(listener) };
    },
    onAgentRuntimeRestarted: () => ({ dispose: () => undefined }),
    sendConversationCommandV4: async () => ({ status: "accepted", commandId: "c1" }),
  } as unknown as IZCodeAgentService;

  /** 推一帧；用帧 schema 自校验，防止测试自身造出非法帧。 */
  const push = (payload: ConversationTopicFrame["payload"], toSeq: number) => {
    ordinal += 1;
    const frame: ConversationTopicFrame = {
      topic: TOPIC,
      subscriptionId: SUB_ID,
      fromSeq: payload.kind === "snapshot" ? 0 : toSeq - 1,
      toSeq,
      sentAt: Date.now(),
      payload,
    };
    conversationTopicFrameSchema.parse(frame);
    // deliveryKind 必须是 wire 自身的属性：assembler 会 parse 它，缺省会以
    // proto.frameAssemblyMetadataMismatch 拒帧（第二参数只是 listener 的提示）。
    const wire = {
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete" as const,
      deliveryKind: "initial" as const,
      logicalFrameId: `frame-${ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic: TOPIC,
      subscriptionId: SUB_ID,
      frame,
    };
    for (const listener of frameListeners) listener(wire as never, { deliveryKind: "initial" });
  };

  return { service, push };
}

function rowBase(rowId: number, turnId: string) {
  return { rowId, turnId, createdAt: Date.now(), createdAtSeq: rowId };
}

function turnHeader(rowId: number, turnId: string, state: "running" | "completedSuccess"): ConversationRow {
  return {
    ...rowBase(rowId, turnId),
    kind: "turnHeader",
    origin: "userInput",
    state,
    startedAt: Date.now(),
  } as ConversationRow;
}

function userInput(rowId: number, turnId: string, text: string): ConversationRow {
  return { ...rowBase(rowId, turnId), kind: "userInput", text, origin: "realUser" } as ConversationRow;
}

function assistantText(
  rowId: number,
  turnId: string,
  text: string,
  state: "streaming" | "complete",
): ConversationRow {
  return { ...rowBase(rowId, turnId), kind: "assistantText", text, state } as ConversationRow;
}

function reasoning(rowId: number, turnId: string, text: string): ConversationRow {
  return { ...rowBase(rowId, turnId), kind: "reasoning", text, state: "complete" } as ConversationRow;
}

function toolCall(
  rowId: number,
  turnId: string,
  status: "running" | "error",
  extra: Record<string, unknown> = {},
): ConversationRow {
  return {
    ...rowBase(rowId, turnId),
    kind: "toolCall",
    toolCallId: "t1",
    toolName: "Bash",
    status,
    inputText: "pnpm build",
    ...extra,
  } as ConversationRow;
}

function snapshot(rows: ConversationRow[], totalCount: number, firstRowId: number | null) {
  return {
    protocolVersion: 1 as const,
    sessionId: SESSION_ID,
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "running" as const,
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable" as const,
      stopTargetKind: "assistant" as const,
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true as const },
      compact: { allowed: true as const },
      switchModelConfig: { allowed: true as const },
      setFollowupMode: { allowed: true as const },
      queueEdit: { allowed: true as const },
      sendQueuedNow: { allowed: true as const },
      pauseGoal: { allowed: true as const },
      resumeGoal: { allowed: true as const },
    },
    inputRouting: { mode: "startNow" as const },
    meta: { title: "live test", titleSource: "default" as const },
    config: {
      provider: "test",
      model: "test-model",
      thought: "medium",
      thoughtLevels: ["low", "medium"],
      followupMode: "queue" as const,
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: { window: rows, totalCount, firstRowId },
  };
}

async function main(): Promise<void> {
  const { service, push } = createFakeAgentService();
  const transport = createAgentConversationTransport(service, { workspacePath: "/tmp/ws" });
  const layer = new SessionDataLayer({ transport });
  const lease = layer.acquire(SESSION_ID);

  const TURN = "turn-1";

  // 首帧必须等在 subscribe ACK 之后：store 把 ACK 存进 awaitingInitial，
  // 只有此后到达的 initial 帧才会被当作 base 应用（真实 host 也是
  // post-response notification 的时序）。
  await waitFor(() => lease.store.getState().status === "live");

  // ---- 1) 首帧 snapshot：user 行立即可渲染 ----
  push(
    {
      kind: "snapshot",
      snapshot: snapshot(
        [turnHeader(1, TURN, "running"), userInput(2, TURN, "hello mobile")],
        2,
        1,
      ),
    },
    1,
  );

  const afterSnapshot = lease.store.getState().snapshot;
  assert.ok(afterSnapshot, "snapshot 应已应用到 store");
  let turns = buildTimelineFromRows(afterSnapshot.rows.window);
  assert.equal(turns.length, 1, "应只有一轮");
  const firstUser = turns[0]?.items.find((item) => item.kind === "user");
  assert.ok(firstUser && firstUser.kind === "user", "首帧就应出现 user 行");
  assert.equal(firstUser.text, "hello mobile", "user 文本应来自 v4 userInput row");
  assert.equal(anyTurnRunning(afterSnapshot.rows.window), true, "turnHeader.state=running 应驱动 generating");
  console.log("1) snapshot → user 行即时渲染: OK");

  // ---- 2) row.appended 正文 + row.delta 流式追加 ----
  push(
    { kind: "deltas", deltas: [{ op: "row.appended", row: assistantText(3, TURN, "Thinking", "streaming") }] },
    2,
  );
  push(
    { kind: "deltas", deltas: [{ op: "row.delta", rowId: 3, path: "text", append: " out loud…" }] },
    3,
  );

  let rows = lease.store.getState().snapshot?.rows.window ?? [];
  turns = buildTimelineFromRows(rows);
  const textItem = turns[0]?.items.find((item) => item.kind === "assistant-text");
  assert.ok(textItem && textItem.kind === "assistant-text", "应出现 assistant 正文行");
  assert.equal(textItem.text, "Thinking out loud…", "row.delta 应把正文追加进时间线");
  console.log("2) row.appended + row.delta → 正文流式增长: OK");

  // ---- 3) 思考行 ----
  push(
    { kind: "deltas", deltas: [{ op: "row.appended", row: reasoning(4, TURN, "weighing options") }] },
    4,
  );
  rows = lease.store.getState().snapshot?.rows.window ?? [];
  turns = buildTimelineFromRows(rows);
  const thinkItem = turns[0]?.items.find((item) => item.kind === "thinking");
  assert.ok(thinkItem && thinkItem.kind === "thinking", "应出现思考行");
  assert.equal(thinkItem.text, "weighing options", "思考文本应来自 reasoning row");
  console.log("3) reasoning row → 思考行: OK");

  // ---- 4) 运行中的工具：必须是 live，且不因后面跟了正文而被判 neutral ----
  push(
    { kind: "deltas", deltas: [{ op: "row.appended", row: toolCall(5, TURN, "running") }] },
    5,
  );
  rows = lease.store.getState().snapshot?.rows.window ?? [];
  turns = buildTimelineFromRows(rows);
  const liveTool = turns[0]?.items.find((item) => item.kind === "tool");
  assert.ok(liveTool && liveTool.kind === "tool", "应出现工具行");
  assert.equal(liveTool.live, true, "运行中的工具必须带 live 标志（否则渲染成 neutral）");
  assert.equal(liveTool.tool?.status, undefined, "进行中态不应伪造终态 status");
  console.log("4) 运行中工具 → live 标志: OK");

  // ---- 5) row.upserted 终态：failed + 错误文本 ----
  push(
    {
      kind: "deltas",
      deltas: [
        {
          op: "row.upserted",
          row: toolCall(5, TURN, "error", {
            error: { code: "E1", message: "Process exited with code 1" },
          }),
        },
      ],
    },
    6,
  );
  rows = lease.store.getState().snapshot?.rows.window ?? [];
  turns = buildTimelineFromRows(rows);
  const failedTool = turns[0]?.items.find((item) => item.kind === "tool");
  assert.ok(failedTool && failedTool.kind === "tool", "工具行应仍在");
  assert.equal(failedTool.live, false, "终态不应再是 live");
  assert.equal(failedTool.tool?.status, "failed", "error 状态应映射为 failed");
  assert.equal(failedTool.tool?.error, "Process exited with code 1", "错误文本应带出");
  console.log("5) row.upserted 终态 → failed + 错误文本: OK");

  // ---- 6) 收口：turnHeader 转 completedSuccess 后 generating 归零 ----
  push(
    {
      kind: "deltas",
      deltas: [{ op: "row.upserted", row: turnHeader(1, TURN, "completedSuccess") }],
    },
    7,
  );
  rows = lease.store.getState().snapshot?.rows.window ?? [];
  assert.equal(anyTurnRunning(rows), false, "turn 收口后 generating 应为 false");
  console.log("6) turnHeader 收口 → generating 归零: OK");

  // ---- 7) 租约释放后 store 关停 ----
  lease.release();
  layer.dispose();
  assert.equal(lease.store.getState().status, "closed", "dispose 后 store 应关闭");
  console.log("7) 租约释放 → store 关闭: OK");

  console.log("mobile live conversation smoke: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
