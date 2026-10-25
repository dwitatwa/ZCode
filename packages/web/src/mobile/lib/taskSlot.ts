/**
 * 主屏右槽的呈现规则。
 *
 * 手机主屏每行只有一个右侧位置,它必须回答「这行现在要不要我管」:
 * 运行中/失败时给状态词,其余给相对时间。把这套判断抽成纯函数,是为了能用真实
 * 输入测试三种状态的映射,而不是靠断言源码里出现过某个字符串。
 */
import type { ZCodeTaskPersistStatus } from "@zcode/shared";

export type TaskSlotTone = "running" | "error" | "quiet";

export interface TaskSlot {
  /** 右槽文字:需要关注时是状态词,否则是相对时间。 */
  text: string;
  tone: TaskSlotTone;
}

/**
 * 相对时间,刻意保持极短:主屏右槽只有几十像素,写 "2 minutes ago" 会挤掉标题。
 * 一个月以上退化成天数,避免出现 "43d" 这种没有意义的数字。
 */
export function relativeTime(ts: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * 决定右槽显示什么。
 *
 * 完成态刻意不显示 "Done":一屏里大多数行都是完成的,重复同一个词只会制造噪声,
 * 而时间才是这些行唯一有差异的信息。运行中和失败是少数、且需要行动,所以它们
 * 抢占这个位置。
 */
export function taskRightSlot(
  status: ZCodeTaskPersistStatus | undefined,
  age: string,
): TaskSlot {
  if (status === "running") return { text: "Running", tone: "running" };
  if (status === "error") return { text: "Failed", tone: "error" };
  return { text: age, tone: "quiet" };
}
