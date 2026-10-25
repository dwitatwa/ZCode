/**
 * 手机直连的 workspace 列表与 scope 解析。
 *
 * 关键行为:
 * - 列表带出远端 identity,手机才可能请求到 WSL runtime;
 * - 没有可用条目时返回空列表(不再拿桌面进程目录冒充项目);
 * - 未知/不可用的远端 workspace 被明确拒绝,绝不回退到本地服务。
 *
 * `resolveWindowWorkspaces` 与 scope 解析都是模块内私有函数,通过 manager 的公开
 * 行为不便直接触达(需要 Electron 窗口与真实监听),这里用源码级断言锁定这两个
 * 契约点,避免它们被静默改回旧行为。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const managerSource = readSource("../src/main/mobileDirectConnectionManager.ts");
const serverSource = readSource("../src/main/mobileDirectServer.ts");
const bridgeSource = readSource("../src/main/mobileDirectBridge.ts");

describe("mobile direct workspace listing", () => {
  it("no longer falls back to the desktop process directory", () => {
    // 空列表是真实状态;拿 process.cwd() 冒充项目会显示一个不属于用户的工作区。
    // 注意 process.cwd() 在 resolveDefaultMobileDistRoot 里仍合法(那是找静态资源),
    // 所以只断言 workspace 解析函数体内没有它。
    const start = managerSource.indexOf("function resolveWindowWorkspaces(");
    expect(start).toBeGreaterThan(-1);
    const end = managerSource.indexOf("\n}", start);
    const body = managerSource.slice(start, end);
    expect(body).not.toContain("process.cwd()");
    expect(body).toContain("windowWorkspaceEntryMap");
  });

  it("publishes the remote identity with each entry", () => {
    expect(managerSource).toContain("workspaceIdentity: entry.workspaceIdentity");
    expect(managerSource).toContain("windowWorkspaceEntryMap");
  });

  it("publishes why a remote workspace is unavailable", () => {
    // 手机必须在连接之前就知道某个远端 workspace 连不上:握手被拒时浏览器读不到
    // 响应体,只能得到一个没有信息量的网络错误。
    expect(managerSource).toContain("unavailableCode: resolved.code");
    expect(managerSource).toContain("resolveRemoteSessionForWorkspace(win, {");
  });
});

describe("mobile direct scope resolution", () => {
  it("resolves a requested identity to a remote scope through the session registry", () => {
    // 手机只报 identity;sessionId 由 main 在窗口自己的会话表里解析。
    expect(managerSource).toContain("resolveRemoteSessionForWorkspace");
    expect(managerSource).toContain('kind: "remote"');
    expect(managerSource).toContain("remoteSessionId: resolved.remoteSessionId");
  });

  it("defaults to the local scope when no workspace is requested", () => {
    expect(managerSource).toContain('{ ok: true, scope: { kind: "local" } }');
  });

  it("refuses a workspace that is not open in this window", () => {
    expect(managerSource).toContain("请求的 workspace 不在当前窗口中");
    // 拒绝必须返回 ok:false,而不是静默回退。
    expect(managerSource).toContain("if (!resolved.ok) return { ok: false, message: resolved.message };");
  });

  it("carries the requested workspace from the upgrade into the socket handler", () => {
    expect(serverSource).toContain('c.req.query("workspace")');
    expect(serverSource).toContain("resolveSocketScope");
    // 拒绝必须在握手之前：先 upgrade 再 close 会让浏览器侧 open 先触发，
    // connectViaWebSocket 的 promise 已经 resolve，手机就会把连接当成可用。
    expect(serverSource).toContain("return c.text(resolved.message, 400)");
    expect(serverSource).not.toContain("ws.close(4004");
  });

  it("attaches with the resolved scope instead of always local", () => {
    expect(bridgeSource).toContain("scope: WindowHostAttachmentScope");
    expect(bridgeSource).toContain("scope,");
    expect(bridgeSource).not.toContain('scope: { kind: "local" },\n        },\n        [port2],');
  });
});
