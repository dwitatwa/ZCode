/**
 * 手机端的 workspace 呈现规则。
 *
 * 抽成独立模块的原因:这些是纯函数,可以真正跑测试;而 main.tsx 在模块顶层就
 * createRoot().render(),没法在单测里安全导入。顺带消掉了选择器与外壳各自
 * 复制一份 label 规则的问题。
 */
import type { ServerRemoteWorkspaceInfo } from "@zcode/shared";

export type MobileWorkspaceInfo = ServerRemoteWorkspaceInfo;

/** 显示名:优先服务端给的 label,否则取路径最后一段。 */
export function workspaceLabel(workspace: MobileWorkspaceInfo): string {
  if (workspace.label) return workspace.label;
  const parts = workspace.path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || workspace.path;
}

/**
 * 不可用原因的说明文案。
 *
 * 服务端只给机器可读代码,文案在这里决定:手机才是用户看到它的地方,也只有这里
 * 知道该怎么措辞。两种原因都指向同一个动作 —— 在桌面端把这个项目重新连上。
 */
export function unavailableNote(code: string | undefined): string {
  if (code === "REMOTE_SESSION_OFFLINE") {
    return "Its remote connection is offline. Reconnect the project on the desktop, then retry.";
  }
  return "Its remote connection is not available. Reconnect the project on the desktop, then retry.";
}

/**
 * 下一个可用 workspace 的下标;没有可用项时返回 -1。
 *
 * 不可用态要给出「换一个项目」的出口,但只在确实还有别的可用项时才有意义 ——
 * 全部不可用时给这个按钮只会让用户原地打转。
 */
export function nextAvailableWorkspaceIndex(
  workspaces: readonly MobileWorkspaceInfo[],
  currentIndex: number,
): number {
  return workspaces.findIndex(
    (candidate, index) => index !== currentIndex && !candidate.unavailableCode,
  );
}

/** 选择器里的一项,带着它在原列表中的下标 —— 下标才是切换 workspace 的依据。 */
export interface WorkspacePickerEntry {
  item: MobileWorkspaceInfo;
  index: number;
}/**
 * 把 workspace 列表拆成「可用」与「不可用」两组,各自保持服务端给出的顺序。
 *
 * 桌面端按标签页顺序给列表,里面会混着已被回收的 WSL 会话。原样展示的后果是
 * 用户要在一个半数是死项的列表里找自己的项目,而点中死项只会把整屏换成错误页。
 * 分组后可用项集中在顶部、立即能选;不可用项退到下面并标明原因。
 *
 * 下标必须跟着条目一起走:数组位置会因分组而变,但切换 workspace 用的始终是
 * 服务端列表里的位置。
 */
export function splitWorkspaceEntries(workspaces: readonly MobileWorkspaceInfo[]): {
  available: WorkspacePickerEntry[];
  unavailable: WorkspacePickerEntry[];
} {
  const available: WorkspacePickerEntry[] = [];
  const unavailable: WorkspacePickerEntry[] = [];
  workspaces.forEach((item, index) => {
    (item.unavailableCode ? unavailable : available).push({ item, index });
  });
  return { available, unavailable };
}

/**
 * 一个 workspace 的连接标识。
 *
 * 为什么需要:workspace 列表每次刷新都会重建对象,而 React 按引用比较依赖。若连接
 * 副作用依赖 workspace 对象,刷新一次就会重连,phase 先回到 connecting,整屏被换成
 * "Connecting…" —— 主屏连同打开的选择器一起被卸载,用户看到的就是"选择器刚点开
 * 就自己关了"。这里给出稳定的字符串,同一个项目刷新前后得到同一个值。
 */
export function workspaceScope(workspace: MobileWorkspaceInfo | null | undefined): string {
  if (!workspace) return "";
  return `${workspace.path}\u0000${workspace.workspaceIdentity ?? ""}`;
}

/**
 * 列表刷新后,按路径找回当前项目的新下标。
 *
 * 为什么按路径而不是按下标:下标只是「服务端这次给的顺序」,桌面端关掉一个标签页
 * 就会让后面所有项目前移一位。若沿用旧下标,用户会在毫不知情的情况下被切到另一个
 * 项目 —— 而手机端切换 workspace 是重连,看起来就像「我的任务全没了」。
 *
 * 找不到当前项目时退回 0(而不是保留旧下标,那会指向别的项目);空列表返回 -1。
 */
export function resolveWorkspaceIndex(
  workspaces: readonly MobileWorkspaceInfo[],
  currentPath: string | undefined,
): number {
  if (workspaces.length === 0) return -1;
  if (currentPath) {
    const found = workspaces.findIndex((item) => item.path === currentPath);
    if (found !== -1) return found;
  }
  return 0;
}
