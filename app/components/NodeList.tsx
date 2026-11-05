'use client';

import { useEffect, useRef, useState } from 'react';
import { AliasAvatar } from './AliasAvatar';
import { useChatUnread } from '../lib/chat-unread';
import { useHasDraft } from '../lib/chat-drafts';
import { usePinned } from '../lib/chat-pin';
import { useMuted } from '../lib/chat-mute';
import { NodeListContextMenu } from './NodeListContextMenu';
import type { Session } from './types';
import { t } from '../lib/ui-lang';

// Batch (07-31 通信龙): wire chat-pin / chat-mute into the rail. Pattern
// copied from AgentCard.tsx (usePinned + useMuted per row) so behavior
// matches the existing table view — pinned rows sort first (inherited
// from NodesView's sort chain), and muted rows suppress the unread
// badge (but keep the underlying count correct — muted ≠ marked-read).

// #Stage A (dashboard 3-col): persistent narrow node list rail —
// WeChat-style entries (avatar + alias + activity preview + unread badge)
// that stay visible while user reads/interacts with the table on the
// right OR opens a chat popover. The point is not "look like Feishu";
// the point is "node list and chat panel are visible at the same time,
// switching between nodes takes zero operations" (通信龙, 07-31).
//
// Test-hook contract:
//   - Rail entries carry `data-node-list-item` + `data-node-list-alias`.
//     Deliberately distinct from the table's `data-node-card` /
//     `data-node-alias` so #492's exact-count assertions on the table
//     view stay valid (rail and table would otherwise both match and
//     `toHaveCount(1)` would break).
//   - Selected entry gets `data-selected="true"` for keyboard/screen-
//     reader affordance and future tests.

type SessionRow = Session & { online: boolean };

export interface NodeListProps {
  /** The already-filtered list from NodesPage — rail mirrors what the
   *  table shows, not a second filter chain. Sharing keeps the two
   *  views from disagreeing while filter chips are being toggled. */
  sessions: SessionRow[];
  /** Currently-selected alias (drives visual highlight). Passing null
   *  means nothing selected — the rail still lists everything. */
  selectedAlias: string | null;
  /** Called when the user clicks an entry. Parent decides what to do
   *  with it (open ChatPopover, navigate, etc). Stage A keeps the
   *  existing ChatPopover behavior; Stage B may swap this for URL
   *  navigation. */
  onSelect: (alias: string) => void;
  /** #Stage D (Vincent ③): rail-top search. Bound to the SAME search
   *  state as the middle table's magnifier search, so in the unselected
   *  state typing here filters table and rail together (preserves the
   *  Stage A "rail count == table count" invariant), and in the selected
   *  state — where the table column doesn't render at all — the user
   *  can still search. pinyin matching comes for free because the parent
   *  filter chain already runs pinyinMatch. */
  search: string;
  onSearchChange: (v: string) => void;
}

