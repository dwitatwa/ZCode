/**
 * 窗口 workspace 条目表的纯函数守卫。
 *
 * 这些函数同时喂两个消费面（跨窗口按路径去重、手机直连的 workspace 列表），
 * 所以分开测：条目的校验/清洗，以及两种 key 的推导口径。
 */
import { describe, expect, it } from "vitest";
import {
  isRemoteWorkspaceEntry,
  parseWindowWorkspaceEntries,
  windowWorkspacePaths,
  windowWorkspaceRealtimeKeys,
} from "../src/main/windowWorkspaceEntries.js";

const WSL_IDENTITY = "remote:wsl:Ubuntu-24.04:/home/dev/project";

describe("parseWindowWorkspaceEntries", () => {
  it("rejects a non-array payload", () => {
    expect(parseWindowWorkspaceEntries(undefined)).toBeNull();
    expect(parseWindowWorkspaceEntries("C:\\ws")).toBeNull();
    expect(parseWindowWorkspaceEntries({ path: "/ws" })).toBeNull();
  });

  it("keeps local entries without inventing remote fields", () => {
    expect(parseWindowWorkspaceEntries([{ path: "/ws", label: "ws" }])).toEqual([
      { path: "/ws", label: "ws" },
    ]);
  });

  it("keeps the remote identity and session of a remote entry", () => {
    expect(
      parseWindowWorkspaceEntries([
        { path: "/home/dev/project", label: "project", workspaceIdentity: WSL_IDENTITY, remoteSessionId: "s1" },
      ]),
    ).toEqual([
      { path: "/home/dev/project", label: "project", workspaceIdentity: WSL_IDENTITY, remoteSessionId: "s1" },
    ]);
  });

  it("keeps a disconnected remote entry, which has an identity but no session", () => {
    const parsed = parseWindowWorkspaceEntries([
      { path: "/home/dev/project", workspaceIdentity: WSL_IDENTITY },
    ]);
    expect(parsed).toEqual([{ path: "/home/dev/project", workspaceIdentity: WSL_IDENTITY }]);
    expect(parsed?.[0]?.remoteSessionId).toBeUndefined();
  });

  it("drops a single malformed entry instead of rejecting the whole batch", () => {
    // 一个坏条目不该让整个窗口的 workspace 列表消失。
    expect(
      parseWindowWorkspaceEntries([
        { path: "/ws" },
        { path: "   " },
        { label: "no path" },
        null,
        "string",
        { path: "/ws2" },
      ]),
    ).toEqual([{ path: "/ws" }, { path: "/ws2" }]);
  });

  it("trims values and drops empty remote fields", () => {
    expect(
      parseWindowWorkspaceEntries([
        { path: "  /ws  ", label: "  ", workspaceIdentity: "   ", remoteSessionId: "" },
      ]),
    ).toEqual([{ path: "/ws" }]);
  });
});

describe("window workspace key derivation", () => {
  const entries = [
    { path: "C:\\local\\project" },
    { path: "/home/dev/project", workspaceIdentity: WSL_IDENTITY, remoteSessionId: "s1" },
  ];

  it("uses paths for cross-window dedup", () => {
    expect(windowWorkspacePaths(entries)).toEqual(["C:\\local\\project", "/home/dev/project"]);
  });

  it("uses identity for realtime keys, matching the task service", () => {
    // task service 的 resolveWorkspaceKey 是 identity 优先；不一致会让远端订阅不到更新。
    expect(windowWorkspaceRealtimeKeys(entries)).toEqual([
      "C:\\local\\project",
      WSL_IDENTITY,
    ]);
  });

  it("treats a missing list as empty", () => {
    expect(windowWorkspacePaths(undefined)).toEqual([]);
    expect(windowWorkspaceRealtimeKeys(undefined)).toEqual([]);
  });

  it("classifies an entry as remote from its identity alone", () => {
    expect(isRemoteWorkspaceEntry(entries[0]!)).toBe(false);
    expect(isRemoteWorkspaceEntry(entries[1]!)).toBe(true);
    // 断连占位条目仍有 identity，仍是远端。
    expect(isRemoteWorkspaceEntry({ path: "/p", workspaceIdentity: WSL_IDENTITY })).toBe(true);
  });
});
