/**
 * 会话头部用的行查询。
 *
 * 这里曾经是一整套"v4 行 → 手机自有时间线条目"的投影（buildTimelineFromRows 等），
 * 因为手机当时用自己的渲染器画正文。现在正文交给桌面那棵 ConversationTimeline
 * （见 components/DesktopConversationBody.tsx），投影层不再参与渲染，只留下头部
 * 需要的两个判断。删掉的不是能力，是重复实现 —— 行的语义现在由桌面渲染器自己决定。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/** 首屏是否没有可渲染行；用于区分"空会话"与"还在连"。 */
export function rowsAreEmpty(rows: readonly ConversationRow[]): boolean {
  // turnHeader 只是轮边界，不算内容。
  return rows.every((row) => row.kind === "turnHeader");
}

/** 窗口里最后一轮是否 running；驱动头部状态。 */
export function anyTurnRunning(rows: readonly ConversationRow[]): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "turnHeader") return row.state === "running";
  }
  return false;
}
