/**
 * 手机端 workspace 呈现规则的行为测试。
 *
 * 这些是纯函数,直接跑真实输入:上一版只断言源码里有某个字符串,证明不了
 * 「全部不可用时不会给出换项目的按钮」这类判断。
 */
import { describe, expect, it } from "vitest";
import {
  nextAvailableWorkspaceIndex,
  resolveWorkspaceIndex,
  splitWorkspaceEntries,
  unavailableNote,
  workspaceLabel,
  workspaceScope,
} from "../src/mobile/lib/workspaces.js";
import type { MobileWorkspaceInfo } from "../src/mobile/lib/workspaces.js";

const local: MobileWorkspaceInfo = { path: "C:\\Users\\me\\local", label: "local" };
const offline: MobileWorkspaceInfo = {
  path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj",
  label: "proj",
  workspaceIdentity: "remote:wsl:Ubuntu:me:/home/me/proj",
  unavailableCode: "REMOTE_SESSION_MISSING",
};

describe("workspaceLabel", () => {
  it("prefers the label from the server", () => {
    expect(workspaceLabel(local)).toBe("local");
  });

  it("falls back to the last path segment for windows and posix paths", () => {
    expect(workspaceLabel({ path: "C:\\work\\repo" })).toBe("repo");
    expect(workspaceLabel({ path: "/home/me/repo" })).toBe("repo");
  });

  it("ignores trailing separators", () => {
    expect(workspaceLabel({ path: "/home/me/repo/" })).toBe("repo");
  });
});

describe("unavailableNote", () => {
  it("distinguishes an offline session from a missing one", () => {
    expect(unavailableNote("REMOTE_SESSION_OFFLINE")).toContain("offline");
    expect(unavailableNote("REMOTE_SESSION_MISSING")).not.toContain("offline");
  });

  it("always names the action the user has to take", () => {
    for (const code of ["REMOTE_SESSION_OFFLINE", "REMOTE_SESSION_MISSING", undefined]) {
      expect(unavailableNote(code)).toContain("Reconnect the project on the desktop");
    }
  });
});

describe("nextAvailableWorkspaceIndex", () => {
  it("skips the current workspace and picks an available one", () => {
    expect(nextAvailableWorkspaceIndex([offline, local], 0)).toBe(1);
  });

  it("skips other unavailable workspaces", () => {
    const second: MobileWorkspaceInfo = {
      path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\other",
      label: "other",
      workspaceIdentity: "remote:wsl:Ubuntu:me:/home/me/other",
      unavailableCode: "REMOTE_SESSION_OFFLINE",
    };
    expect(nextAvailableWorkspaceIndex([offline, second, local], 0)).toBe(2);
  });

  it("returns -1 when nothing else is available", () => {
    // 全部不可用时不该给出「换一个项目」的出口,否则用户只是原地打转。
    expect(nextAvailableWorkspaceIndex([offline], 0)).toBe(-1);
    const second: MobileWorkspaceInfo = {
      path: "/other",
      unavailableCode: "REMOTE_SESSION_MISSING",
    };
    expect(nextAvailableWorkspaceIndex([offline, second], 0)).toBe(-1);
  });

  it("treats a local workspace as available", () => {
    expect(nextAvailableWorkspaceIndex([offline, local], 0)).toBe(1);
  });
});

describe("splitWorkspaceEntries", () => {
  const third: MobileWorkspaceInfo = {
    path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\other",
    label: "other",
    workspaceIdentity: "remote:wsl:Ubuntu:me:/home/me/other",
    unavailableCode: "REMOTE_SESSION_OFFLINE",
  };

  it("puts usable projects first and dead ones after them", () => {
    const { available, unavailable } = splitWorkspaceEntries([offline, local, third]);
    expect(available.map((entry) => entry.item.label)).toEqual(["local"]);
    expect(unavailable.map((entry) => entry.item.label)).toEqual(["proj", "other"]);
  });

  it("keeps the original server index on every entry", () => {
    // 分组会改变数组位置,但切换 workspace 必须按服务端列表的下标走。
    const { available, unavailable } = splitWorkspaceEntries([offline, local, third]);
    expect(available[0]!.index).toBe(1);
    expect(unavailable[0]!.index).toBe(0);
    expect(unavailable[1]!.index).toBe(2);
  });

  it("preserves the relative order inside each group", () => {
    const second: MobileWorkspaceInfo = { path: "/b", label: "b" };
    const { available } = splitWorkspaceEntries([local, offline, second]);
    expect(available.map((entry) => entry.item.label)).toEqual(["local", "b"]);
  });

  it("returns an empty unavailable group when everything is usable", () => {
    const { available, unavailable } = splitWorkspaceEntries([local]);
    expect(available).toHaveLength(1);
    expect(unavailable).toEqual([]);
  });

  it("returns an empty available group when nothing is usable", () => {
    // 全不可用时界面必须说「现在没有可用项目」,而不是给一个空列表。
    const { available, unavailable } = splitWorkspaceEntries([offline, third]);
    expect(available).toEqual([]);
    expect(unavailable).toHaveLength(2);
  });

  it("does not mutate the input list", () => {
    const input = [offline, local];
    splitWorkspaceEntries(input);
    expect(input.map((item) => item.label)).toEqual(["proj", "local"]);
  });
});

