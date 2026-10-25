/**
 * 主屏右槽的行为测试。
 *
 * 右槽是这一版主屏唯一承载状态的位置,所以三种状态的映射必须用真实输入验证,
 * 而不是断言源码里出现过某个字符串。刻意锁住两点:
 * - 完成态不显示 "Done"(一屏里大多数行都完成,重复同一个词只是噪声);
 * - 运行中/失败抢占槽位,时间让位。
 */
import { describe, expect, it } from "vitest";
import { relativeTime, taskRightSlot } from "../src/mobile/lib/taskSlot.js";

describe("taskRightSlot", () => {
  it("shows the status word while a task is running", () => {
    expect(taskRightSlot("running", "2m")).toEqual({ text: "Running", tone: "running" });
  });

  it("shows the status word when a task failed", () => {
    expect(taskRightSlot("error", "3h")).toEqual({ text: "Failed", tone: "error" });
  });

  it("falls back to the age for a completed task", () => {
    // 完成态故意不写 "Done":重复同一个词只会制造噪声,时间才是这些行唯一有差异的信息。
    expect(taskRightSlot("completed", "18m")).toEqual({ text: "18m", tone: "quiet" });
  });

  it("falls back to the age when the task has no status yet", () => {
    expect(taskRightSlot(undefined, "now")).toEqual({ text: "now", tone: "quiet" });
  });

  it("never puts two facts in the slot", () => {
    // 右槽只有几十像素,状态词和时间必须二选一。
    for (const status of ["running", "completed", "error", undefined] as const) {
      const slot = taskRightSlot(status, "5m");
      expect(slot.text).not.toContain("·");
      expect(slot.text.split(/\s+/)).toHaveLength(1);
    }
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);

  it("shows minutes under an hour", () => {
    expect(relativeTime(now - 30_000, now)).toBe("now");
    expect(relativeTime(now - 60_000, now)).toBe("1m");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m");
  });

  it("switches to hours and then days", () => {
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h");
    expect(relativeTime(now - 23 * 60 * 60_000, now)).toBe("23h");
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d");
    expect(relativeTime(now - 5 * 24 * 60 * 60_000, now)).toBe("5d");
  });

  it("never returns a negative age for a future timestamp", () => {
    // 服务端时钟偏差会让 updatedAt 落在未来,不能因此显示 "-3m"。
    expect(relativeTime(now + 60_000, now)).toBe("now");
  });

  it("stays short enough for a narrow slot", () => {
    for (const minutes of [0, 1, 59, 60, 1439, 1440, 60 * 24 * 400]) {
      expect(relativeTime(now - minutes * 60_000, now).length).toBeLessThanOrEqual(4);
    }
  });
});