// Extracted so per-row hooks (usePinned / useMuted / useHasDraft) attach
// per-alias. Rules-of-hooks means we can't call them inside a .map()
// callback conditionally; each row is its own component so React
// mounts a fresh hook state per alias.
interface NodeListRowProps {
  session: SessionRow;
  selected: boolean;
  unread: number;
  onSelect: (alias: string) => void;
  onContextMenu: (alias: string, e: React.MouseEvent) => void;
}
function NodeListRow({ session: s, selected, unread, onSelect, onContextMenu }: NodeListRowProps) {
  const pinned = usePinned(s.alias);
  const muted = useMuted(s.alias);
  return (
    <button
      key={s.alias}
      type="button"
      data-node-list-item
      data-node-list-alias={s.alias}
      data-selected={selected ? 'true' : 'false'}
      // 通信龙 07-31: attribute is ALWAYS present ('true'|'false'),
      // never removed. This separates capability (attr exists on every
      // row → wire is intact) from state (attr === 'true' → user did
      // pin/mute this one). Prior form (undefined when false) made a
      // gate script's "at least one on page" check indistinguishable
      // from "wire got ripped out" — both looked like `[data-node-pinned]`
      // empty. See feedback_tolerant_assertion_accepts_noncompliance.
      data-node-pinned={pinned ? 'true' : 'false'}
      data-node-muted={muted ? 'true' : 'false'}
      onClick={() => onSelect(s.alias)}
      onContextMenu={e => onContextMenu(s.alias, e)}
      // 键盘等价于右键：Shift+F10（Windows 惯例）或菜单键。否则这三项
      //（pin/mute/已读）只能鼠标右键——虽然别处有入口，标准行为仍应支持。
      onKeyDown={e => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onContextMenu(s.alias, { preventDefault() {}, clientX: r.left + 24, clientY: r.top + r.height / 2 } as React.MouseEvent);
        }
      }}
      // SPEC §11.1: pinned row = whole-row light background
      // rgba(125,211,252,0.04) (hover 0.08); no pin ICON (Feishu
      // pattern). Selected wins over both.
      style={{ height: NODE_ROW_HEIGHT, minHeight: NODE_ROW_HEIGHT }}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors border-b border-[var(--col-hairline)] ${
        selected
          ? 'bg-cyan-500/8'
          : pinned
            ? 'bg-[rgba(125,211,252,0.04)] hover:bg-[rgba(125,211,252,0.08)]'
            : 'hover:bg-[var(--bg-elevated)]'
      }`}
    >
      <div className="relative shrink-0">
        <AliasAvatar alias={s.alias} size={32} />
        {s.online && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 ring-2 ring-[var(--col-list)]"
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          {/* SPEC §11: alias + optional bell-slash icon at RIGHT of
              alias when muted (12×12, #64748B). NO pin icon — pinned
              state is signaled by row background per §11.1. */}
          <span className={`text-[13px] truncate flex items-center gap-1.5 min-w-0 ${selected ? 'text-cyan-200 font-medium' : 'text-gray-200'}`}>
            <span className="truncate">{s.alias}</span>
            {muted && (
              <svg
                aria-label={t('已免打扰', 'Muted')}
                data-mute-icon
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#64748B"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0"
              >
                <path d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7" />
                <path d="M6 8v3.2c0 .5-.2 1-.6 1.4L4 14h9" />
                <path d="M13.7 21a2 2 0 01-3.4 0" />
                <path d="M3 3l18 18" />
              </svg>
            )}
          </span>
          {/* SPEC §11.3: unread badge color depends on mute:
              - not-muted → red (#EF4444 / white)
              - muted    → gray (#475569 / #CBD5E1) — count still shown,
                           per "static + silent" (mute ≠ mark-read).
              Kept as one <span> with data-unread-badge on both
              variants so tests can find it regardless of state. */}
          {unread > 0 && (
            <span
              aria-label={muted
                ? t(`已免打扰，未读 ${unread}`, `Muted, ${unread} unread`)
                : t(`${unread} 条未读`, `${unread} unread`)
              }
              data-unread-badge
              data-badge-variant={muted ? 'muted' : 'default'}
              className={`shrink-0 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-semibold leading-4 text-center ${
                muted
                  ? 'bg-[var(--badge-muted-bg)] text-[var(--badge-muted-fg)]'
                  : 'bg-[var(--danger)] text-white'
              }`}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <LastLine alias={s.alias} session={s} />
        </div>
      </div>
    </button>
  );
}

// Rows have an explicit fixed height so a large fleet can be windowed without
// measuring every mounted node. Six rows of overscan keep wheel/touch scrolling
// smooth while bounding a 100+ node rail to a small DOM working set.
const NODE_ROW_HEIGHT = 53;
const NODE_ROW_OVERSCAN = 6;
const INITIAL_VIEWPORT_HEIGHT = 600;

export function nodeListWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
) {
  const safeTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeHeight = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : INITIAL_VIEWPORT_HEIGHT);
  const start = Math.max(0, Math.floor(safeTop / NODE_ROW_HEIGHT) - NODE_ROW_OVERSCAN);
  const visible = Math.ceil(safeHeight / NODE_ROW_HEIGHT) + NODE_ROW_OVERSCAN * 2;
  const end = Math.min(itemCount, start + visible);
  return {
    start,
    end,
    top: start * NODE_ROW_HEIGHT,
    bottom: Math.max(0, (itemCount - end) * NODE_ROW_HEIGHT),
  };
}

function LastLine({ alias, session }: { alias: string; session: SessionRow }) {
  const draft = useHasDraft(alias);
  if (draft) {
    return (
      <span className="text-[11px] text-red-400/90 truncate" aria-label={t('有未发送草稿', 'Unsent draft')}>
        {t('[草稿]', '[draft]')} {session.task ? session.task.slice(0, 40) : ''}
      </span>
    );
  }
  if (session.task) {
    return <span className="text-[11px] text-gray-500 truncate">{session.task}</span>;
  }
  if (!session.online) {
    return <span className="text-[11px] text-gray-600 italic">{t('离线', 'offline')}</span>;
  }
  return <span className="text-[11px] text-gray-600">{t('空闲', 'idle')}</span>;
}

export function NodeList({ sessions, selectedAlias, onSelect, search, onSearchChange }: NodeListProps) {
  const { unreadCount } = useChatUnread();
  // Batch (07-31) segment 2: right-click context menu state. `null` when
  // closed; `{alias, x, y}` when open. Positioning is at the mouse
  // coords from the contextmenu event so the menu appears where the
  // user right-clicked, not at a static offset.
  const [menu, setMenu] = useState<{ alias: string; x: number; y: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(INITIAL_VIEWPORT_HEIGHT);

  // Batch (07-31) segment 3: keyboard ↑↓ walks the list, Enter opens
  // the focused entry (URL changes via parent's onSelect → router.push).
  //
  // Focus discipline: window-level keydown, guarded to skip when the
  // user is typing in a text control — the "chat input" case Vincent
  // explicitly named, plus any generic input/textarea/contenteditable
  // so we don't hijack keystrokes anywhere in the app.
  //
  // Ref pattern: parent's `onSelect` and `sessions` change reference
  // every render (arrow fn / filtered array). If we used them in the
  // deps array, the effect would re-attach the listener on every
  // render — brief windows with no listener could miss keydowns.
  // Instead: attach ONCE (empty deps), read latest values via ref.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ sessions, selectedAlias, onSelect });
  // (was a bare write during render — react-hooks/refs violation caught by
  // the pre-commit gate; an effect keeps the same "listener reads latest
  // values" semantics, updated post-render.)
  useEffect(() => { stateRef.current = { sessions, selectedAlias, onSelect }; });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
      // 焦点在菜单/弹层里时不要接管：那些控件自己要用方向键。
      // （实测：会话溢出菜单内按 ↓ 会被这里当成「切换侧栏会话」，直接换会话。）
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="menu"], [role="dialog"], [role="listbox"], [role="tablist"]')) return;
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (active.isContentEditable) return;
        // 焦点在主列表的卡片上时，方向键归卡片列表（NodesView 自己处理）。
        // 不加这一条的话，这里会把方向键当成「切换侧栏选中项」，直接切到会话视图、
        // 主列表整片卸载——表现就是「按了方向键，卡片全没了」（实测）。
        if (active.closest('[data-node-card]')) return;
      }
      const { sessions: s, selectedAlias: sel, onSelect: pick } = stateRef.current;
      if (s.length === 0) return;
      const currentIdx = sel ? s.findIndex(x => x.alias === sel) : -1;
      if (e.key === 'Enter') {
        if (currentIdx === -1) {
          e.preventDefault();
          pick(s[0].alias);
        }
        return;
      }
      e.preventDefault();
      const nextIdx = currentIdx === -1
        ? (e.key === 'ArrowDown' ? 0 : s.length - 1)
        : (e.key === 'ArrowDown'
            ? Math.min(s.length - 1, currentIdx + 1)
            : Math.max(0, currentIdx - 1));
      if (nextIdx !== currentIdx) pick(s[nextIdx].alias);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewportHeight(Math.max(1, element.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selectedIndex = selectedAlias
    ? sessions.findIndex(session => session.alias === selectedAlias)
    : -1;

  // Auto-scroll works from the item index rather than querying the DOM: a
  // selected off-screen row is intentionally not mounted by the virtualizer.
  // Depend on the numeric index, not the sessions array reference — SWR
  // refreshes return a fresh array every five seconds and must not snap an
  // operator back to the selected row while they browse elsewhere.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || selectedIndex < 0) return;
    const rowTop = selectedIndex * NODE_ROW_HEIGHT;
    const rowBottom = rowTop + NODE_ROW_HEIGHT;
    let nextTop = element.scrollTop;
    if (rowTop < element.scrollTop) nextTop = rowTop;
    else if (rowBottom > element.scrollTop + element.clientHeight) {
      nextTop = Math.max(0, rowBottom - element.clientHeight);
    }
    if (nextTop !== element.scrollTop) {
      element.scrollTop = nextTop;
    }
  }, [selectedIndex]);

  // A filter can shrink the list while it is scrolled near the bottom. Clamp
  // the retained offset so the new result set cannot render as a blank rail.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const maxTop = Math.max(0, sessions.length * NODE_ROW_HEIGHT - element.clientHeight);
    if (element.scrollTop > maxTop) {
      element.scrollTop = maxTop;
    }
  }, [sessions.length]);

  const virtualWindow = nodeListWindow(sessions.length, scrollTop, viewportHeight);
  const visibleSessions = sessions.slice(virtualWindow.start, virtualWindow.end);

  return (
    <div
      data-node-list-rail
      data-node-list-count={sessions.length}
      className="flex flex-col w-full overflow-hidden bg-[var(--col-list)] border-r border-[var(--col-line)]"
      aria-label={t('节点列表', 'Node list')}
    >
      <div className="p-2 border-b border-[var(--col-hairline)] shrink-0">
        <input
          type="search"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          placeholder={t('搜索节点（拼音可）', 'Search nodes (pinyin ok)')}
          aria-label={t('搜索节点', 'Search nodes')}
          data-testid="rail-search"
          className="w-full rounded-md bg-[var(--col-inset)] border border-[rgba(255,255,255,0.08)] px-2.5 py-1.5 text-[12px] text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/40"
        />
      </div>
      <div className="px-3 py-2 text-[11px] text-gray-500 tracking-wide uppercase border-b border-[var(--col-hairline)] shrink-0">
        {t(`节点 ${sessions.length}`, `Nodes · ${sessions.length}`)}
      </div>
      {menu && (
        <NodeListContextMenu
          alias={menu.alias}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
      <div
        ref={scrollRef}
        data-testid="node-list-scroll"
        data-virtual-start={virtualWindow.start}
        data-virtual-end={virtualWindow.end}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        className="flex-1 min-h-0 overflow-y-auto pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0"
      >
        {sessions.length === 0 ? (
          search ? (
            /* #Stage D (Vincent ③ 判据): a no-match search MUST look
               different from "search broke and returned nothing" — echo
               the query so the user sees their input was applied. */
            <div className="p-4 text-[11px] text-gray-500" data-testid="rail-search-empty">
              {t(`没有节点匹配 “${search}”`, `No match — no nodes named "${search}"`)}
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="ml-2 text-cyan-400/80 hover:text-cyan-300 underline-offset-2 hover:underline"
              >
                {t('清除', 'Clear')}
              </button>
            </div>
          ) : (
          <div className="p-4 text-[11px] text-gray-600">
            {t('列表为空 —— 右侧的筛选控件或空态说明会告诉你原因。', 'Rail is empty — the filter controls or empty state on the right explain why.')}
          </div>
          )
        ) : (
          <>
            {virtualWindow.top > 0 && <div aria-hidden style={{ height: virtualWindow.top }} />}
            {visibleSessions.map(s => <NodeListRow
              key={s.alias}
              session={s}
              selected={s.alias === selectedAlias}
              unread={unreadCount(s.alias)}
              onSelect={onSelect}
              onContextMenu={(alias, e) => {
                e.preventDefault();
                setMenu({ alias, x: e.clientX, y: e.clientY });
              }}
            />)}
            {virtualWindow.bottom > 0 && <div aria-hidden style={{ height: virtualWindow.bottom }} />}
          </>
        )}
      </div>
    </div>
  );
}
