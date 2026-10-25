/**
 * 工作区选择器浮层。
 *
 * 从 ExplorerScreen 拆出来的原因有两个:一是那个文件已经接近行数上限,二是选择器
 * 的规则(哪些能点、哪些只展示)值得单独成文件,读的人一眼能看全。
 *
 * 规则:
 * - 可用项目在上,直接可点。
 * - 不可用项目在下,列出来但不可点 —— 点中只会把整屏换成错误页,用户还得再退回来。
 * - 不可用的原因只在分组下说一次;每行重复一整句只会把列表拉长一倍。
 */
import type { MobileWorkspaceInfo } from "../lib/connection.js";
import { splitWorkspaceEntries, unavailableNote, workspaceLabel } from "../lib/workspaces.js";
import { Sheet } from "../components/Overlays.js";

export function WorkspacePicker({
  workspaces,
  workspaceIndex,
  onPick,
  onClose,
}: {
  workspaces: MobileWorkspaceInfo[];
  workspaceIndex: number;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const picker = splitWorkspaceEntries(workspaces);
  const total = picker.available.length + picker.unavailable.length;

  return (
    <Sheet title="Workspace" onClose={onClose} className="ms-sheet">
      <div className="ms-sheet-group">
        <span>Projects</span>
        {picker.unavailable.length > 0 ? (
          <span>
            {picker.available.length} of {total}
          </span>
        ) : null}
      </div>

      {picker.available.length === 0 ? (
        <div className="ms-sheet-empty">No project is available right now.</div>
      ) : null}

      {picker.available.map(({ item, index }) => (
        <button
          key={`${item.path}-${index}`}
          className={`option-row${index === workspaceIndex ? " selected" : ""}`}
          onClick={() => {
            onClose();
            onPick(index);
          }}
        >
          <span className="option-row-main">
            <span className="option-row-label">
              {workspaceLabel(item)}
              {item.workspaceIdentity ? <span className="ws-remote-tag">remote</span> : null}
            </span>
            <span className="option-row-sub">{item.path}</span>
          </span>
          {index === workspaceIndex ? <span className="option-check">✓</span> : null}
        </button>
      ))}

      {picker.unavailable.length > 0 ? (
        <>
          <div className="ms-sheet-group">
            <span>Offline</span>
            <span>{picker.unavailable.length}</span>
          </div>
          <div className="ms-sheet-note">
            {unavailableNote(picker.unavailable[0]!.item.unavailableCode)}
          </div>
          {picker.unavailable.map(({ item, index }) => (
            <div
              key={`${item.path}-${index}`}
              className="option-row unavailable"
              aria-disabled="true"
            >
              <span className="option-row-main">
                <span className="option-row-label">
                  {workspaceLabel(item)}
                  {item.workspaceIdentity ? <span className="ws-remote-tag">remote</span> : null}
                </span>
                <span className="option-row-sub">{item.path}</span>
              </span>
            </div>
          ))}
        </>
      ) : null}
    </Sheet>
  );
}
