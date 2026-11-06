'use client';

import { useState, useRef, memo } from 'react';
import Link from 'next/link';
import { StatsBar } from './components/StatsBar';
import { TopoGraph } from './components/TopoGraph';
// Loop R23: opening a chat tab (openTab state) re-rendered the whole
// Overview including the 15k-line TopoGraph SVG — measured ~300ms of the
// 1.0s panel-open TTI. Its three props are identity-stable between data
// changes (SWR structural sharing / health object / rare rename state),
// so a memo wrapper skips the redraw entirely on unrelated state churn.
const MemoTopoGraph = memo(TopoGraph);

/** 桌面通知：仅在用户开启、已授权、且页面不可见时弹系统通知。
 *  载荷在 SSE 事件的 data 里，这里摊平后交给纯函数判定。 */
// 同一事件可能因 SSE 重连被重放（实测：桩流关闭后重连，一条事件弹了 4 次）。
// 浏览器原生会按 tag 覆盖，但这里再加 10 秒去重，避免重复构造/闪烁。
const notifiedTags = new Map<string, number>();
function maybeDesktopNotify(event: { type?: string; data?: unknown }) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!('Notification' in window)) return;
  const data = (event.data && typeof event.data === 'object') ? event.data as Record<string, unknown> : {};
  const message = notificationFor(
    { ...data, type: event.type ?? '' },
    { enabled: readNotifyPreference(window.localStorage), permission: Notification.permission, hidden: document.hidden },
  );
  if (!message) return;
  const now = Date.now();
  const last = notifiedTags.get(message.tag) ?? 0;
  if (now - last < 10_000) return;
  if (notifiedTags.size > 50) notifiedTags.clear();
  notifiedTags.set(message.tag, now);
  try {
    const n = new Notification(message.title, { body: message.body, tag: message.tag });
    // 点通知把窗口拉回前台：否则用户点了没反应，还得自己找窗口。
    n.onclick = () => { try { window.focus(); n.close(); } catch { /* 忽略 */ } };
  } catch { /* 权限被回收等情况忽略 */ }
}
import { AgentCard } from './components/AgentCard';
import { LoadingSkeleton } from './components/LoadingSkeleton';
import { NodesEmptyState as EmptyState } from './components/EmptyState';
import { CommandCenter, useCommandCenter } from './components/CommandCenter';
import { useSessions, useHealth, useTaskStats, useStats } from './lib/hooks';
import { useChatUnread } from './lib/chat-unread';
import { isPinned, usePinVersion } from './lib/chat-pin';
import { useSSE } from './lib/useSSE';
import { notificationFor, readNotifyPreference } from './lib/desktop-notify';
import { isOnline as presenceIsOnline, sseCountFor as presenceSseCountFor, presenceStatus } from './lib/presence';
import { useSWRConfig } from 'swr';

