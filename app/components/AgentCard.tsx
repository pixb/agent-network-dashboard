'use client';

import { useState, memo } from 'react';
import Link from 'next/link';
import { Session } from './types';
import { timeAgo } from './utils';
import { AliasAvatar } from './AliasAvatar';
import { useHasDraft } from '../lib/chat-drafts';
import { useMuted } from '../lib/chat-mute';
import { usePinned } from '../lib/chat-pin';
import { NodeSettingsPanel } from './NodeSettingsPanel';
import { t } from '../lib/ui-lang';

interface AgentCardProps {
  session: Session;
  hasSse: boolean;
  sseCount: number;
  onChat?: (alias: string) => void;
  /** R8 (Vincent: 微信式未读角标): unread count for this conversation.
   *  Passed as a prop (computed once page-level) so the R6 memo keeps
   *  protecting against fleet-wide re-render storms. */
  unreadCount?: number;
}

const STATUS_CONFIG: Record<string, { bg: string; text: string; dot: string; glow: string }> = {
  working: { bg: 'bg-green-900/30 border-green-800/30', text: 'text-green-300', dot: 'bg-green-500', glow: 'shadow-green-500/10' },
  idle: { bg: 'bg-cyan-900/30 border-cyan-800/30', text: 'text-cyan-300', dot: 'bg-cyan-400', glow: 'shadow-cyan-500/5' },
  blocked: { bg: 'bg-yellow-900/30 border-yellow-800/30', text: 'text-yellow-300', dot: 'bg-yellow-500', glow: '' },
  error: { bg: 'bg-red-900/30 border-red-800/30', text: 'text-red-300', dot: 'bg-red-500', glow: '' },
};

const DEFAULT_STATUS = { bg: 'bg-gray-800/50 border-gray-700/30', text: 'text-gray-500', dot: 'bg-gray-500', glow: '' };

