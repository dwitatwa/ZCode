/**
 * 会话头部用到的纯格式化。
 *
 * 这里曾经还负责轮次编号、时钟时间、工具状态词 —— 那些是手机自有时间线的组成部分。
 * 正文改由桌面渲染器绘制后（见 components/DesktopConversationBody.tsx），这些值由
 * 渲染器自己算，手机只保留头部需要的两项。
 */

/** 路径最后一段,用作项目名。meta 只有 workspacePath,不能复用 workspaceLabel。 */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** "1 turn" / "3 turns"。 */
export function turnCountLabel(count: number): string {
  return count === 1 ? "1 turn" : `${count} turns`;
}
