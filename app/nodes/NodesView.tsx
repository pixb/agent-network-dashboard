'use client';

import { useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { timeAgo } from '../components/utils';
import { useSessions, useHealth, useNodeLifecycle } from '../lib/hooks';
import { useSWRConfig } from 'swr';
import { CreateNodeWizard } from '../components/CreateNodeWizard';
import { NodeLifecycleMenu } from '../components/NodeLifecycleMenu';
import { EmptyState, NodesEmptyState } from '../components/EmptyState';
import { AliasAvatar } from '../components/AliasAvatar';
import { useHasDraft } from '../lib/chat-drafts';
import { isMuted, useMuteVersion } from '../lib/chat-mute';
import { isPinned, usePinVersion } from '../lib/chat-pin';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin-match';
import { useCollapsibleSearch } from '../components/CollapsibleSearch';
import { NodeList } from '../components/NodeList';
import { ChatPane } from '../components/ChatPane';
import type { Session } from '../components/types';
import { SESSION_STATUS_TEXT_CLASS } from '../lib/status';
import { SESSION_STATUS_DOT_HEX } from '../lib/status';
import { useChatUnread } from '../lib/chat-unread';
import { t, useT } from '../lib/ui-lang';

/** Round 81: shorten long server hostnames (Alibaba `iZ…oyZ` style)
 *  for table display. Returns the original string unchanged when ≤12
 *  chars. Full value should stay in `title=` for hover + screen-readers. */
function shortServer(server: string | null | undefined): string {
  if (!server) return '—';
  return server.length > 12 ? `${server.slice(0, 8)}…` : server;
}

type ViewMode = 'list' | 'grid';

/** 节点状态：圆点 + 文字，不再是带边框的彩色胶囊。
 *  颜色仍来自 status.ts 的单一事实源（working 绿 / blocked 琥珀 / error 红，
 *  idle 灰），只是把「胶囊壳」去掉——minimal-2026-09 的准绳是胶囊与描边越少越好。 */
function StatusLabel({ statusKey }: { statusKey: string }) {
  const dot = SESSION_STATUS_DOT_HEX[statusKey] || SESSION_STATUS_DOT_HEX.offline;
  const text = SESSION_STATUS_TEXT_CLASS[statusKey] || SESSION_STATUS_TEXT_CLASS.offline;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] ${text}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} aria-hidden />
      {statusKey}
    </span>
  );
}
type SessionRow = Session & { online: boolean };

