'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { togglePin, usePinned } from '../lib/chat-pin';
import { useReturnFocus } from '../lib/useReturnFocus';
import { t } from '../lib/ui-lang';

// SPEC §12: chat header ⋮ opens an overflow menu. Container reuses the
// same visual tokens as NodeListContextMenu (SPEC §10): 200px width,
// 32px item height, #1E293B background, 1px border, no shadow, edge-
// flip on overflow. Portal to body so overflow-y-auto ancestors don't
// clip us.
//
// Items:
//   - 添加标签页 / 移除标签页  → togglePin(alias)  (label swaps by state)
//   - 查看任务                 → navigate /tasks?to_name=<alias>
//   - 会话设置                 → open NodeSettingsPanel (via onOpenSettings)
//   - ─                       → separator (visual only, non-interactive)
//
// 清空历史 is intentionally absent — hub has no clear-history endpoint
// (see issue #66); rendering it as pure-client setChatEvents([]) would
// "hide until next fetch", which is worse than not offering it.

export interface ChatPaneOverflowMenuProps {
  alias: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenSettings: () => void;
}

const EDGE = 8;

export function ChatPaneOverflowMenu({ alias, anchorRef, onClose, onOpenSettings }: ChatPaneOverflowMenuProps) {
  // 菜单在 DOM 末尾（portal），打开后焦点若不进来，键盘用户要 Tab 穿过整页才能到达。
  // 按 role=menu 的标准模式：打开聚焦第一项，↑/↓ 循环，Esc 关闭并归还焦点。
  useReturnFocus();
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    ).filter(el => el.offsetParent !== null);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(current + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const pinned = usePinned(alias);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; flippedY: boolean; flippedX: boolean }>({
    top: 0, left: 0, flippedY: false, flippedX: false,
  });

  // Position below the anchor (⋮ button) by default; flip up if would
  // overflow bottom, flip left if would overflow right. Same logic as
  // NodeListContextMenu but anchored to an element instead of a cursor.
  useLayoutEffect(() => {
    if (!anchorRef.current || !menuRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let top = a.bottom + 4;
    let left = a.right - m.width;
    let flippedY = false;
    let flippedX = false;
    if (top + m.height + EDGE > vh) {
      top = Math.max(EDGE, a.top - m.height - 4);
      flippedY = true;
    }
    if (left < EDGE) {
      left = a.left;
      flippedX = true;
    }
    top = Math.max(EDGE, Math.min(top, vh - m.height - EDGE));
    left = Math.max(EDGE, Math.min(left, vw - m.width - EDGE));
    setPos({ top, left, flippedY, flippedX });
  }, [anchorRef]);

  // Close on click-outside (excluding the anchor button itself, which
  // has its own toggle handler) and Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus({ preventScroll: true });
  }, []);

  if (typeof window === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('会话溢出菜单', 'Chat overflow menu')}
      onKeyDown={onMenuKeyDown}
      data-testid="chat-pane-overflow-menu"
      data-flipped-y={pos.flippedY ? 'true' : undefined}
      data-flipped-x={pos.flippedX ? 'true' : undefined}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: 200, zIndex: 200 }}
      className="rounded-md border border-[var(--col-line-strong)] bg-[var(--menu-bg)] py-1 text-[12px] text-gray-100"
    >
      <MenuItem
        testid="chat-pane-overflow-pin"
        onClick={() => { togglePin(alias); onClose(); }}
      >
        {pinned ? t('移除标签页', 'Remove tab') : t('添加标签页', 'Add as tab')}
      </MenuItem>
      <MenuItemLink
        testid="chat-pane-overflow-view-tasks"
        href={`/tasks?to_name=${encodeURIComponent(alias)}`}
        onClick={onClose}
      >
        {t('查看任务', 'View tasks')}
      </MenuItemLink>
      <MenuItem
        testid="chat-pane-settings"
        onClick={() => { onOpenSettings(); onClose(); }}
      >
        {t('会话设置', 'Conversation settings')}
      </MenuItem>
      <div
        role="separator"
        data-testid="chat-pane-overflow-separator"
        className="my-1 h-px bg-[rgba(255,255,255,0.08)]"
      />
    </div>,
    document.body,
  );
}

function MenuItem({ children, onClick, testid }: { children: React.ReactNode; onClick: () => void; testid: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testid}
      onClick={onClick}
      className="flex h-8 w-full items-center px-3 text-left hover:bg-[rgba(125,211,252,0.08)] focus:bg-[rgba(125,211,252,0.08)] focus:outline-none"
    >
      {children}
    </button>
  );
}

function MenuItemLink({ children, href, onClick, testid }: { children: React.ReactNode; href: string; onClick: () => void; testid: string }) {
  return (
    <a
      role="menuitem"
      data-testid={testid}
      href={href}
      onClick={onClick}
      className="flex h-8 w-full items-center px-3 text-left hover:bg-[rgba(125,211,252,0.08)] focus:bg-[rgba(125,211,252,0.08)] focus:outline-none"
    >
      {children}
    </a>
  );
}
