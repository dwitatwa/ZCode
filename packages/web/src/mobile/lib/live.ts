/**
 * 手机端实时会话订阅。
 *
 * 用桌面同一条 v4 投影链路（SessionDataLayer + ConversationProjectionStore）取代
 * "3s 轮询快照 + 丢弃流式事件" 的旧读路径。一个 workspace 一条 transport，
 * 一个 session 一份 store 租约；store 内部按 snapshot/delta 自证水位，
 * 因此文本、思考、工具行都是到达即渲染，不再等轮询。
 *
 * 为什么 layer/lease 都放在 effect 里而不是 useMemo：
 * 手机入口跑在 React StrictMode 下（桌面 renderer 明确不用 StrictMode），
 * StrictMode 会 mount → cleanup → mount 各跑一次 effect。useMemo 不会重算，
 * 于是 cleanup 里 dispose 掉的 layer 会被永久复用 —— 表现是 30s keep-warm 到期后
 * store 被关掉、界面静默停止更新。放进 effect 后 cleanup 与重建成对出现，
 * 引用计数最终收敛到 1。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { IServiceAccessor } from "@zcode/services";
import {
  createConversationLiveLayerFromAccessor,
  type ConversationStoreState,
  type SessionDataLayer,
  type SessionLease,
} from "@zcode/ui/conversation-live";

export interface ConversationLive {
  /** null 表示 accessor/session 还没就绪。 */
  state: ConversationStoreState | null;
  /** 补拉更早的历史行；store 未就绪时是空操作。 */
  loadOlder: () => void;
  /** 订阅失败后的手动重试（store 自带退避，这里只是入口）。 */
  retry: () => void;
}

const NOOP_SUBSCRIBE = () => () => undefined;
const NOOP_STATE = (): null => null;

/**
 * 订阅失败后的退避节奏。新会话刚创建时最可能需要它（会话还没在 CLI 就绪），
 * 因此首次很快、后续放缓；耗尽后交给用户手动重试，不做无限重连。
 */
const RETRY_DELAYS_MS: readonly number[] = [400, 1_000, 2_500, 5_000];

export function useConversationLive(params: {
  accessor: IServiceAccessor | null;
  workspacePath: string | null;
  workspaceIdentity: string | undefined;
  sessionId: string | null;
}): ConversationLive {
  const { accessor, workspacePath, workspaceIdentity, sessionId } = params;
  const [layer, setLayer] = useState<SessionDataLayer | null>(null);
  const [lease, setLease] = useState<SessionLease | null>(null);

  // 每个 workspace 一个 layer（= 一条 host 连接上的投影层），与桌面 Provider 同构。
  useEffect(() => {
    if (!accessor || !workspacePath) {
      setLayer(null);
      return;
    }
    const created = createConversationLiveLayerFromAccessor(accessor, {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    if (!created) return;
    setLayer(created);
    return () => {
      setLayer(null);
      created.dispose();
    };
  }, [accessor, workspacePath, workspaceIdentity]);

  // 一个 session 一份租约；切 session 或卸载即释放（layer 自身进 keep-warm）。
  useEffect(() => {
    if (!layer || !sessionId) {
      setLease(null);
      return;
    }
    const acquired = layer.acquire(sessionId);
    setLease(acquired);
    return () => {
      setLease(null);
      acquired.release();
    };
  }, [layer, sessionId]);

  const state = useSyncExternalStore(
    lease ? (listener) => lease.store.subscribe(listener) : NOOP_SUBSCRIBE,
    lease ? () => lease.store.getState() : NOOP_STATE,
    lease ? () => lease.store.getState() : NOOP_STATE,
  );

  /**
   * 订阅失败的有界自动重试。
   *
   * 为什么需要：新建会话后立刻订阅时，会话可能还没在 CLI 侧就绪（draft 阶段），
   * 首次 subscribe 会失败。store 自身只在 runtime 换代那类错误上退避重连，
   * 普通 subscribe 失败会停在 error —— 手机上表现为"新会话一片空白"。
   * 这里补一层退避：live 时归零，连续失败到上限后停下并保留手动重试入口。
   */
  const retryAttempt = useRef(0);
  const status = state?.status;
  useEffect(() => {
    if (!lease) return;
    if (status === "live") {
      retryAttempt.current = 0;
      return;
    }
    if (status !== "error") return;
    const delay = RETRY_DELAYS_MS[retryAttempt.current];
    if (delay === undefined) return;
    retryAttempt.current += 1;
    const timer = setTimeout(() => {
      void lease.store.retry();
    }, delay);
    return () => clearTimeout(timer);
  }, [lease, status]);

  return {
    state,
    loadOlder: () => {
      void lease?.store.loadOlder();
    },
    retry: () => {
      retryAttempt.current = 0;
      void lease?.store.retry();
    },
  };
}
