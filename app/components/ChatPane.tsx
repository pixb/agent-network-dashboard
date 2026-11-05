'use client';

import { useEffect, useRef, useState } from 'react';
import { AliasAvatar } from './AliasAvatar';
import { TaskChatPanel } from './TaskChatPanel';
import { NodeSettingsPanel } from './NodeSettingsPanel';
import { ChatPaneOverflowMenu } from './ChatPaneOverflowMenu';
import { useSessions } from '../lib/hooks';
import { t } from '../lib/ui-lang';

// #Stage B (dashboard 3-col): the persistent right chat column on /nodes.
// This is ChatPopover with the floating shell stripped: no drag, no resize,
// no viewport-clamped positioning — just a column header + TaskChatPanel's
// `inline` body (the same body ChatPopover embeds), so send / SSE / history
// / drafts behave identically in popover, overlay, and pane.
//
// #Stage C: flex-1 — when a node is selected the middle table no longer
// renders (NodesView.chatOpenDesktop), so the pane takes all width right
// of the rail instead of being squeezed to a fixed sliver by the table.
//
// Batch (07-31 通信龙) segment 4: chat top-bar right adds ⋮ (overflow /
// settings entry), 📅 (view task), 🔍 (search — disabled v1), + existing
// ✕ (close). Settings entry opens NodeSettingsPanel as a 360px right-
// drawer SCOPED to the chat pane (positioning='absolute'), so opening
// settings doesn't cover the sidebar or rail — SPEC §12 + 通信龙 判定.
// TaskChatPanel stays mounted while the drawer opens (renders as a
// sibling, not a replacement) so draft / scroll / SSE state survives —
// Vincent's "只发生一次就再也不敢用" red-line.
//
// Test-hook contract:
//   - Root: data-testid="chat-pane", data-chat-alias
//   - Buttons: data-testid="chat-pane-{settings,view-tasks,search,close}"
//   - Settings dialog inherits NodeSettingsPanel's role="dialog"
export interface ChatPaneProps {
  /** Node alias to chat with. Changing it swaps the conversation in place. */
  alias: string;
  /** Close the pane (unselect + URL back to /nodes — parent owns both). */
  onClose: () => void;
  /** #Mobile two-level nav: 'page' renders full-width/full-height with a
   *  back arrow (Feishu phone form — chat is a page, not a column).
   *  Default 'column' keeps the desktop right-column behavior. */
  variant?: 'column' | 'page';
  /** Back arrow handler (page variant). Falls back to onClose. */
  onBack?: () => void;
}

