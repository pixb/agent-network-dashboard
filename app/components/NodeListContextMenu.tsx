'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { togglePin, usePinned } from '../lib/chat-pin';
import { toggleMute, useMuted } from '../lib/chat-mute';
import { markChatRead, useChatUnread } from '../lib/chat-unread';
import { useNetworkId } from '../lib/network-context';
import { t } from '../lib/ui-lang';
import { useReturnFocus } from '../lib/useReturnFocus';

// SPEC §10 (dashboard-ui-ref/SPEC.md): right-click context menu for
// NodeList rail entries. Actions: 置顶 / 免打扰 / 标记已读.
//
// Positioning (SPEC §10 "贴边行为"):
//   - default: right-and-down of cursor
//   - if rect.bottom + menuHeight > viewport.bottom → flip up
//   - if rect.right  + menuWidth  > viewport.right  → flip left
//   - at least 8px margin from every viewport edge
//   - useLayoutEffect measures menu then adjusts position (menu size
//     is bounded but not fixed — item labels change per state)
//
// Deep-styling: NO shadow (SPEC §2 conclusion — dark theme shadow
// renders as gray haze). Use brighter bg (#1E293B vs chat's #141826)
// + 1px border for shape.
//
// Test-hook contract:
//   - Root: data-testid="node-context-menu", data-target-alias, role="menu"
//   - Items: data-testid="ctx-pin"|"ctx-mute"|"ctx-mark-read", role="menuitem"
//   - data-flipped-{y,x}="true" when position was flipped for tests.

export interface NodeListContextMenuProps {
  alias: string;
  x: number;  // cursor clientX at right-click
  y: number;  // cursor clientY at right-click
  onClose: () => void;
}

const MENU_W = 200;   // SPEC §10: 200px fixed width
const EDGE = 8;       // SPEC §10: ≥8px margin from viewport edge

export function NodeListContextMenu({ alias, x, y, onClose }: NodeListContextMenuProps) {
  // 键盘打开（Shift+F10 / 菜单键）后焦点必须进菜单，否则方向键到不了。
  useReturnFocus();
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
      .filter(el => !(el as HTMLButtonElement).disabled);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  };

  const pinned = usePinned(alias);
  const muted = useMuted(alias);
  const { networkId } = useNetworkId();
  const { unreadCount } = useChatUnread();
  const unread = unreadCount(alias);
  const ref = useRef<HTMLDivElement | null>(null);
// Position is applied imperatively in the layout effect below (no state:
  // measure-then-setState — even in useLayoutEffect — trips the
  // react-hooks/set-state-in-effect gate, and a re-render isn't needed
  // just to move a fixed-position element).

  // SPEC §10 "贴边行为" — measure after paint, flip axis if would
  // overflow. useLayoutEffect so users don't see a paint at the
  // wrong location before the flip.
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuH = rect.height || 120;  // fallback if getBoundingClientRect races
    const menuW = MENU_W;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let top = y;
    let left = x;
    let flippedY = false;
    let flippedX = false;
    if (y + menuH + EDGE > vh) {
      top = Math.max(EDGE, y - menuH);
      flippedY = true;
    }
    if (x + menuW + EDGE > vw) {
      left = Math.max(EDGE, x - menuW);
      flippedX = true;
    }
    // Final clamp — in case the flip still overflows on tiny viewports.
    top = Math.max(EDGE, Math.min(top, vh - menuH - EDGE));
    left = Math.max(EDGE, Math.min(left, vw - menuW - EDGE));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    if (flippedY) el.setAttribute('data-flipped-y', 'true'); else el.removeAttribute('data-flipped-y');
    if (flippedX) el.setAttribute('data-flipped-x', 'true'); else el.removeAttribute('data-flipped-x');
  }, [x, y]);

  useEffect(() => {
    // mousedown-capture so a right-click INSIDE the menu doesn't dismiss.
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('mousedown', onClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, []);

  const runAndClose = (fn: () => void) => () => { fn(); onClose(); };

  // SPEC §10 三态色值 (Tailwind can't do arbitrary custom hex on
  // pseudo-classes easily; the group-hover + `data-*` selectors on the
  // Menu item below drive the state colors via inline CSS variables to
  // keep both bg + text + icon flipping together on hover.)
  const itemCls =
    'group w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 text-[12px] font-medium text-[var(--fg)] ' +
    'hover:bg-[rgba(125,211,252,0.10)] hover:text-white active:bg-[rgba(125,211,252,0.18)] ' +
    'disabled:text-[var(--fg-dim)] disabled:cursor-not-allowed disabled:hover:bg-transparent';

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={t(`节点 ${alias} 操作菜单`, `Actions for node ${alias}`)}
      onKeyDown={onMenuKeyDown}
      data-testid="node-context-menu"
      data-target-alias={alias}
      style={{ position: 'fixed', top: y, left: x, width: MENU_W, zIndex: 60 }}
      className="rounded-lg border border-[var(--border)] bg-[var(--menu-bg)] py-1"
      onContextMenu={e => e.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="ctx-pin"
        onClick={runAndClose(() => togglePin(alias))}
        className={itemCls}
      >
        <IconPin className="shrink-0 w-5 h-5 text-[var(--fg-muted)] group-hover:text-[var(--hl)]" />
        {pinned ? t('取消置顶', 'Unpin') : t('置顶会话', 'Pin conversation')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="ctx-mute"
        onClick={runAndClose(() => toggleMute(alias))}
        className={itemCls}
      >
        <IconBell muted className="shrink-0 w-5 h-5 text-[var(--fg-muted)] group-hover:text-[var(--hl)]" />
        {muted ? t('取消免打扰', 'Unmute') : t('免打扰', 'Mute')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="ctx-mark-read"
        onClick={runAndClose(() => markChatRead(alias, networkId))}
        disabled={unread === 0}
        className={itemCls}
      >
        <IconCheck className="shrink-0 w-5 h-5 text-[var(--fg-muted)] group-hover:text-[var(--hl)] group-disabled:text-[var(--fg-dim)]" />
        {t(unread > 0 ? `标记已读 (${unread})` : '标记已读', unread > 0 ? `Mark ${unread} read` : 'Mark read')}
      </button>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(menu, document.body);
}

function IconPin({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M5 10l7 7 7-7" />
      <path d="M5 10l3-8h8l3 8z" />
    </svg>
  );
}
function IconBell({ className, muted }: { className?: string; muted?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5" />
      <path d="M13.7 21a2 2 0 01-3.4 0" />
      {muted && <path d="M3 3l18 18" />}
    </svg>
  );
}
function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}
