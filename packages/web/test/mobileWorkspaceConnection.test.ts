/**
 * 手机端连接层:workspace identity 必须进 WS 地址。
 *
 * 一个 attachment 只能绑定一个 scope,所以切换 workspace 是重连而不是复用同一条连接。
 * 这里锁定 URL 构造,避免远端 identity 被丢掉(那会让手机静默落回本地服务)。
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// connection.ts 在模块顶层读 window.location 与 sessionStorage,先给最小桩。
const location = { protocol: "http:", host: "100.64.0.5:3030", search: "" };
const storage = new Map<string, string>();

vi.stubGlobal("window", { location });
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
});

const { buildWsUrl, wsUrl } = await import("../src/mobile/lib/connection.js");

describe("mobile ws url", () => {
  beforeEach(() => storage.clear());

  it("omits the workspace parameter for a local workspace", () => {
    expect(buildWsUrl()).toBe("ws://100.64.0.5:3030/ws");
  });

  it("carries the remote identity so the server can resolve a remote scope", () => {
    const identity = "remote:wsl:Ubuntu-24.04:/home/dev/project";
    const url = buildWsUrl(identity);
    expect(url).toBe(`ws://100.64.0.5:3030/ws?workspace=${encodeURIComponent(identity)}`);
    // identity 里的冒号与斜杠必须被编码,否则查询串会被截断。
    expect(url).toContain("remote%3Awsl%3A");
  });

  it("keeps the default url local", () => {
    expect(wsUrl).toBe("ws://100.64.0.5:3030/ws");
  });
});
