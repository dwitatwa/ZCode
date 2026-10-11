/**
 * 消息导航轨：屏幕右侧一列刻度，一问一档，点一下跳到那一轮。
 *
 * 为什么需要：手机上没有桌面端的滚动条缩略图，长会话（尤其带 goal 迭代的）滚起来
 * 完全失去方位感。这里给出与桌面 ConversationTurnNavigator 同款的"刻度 + 悬停预览"
 * 体验，但适配触摸：点击即跳，长按/点击后短暂显示预览气泡。
 *
 * 与桌面端的取舍差异：
 * - 桌面端刻度是 0.5px 高的横条，靠 hover 放大；触摸没有 hover，所以这里点按
 *   直接跳转，并把"当前所在轮"用琥珀色高亮出来。
 * - 预览气泡固定显示在刻度左侧，避免被屏幕右边缘裁掉。
 */
import { memo, useEffect, useRef, useState } from "react";
import type { TimelineNavItem } from "../lib/navigation.js";

interface PeekState {
  index: number;
  /** 气泡中心相对 .msg-nav 顶部的像素偏移，跟随被点的刻度。 */
  top: number;
}

/** 气泡的最小半高（两行文字约 73px），用于边界夹取。 */
const PEEK_HALF_HEIGHT = 40;

export const MessageNav = memo(function MessageNav({
  items,
  activeKey,
  onJump,
}: {
  items: readonly TimelineNavItem[];
  activeKey: string | null;
  onJump: (turnKey: string) => void;
}) {
  const [peek, setPeek] = useState<PeekState | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    };
  }, []);

  const showPeek = (index: number, tick: HTMLButtonElement) => {
    // 气泡锚到被点的那根刻度，而不是容器中心：刻度可能有一二十根，
    // 居中显示会让气泡跟手指位置差很远，看不出点的是哪一条。
    //
    // 用 rect 差值而不是 offsetTop：轨道未定位时，track.offsetTop 与
    // tick.offsetTop 都相对 .msg-nav 解析，相加会双计一次轨道偏移
    // （实测 340 + 364，正确值是 340 + 24）。
    const nav = navRef.current;
    const navRect = nav?.getBoundingClientRect();
    const tickRect = tick.getBoundingClientRect();
    let top = navRect ? tickRect.top - navRect.top + tickRect.height / 2 : 0;
    // 夹住上下边界：气泡是 translateY(-50%)，贴近顶/底刻度时不夹会被裁掉。
    if (navRect) {
      const half = PEEK_HALF_HEIGHT;
      top = Math.min(Math.max(top, half), Math.max(half, navRect.height - half));
    }
    setPeek({ index, top });
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(null), 1600);
  };

  // 少于 2 档没有导航价值，反而挡住正文右侧。
  if (items.length < 2) return null;

  const activeIndex = items.findIndex((item) => item.turnKey === activeKey);

  return (
    <div className="msg-nav" role="navigation" aria-label="Message navigation" ref={navRef}>
      <div className="msg-nav-track">
        {items.map((item, index) => {
          const active = item.turnKey === activeKey;
          return (
            <button
              key={item.turnKey}
              className={`msg-nav-tick${active ? " active" : ""}${item.isRunning ? " running" : ""}`}
              onClick={(event) => {
                showPeek(index, event.currentTarget);
                onJump(item.turnKey);
              }}
              aria-label={`Jump to message ${index + 1}`}
              aria-current={active ? "true" : undefined}
            >
              <span className="msg-nav-bar" />
            </button>
          );
        })}
      </div>

      {peek !== null && items[peek.index] ? (
        <div className="msg-nav-peek" role="tooltip" style={{ top: `${peek.top}px` }}>
          <div className="msg-nav-peek-user">{items[peek.index]?.userPreview}</div>
          <div
            className={`msg-nav-peek-assistant${
              items[peek.index]?.assistantPreview.startsWith("No assistant") ? " empty" : ""
            }`}
          >
            {items[peek.index]?.assistantPreview}
          </div>
        </div>
      ) : null}

      {activeIndex >= 0 ? <span className="msg-nav-pos">{activeIndex + 1}/{items.length}</span> : null}
    </div>
  );
});