describe("workspaceScope", () => {
  const local: MobileWorkspaceInfo = { path: "C:\\proj", label: "proj" };
  const remote: MobileWorkspaceInfo = {
    path: "\\\\wsl.localhost\\Ubuntu\\proj",
    label: "proj",
    workspaceIdentity: "remote:wsl:Ubuntu:/proj",
  };

  it("is identical for two objects describing the same project", () => {
    // 这正是缺陷所在:刷新列表会重建对象,但 scope 必须不变,否则连接副作用重跑、
    // 整屏被换成 Connecting…、打开的选择器随之被卸载。
    const refreshed: MobileWorkspaceInfo = { path: "C:\\proj", label: "proj" };
    expect(workspaceScope(refreshed)).toBe(workspaceScope(local));
  });

  it("differs when the project path differs", () => {
    const other: MobileWorkspaceInfo = { path: "C:\\other", label: "proj" };
    expect(workspaceScope(other)).not.toBe(workspaceScope(local));
  });

  it("differs when only the remote identity differs", () => {
    const otherIdentity: MobileWorkspaceInfo = {
      ...remote,
      workspaceIdentity: "remote:ssh:host:/proj",
    };
    expect(workspaceScope(otherIdentity)).not.toBe(workspaceScope(remote));
  });

  it("distinguishes a local project from a remote one at the same path", () => {
    expect(workspaceScope({ path: remote.path })).not.toBe(workspaceScope(remote));
  });

  it("is empty when there is no workspace", () => {
    expect(workspaceScope(null)).toBe("");
    expect(workspaceScope(undefined)).toBe("");
  });
});

describe("resolveWorkspaceIndex", () => {
  const a: MobileWorkspaceInfo = { path: "/a", label: "a" };
  const b: MobileWorkspaceInfo = { path: "/b", label: "b" };
  const c: MobileWorkspaceInfo = { path: "/c", label: "c" };

  it("finds the same project after the list order changes", () => {
    // 桌面端关掉一个标签页会让后面的项目前移;沿用旧下标就会静默切到别的项目。
    expect(resolveWorkspaceIndex([a, b, c], "/b")).toBe(1);
    expect(resolveWorkspaceIndex([b, c, a], "/b")).toBe(0);
    expect(resolveWorkspaceIndex([c, b, a], "/b")).toBe(1);
  });

  it("falls back to the first project when the current one disappeared", () => {
    expect(resolveWorkspaceIndex([a, c], "/b")).toBe(0);
  });

  it("falls back to the first project when no path is known", () => {
    expect(resolveWorkspaceIndex([a, b], undefined)).toBe(0);
  });

  it("returns -1 for an empty list", () => {
    // -1 是「没有可选项」的信号,调用方据此保留原状态而不是指向不存在的下标。
    expect(resolveWorkspaceIndex([], "/a")).toBe(-1);
  });

  it("does not confuse a remote entry with a local one sharing a label", () => {
    // 路径是身份,label 只是显示名;同名项目必须靠 path 区分。
    const remoteB: MobileWorkspaceInfo = {
      path: "\\\\wsl.localhost\\Ubuntu\\b",
      label: "b",
      workspaceIdentity: "remote:wsl:Ubuntu:/b",
      unavailableCode: "REMOTE_SESSION_OFFLINE",
    };
    expect(resolveWorkspaceIndex([a, b, remoteB], remoteB.path)).toBe(2);
  });
});
