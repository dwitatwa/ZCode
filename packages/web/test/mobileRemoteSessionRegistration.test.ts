/**
 * 手机页 remote session 登记的守卫。
 *
 * 手机聊天区走桌面 V4ConversationProvider,远端 workspace 必须能在
 * remoteWorkspaceSessionStore 里解析到 session,否则 provider 渲染 null,
 * 会话正文与 composer 整体消失(远端项目新会话空白的原因)。这里锁定:
 * 登记/注销按连接生命周期成对,且同 identity 重连时旧清理不能拆掉新登记。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { useRemoteWorkspaceSessionStore } from "@zcode/ui/remote-workspace-session-store";
import {
  mobileRemoteSessionId,
  registerMobileRemoteWorkspaceSession,
} from "@web/mobile/lib/remoteSessionRegistration.js";

const IDENTITY_A = "remote:wsl:Ubuntu-24.04:/home/dev/project";
const IDENTITY_B = "remote:ssh:host:/root";

describe("registerMobileRemoteWorkspaceSession", () => {
  beforeEach(() => {
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    });
  });

  it("registers the connection and resolves it by workspace identity", () => {
    const services = { __testId: "a1" } as unknown as IServiceAccessor;

    const registration = registerMobileRemoteWorkspaceSession({
      workspaceIdentity: IDENTITY_A,
      services,
    });

    const state = useRemoteWorkspaceSessionStore.getState();
    const sessionId = mobileRemoteSessionId(IDENTITY_A);
    expect(state.sessionsById[sessionId]?.services).toBe(services);
    expect(state.sessionIdByWorkspaceIdentity[IDENTITY_A]).toBe(sessionId);
    expect(state.baseServices).toBe(services);

    registration.dispose();

    const disposed = useRemoteWorkspaceSessionStore.getState();
    expect(disposed.sessionsById[sessionId]).toBeUndefined();
    expect(disposed.sessionIdByWorkspaceIdentity[IDENTITY_A]).toBeUndefined();
    expect(disposed.baseServices).toBeNull();
  });

  it("keeps a newer registration when a stale dispose runs after reconnect", () => {
    const first = { __testId: "first" } as unknown as IServiceAccessor;
    const second = { __testId: "second" } as unknown as IServiceAccessor;

    const staleRegistration = registerMobileRemoteWorkspaceSession({
      workspaceIdentity: IDENTITY_A,
      services: first,
    });
    registerMobileRemoteWorkspaceSession({
      workspaceIdentity: IDENTITY_A,
      services: second,
    });

    staleRegistration.dispose();

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(state.sessionsById[mobileRemoteSessionId(IDENTITY_A)]?.services).toBe(second);
    expect(state.sessionIdByWorkspaceIdentity[IDENTITY_A]).toBe(mobileRemoteSessionId(IDENTITY_A));
    expect(state.baseServices).toBe(second);
  });

  it("follows the connection lifecycle: close removes the mapping, switch moves it", () => {
    const servicesA = { __testId: "a" } as unknown as IServiceAccessor;
    const servicesB = { __testId: "b" } as unknown as IServiceAccessor;

    // 连接 A → 连接关闭(断线/回收):映射清空。
    const registrationA = registerMobileRemoteWorkspaceSession({
      workspaceIdentity: IDENTITY_A,
      services: servicesA,
    });
    registrationA.dispose();
    expect(useRemoteWorkspaceSessionStore.getState().sessionIdByWorkspaceIdentity).toEqual({});

    // 切换 workspace:先撤 A,再连 B,身份映射指向 B 且不再指向 A。
    const registrationB = registerMobileRemoteWorkspaceSession({
      workspaceIdentity: IDENTITY_B,
      services: servicesB,
    });

    const switched = useRemoteWorkspaceSessionStore.getState();
    expect(switched.sessionIdByWorkspaceIdentity[IDENTITY_A]).toBeUndefined();
    expect(switched.sessionIdByWorkspaceIdentity[IDENTITY_B]).toBe(mobileRemoteSessionId(IDENTITY_B));
    expect(switched.baseServices).toBe(servicesB);

    registrationB.dispose();
    expect(useRemoteWorkspaceSessionStore.getState().baseServices).toBeNull();
  });
});
