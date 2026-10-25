/**
 * 窗口 workspace 条目表。
 *
 * Renderer 每个窗口上报一份有序条目(路径 + 可选远端身份)。这里集中维护,因为有两个
 * 消费面:
 * - 按路径的窗口去重(ActivateOrSetWorkspace / focusWorkspaceInExistingWindow),
 *   只关心本地路径;
 * - 手机直连的 workspace 列表,需要远端 identity 才能把条目解析成可 attach 的 scope。
 *
 * 顺序即 renderer 的 tab 顺序,也就是手机端选择器的展示顺序(第一项为默认选中项)。
 */
import type { WindowWorkspaceEntry } from "@zcode/shared";

/** 一个窗口的 workspace 条目;窗口关闭即删除整条记录。 */
export type WindowWorkspaceEntryMap = Map<number, WindowWorkspaceEntry[]>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 校验 renderer 上报的条目。
 *
 * 逐条过滤而不是整批拒绝:一个坏条目不该让整个窗口的 workspace 列表消失。
 * 路径必填且去空白;远端字段只在非空字符串时保留,避免把空串当成 identity。
 */
export function parseWindowWorkspaceEntries(value: unknown): WindowWorkspaceEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: WindowWorkspaceEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const path = record.path;
    if (!isNonEmptyString(path)) continue;
    const label = isNonEmptyString(record.label) ? record.label.trim() : undefined;
    const workspaceIdentity = isNonEmptyString(record.workspaceIdentity)
      ? record.workspaceIdentity.trim()
      : undefined;
    const remoteSessionId = isNonEmptyString(record.remoteSessionId)
      ? record.remoteSessionId.trim()
      : undefined;
    entries.push({
      path: path.trim(),
      ...(label ? { label } : {}),
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    });
  }
  return entries;
}

/** 条目集合里的本地路径(跨窗口去重只认路径)。 */
export function windowWorkspacePaths(entries: readonly WindowWorkspaceEntry[] | undefined): string[] {
  return (entries ?? []).map((entry) => entry.path);
}

/**
 * 条目对应的任务实时通道 key。
 *
 * 本地用路径,远端用 identity —— 与 task service 的 `resolveWorkspaceKey` 一致
 * (identity 优先)。不一致会让远端 workspace 的实时更新订阅不到。
 */
export function windowWorkspaceRealtimeKeys(
  entries: readonly WindowWorkspaceEntry[] | undefined,
): string[] {
  return (entries ?? []).map((entry) => entry.workspaceIdentity?.trim() || entry.path);
}

/** 该条目是否指向远端 runtime(有 identity 即远端,断连占位 tab 也算)。 */
export function isRemoteWorkspaceEntry(entry: WindowWorkspaceEntry): boolean {
  return Boolean(entry.workspaceIdentity?.trim());
}