export function ChatPane({ alias, onClose, variant = 'column', onBack }: ChatPaneProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 07-31 通信龙 batch (SPEC §12 remaining): ⋮ opens overflow menu
  // (not settings direct). Menu items include 会话设置 as one of four.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowAnchorRef = useRef<HTMLButtonElement | null>(null);
  // Look up session for NodeSettingsPanel — it requires the full row.
  // useSessions is SWR-cached (same key as NodesView), so no extra
  // network cost.
  const { sessions } = useSessions();
  const session = sessions.find(s => s.alias === alias);

  // 抽屉关闭后把焦点还给 ⋮：触屏上按钮不会被 focus，useReturnFocus 记不到来源
  //（实测 390 下 Esc 关闭后 activeElement = BODY），这里显式归还一次。
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen) {
      overflowAnchorRef.current?.focus({ preventScroll: true });
    }
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen]);

  return (
    <aside
      data-testid="chat-pane"
      data-chat-alias={alias}
      // `relative` so the settings drawer (positioning='absolute')
      // scopes to this <aside>, not the viewport. Without this the
      // drawer would cover the whole page — the exact regression
      // 通信龙's judgment ("settings-as-right-drawer, not 4th column
      // and not fullscreen") is designed to prevent.
      // page variant (#mobile two-level nav): full-bleed chat page below md.
      // pb keeps the composer above the fixed MobileNav (visible < lg) —
      // same offset AppShell reserves for normal pages.
      className={variant === 'page'
        ? 'relative flex flex-col w-full min-w-0 h-full bg-[var(--col-chat)] pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0'
        : 'relative hidden md:flex md:flex-col flex-1 min-w-0 h-full bg-[var(--col-chat)] pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0'}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-[var(--col-line)] bg-[var(--col-chat)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {variant === 'page' && (
            <button
              type="button"
              onClick={onBack ?? onClose}
              aria-label={t('返回列表', 'Back to list')}
              data-testid="chat-back"
              className="inline-flex h-8 w-8 -ml-1 items-center justify-center rounded-lg text-gray-400 hover:text-gray-100 hover:bg-[var(--bg-elevated)] transition-colors shrink-0"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <AliasAvatar alias={alias} size={26} />
          <span className="truncate text-sm font-semibold text-white">{alias}</span>
        </div>
        {/* SPEC §12 (this batch): four header controls.
            - ⋮ chat-pane-more     opens overflow dropdown (4 items)
            - 📋 chat-pane-view-tasks jumps to /tasks?to_name=<alias>
                (URL param wired via TasksView.tsx:75-76 same batch —
                the prior `?alias=` was silently dropped in prod)
            - 🔍 chat-pane-search  dispatches CustomEvent
                'chat:open-search' which TaskChatPanel listens for
                (search infra already existed; needed a header trigger)
            - ✕ chat-pane-close    unchanged
            NodeSettingsPanel is now inside the overflow menu as
            'chat-pane-settings' (same testid preserved), NOT the
            direct handler of ⋮. */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            ref={overflowAnchorRef}
            type="button"
            onClick={() => setOverflowOpen(v => !v)}
            aria-label={t('会话溢出菜单', 'Chat overflow menu')}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            title={t('更多', 'More')}
            data-testid="chat-pane-more"
            data-menu-open={overflowOpen ? 'true' : 'false'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:text-gray-200 hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="5" r="1.5" fill="currentColor" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              <circle cx="12" cy="19" r="1.5" fill="currentColor" />
            </svg>
          </button>
          <a
            href={`/tasks?to_name=${encodeURIComponent(alias)}`}
            aria-label={t(`查看 ${alias} 的任务`, `View ${alias} tasks`)}
            title={t('查看任务', 'View tasks')}
            data-testid="chat-pane-view-tasks"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:text-gray-200 hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3M16 7V3M4 11h16M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </a>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('chat:open-search', { detail: { alias } }))}
            aria-label={t('会话内搜索', 'In-chat search')}
            title={t('搜索（⌘/Ctrl+F）', 'Search (⌘/Ctrl+F)')}
            data-testid="chat-pane-search"
            data-search-enabled="true"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:text-gray-200 hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('关闭会话', 'Close chat')}
            data-testid="chat-pane-close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:text-gray-200 hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {/* TaskChatPanel stays mounted regardless of settingsOpen —
            it's a SIBLING of the settings drawer, not a child. React
            preserves its state (draft / scroll / SSE) across drawer
            toggle because the tree position doesn't change. */}
        <TaskChatPanel alias={alias} onClose={onClose} inline />
      </div>
      {/* Settings drawer — mounts as sibling of TaskChatPanel, scoped
          to this aside via positioning='absolute'. session may be
          undefined briefly during SWR revalidation; guard so the
          drawer doesn't open with no data (button was clicked before
          sessions loaded — rare but possible). */}
      {settingsOpen && session && (
        <NodeSettingsPanel
          session={session}
          onClose={() => setSettingsOpen(false)}
          positioning="absolute"
        />
      )}
      {overflowOpen && (
        <ChatPaneOverflowMenu
          alias={alias}
          anchorRef={overflowAnchorRef}
          onClose={() => setOverflowOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
    </aside>
  );
}
