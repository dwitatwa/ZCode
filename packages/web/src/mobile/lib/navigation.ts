/**
 * 消息导航刻度：从时间线投影结果生成右侧导航轨的数据。
 *
 * 单独成文件的原因：时间线投影（timeline.ts）已经接近行数上限，而导航是
 * 纯展示派生逻辑，与投影规则无耦合，拆开两边都更好读。
 */
import type { TimelineTurn } from "./timeline.js";

export interface TimelineNavItem {
  /** 对应 TimelineTurn.key，用于跳转。 */
  turnKey: string;
  turnIndex: number | null;
  /** 用户提问的一行预览。 */
  userPreview: string;
  /** 该轮助手的回答预览；没有正文时给占位文案。 */
  assistantPreview: string;
  isRunning: boolean;
  hasDivider: boolean;
}

const NAV_PREVIEW_MAX = 120;

function navPreview(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > NAV_PREVIEW_MAX ? `${single.slice(0, NAV_PREVIEW_MAX)}…` : single;
}

/**
 * 从 turn 列表生成导航刻度：一问一档。
 *
 * v4 投影路径下 turn 由 CLI 裁决（row.turnId），因此按轮出刻度就够了，
 * 与桌面 ConversationTurnNavigator 的 unit 粒度一致。桌面还会再按
 * origin=realUser 折叠掉系统注入的 user 行；手机时间线里 system 行
 * （goalContinuation / backgroundResult / mailbox）本来就不渲染成 user 条目，
 * 所以这里不需要 origin 判定。
 */
export function buildTimelineNav(
  turns: readonly TimelineTurn[],
  isGenerating: boolean,
): TimelineNavItem[] {
  const items: TimelineNavItem[] = [];
  turns.forEach((turn, turnIndexInList) => {
    const userItem = turn.items.find((item) => item.kind === "user");
    if (!userItem || userItem.kind !== "user") return;

    let assistantPreview = "";
    let hasDivider = false;
    for (const item of turn.items) {
      if (item.kind === "assistant-text" && !assistantPreview) {
        assistantPreview = navPreview(item.text);
      }
      if (item.kind === "divider") hasDivider = true;
    }
    const isLastTurn = turnIndexInList === turns.length - 1;
    const isRunning = isGenerating && isLastTurn;
    items.push({
      turnKey: turn.key,
      turnIndex: turn.turnIndex,
      userPreview: navPreview(userItem.text) || "User query",
      assistantPreview:
        assistantPreview ||
        (isRunning ? "Assistant is still working" : "No assistant text yet"),
      isRunning,
      hasDivider,
    });
  });
  return items;
}