function AgentCardInner({ session: s, hasSse, sseCount, onChat, unreadCount = 0 }: AgentCardProps) {
  // R10 微信草稿闭环: list surfaces show which conversation has an unsent
  // draft. Internal subscription (useSyncExternalStore) so the memo
  // comparator stays untouched — a draft change re-renders only this card.
  const hasDraft = useHasDraft(s.alias);
  const muted = useMuted(s.alias);
  const pinned = usePinned(s.alias);
  const cfg = hasSse ? (STATUS_CONFIG[s.status] || DEFAULT_STATUS) : DEFAULT_STATUS;
  // #260: per-node settings panel (UI-only stub). Local open state — the
  // panel itself is presentational and issues no backend calls.
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
    {settingsOpen && <NodeSettingsPanel session={s} onClose={() => setSettingsOpen(false)} />}
    <Link
      href={`/node?alias=${encodeURIComponent(s.alias)}`}
      prefetch={false}
      // #17 M1: name the action for screen readers + hover tooltip. The
      // card does two different things depending on reachability (chat vs
      // drill-in) and the old inner text alone ("alias · status · time")
      // never said which — so a reachable card now announces "Chat with
      // {alias}", an offline one "View {alias} details".
      aria-label={hasSse ? `Chat with ${s.alias}` : `View ${s.alias} details`}
      onClick={e => {
        // #217 M2 (Vincent tg 646 "为什么还要留一个 chat 按钮，直接点击
        // 不就行了"): tapping a reachable agent's card opens chat
        // directly — the Chat button is gone. Offline/unreachable cards
        // keep navigating to /node detail, and detail for reachable
        // agents stays available via the Agents tab.
        if (onChat && hasSse) {
          e.preventDefault();
          onChat(s.alias);
        }
      }}
      className={`anet-agent-card group relative block rounded-xl border p-3 sm:p-4 transition-all duration-300 cursor-pointer hover:-translate-y-0.5 ${
        hasSse
          ? `bg-[#161618] border-[#26262b] hover:border-cyan-500/30 hover:shadow-lg ${cfg.glow}`
          : 'bg-[#111113] border-[#1c1c1f] opacity-40'
      }`}
    >
      {/* Header: avatar + name + status. Avatar carries the alias→hue map
          shared with Messages/Nodes/Tasks/Overview; the live status dot
          stays as a small pulse-capable indicator. R5 of #190 mobile
          polish: trim mb-3 → mb-2 sm:mb-3 so the card's vertical rhythm
          tightens on narrow viewports. */}
      <div className="flex items-center justify-between mb-2 sm:mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative inline-flex shrink-0">
            <AliasAvatar alias={s.alias} size={22} />
            {unreadCount > 0 && muted && (
              <span
                aria-label={t('有未读（已静音）', 'Unread (muted)')}
                className="absolute -top-0.5 -right-1 h-2.5 w-2.5 rounded-full bg-red-500/80 ring-2 ring-[var(--bg-secondary)]"
              />
            )}
            {unreadCount > 0 && !muted && (
              <span
                aria-label={t(`${unreadCount} 条未读`, `${unreadCount} unread`)}
                className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[11px] font-semibold leading-4 text-center ring-2 ring-[var(--bg-secondary)]"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </span>
          <span className="font-semibold text-white truncate text-sm" title={s.alias}>{s.alias}</span>
          {pinned && <span className="shrink-0 text-[11px] text-[var(--fg-dim)]" aria-label={t('已置顶', 'Pinned')} title={t('已置顶', 'Pinned')}>📌</span>}
          {hasDraft && <span className="shrink-0 text-[11px] text-red-400/90" aria-label={t('有未发送草稿', 'Unsent draft')}>{t('[草稿]', '[draft]')}</span>}
          <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} ${hasSse && s.status === 'working' ? 'animate-pulse' : ''}`} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[11px] px-2 py-0.5 rounded-md border ${cfg.bg} ${cfg.text}`}>
            {hasSse ? s.status : 'offline'}
          </span>
          {/* #260: per-node ⋮ menu → settings panel. The card is a <Link>,
              so stop the click from navigating / opening chat. Opens a
              UI-only stub panel (channels / model / mode / restart) — no
              backend wired yet. 44px tap target for mobile. */}
          <button
            type="button"
            aria-label={`${s.alias} 节点设置`}
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              setSettingsOpen(true);
            }}
            className="inline-flex h-7 w-7 items-center justify-center -mr-1 rounded-md text-gray-500 hover:text-[var(--fg)] hover:bg-[var(--hover-tint)] transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Agent type badge — hidden below sm because the runtime
          (`claude-code` / `codex`) repeats across nearly every card and
          chews ~28px per card × 99 sessions on Overview mobile. The
          agent type stays one tap away on /node detail. */}
      <div className="hidden sm:flex items-center gap-2 mb-3">
        <span className="text-xs text-gray-600 bg-[#0e0e10] px-2 py-0.5 rounded border border-[#1c1c1f]">
          {s.agent || 'unknown'}
        </span>
        {hasSse && (
          <span className="text-[11px] text-green-500">SSE:{sseCount}</span>
        )}
      </div>

      {/* Task. Mobile: line-clamp-1 (one-liner) instead of two, and a
          single-line padding (px-2 py-1) so the task strip is ~28px
          rather than ~56px. The full task is still in the title
          tooltip and on /node detail. */}
      {/* #217 M3: the "No active task" italic placeholder is gone — the
          idle status chip in the header already says it, and the line
          cost ~30px on every idle card across a 150-node fleet. The
          task strip renders only when there is a task. */}
      {s.task && (
        <div className="text-xs text-gray-400 bg-[#0e0e10] rounded-lg px-2 sm:px-3 py-1 sm:py-2 border border-[#1c1c1f] line-clamp-1 sm:line-clamp-2" title={s.task}>
          {s.task}
        </div>
      )}

      {/* Progress bar — hidden below sm so an empty 0% bar doesn't
          occupy 20px on every idle card. Visible from sm up where space
          is no longer the constraint. */}
      {s.progress > 0 && (
        <div className="hidden sm:block mt-3">
          <div className="flex justify-between text-[11px] mb-1">
            <span className="text-gray-600">Progress</span>
            <span className={cfg.text}>{s.progress}%</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-1.5 rounded-full transition-all duration-700 ${s.status === 'working' ? 'bg-green-500' : 'bg-cyan-500'}`}
              style={{ width: `${Math.min(s.progress, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer: server + time + a persistent action cue.
          #17 M1 (card-gesture disambiguation): the same card does two
          different things — a reachable card opens chat, an offline card
          drills into /node detail — but the only signifier used to be a
          hover chevron gated `hidden sm:inline-block`, i.e. INVISIBLE on
          touch (where most taps happen) and identical for both actions.
          The cue is now (a) always rendered, incl. mobile, and (b)
          action-aware: reachable → a cyan chat glyph (+ "Chat" label on
          sm) matching the chat/cyan theme; offline → a muted "Details"
          chevron. It stays subtle (footer, small, low emphasis) and
          brightens/nudges on hover, so it reads as a hint not a button.
          Presentational only — the onClick behaviour above is unchanged.
          #209 R40 density (mt-2 sm:mt-3) is preserved. */}
      <div className="mt-2 sm:mt-3 flex justify-between items-center text-[11px] text-gray-600">
        {/* #217 D5 (Vincent: 乱七八糟的元素都可以删掉): the raw server
            hostname (cloud instance IDs like iZrj93…) is noise on a
            phone card — desktop keeps it, /node detail always has it. */}
        <span className="hidden sm:inline truncate" title={s.server || ''}>{s.server || '--'}</span>
        <div className="flex items-center gap-2 ml-auto">
          <span>{timeAgo(s.updated_at)}</span>
          {hasSse ? (
            <span className="inline-flex items-center gap-1 text-cyan-500/70 group-hover:text-cyan-400 transition-colors" aria-hidden>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              <span className="hidden sm:inline text-[11px]">Chat</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-gray-600 group-hover:text-gray-400 transition-colors" aria-hidden>
              <span className="hidden sm:inline text-[11px]">Details</span>
              <svg className="w-3 h-3 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </span>
          )}
        </div>
      </div>
    </Link>
    </>
  );
}

/* Loop R6 (性能主线): SWR revalidation hands each card a NEW session object
   every poll/SSE mutate even when nothing changed, so all ~190 cards
   re-rendered on every event. memo + field comparison skips cards whose
   visible data (and the fields the settings panel reads) are unchanged.
   onChat is stable (useCallback in useCommandCenter). */
const CARD_FIELDS = [
  'alias', 'status', 'agent', 'task', 'progress', 'server', 'updated_at',
  'node_id', 'network_id', 'model', 'runtime', 'channels', 'session_id',
] as const;

export const AgentCard = memo(AgentCardInner, (prev, next) => {
  if (prev.hasSse !== next.hasSse || prev.sseCount !== next.sseCount || prev.onChat !== next.onChat || prev.unreadCount !== next.unreadCount) return false;
  const a = prev.session as unknown as Record<string, unknown>, b = next.session as unknown as Record<string, unknown>;
  for (const k of CARD_FIELDS) if (a[k] !== b[k]) return false;
  return true;
});
