/**
 * 手机端的 v4 会话实时层入口。
 *
 * 存在的理由：移动端此前只轮询 getTaskSnapshot，把已到达的 agent_message_chunk /
 * agent_thought_chunk / tool_call 全部丢弃（isTimelineRelevantEvent 只放行少数结构性事件，
 * 且放行后也只当作"该重拉快照"的信号）。结果是新开会话发消息后最长 3s 什么都看不到，
 * 思考与工具行同样滞后。
 *
 * 修法不是再写一套手机专用的 reducer —— 那会变成第三条只有手机才有的管线。桌面端的
 * 会话视图本来就不消费裸 chunk，它走 SessionDataLayer → ConversationProjectionStore，
 * 由 subscribe/frame 的 snapshot+delta 协议自证水位。这里直接把同一条链路接到手机：
 * transport 本身是依赖注入的（transport.ts 头注释：desktop 走 preload/MessagePort，
 * web 走 ws relay，数据层零感知），因此手机复用零改动。
 *
 * 本文件只做接线与再导出，不含投影逻辑，便于手机端按子路径引入而不拉起 @zcode/ui
 * 根入口的一大批重依赖（pdfjs / stripe / xterm）。
 *
 * 写路径不在这里：手机的 service.sendPrompt 在 services 层已经收敛到 v4
 * sendText 命令（zcodeTaskServiceAdapter 的 sendPrompt 主路径），因此发出的输入
 * 与本层的订阅由同一个 CLI 投影作者产出，不需要第二条发送口。
 */
import type { IZCodeAgentService, IServiceAccessor } from "@zcode/services";
import { createAgentConversationTransport } from "./agentConversationTransport.js";
import { SessionDataLayer, type SessionLease } from "./sessionDataLayer.js";

export type { SessionLease } from "./sessionDataLayer.js";
export { SessionDataLayer } from "./sessionDataLayer.js";
export type { ConversationStoreState } from "./conversationProjectionStore.js";
export type { ConversationTransport } from "./transport.js";
export { conversationTopic } from "@zcode/shared/zcode-protocol-v4";

/**
 * 桌面端注入的本地媒体 URL 转换器；手机没有本地媒体协议，保持分片读取即可。
 * 这里只声明形状，避免把平台的 usePlatform 拖进手机包。
 */
export interface ConversationLiveLayerOptions {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 一条 host 连接 + 一个 SessionDataLayer。
 *
 * 与桌面 ReadyV4ConversationProvider 同一装配方式：每个 workspace 一条 transport，
 * 同一 transport 上多个 session 各自一个 projection store。
 */
export function createConversationLiveLayer(
  agentService: IZCodeAgentService,
  options: ConversationLiveLayerOptions,
): SessionDataLayer {
  const transport = createAgentConversationTransport(agentService, {
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
  });
  return new SessionDataLayer({ transport });
}

/**
 * 从 service accessor 取 agent service 并建层；accessor 尚未就绪时返回 null。
 * 手机端 host 侧把 IZCodeAgentService 换成了带 connection scope 的实现
 * （host/index.ts 的 overrides.set(IZCodeAgentService.channelName, connectionScope.service)），
 * 因此 subscribe/frame 的握手与归属判定都按 web-remote-replayable 生效。
 */
export function createConversationLiveLayerFromAccessor(
  accessor: IServiceAccessor | null | undefined,
  options: ConversationLiveLayerOptions,
): SessionDataLayer | null {
  const agentService = accessor?.zcodeAgentService;
  if (!agentService) return null;
  return createConversationLiveLayer(agentService, options);
}

/** 取一个 session 的租约；调用方负责在切换/卸载时 release。 */
export function acquireConversation(
  layer: SessionDataLayer,
  sessionId: string,
): SessionLease {
  return layer.acquire(sessionId);
}
