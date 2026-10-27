/**
 * 手机页连接的 remote session 登记。
 *
 * 手机聊天区是桌面 V4ChatPane,它内部的 V4ConversationProvider 按 workspaceIdentity
 * 解析 remote session;解析不到就停在 remote-waiting 并渲染 null —— 这正是「远端项目
 * 新会话整屏空白、composer 不出现」的原因。桌面 relay bridge 有登记
 * (webRemoteControlWorkspaceBridgeSession),手机直连页此前没有。
 *
 * sessionId 只当 transport 句柄用,不必是打开中的任务 id:会话 RPC 全部走
 * accessor.zcodeAgentService 并带 workspaceIdentity 参数,而 accessor 已由
 * `?workspace=<identity>` 的 WS attachment 定格到对应 workspace(connection.ts)。
 */
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspaceIdentity,
  getRemoteWorkspaceSession,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@zcode/ui/remote-workspace-session-store";

export interface MobileRemoteSessionRegistration {
  dispose: () => void;
}

export function mobileRemoteSessionId(workspaceIdentity: string): string {
  return `mobile-remote:${workspaceIdentity}`;
}

export function registerMobileRemoteWorkspaceSession(params: {
  workspaceIdentity: string;
  services: IServiceAccessor;
}): MobileRemoteSessionRegistration {
  const { workspaceIdentity, services } = params;
  const sessionId = mobileRemoteSessionId(workspaceIdentity);

  registerBaseWorkspaceServices(services);
  registerRemoteWorkspaceSession({ sessionId, services });
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);

  return {
    dispose: () => {
      // 同 identity 重连会以新 accessor 复用同一 sessionId(StrictMode 重挂、硬刷新、
      // 断线重连)。旧清理晚于新注册执行时不能把新登记拆掉 —— 与 relay bridge 的
      // dispose 守卫同款:只有仍持有本代 accessor 时才撤。
      if (getRemoteWorkspaceSession(sessionId)?.services !== services) {
        return;
      }
      // 手机页只有一条连接:它关闭后 base fallback 也要跟着撤,否则切回本地
      // workspace 时会解析到这条已死的 accessor。
      if (useRemoteWorkspaceSessionStore.getState().baseServices === services) {
        useRemoteWorkspaceSessionStore.setState({ baseServices: null });
      }
      unregisterRemoteWorkspaceSession(sessionId);
    },
  };
}