export default function Dashboard() {
  // #214 F1: the old "V3 auto-upgrade" guard here checked per-tab
  // sessionStorage and, when empty (every new tab / browser restart /
  // bookmark visit), logged out the *valid* cookie session and bounced
  // to /login. Unauthenticated access is already handled server-side
  // by proxy.ts (no cookie → /login); the sessionStorage blob is just
  // a client cache that pages re-hydrate on demand. A genuinely stale
  // pre-V3 cookie now surfaces as API 401s with the error banner
  // instead of silent session destruction.

  // lite：首页只用 alias/status/network_id 等字段；不拉 host / process_telemetry（约 65% 体积）。
  const { sessions, hint: sessHint, error: sessError, isLoading } = useSessions({ lite: true });
  const { health } = useHealth();
  const { stats } = useStats();
  // 首页只在 /api/stats 没给 by_status 时才需要统计任务状态。
  // 以前回退是拉 tasks?limit=500（生产实测 665,867 B）；现在改叫服务端计数端点
  //（/api/hub/task-stats，回几百字节），浏览器不再为 5 个数字下载 666 KB。
  const statsHasTaskStatus = Boolean(stats?.tasks?.by_status?.length);
  const { taskStats: fallbackTaskStats } = useTaskStats(stats != null && !statsHasTaskStatus);
  const [showTopo, setShowTopo] = useState(typeof window !== 'undefined' && window.innerWidth >= 1024);
  const cmd = useCommandCenter();
  // R8: one page-level unread computation; counts flow to memo'd cards as props.
  const { unreadCount, lastActivityAt } = useChatUnread();
  const [agentFilter, setAgentFilter] = useState<'all' | 'working' | 'idle' | 'offline'>('all');
  // #84: last node.renamed event — passed to TopoGraph so an open chat
  // popover follows the rename instead of pointing at a dead alias. `ts`
  // makes the effect re-fire even when the same from/to repeats.
  const [renameSignal, setRenameSignal] = useState<{ from: string; to: string; ts: number } | null>(null);
  const { mutate } = useSWRConfig();

  // SSE: instant revalidation on CommHub events
  // Opt-out via NEXT_PUBLIC_DISABLE_SSE=1 — avoids HTTP/1.1 head-of-line blocking on navigation
  const sseEnabled = process.env.NEXT_PUBLIC_DISABLE_SSE !== '1';
  const { connected: sseConnected, supported: sseSupported } = useSSE({
    url: '/api/hub/events',
    enabled: sseEnabled,
    onEvent: (event) => {
      maybeDesktopNotify(event);
      // #84 (RFC-010 §3.4): node.renamed — revalidate the session list so the
      // new alias propagates instantly (TopoGraph + node grid re-render, the
      // avatar hue recomputes as a pure fn of alias) instead of waiting for
      // the next 5s poll. The renamed node's history keeps the old alias
      // server-side, so the task list needs no revalidation here.
      if (event.type === 'node.renamed') {
        mutate('/api/hub/status');
        const d = event.data as { old_alias?: string; new_alias?: string } | undefined;
        if (d?.old_alias && d?.new_alias) {
          setRenameSignal({ from: d.old_alias, to: d.new_alias, ts: Date.now() });
        }
        return;
      }
      if (['new_task', 'new_message', 'new_reply', 'node_status_changed', 'broadcast'].includes(event.type)) {
        mutate('/api/hub/status');
        mutate((key: string) => typeof key === 'string' && key.startsWith('/api/hub/tasks'), undefined, { revalidate: true });
      }
    },
  });

  // R30 HOTFIX: this ref MUST be declared before the early loading return —
  // it originally sat below it, so loading→data transitions changed the
  // hook count and crashed the page (React #310) whenever the hub was slow
  // enough for the skeleton to render first. (Same rules-of-hooks trap as
  // the app-repo v0.1.28 launch crash.)
  const lastOnlineRef = useRef<Map<string, number>>(new Map());
  const pinVersion = usePinVersion(); // R41 — MUST sit above the early return (the R29 #310 trap)
  void pinVersion; // re-sort when pins change (isPinned used in comparator)
  if (isLoading) return <LoadingSkeleton />;

  // #53: distinguish "we have the SSE map" from "we can't see it". The
  // per-node `isOnline` predicate below is fine for halo/legend rendering
  // (degrades to "everyone offline") but the header count MUST NOT
  // confidently show 0 online when we're actually blind — HealthBanner
  // surfaces the "why", and StatsBar renders '?' for online.
  const presenceState = presenceStatus(health?.sse_sessions, health);
  const sseSessions = health?.sse_sessions || {};
  // #515 / #214 F2: presence = SSE-reachable ("can I talk to it right now").
  // Definition lives in app/lib/presence.ts so stats card / sidebar /
  // topology halos always agree. See presence.ts for why hub `status` is
  // an unreliable signal on its own (#520).
  const isOnline = (s: { alias: string; network_id?: string }) => presenceIsOnline(s, sseSessions);
  const online = sessions.filter(isOnline).length;
  const presenceUnknown = presenceState !== 'ready';
  const total = sessions.length;
  const working = sessions.filter(s => s.status === 'working').length;
  // Task stats: prefer /api/stats, fallback to manual
  const taskStats: Record<string, number> = {};
  if (stats?.tasks?.by_status?.length) {
    for (const s of stats.tasks.by_status) {
      taskStats[s.status] = s.count;
    }
  } else if (fallbackTaskStats) {
    Object.assign(taskStats, fallbackTaskStats);
  }

  // R29 (通信龙批准): 'working' demoted from sort key to visual badge —
  // it flipped constantly on the live fleet and reshuffled ~100 cards per
  // 12s window (measured [100,101,100] ×3). WeChat doesn't reorder your
  // list because the counterpart is busy; the badge + header chip still
  // show who's working. Sort: online → your conversation recency → hub
  // order.
  // R29b: SSE connections flap on the live fleet (reconnect churn), and the
  // raw online bit still moved ~60 cards per bad window. The SORT key gets
  // 60s hysteresis — a card holds its online position through a brief
  // reconnect — while badges/chips keep showing the real-time truth.
  // Intentional coarse clock for the 60s sort hysteresis; poll-level
  // freshness is all it needs.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  for (const s of sessions) if (isOnline(s)) lastOnlineRef.current.set(s.alias, nowMs);
  const sortOnline = (s: { alias: string }) => (nowMs - (lastOnlineRef.current.get(s.alias) || 0)) < 60_000 ? 1 : 0;
  const sortedSessions = [...sessions].sort((a, b) => {
    // R41: WeChat pin — deliberate pins beat presence and recency.
    const p = (isPinned(b.alias) ? 1 : 0) - (isPinned(a.alias) ? 1 : 0);
    if (p !== 0) return p;
    const d = sortOnline(b) - sortOnline(a);
    if (d !== 0) return d;
    return lastActivityAt(b.alias) - lastActivityAt(a.alias);
  });

  return (
    <div className="min-h-screen bg-[#0b0b0d] text-gray-100 p-4 sm:p-6">
      <StatsBar online={online} working={working} total={total} presenceUnknown={presenceUnknown} />

      {/* #217 S5 (Vincent: "极简极简，这些都可以放到设置里面去"): the
          Dispatch button and UserBar row are gone from Overview.
          Dispatch lives in /admin (Send Task panel); sign-out lives in
          Settings and the sidebar; network switching lives in the
          sidebar. */}

      {/* Task summary. #217 S5 (Vincent: "乱七八糟的东西太多"): the
          9-status colored chip wall is now a single quiet line — the
          only two numbers that drive action are running and failed;
          everything else lives on /tasks. */}
      {Object.keys(taskStats).length > 0 && (
        <section className="mb-4 sm:mb-6 flex items-center justify-between rounded-lg bg-[var(--bg-secondary)] px-4 py-2.5 text-xs">
          <div className="text-gray-400 tabular-nums">
            <span className={taskStats['running'] ? 'text-green-400' : 'text-gray-500'}>{taskStats['running'] || 0} running</span>
            <span className="text-gray-600"> &middot; </span>
            <span className={taskStats['failed'] ? 'text-red-400' : 'text-gray-500'}>{taskStats['failed'] || 0} failed</span>
          </div>
          <Link href="/tasks" prefetch={false} className="text-[var(--accent-text)] hover:opacity-80">View all &rarr;</Link>
        </section>
      )}

      {/* #217 S5 (less is more): Quick Navigation stat cards, the nav
          rail, and Recent Activity are deleted. Every route they linked
          to is one tap away in the bottom tab bar (mobile) or sidebar
          (desktop), the headline numbers already live in the KPI cards
          and the task summary line, and recent tasks live on /tasks.
          Restore path: git revert this commit. */}

      {sessError && (
        <div className="bg-red-900/20 border border-red-800/40 text-red-300 px-4 py-3 rounded-lg mb-6 text-sm flex items-center justify-between gap-3" role="alert">
          <span className="min-w-0 truncate">{String(sessError)}</span>
          {/* #17 M1: the hub-unreachable hint was inert text. The top
              HealthBanner already turns the same condition into an
              actionable "Open Settings →" link — this makes the Overview
              banner consistent: one tap to the CommHub connection panel
              instead of a dead-end instruction. */}
          <Link href="/settings" className="shrink-0 text-xs font-medium text-red-300/90 underline-offset-2 hover:underline hover:text-red-200 whitespace-nowrap">
            Check CommHub connection →
          </Link>
        </div>
      )}

      {/* #217 M1: topology toggle is lg-only — on a 390px phone the
          graph needed a 70vh cap (R41) just to stay scrollable, i.e.
          it never really worked there. Desktop keeps the full feature;
          mobile Overview loses its last piece of chrome. */}
      {sessions.length > 0 && (
        <div className="hidden lg:flex justify-center mb-4">
          <button
            onClick={() => setShowTopo(!showTopo)}
            className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700/50 px-4 py-1.5 rounded-lg transition-colors hover:border-gray-600 cursor-pointer"
          >
            {showTopo ? 'Hide Topology' : 'Show Topology'}
          </button>
        </div>
      )}

      {showTopo && sessions.length > 0 && (
        // #209 R41: mobile-only soft cap on the rendered TopoGraph.
        // Default behaviour on desktop is unchanged (lg: drops the cap
        // entirely). On phones the SVG card was free to claim ~600+ px
        // of vertical real-estate, which on a 667-844 px viewport meant
        // tapping "Show Topology" pushed the agent grid completely off
        // screen. Capping to 70 vh with overflow-y-auto keeps the graph
        // interactive (the SVG already does its own pan + zoom inside
        // the viewport) while letting the page below stay reachable
        // with a single ordinary scroll past the cap.
        <div className="lg:max-h-none lg:overflow-visible max-h-[70vh] overflow-y-auto rounded-xl border border-transparent lg:border-0">
          <MemoTopoGraph sessions={sessions} sseSessions={sseSessions} renameSignal={renameSignal} />
        </div>
      )}

      {sessions.length === 0 && !sessError && presenceState === 'ready' ? (
        // #53: only pitch "Spin up your first agent" when we actually
        // know the fleet is empty. If presence is blind or still loading,
        // suppress the empty state — HealthBanner already surfaces the
        // real reason and the "first agent" CTA in that context would
        // read as "the fleet died overnight", exactly the failure mode
        // #53 was opened for.
        <EmptyState
          hint={sessHint}
          taskHistoryCount={Object.values(taskStats).reduce((a, b) => a + b, 0)}
        />
      ) : sessions.length === 0 && !sessError ? null : (() => {
        const counts = {
          all: sortedSessions.length,
          working: sortedSessions.filter(s => isOnline(s) && s.status === 'working').length,
          idle: sortedSessions.filter(s => isOnline(s) && s.status !== 'working').length,
          offline: sortedSessions.filter(s => !isOnline(s)).length,
        };
        const filtered = sortedSessions.filter(s => {
          if (agentFilter === 'all') return true;
          if (agentFilter === 'offline') return !isOnline(s);
          if (agentFilter === 'working') return isOnline(s) && s.status === 'working';
          if (agentFilter === 'idle') return isOnline(s) && s.status !== 'working';
          return true;
        });
        // Filter chip color keyed to status (round 34): working=green, idle=cyan,
        // offline=gray, all=neutral. Inline hex dots avoid Tailwind v4 purge.
        const chips: { key: typeof agentFilter; label: string; dot?: string }[] = [
          { key: 'all',     label: 'All' },
          { key: 'working', label: 'Working', dot: '#4ade80' },
          { key: 'idle',    label: 'Idle',    dot: '#22d3ee' },
          { key: 'offline', label: 'Offline', dot: '#6b7280' },
        ];
        return (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-1">
              {chips.map(c => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setAgentFilter(c.key)}
                  disabled={counts[c.key] === 0 && c.key !== 'all'}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                    agentFilter === c.key
                      ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]'
                      : 'text-gray-500 hover:text-gray-200 hover:bg-[var(--hover-tint)]'
                  }`}
                >
                  {c.dot && <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c.dot }} />}
                  {/* #217 D5: counts dropped — the KPI cards directly above
                      already carry 53/100/153; repeating them here doubled
                      every number on the first screen. */}
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
            {/* Round 48: previous breakpoints had `lg:grid-cols-2 xl:grid-cols-3`
                which kept lg (1024-1279px) at only 2 columns even though
                each AgentCard is fine ≥260px wide. With the sidebar (208px),
                main area at lg is ~816px so 3 cols at ~272px each fits.
                xl breakpoint auto-inherits lg=3 cols; 2xl bumps to 4. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3 sm:gap-4">
              {filtered.map(s => (
                <AgentCard key={s.alias} session={s} hasSse={isOnline(s)} sseCount={presenceSseCountFor(s, sseSessions) ?? 0} onChat={cmd.openTab} unreadCount={unreadCount(s.alias)} />
              ))}
            </div>
            {filtered.length === 0 && (
              <div className="mt-4 text-center text-xs text-gray-600">
                No agents match &quot;{agentFilter}&quot; — <button onClick={() => setAgentFilter('all')} className="underline hover:text-gray-400">Show all</button>
              </div>
            )}
          </>
        );
      })()}

      {/* Round 111 (issue #82): dropped the license badge — "trial (12d
          left)" read like a paywall countdown on an open-source dashboard
          and Vincent flagged it as misleading more than once. The SSE /
          polling dot stays: it's a real connection-status indicator, not
          a sales surface. */}
      <div className="mt-8 text-center text-xs text-gray-600 flex items-center justify-center gap-2 flex-wrap">
        {sseSupported && (
          <>
            <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-green-400' : 'bg-gray-600'}`} />
            {sseConnected ? 'SSE live' : 'SWR polling'}
          </>
        )}
      </div>

      {/* Command Center (multi-tab chat) */}
      {cmd.tabs.length > 0 && (
        <CommandCenter
          tabs={cmd.tabs}
          activeTab={cmd.activeTab}
          onOpenTab={cmd.openTab}
          onCloseTab={cmd.closeTab}
          onSetActive={cmd.setActiveTab}
          onClose={cmd.closeAll}
        />
      )}
    </div>
  );
}