// #Stage B (dashboard 3-col): /nodes/[alias] URL routing. Next's app-router
// param may arrive still percent-encoded (aliases are often Chinese); decode
// exactly once, defensively — if the segment was already decoded and contains
// a literal '%' that doesn't form a valid escape, decodeURIComponent throws
// and we keep the raw value instead of double-decoding.
export function decodeAliasSegment(seg: string): string {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

// #Stage B: < 768px (Tailwind md) falls back to the single-column layout —
// chat opens as the existing full-screen overlay push instead of a third
// column. useSyncExternalStore so SSR (no matchMedia) renders the desktop
// shape and hydration corrects without a React mismatch.
const MD_QUERY = '(min-width: 768px)';
function subscribeMd(cb: () => void) {
  const mql = window.matchMedia(MD_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeMd, () => window.matchMedia(MD_QUERY).matches, () => true);
}

/** R13 (草稿闭环还债): same [草稿] mark as AgentCard/CommandCenter tabs. */
function DraftMark({ alias }: { alias: string }) {
  const t = useT();
  const hasDraft = useHasDraft(alias);
  if (!hasDraft) return null;
  return <span className="shrink-0 text-[9px] text-red-400/90" aria-label={t('有未发送草稿', 'Unsent draft')}>{t('[草稿]', '[draft]')}</span>;
}

export function NodesView({ initialAlias = null }: { initialAlias?: string | null }) {
  // 水合安全：首帧与 SSR 一致（英文），挂载后再切到浏览器语言（#182）。
  const t = useT();
  const { sessions, isLoading: loading, error: loadError, mutate: mutateSessions } = useSessions();
  const { health } = useHealth();
  const { lifecycleByAlias, nodeIdByAlias, attrsByAlias } = useNodeLifecycle();
  const { hasUnread, unreadCount, lastActivityAt } = useChatUnread();
  const { mutate } = useSWRConfig();
  // RFC-027 PR2 — after a stop/delete/restart dispatch lands, refresh
  // /api/hub/nodes (lifecycle_state) AND /api/hub/status (sessions).
  // Both feed the menu's state-aware items; otherwise menu stays
  // stale until next 5s SWR poll.
  const refreshNodes = () => {
    mutate((k: unknown) => typeof k === 'string' && (k.startsWith('/api/hub/nodes') || k.startsWith('/api/hub/status')));
  };
  const sseMap = health?.sse_sessions || {};
  // SSE keys are `network_id:alias` since server v0.7+. Look up with the
  // composite key first, fall back to alias-only for legacy hubs.
  const sseFor = (s: { alias: string; network_id?: string }) =>
    (s.network_id ? sseMap[`${s.network_id}:${s.alias}`] : undefined) ?? sseMap[s.alias];
  const [filterStatus, setFilterStatus] = useState('');
  // #492 goal-3 step 2: filter by team (single-select, '' = no filter,
  // '__NO_TEAM__' = "nodes without any team assignment"). team match is
  // strict equality against attrsByAlias[alias].team ?? null — nodes
  // WITHOUT a team never leak into "team X" results (per PR review:
  // fixture must have mixed team values and assert exact aliases, not
  // just count).
  const [filterTeam, setFilterTeam] = useState('');
  // #492 goal-3 step 2: tag filter is multi-select with AND semantics —
  // "show nodes that have ALL of these tags". This is a product
  // decision (per PR review: OR would be the naive user default; AND
  // is intentional so operators can narrow down instead of widen out).
  // Rendered chip row shows explicit "AND" separators + empty-state
  // echoes the filter conditions so a zero-result AND intersection
  // never looks like a data-sync bug.
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const toggleTag = (t: string) => setFilterTags(cur => cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]);
  // Distinct teams/tags across visible sessions — drives the select
  // options and chip row, and lets us distinguish "cold-start no attrs"
  // from "no match" in the empty state.
  const distinctTeams = Array.from(new Set(sessions.map(s => attrsByAlias[s.alias]?.team).filter((t): t is string => !!t && t.length > 0))).sort();
  const distinctTags = Array.from(new Set(sessions.flatMap(s => attrsByAlias[s.alias]?.tags ?? []).filter(t => t && t.length > 0))).sort();
  const anyAttrs = distinctTeams.length > 0 || distinctTags.length > 0;
  const pinyinReady = usePinyinReady();
  const muteVersion = useMuteVersion();
  void muteVersion; // re-render on mute toggles (isMuted used in map callbacks)
  const pinVersion = usePinVersion();
  void pinVersion;
  void pinyinReady; // R25: re-filter once the lazy pinyin dict lands
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  // #Stage B: selection is seeded from the /nodes/[alias] URL (shareable
  // deep link); afterwards it's plain client state kept in sync with the
  // URL via history.pushState — shallow, no route remount, so switching
  // nodes is zero-operation and the conversation pane swaps in place.
  const [chatAlias, setChatAlias] = useState<string | null>(initialAlias);
  const isDesktop = useIsDesktop();
  const selectNode = (alias: string) => {
    try {
      const el = document.querySelector('[data-testid="node-list-scroll"]');
      if (el) savedListScrollRef.current = el.scrollTop;
    } catch {}
    setChatAlias(alias);
    try { window.history.pushState({}, '', `/nodes/${encodeURIComponent(alias)}`); } catch {}
  };
  const closeChat = () => {
    userClosedRef.current = true; // ③ explicit close wins over auto-select
    setChatAlias(null);
    try { window.history.pushState({}, '', '/nodes'); } catch {}
  };
  // Back/forward buttons walk the selection history the pushState calls
  // above created — mirror the URL back into state.
  useEffect(() => {
    const onPop = () => {
      const m = window.location.pathname.match(/^\/nodes\/([^/]+)\/?$/);
      setChatAlias(m ? decodeAliasSegment(m[1]) : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // #Stage D: the shell above us (AppShell) keeps a ~28px HealthBanner in
  // flow even when green, and its root is min-h (content-driven), so a
  // plain h-[100dvh] here overflows the viewport by exactly the banner
  // height and the document scrolls again. AppShell is shared by every
  // page (out of Stage D scope) — instead, size this page to the space
  // actually left below whatever the shell renders above us. The
  // ResizeObserver on body re-measures when the banner appears/collapses/
  // is dismissed. className keeps h-[100dvh] as the SSR first paint.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = () => {
      // 用文档坐标（rect.top + scrollY）算高度，并且**不监听 scroll**。
      //
      // 曾经这里用 rect.top（视口坐标）+ scroll 重算，理由是「滚动后要够到窗口底部」；
      // 但外壳的文档本来就比视口高 80px（移动端底部留白），滚动会让 rect.top 变小，
      // 高度随之变大 → 文档再变高 → 下次滚动又更大。实测 390 宽每滚一次文档高
      // +80px、布局高 +80px，无上限（924→1004→1084→1164）。
      // 高度一旦与滚动无关，这个自激就断了；滚到页面底部看到的是外壳的留白。
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(240, window.innerHeight - top)}px`;
    };
    apply();
    window.addEventListener('resize', apply);
    const ro = new ResizeObserver(apply);
    ro.observe(document.body);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('scroll', apply);
      ro.disconnect();
    };
  }, []);
  // #Vincent 插单 (07-31): entering /nodes with nothing selected showed the
  // management table full-bleed — "这样特别难看". Feishu opens INTO a
  // conversation, so desktop /nodes auto-selects the first (sorted) session.
  // Three traps, each deliberately handled:
  //  ① URL via history.REPLACE, never push — push would trap the browser
  //    back button (/nodes → auto-select → /nodes/x → back → /nodes →
  //    auto-select again, forever).
  //  ② the table is NOT gone — it's the "manage all nodes" view, reachable
  //    via the explicit 管理视图 toggle below (localStorage-persisted; a
  //    user who prefers the table keeps it as their default and auto-select
  //    stays off).
  //  ③ an explicit ✕ close must NOT be answered by an immediate re-select
  //    (the ✕ would look broken) — userClosedRef gates auto-select off for
  //    the rest of this mount.
  // 键盘位置（roving index）：状态要在下面的 keydown effect 之前声明。
  const [kbIndex, setKbIndex] = useState<number | null>(null);
  const kbFocusPending = useRef(false);
  // 卡片清单只取「真的有盒子」的：这一页容器是定位布局，offsetParent 恒为 null。
  const visibleCards = () => [...document.querySelectorAll<HTMLElement>('[data-node-card]')]
    .filter(el => el.getClientRects().length > 0);

  // 键盘：`/` 聚焦节点搜索（和需求页一致，别让全局命令面板抢走）；
  // 焦点在某张卡片上时，↑/↓ 在卡片之间移动，省得按几十次 Tab。
  useEffect(() => {
    const inField = () => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      // 焦点在菜单/弹层/列表里时不要接管方向键：这些控件自己要用方向键与 Home/End
      //（实测：会话溢出菜单内按 ↓ 会被这里 stopImmediatePropagation 抢走，
      // 焦点直接跳到输入框，菜单等于不可键盘操作）。
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="menu"], [role="dialog"], [role="listbox"], [role="tablist"]')) return;
      if (e.key === '/' && !inField() && !document.querySelector('[role="dialog"]')) {
        const box = document.querySelector<HTMLInputElement>('[data-testid="rail-search"]');
        if (box) { e.preventDefault(); e.stopImmediatePropagation(); box.focus(); box.select(); }
        return;
      }
      // ↑/↓ 逐张移动；Home/End 直接到头尾（只在焦点已经在卡片上时生效，
      // 否则会抢走页面本身的 Home/End 滚动）。
      if (e.key === 'Home' || e.key === 'End') {
        const active0 = document.activeElement as HTMLElement | null;
        if (!active0?.matches('[data-node-card]') && kbIndex === null) return;
        const list = visibleCards();
        if (!list.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        kbFocusPending.current = true;
        setKbIndex(e.key === 'Home' ? 0 : list.length - 1);
        return;
      }
      // ↑/↓ 在卡片之间移动焦点（见上面的 roving index effect）。
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const cards = visibleCards();
        if (!cards.length) return;
        const active = document.activeElement as HTMLElement | null;
        const fromDom = active ? cards.indexOf(active) : -1;
        const base = fromDom >= 0 ? fromDom : (kbIndex ?? -1);
        const next = Math.max(0, Math.min(cards.length - 1, base + (e.key === 'ArrowDown' ? 1 : -1)));
        e.preventDefault();
        e.stopImmediatePropagation();
        kbFocusPending.current = true;
        setKbIndex(next);
        return;
      }
      // ↑/↓ 移动焦点这件事这一轮没做成：按下后列表会重排一次，刚聚焦的卡片
      // 立刻被替换掉，焦点掉回 body（探针实测 immediate.activeElement = BODY）。
      // 留到「用选中态而不是 DOM 焦点来驱动」时再做，别在这里硬凑。
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [kbIndex]);

  const [manageView, setManageView] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('anet-nodes-manage-view') === '1';
  });
  const autoSelectedRef = useRef(false);
  const userClosedRef = useRef(false);
  const toggleManageView = () => {
    setManageView(v => {
      const next = !v;
      try { window.localStorage.setItem('anet-nodes-manage-view', next ? '1' : '0'); } catch {}
      if (next) {
        // entering manage view: drop any open chat, land on the table
        userClosedRef.current = true;
        if (chatAlias) closeChat();
      } else {
        // back to conversation view: let auto-select pick up again
        userClosedRef.current = false;
        autoSelectedRef.current = false;
      }
      return next;
    });
  };
  const [showCreate, setShowCreate] = useState(false);
  // #Stage A (dashboard 3-col, 07-31): persistent narrow node list rail
  // to the left of the existing table. Default on; user can hide to
  // restore the pre-Stage-A dense-table-only layout (Vincent's "看全局"
  // pattern MUST stay reachable — 通信龙 07-31 explicit constraint).
  // Persisted in localStorage so a returning user gets the same layout
  // they left.
  const [showRail, setShowRail] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const v = window.localStorage.getItem('anet-nodes-rail');
    return v === null ? true : v !== '0';
  });
  const toggleRail = () => {
    setShowRail(v => {
      const next = !v;
      try { window.localStorage.setItem('anet-nodes-rail', next ? '1' : '0'); } catch {}
      return next;
    });
  };
  // #209 R32→R34: the WeChat-style magnifier-toggle search was hand-rolled
  // inline in R32. R34 extracted it to a shared hook so /nodes, /messages,
  // and any future search surface stay visually + behaviourally identical.
  // The hook returns a Button (place in header) + Row (place after header).
  const searchCtl = useCollapsibleSearch({
    value: search,
    onChange: setSearch,
    placeholder: t('搜索节点（支持拼音/首字母）…', 'Search nodes (pinyin ok)…'),
    label: 'Search nodes',
    enabled: sessions.length > 0,
  });

  const lastOnlineRef = useRef<Map<string, number>>(new Map());
  // eslint-disable-next-line react-hooks/purity -- see Overview note (60s sort hysteresis clock)
  const nowMs = Date.now();
  const sortOnline = (alias: string, online: boolean) => {
    if (online) lastOnlineRef.current.set(alias, nowMs);
    return (nowMs - (lastOnlineRef.current.get(alias) || 0)) < 60_000 ? 1 : 0;
  };
  const filtered: SessionRow[] = sessions
    .map(s => ({ ...s, online: !!sseFor(s) }))
    .filter(s => {
      if (filterStatus === 'online') return s.online;
      if (filterStatus === 'offline') return !s.online;
      if (filterStatus && filterStatus !== s.status) return false;
      return true;
    })
    .filter(s => {
      // #492 team filter — strict match. '' = pass all; '__NO_TEAM__' =
      // only nodes with no team assigned; any other value = exact match.
      // Nodes without a team NEVER leak into a "team X" result.
      if (!filterTeam) return true;
      const team = attrsByAlias[s.alias]?.team ?? null;
      if (filterTeam === '__NO_TEAM__') return team === null || team === '';
      return team === filterTeam;
    })
    .filter(s => {
      // #492 tag filter — AND across all chip selections. Zero selected =
      // pass all. Product decision (AND not OR): operators narrow down.
      if (filterTags.length === 0) return true;
      const nodeTags = attrsByAlias[s.alias]?.tags ?? [];
      return filterTags.every(t => nodeTags.includes(t));
    })
    .filter(s => !search || pinyinMatch(s.alias, search) || pinyinMatch(s.agent || '', search))
    .sort((a, b) => ((isPinned(b.alias) ? 1 : 0) - (isPinned(a.alias) ? 1 : 0)) || (sortOnline(b.alias, b.online) - sortOnline(a.alias, a.online)) || lastActivityAt(b.alias) - lastActivityAt(a.alias)); // R41 pin > R29 online-hysteresis > recency

  // ↑/↓ 在卡片之间移动焦点：维护「当前键盘位置」，渲染后由 effect 聚焦。
  // 不用直接 focus(next)：按下键后列表会重排，刚聚焦的元素可能已被替换。
  const listSignature = useMemo(() => filtered.map(s => s.alias).join('|'), [filtered]);
  useEffect(() => {
    if (!kbFocusPending.current || kbIndex === null) return;
    kbFocusPending.current = false;
    const raf = requestAnimationFrame(() => {
      const el = visibleCards()[Math.min(kbIndex, Math.max(0, visibleCards().length - 1))];
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [kbIndex, listSignature]);
  // 列表变了（搜索/筛选）就作废位置。
  useEffect(() => { setKbIndex(null); }, [listSignature]);

  const onlineCount = sessions.filter(s => sseFor(s)).length;

  // #Stage A: filtered rail sessions — same criteria as the table, so
  // the two views agree while chips are toggled. Passing the SAME
  // filtered array (not re-computing) is the invariant that keeps
  // "rail count == table count" true at all times.
  const railSessions = filtered;

  const firstAlias = filtered.length > 0 ? filtered[0].alias : null;
  useEffect(() => {
    if (!isDesktop || manageView || chatAlias || userClosedRef.current || autoSelectedRef.current) return;
    if (!firstAlias) return; // empty list: nothing to select, no loop
    autoSelectedRef.current = true;
    setChatAlias(firstAlias);
    try { window.history.replaceState({}, '', `/nodes/${encodeURIComponent(firstAlias)}`); } catch {}
  }, [isDesktop, manageView, chatAlias, firstAlias]);

  // #Stage C: with a node selected on desktop, the page is LIST + CHAT —
  // the middle table does not render (通信龙 production screenshot catch:
  // rail and table were painting the same 199 nodes twice, squeezing the
  // chat into a sliver; Feishu/WeChat is icon | list | chat, 3 columns not
  // 4). The table is NOT deleted — it's the "manage all nodes" view and
  // stays on /nodes with nothing selected.
  //
  // The sessions.length guard does TWO jobs (通信龙 Stage C review — do
  // not remove it thinking the rail makes it redundant):
  //  1. empty states: with no sessions there's no rail either, so the
  //     middle column must stay to show onboarding/empty UI;
  //  2. SSR blank-screen guard: useIsDesktop's server snapshot is `true`,
  //     so on a narrow-screen deep link the server would otherwise render
  //     "middle hidden + ChatPane hidden by `hidden md:` + rail hidden by
  //     `hidden sm:`" = a fully blank page until hydration. During SSR,
  //     SWR has no data yet → sessions=[] → this guard keeps the middle
  //     column rendered.
  const chatOpenDesktop = !!chatAlias && isDesktop && sessions.length > 0;

  // #Mobile two-level nav (Feishu phone form, 通信龙 07-31, breakpoint md
  // per my own ruling — no third media query):
  //   < md unselected  = conversation LIST fullscreen (not the table)
  //   < md selected    = chat as a full PAGE with a back arrow
  //   manage mode      = the old table, reachable via the same toggle
  // Desktop auto-selects; mobile deliberately does NOT (the list IS the
  // first screen — auto-select effect above is gated on isDesktop).
  const mobileListLevel = !isDesktop && !chatAlias && !manageView && sessions.length > 0;
  const mobileChatLevel = !isDesktop && !!chatAlias;

  // #Mobile back restores the list scroll position (判据: enter from row
  // ~50, come back, offset ≤200px — snapping to top is the annoying bug).
  // Saved at selection time; restored when the list level remounts.
  // Desktop is exempt: its rail never unmounts while chatting, and the
  // user may have scrolled it meanwhile.
  const savedListScrollRef = useRef(0);
  useEffect(() => {
    if (isDesktop || chatAlias) return;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector('[data-testid="node-list-scroll"]');
      if (el) el.scrollTop = savedListScrollRef.current;
    });
    return () => cancelAnimationFrame(id);
  }, [isDesktop, chatAlias]);

  return (
    <div
      ref={rootRef}
      data-testid="nodes-layout"
      data-rail-visible={showRail ? 'true' : 'false'}
      className="h-[100dvh] max-w-full overflow-hidden bg-[var(--bg)] text-gray-100 flex"
    >
      {/* #Stage A rail — only mounted when showRail is true AND we're
          past the mobile breakpoint (below sm, rail is hidden by CSS
          to give the table full width on small screens; the toggle
          button controls both). sessions.length===0 also hides the rail
          because there's nothing to list.
          #Stage C: a selected node FORCES the rail on (even for dense-view
          users with showRail=false) — in the list+chat layout the rail is
          the only way to switch nodes, so it must be there. */}
      {(mobileListLevel || (isDesktop && (showRail || chatOpenDesktop) && sessions.length > 0)) && (
        <aside
          data-testid="node-list-rail"
          className="flex flex-col w-full md:w-[280px] shrink-0 h-full min-h-0 bg-[var(--col-list)]"
        >
          <NodeList
            sessions={railSessions}
            selectedAlias={chatAlias}
            onSelect={selectNode}
            search={search}
            onSearchChange={setSearch}
          />
          {/* #Vincent 插单 ②: explicit doorway between conversation-first
              and table-first ("manage all nodes") modes. Lives in the
              aside (NodesView's JSX) — NOT in NodeList, which IM马 is
              editing concurrently. */}
          <button
            type="button"
            onClick={toggleManageView}
            data-testid="manage-view-toggle"
            className="shrink-0 border-t border-[var(--col-line)] bg-[var(--col-list)] px-3 py-2 text-left text-[11px] text-gray-500 hover:text-gray-200 transition-colors"
          >
            {manageView ? t('≡ 对话视图', '≡ Conversation view') : t('☷ 管理视图', '☷ Manage view')}
          </button>
        </aside>
      )}
      {/* #Stage C: middle column (header + filters + table/grid) renders
          only when NO node is selected on desktop — see chatOpenDesktop
          note above. Mobile keeps it always (chat is an overlay there).
          🔴 移动端在 sessions.length === 0 时也必须渲染：此时
          mobileListLevel 为 false（它要求 sessions>0），如果这里再只认
          manageView，手机就是一整屏空白——新装看不到「建第一个 Agent」、
          读失败看不到错误原因，用户只能猜。桌面端本来就走空态分支。 */}
      {(isDesktop ? !chatOpenDesktop : ((manageView && !chatAlias) || sessions.length === 0)) && (
      <div data-testid="nodes-main-scroll" className="flex-1 min-w-0 max-w-full h-full overflow-y-auto overflow-x-hidden p-4 sm:p-6 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6">
      {/* #Mobile manage mode: way back to the conversation list — the rail
          (which hosts the toggle) is hidden at this level on phones. */}
      {!isDesktop && manageView && (
        <button
          type="button"
          onClick={toggleManageView}
          data-testid="manage-view-toggle-mobile"
          className="md:hidden mb-3 rounded-lg border border-[var(--col-line-strong)] bg-[var(--col-list)] px-3 py-1.5 text-[12px] text-gray-400 hover:text-gray-200"
        >
          {t('≡ 返回对话视图', '≡ Back to conversations')}
        </button>
      )}
      {/* #209 R31 (mobile vertical rhythm — goal "大幅提升移动端体验",
          extending R28's Overview pattern + R30's /tasks pattern):
          this header row + the status-bar wrapper + the filter row
          below all drop mb-6 → mb-4 sm:mb-6. Three spots × 8 px =
          ~24 px scroll reclaim on /nodes before the first card.
          #209 R32: search affordance moved to top-right magnifier
          button (Vincent WeChat ref msg 563). justify-between makes
          the title cluster hug left, button hugs right. */}
      <div className="flex items-center gap-4 mb-4 sm:mb-6">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-white lg:ml-0 ml-10">Nodes</h1>
          <span className="text-xs bg-[var(--success)]/5 text-[var(--success)] px-2 py-0.5 rounded-full border border-[var(--success)]/25 shrink-0">
            {onlineCount} online
          </span>
          <span className="text-xs bg-[var(--bg-elevated)] text-[var(--fg-muted)] px-2 py-0.5 rounded-full border border-[var(--border)] shrink-0">
            {sessions.length} total
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* #Stage A rail toggle — visible on sm+ (where rail also
              renders). Preserves Vincent's "看全局" dense-table view
              as one click away (通信龙 07-31 constraint). Icon-only
              on mobile / sm; icon + text on md+. */}
          <button
            type="button"
            onClick={toggleRail}
            aria-pressed={showRail}
            data-testid="toggle-rail"
            title={showRail ? t('隐藏节点列表', 'Hide node list') : t('显示节点列表', 'Show node list')}
            className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:border-[var(--border-hover)] transition-colors"
          >
            <span aria-hidden className="text-sm leading-none">{showRail ? '☷' : '☰'}</span>
            <span className="hidden md:inline">{showRail ? t('密视图', 'Dense') : t('分栏', 'Split')}</span>
          </button>
          {/* node-lifecycle M2: open the create-node wizard (RFC-026 §3.1 P1). */}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            aria-label="新建节点"
            className="inline-flex items-center gap-1 rounded-lg border border-cyan-700/50 bg-cyan-900/15 px-3 py-1.5 text-sm font-medium text-cyan-300 hover:bg-cyan-900/25 transition-colors"
          >
            <span aria-hidden className="text-base leading-none">+</span>
            <span className="hidden sm:inline">新建节点</span>
          </button>
          <searchCtl.Button />
        </div>
      </div>

      {showCreate && <CreateNodeWizard onClose={() => setShowCreate(false)} />}

      {/* #209 R34: shared <CollapsibleSearch> component handles row reveal,
          autofocus, Escape, and Cancel. enabled=sessions.length>0 hides
          everything until there's content to search. */}
      <searchCtl.Row />

      {/* #217 D6 (less is more): the status distribution bar + its
          working/idle/offline legend duplicated the header chips
          (N online / N total) and the per-card status pills right
          below. One count display per screen — the bar is gone. */}

      {/* Round 74: hide the filter+view chrome when there are no nodes
          anywhere — these controls have nothing to act on, and they only
          push the onboarding CTA further down. When at least one session
          exists, the chrome is back even if the current filter happens
          to hide everything (so users can clear filters). */}
      {sessions.length > 0 && (
      <div className="flex flex-wrap gap-3 mb-4 sm:mb-6">
        {/* R32: the inline search input was moved to the top-right
            magnifier toggle above. The status select + List/Grid
            toggle stay here. */}
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-base sm:text-sm text-white focus:border-blue-500/50 focus:outline-none"
        >
          <option value="">All</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="working">Working</option>
          <option value="idle">Idle</option>
          <option value="blocked">Blocked</option>
          <option value="error">Error</option>
        </select>
        {/* #492 team select — only shown once at least one node has a
            team attribute. "__NO_TEAM__" surfaces nodes without team,
            so operators can find nodes that never got tagged. */}
        {distinctTeams.length > 0 && (
          <select
            value={filterTeam}
            onChange={e => setFilterTeam(e.target.value)}
            aria-label={t('按 Team 过滤', 'Filter by team')}
            data-testid="filter-team"
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-base sm:text-sm text-white focus:border-blue-500/50 focus:outline-none"
          >
            <option value="">{t('全部 Team', 'All teams')}</option>
            <option value="__NO_TEAM__">{t('未分组', '(no team)')}</option>
            {distinctTeams.map(team => (
              <option key={team} value={team}>{team}</option>
            ))}
          </select>
        )}
        {/* Round 80: List/Grid toggle hidden on mobile — Grid uses
            grid-cols-1 below `md` and List degrades to the same single
            column, so the toggle has no visual effect under sm and only
            steals a row of vertical space. */}
        <div className="hidden sm:flex ml-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-1 text-sm">
          {(['list', 'grid'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                viewMode === mode
                  ? 'bg-cyan-500/10 text-cyan-300'
                  : 'text-gray-500 hover:text-gray-200'
              }`}
            >
              {mode === 'list' ? 'List' : 'Grid'}
            </button>
          ))}
        </div>
      </div>
      )}
      {/* #492 tag chip row — separate row so multi-select feels distinct
          from single-select controls above. Each chip toggles inclusion;
          selected chips get cyan bg. Explicit "AND" separators between
          selected chips make the join semantics visible in the UI (per
          PR review: silent AND under selected-multiple → 0 results
          reads as bug; the label makes it a deliberate narrow-down). */}
      {sessions.length > 0 && distinctTags.length > 0 && (
        <div className="mb-4 sm:mb-6 flex flex-wrap items-center gap-1.5" data-testid="filter-tags-row">
          <span className="text-[11px] text-gray-500 mr-1">{t('Tags:', 'Tags:')}</span>
          {distinctTags.map((tag, idx) => {
            const selected = filterTags.includes(tag);
            const isNotFirstSelected = selected && filterTags.slice(0, filterTags.indexOf(tag)).length > 0;
            void idx; void isNotFirstSelected;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                aria-pressed={selected}
                data-tag={tag}
                data-selected={selected ? 'true' : 'false'}
                className={`text-xs rounded-full px-2.5 py-1 border transition-colors ${
                  selected
                    ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40'
                    : 'bg-[var(--bg-secondary)] text-gray-400 border-[var(--border)] hover:text-gray-200 hover:border-[var(--border-hover)]'
                }`}
              >
                {tag}
              </button>
            );
          })}
          {filterTags.length >= 2 && (
            <span
              className="text-[10px] text-cyan-300/80 ml-1 tabular-nums"
              data-testid="filter-tags-and-hint"
            >
              {t(`= 同时具有 ${filterTags.length} 个标签`, `= AND of ${filterTags.length} tags`)}
            </span>
          )}
          {(filterTags.length > 0 || filterTeam) && (
            <button
              type="button"
              onClick={() => { setFilterTags([]); setFilterTeam(''); }}
              className="text-[11px] text-gray-500 hover:text-gray-200 underline-offset-2 hover:underline ml-2"
              data-testid="clear-attr-filters"
            >
              {t('清除', 'Clear')}
            </button>
          )}
        </div>
      )}

      {loadError && sessions.length > 0 && (
        <div role="status" className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-[var(--bg-secondary)] px-3 py-2 text-xs">
          <span className="text-[var(--fg-muted)]">{t('刷新失败，下面是上一次读到的节点。', 'Refresh failed — showing the last successful read.')}</span>
          <button
            type="button"
            onClick={() => mutateSessions()}
            className="shrink-0 rounded-md px-2 py-1 text-[var(--hl)] hover:bg-[var(--hover-tint)]"
          >
            {t('重试', 'Retry')}
          </button>
        </div>
      )}

      {/* 读失败不是「没有节点」：旧实现在 error 时继续走 EmptyState，
          新用户会看到「npx … init」引导，以为队伍还没建起来。 */}
      {!loading && loadError && sessions.length === 0 ? (
        <div role="alert" className="rounded-2xl bg-[var(--bg-secondary)] p-6 text-center text-sm">
          <p className="font-medium text-[var(--danger)]">{t('读不到节点列表', 'Could not load nodes')}</p>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            {loadError instanceof Error ? loadError.message : String(loadError)}
          </p>
          <button
            type="button"
            onClick={() => mutateSessions()}
            className="mt-3 rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
          >
            {t('重试', 'Retry')}
          </button>
        </div>
      ) : loading ? (
        <div className="animate-pulse space-y-2">
          {[1,2,3,4].map(i => <div key={i} className="h-16 bg-gray-800/20 rounded-lg" />)}
        </div>
      ) : filtered.length === 0 ? (
        sessions.length === 0 ? (
          /* Round 73: first-run case — no agents anywhere. Use the same
             onboarding empty state as the Overview (NodesEmptyState
             includes the `npx … init` quickstart command). Previously this
             was the "No nodes match your filters" copy, which was wrong
             for new users who have no filters applied. */
          <NodesEmptyState />
        ) : (filterTeam || filterTags.length > 0) ? (
          /* #492: attribute-filter no-match — echo the specific filter
             conditions so the user can tell "no nodes exist with this
             combo" from "I mis-typed / data isn't synced". Distinct
             from the generic status/search "No match" below. Under
             AND semantics for multi-tag, this is the copy 通信龙 asked
             for: "没有节点同时具有 A 和 B" instead of "no match". */
          <EmptyState
            variant="nodes"
            title={t('没有节点符合当前属性筛选', 'No nodes match the current attribute filters')}
            sub={(() => {
              const parts: string[] = [];
              if (filterTeam === '__NO_TEAM__') parts.push(t('未分组', 'no-team'));
              else if (filterTeam) parts.push(t(`Team = ${filterTeam}`, `Team = ${filterTeam}`));
              if (filterTags.length === 1) parts.push(t(`标签 ${filterTags[0]}`, `tag ${filterTags[0]}`));
              else if (filterTags.length >= 2) parts.push(t(`同时具有标签 ${filterTags.join(' 和 ')}`, `all of tags: ${filterTags.join(' AND ')}`));
              return t(`没有节点满足：${parts.join(' + ')}。清除筛选或减少标签。`, `No node satisfies: ${parts.join(' + ')}. Clear filters or drop a tag.`);
            })()}
          />
        ) : !anyAttrs && (filterStatus || search) ? (
          <EmptyState
            variant="nodes"
            title={t('还没有节点被打过标签', 'No nodes have been tagged yet')}
            sub={t('先在节点详情里给几个节点分配 team / tag，然后就可以按属性筛选。', 'Assign team / tag to a few nodes first, then attribute filters will show up.')}
          />
        ) : (
          <EmptyState
            variant="nodes"
            title="No nodes match your filters"
            sub="Try clearing search or status filters, or wait for an agent to register."
          />
        )
      ) : viewMode === 'grid' ? (
        <div className="grid min-w-0 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(s => {
            const statusKey = s.online ? s.status : 'offline';
            const progress = typeof s.progress === 'number' ? s.progress : 0;
            const unread = hasUnread(s.alias);

            return (
              <div
                key={s.alias}
                role="button"
                tabIndex={0}
                data-node-card
                data-node-alias={s.alias}
                onClick={() => selectNode(s.alias)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(s.alias); } }}
                className={`relative min-w-0 max-w-full overflow-hidden rounded-2xl bg-[var(--bg-secondary)] p-4 transition-colors hover:bg-[var(--hover-tint)] cursor-pointer ${!s.online ? 'opacity-60' : ''}`}
              >
                {!s.online && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="rotate-[-20deg] rounded-xl border border-white/10 bg-black/20 px-5 py-2 text-xl font-bold uppercase tracking-[0.35em] text-[var(--fg)]/10">
                      Offline
                    </span>
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <div className="relative shrink-0">
                    <span className="relative inline-flex shrink-0">
                      <AliasAvatar alias={s.alias} size={36} />
                      {unreadCount(s.alias) > 0 && isMuted(s.alias) && (
                        <span aria-label={t('有未读（已静音）', 'Unread (muted)')} className="absolute -top-0.5 -right-1 h-2.5 w-2.5 rounded-full bg-red-500/80 ring-2 ring-[var(--bg-secondary)]" />
                      )}
                      {unreadCount(s.alias) > 0 && !isMuted(s.alias) && (
                        <span aria-label={t(`${unreadCount(s.alias)} 条未读`, `${unreadCount(s.alias)} unread`)} className="absolute -top-1 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold leading-4 text-center ring-2 ring-[var(--bg-secondary)]">
                          {unreadCount(s.alias) > 99 ? '99+' : unreadCount(s.alias)}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-base font-semibold text-white">{s.alias}</span>
                      <DraftMark alias={s.alias} />
                      {/* 数字已经说了「几条」，同一个事实不再加一个 New 胶囊；
                          静音会话不显示数字，才用这个词提示。 */}
                      {unread && isMuted(s.alias) && <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">New</span>}
                      <StatusLabel statusKey={statusKey} />
                    </div>
                    <div className="mt-0.5 truncate text-xs text-gray-500">
                      {(s.agent || '—')}<span className="text-gray-700 mx-1.5">·</span><span title={s.server || ''}>{shortServer(s.server)}</span>
                    </div>
                  </div>
                  <span className="hidden shrink-0 rounded-lg border border-cyan-500/15 bg-cyan-500/5 px-2 py-1 text-[10px] text-cyan-300/70 sm:inline">Tap to chat</span>
                  {/* RFC-027 PR2 — per-node ⋮ lifecycle menu. The button stopsPropagation
                      internally so it doesn't open chat. lifecycleByAlias absent → 'active'
                      default, menu renders normal stop/delete options. */}
                  <NodeLifecycleMenu
                    nodeId={nodeIdByAlias[s.alias] || s.node_id || s.alias}
                    alias={s.alias}
                    lifecycleState={lifecycleByAlias[s.alias]}
                    networkId={s.network_id || null}
                    onCompleted={refreshNodes}
                    attrsSnapshot={attrsByAlias[s.alias]}
                  />
                </div>

                <div className="mt-3 rounded-lg bg-[var(--bg)] px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] uppercase tracking-wide text-gray-600">Current task</span>
                    <span className="text-[10px] text-gray-600">{timeAgo(s.last_seen_at || s.updated_at)}</span>
                  </div>
                  <div className={`mt-1 line-clamp-2 ${s.task ? 'text-gray-300' : 'text-gray-600 italic'}`}>
                    {s.task || 'No current task'}
                  </div>
                </div>

                {progress > 0 && progress < 100 && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-800">
                    <div className="h-1.5 rounded-full bg-cyan-400 transition-all" style={{ width: `${progress}%` }} />
                  </div>
                )}

              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-1 sm:space-y-2">
          {/* Round 94: AGENT + SERVER merged into one `agent · server`
              cell. Round mobile-command: node row itself opens chat, so
              the old Chat / Send Task action column is gone. */}
          <div className="hidden sm:grid sm:grid-cols-10 gap-2 px-4 py-2 text-xs text-gray-600 uppercase">
            <div className="col-span-1">Status</div>
            <div className="col-span-2">Alias</div>
            <div className="col-span-2">Agent · Server</div>
            <div className="col-span-4">Current Task</div>
            <div className="col-span-1">Updated</div>
          </div>
          {filtered.map(s => {
            const statusKey = s.online ? s.status : 'offline';
            const unread = hasUnread(s.alias);

            return (
              <div
                key={s.alias}
                role="button"
                tabIndex={0}
                data-node-card
                data-node-alias={s.alias}
                onClick={() => selectNode(s.alias)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(s.alias); } }}
                className={`rounded-lg bg-[var(--bg-secondary)] px-3 py-2 sm:px-4 sm:py-3 transition-colors hover:bg-[var(--hover-tint)] cursor-pointer ${!s.online ? 'opacity-50' : ''}`}
              >
                <div className="hidden sm:grid sm:grid-cols-10 gap-2 items-center">
                  <div className="col-span-1">
                    <StatusLabel statusKey={statusKey} />
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="relative shrink-0">
                        <span className="relative inline-flex shrink-0">
                          <AliasAvatar alias={s.alias} size={20} />
                          {unreadCount(s.alias) > 0 && isMuted(s.alias) && (
                            <span aria-label={t('有未读（已静音）', 'Unread (muted)')} className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-red-500/80" />
                          )}
                          {unreadCount(s.alias) > 0 && !isMuted(s.alias) && (
                            <span aria-label={t(`${unreadCount(s.alias)} 条未读`, `${unreadCount(s.alias)} unread`)} className="absolute -top-1.5 -right-2 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold leading-[15px] text-center">
                              {unreadCount(s.alias) > 99 ? '99+' : unreadCount(s.alias)}
                            </span>
                          )}
                        </span>
                      </div>
                      <span className="truncate text-sm font-medium text-white">{s.alias}</span>
                      <DraftMark alias={s.alias} />
                      {unread && isMuted(s.alias) && <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-300">New</span>}
                    </div>
                  </div>
                  <div className="col-span-2 truncate text-xs text-gray-400" title={s.server || ''}>
                    <span className="truncate">{s.agent || '--'}<span className="text-gray-700 mx-1.5">·</span>{shortServer(s.server)}</span>
                  </div>
                  <div className="col-span-4 truncate text-xs text-gray-500" title={s.task || ''}>{s.task || '--'}</div>
                  <div className="col-span-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                    <span className="truncate">{timeAgo(s.last_seen_at || s.updated_at)}</span>
                    {/* RFC-027 PR2 ⋮ lifecycle menu — desktop list. Defaults
                        to 'active' when lifecycleByAlias absent. */}
                    <NodeLifecycleMenu
                      nodeId={nodeIdByAlias[s.alias] || s.node_id || s.alias}
                      alias={s.alias}
                      lifecycleState={lifecycleByAlias[s.alias]}
                      networkId={s.network_id || null}
                      onCompleted={refreshNodes}
                      attrsSnapshot={attrsByAlias[s.alias]}
                    />
                  </div>
                </div>
                {/* R7 of #190: mobile node row was ~340px tall × ~150
                    rows = the 51k page. Wins this round, in priority
                    order: (1) drop the per-row "Tap anywhere to chat"
                    hint — useful once, redundant 149 times; the cyan
                    border on hover/focus still teaches it. (2) tighten
                    space-y-2 → space-y-1 so the avatar/task gap is
                    4px tighter on every row. */}
                <div className="sm:hidden space-y-1">
                  <div className="flex items-center gap-2.5">
                    <div className="relative shrink-0">
                      <AliasAvatar alias={s.alias} size={28} />
                      {/* 手机上原来是「纯红点 + New 胶囊」；红点没有信息量，
                          换成条数，静音会话才保留 New 这个词。 */}
                      {unread && isMuted(s.alias) && (
                        <span aria-label={t('有未读（已静音）', 'Unread (muted)')} className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500/80" />
                      )}
                      {unread && !isMuted(s.alias) && (
                        <span aria-label={t(`${unreadCount(s.alias)} 条未读`, `${unreadCount(s.alias)} unread`)} className="absolute -top-1.5 -right-2 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold leading-[15px] text-center">
                          {unreadCount(s.alias) > 99 ? '99+' : unreadCount(s.alias)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="truncate text-sm font-medium text-white">{s.alias}</div>
                        {unread && isMuted(s.alias) && <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-300">New</span>}
                      </div>
                      <div className="truncate text-[10px] text-gray-500">{s.agent || '—'} · {timeAgo(s.last_seen_at || s.updated_at)}</div>
                    </div>
                    <StatusLabel statusKey={statusKey} />
                    {/* RFC-027 PR2 ⋮ lifecycle menu — mobile list. */}
                    <NodeLifecycleMenu
                      nodeId={nodeIdByAlias[s.alias] || s.node_id || s.alias}
                      alias={s.alias}
                      lifecycleState={lifecycleByAlias[s.alias]}
                      networkId={s.network_id || null}
                      onCompleted={refreshNodes}
                      attrsSnapshot={attrsByAlias[s.alias]}
                    />
                  </div>
                  {s.task && <div className="truncate text-xs text-gray-500">{s.task}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* (#Stage B's mobile overlay is gone — < md chat is now a full
          PAGE, rendered as ChatPane variant="page" below. isDesktop
          still guarantees only ONE chat body is ever mounted.) */}
      </div>
      )}
      {/* #Stage B: persistent right chat column (md+) — see ChatPane.tsx
          (ChatPopover minus the floating shell; TaskChatPanel inline body).
          Switching nodes swaps `alias` in place (no remount). */}
      {chatAlias && isDesktop && <ChatPane alias={chatAlias} onClose={closeChat} />}
      {/* #Mobile two-level nav: chat is a full PAGE (not the old overlay).
          Back arrow and browser back both land on the list (closeChat /
          popstate) — 判据: 行为一致. */}
      {mobileChatLevel && <ChatPane alias={chatAlias!} variant="page" onBack={closeChat} onClose={closeChat} />}
    </div>
  );
}
