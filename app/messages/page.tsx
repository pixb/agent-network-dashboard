'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMessages } from '../lib/hooks';
import { timeAgo, previewContent } from '../components/utils';
import { formatWeChatTime } from '../lib/time';
import { EmptyState } from '../components/EmptyState';
import { AliasAvatar } from '../components/AliasAvatar';
import { useCollapsibleSearch } from '../components/CollapsibleSearch';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin-match';
import { t } from '../lib/ui-lang';
import { AttachmentBlock, extractAttachments } from '../components/AttachmentBlock';

interface MessageItem {
  id: string;
  type?: string;
  from_alias?: string;
  to_alias?: string;
  priority?: string;
  content?: string;
  created_at?: string;
  task_id?: string;
  // #492 — attachments render below content. Both fields accepted so
  // this works whether the messages route is pre-parsed or forwards
  // the raw meta_json TEXT column.
  meta_json?: string | null;
  meta?: { attachments?: unknown } | null;
}

const TYPE_COLORS: Record<string, string> = {
  task: 'bg-green-500/10 text-green-300 border-green-500/20',
  message: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  broadcast: 'bg-[var(--accent)]/10 text-[var(--accent-text)] border-[var(--accent)]/25',
  reply: 'bg-[var(--info)]/10 text-[var(--info)] border-[var(--info)]/25',
};

function normalizeDate(value?: string) {
  if (!value) return 0;
  return new Date(value.replace(' ', 'T') + 'Z').getTime();
}

// Loop R7: divider label now shares the chat panel's WeChat-style
// contextual formatter (was a raw toLocaleString() dump) — one time
// language across every conversation surface.
function formatDividerLabel(value?: string) {
  return formatWeChatTime(value) || 'Time gap';
}

function bubbleVariant(message: MessageItem) {
  if (message.type === 'broadcast') return 'broadcast';
  if ((message.from_alias || '').toLowerCase() === 'dashboard') return 'outgoing';
  return 'incoming';
}

/** Render message content, highlighting the search match inline (skips the
 *  `from:` filter prefix since it filters by sender, not by content). */
function renderHighlighted(content: string | undefined, search: string) {
  const text = content || '--';
  const q = search.trim();
  if (!q || q.startsWith('from:')) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return <>{text.slice(0, idx)}<mark className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>;
}

// #217 M5 (Vincent tg 655/656, same directive as chat M4): don't pull the
// full history on every 5s poll. Open with the newest page only and grow
// the window when the user explicitly asks for older messages.
const HISTORY_PAGE = 30;

export default function MessagesPage() {
  const [histLimit, setHistLimit] = useState(HISTORY_PAGE);
  const { messages, isLoading, error, mutate } = useMessages(histLimit);
  // The hub returned a full page → assume more history exists beyond it.
  const hasOlder = messages.length >= histLimit;
  const loadingOlder = isLoading && messages.length > 0;
  const [filterType, setFilterType] = useState('');
  const [search, setSearch] = useState('');
  const pinyinReady = usePinyinReady();
  const [debug, setDebug] = useState(false);
  const [viewMode, setViewMode] = useState<'timeline' | 'grouped'>('timeline');
  // M5: the timeline runs oldest→newest top-to-bottom, so land the first
  // paint on the newest message (what the user came to read) instead of
  // the oldest of the loaded window. Once only — later polls/loads must
  // not yank the scroll position.
  const endRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current || messages.length === 0) return;
    didInitialScrollRef.current = true;
    endRef.current?.scrollIntoView();
  }, [messages.length]);
  // #209 R33→R34: WeChat-style magnifier-toggle search hook (shared with /nodes).
  const searchCtl = useCollapsibleSearch({
    value: search,
    onChange: setSearch,
    placeholder: t('搜 别名(支持拼音)/内容，或 from:别名…', 'Search from/to (pinyin ok)/content, or from:alias…'),
    label: 'Search messages',
    enabled: messages.length > 0,
  });

  const quickFromChips = useMemo(() => {
    const aliases = new Set<string>();
    messages.forEach((message: MessageItem) => {
      const alias = message.from_alias?.trim();
      if (alias && alias.toLowerCase() !== 'dashboard') aliases.add(alias);
    });
    return [...aliases].slice(0, 8);
  }, [messages]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const fromFilter = query.startsWith('from:') ? query.slice(5).trim() : '';

    return [...messages]
      .filter((m: MessageItem) => {
        if (filterType && m.type !== filterType) return false;
        if (fromFilter) {
          return pinyinMatch(m.from_alias || '', fromFilter);
        }
        if (query) {
          // R25: aliases match by pinyin too; content stays substring-only
          // (pinyin over long message bodies is cost without benefit).
          return pinyinMatch(m.from_alias || '', query)
            || pinyinMatch(m.to_alias || '', query)
            || (m.content || '').toLowerCase().includes(query);
        }
        return true;
      })
      .sort((a: MessageItem, b: MessageItem) => normalizeDate(a.created_at) - normalizeDate(b.created_at));
  }, [filterType, messages, search, pinyinReady]);

  // Group messages by conversation pair
  const conversations = useMemo(() => {
    const groups = new Map<string, { participants: string[]; messages: MessageItem[]; lastTime: number }>();
    filtered.forEach(m => {
      const a = m.from_alias || '?';
      const b = m.to_alias || '?';
      const key = [a, b].sort().join('↔');
      const group = groups.get(key) || { participants: [a, b].sort(), messages: [] as MessageItem[], lastTime: 0 };
      group.messages.push(m);
      group.lastTime = Math.max(group.lastTime, normalizeDate(m.created_at));
      groups.set(key, group);
    });
    return [...groups.values()].sort((a, b) => b.lastTime - a.lastTime);
  }, [filtered]);

  return (
    <div data-testid="messages-shell" className="min-h-screen bg-[var(--col-chat)] text-[var(--fg)] p-4 sm:p-6">
      {/* #209 R31 (mobile vertical rhythm — same pattern as R28/R30):
          header row + quick-from chips row both mb-6 → mb-4 sm:mb-6.
          #209 R33: header restructured to mirror /nodes R32 — title
          cluster left (Messages + count chip + Export MD), magnifier
          circle right. Inline ~290 px search input was moved into the
          collapsible row below. */}
      <div className="flex items-center gap-4 mb-4 sm:mb-6">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-[var(--fg)] lg:ml-0 ml-10">Messages</h1>
          {/* Round 89: filter-aware chip. When search/type filter is active
              the visible rows are filtered.length; the total loaded is
              messages.length (the M5 lazy window, newest histLimit). Show
              `filtered / total` so users notice how much the filter is
              hiding. Same pattern as r88 /tasks chip. */}
          <span
            className="text-xs bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded-full border border-blue-800/30 tabular-nums shrink-0"
            title={filtered.length < messages.length ? `Showing ${filtered.length} of ${messages.length} messages` : undefined}
          >
            {filtered.length < messages.length ? `${filtered.length} / ${messages.length}` : messages.length}
          </span>
          {filtered.length > 0 && (
            <button
              onClick={() => {
                const md = filtered.map((m: MessageItem) =>
                  `**${m.from_alias || '?'}** → ${m.to_alias || '?'} (${m.type || '?'}) — ${m.created_at || ''}\n\n${m.content || '--'}\n\n---`
                ).join('\n\n');
                const blob = new Blob([`# Messages Export\n\n${md}`], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `messages-${new Date().toISOString().slice(0,10)}.md`;
                a.click(); URL.revokeObjectURL(url);
              }}
              className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] border border-[var(--border)]/50 px-2.5 py-1 rounded-lg transition-colors shrink-0"
            >
              Export MD
            </button>
          )}
        </div>
        <searchCtl.Button />
      </div>

      {/* #209 R34: shared <CollapsibleSearch> component. enabled gate
          handles the no-content case (button + row both hide). */}
      <searchCtl.Row />

      {/* Round 76: hide search + type filter + view toggle + Debug button
          when there are no messages at all. Same r70-class fix carried
          across /nodes (r74) and /tasks (r75). When at least one message
          exists, the chrome reappears so users can still clear filters. */}
      {messages.length > 0 && (
      <div className="flex flex-wrap gap-3 mb-3">
        {/* R33: inline search input moved to the top-right magnifier
            toggle above. Type select + view-mode toggle + Debug stay. */}
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-base sm:text-sm text-[var(--fg)] focus:border-blue-500/50 focus:outline-none"
        >
          <option value="">All types</option>
          <option value="task">task</option>
          <option value="message">message</option>
          <option value="broadcast">broadcast</option>
          <option value="reply">reply</option>
        </select>
        <div className="flex rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5">
          {(['timeline', 'grouped'] as const).map(mode => (
            <button key={mode} type="button" onClick={() => setViewMode(mode)}
              className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${viewMode === mode ? 'bg-[var(--accent)]/10 text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>
              {mode === 'timeline' ? 'Timeline' : 'Grouped'}
            </button>
          ))}
        </div>
        <button
          onClick={() => setDebug(!debug)}
          className={`text-xs px-3 py-2 rounded-lg border transition-colors ${
            debug ? 'bg-yellow-500/10 text-yellow-300 border-yellow-500/20' : 'text-[var(--fg-muted)] border-[var(--border)]/50 hover:text-[var(--fg)]'
          }`}
        >
          {debug ? 'Debug ON' : 'Debug'}
        </button>
      </div>
      )}

      {/* #217 S8 (less is more): on phones the sender chips wrapped into
          ~5 rows and pushed the first message below the fold. One
          scrollable row on mobile; wrap returns from sm: up. */}
      {quickFromChips.length > 0 && (
        <div className="mb-4 sm:mb-6 flex gap-2 overflow-x-auto whitespace-nowrap pb-1 scrollbar-thin sm:flex-wrap sm:overflow-visible sm:whitespace-normal sm:pb-0">
          {quickFromChips.map(alias => (
            <button
              key={alias}
              type="button"
              onClick={() => setSearch(`from:${alias}`)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs transition-colors ${
                search === `from:${alias}`
                  ? 'border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent-text)]'
                  : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg-muted)] hover:text-[var(--fg)]'
              }`}
            >
              from:{alias}
            </button>
          ))}
          {search.startsWith('from:') && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--fg-dim)] hover:text-[var(--fg)]"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* M5: paging affordance — mirrors the chat panel's M4 row. Sits
          above the list because older history is prepended above what's
          already on screen. Hidden once the hub returns a short page
          (we've reached the beginning). */}
      {messages.length > 0 && hasOlder && (
        <div className="mb-3 flex justify-center">
          <button
            type="button"
            onClick={() => setHistLimit(l => l + HISTORY_PAGE)}
            disabled={loadingOlder}
            className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-1.5 text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg)] disabled:opacity-50"
          >
            {loadingOlder ? 'Loading…' : '↑ Load earlier messages'}
          </button>
        </div>
      )}

      {/* 读失败不等于「没有消息」。旧实现忽略 error，把失败渲染成空态，
          用户看到的是「这里很安静」而不是「没读到」。 */}
      {error && messages.length > 0 && (
        <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-2xl bg-[var(--bg-secondary)] px-3 py-2 text-xs">
          <span className="text-[var(--fg-muted)]">刷新失败，下面是上一次读到的消息。</span>
          <button
            type="button"
            onClick={() => mutate()}
            className="shrink-0 rounded-md px-2 py-1 text-[var(--hl)] hover:bg-[var(--hover-tint)]"
          >
            重试
          </button>
        </div>
      )}

      {isLoading && messages.length === 0 ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-20 rounded-2xl bg-[var(--bg-elevated)]/20" />)}
        </div>
      ) : error && messages.length === 0 ? (
        <div role="alert" className="rounded-2xl bg-[var(--bg-secondary)] p-6 text-center text-sm">
          <p className="font-medium text-[var(--danger)]">读不到消息</p>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <button
            type="button"
            onClick={() => mutate()}
            className="mt-3 rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
          >
            重试
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState variant="messages" />
      ) : viewMode === 'grouped' ? (
        <div className="space-y-4">
          {conversations.map((conv, ci) => (
            <div key={ci} className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AliasAvatar alias={conv.participants[0]} size={16} />
                  <span className="text-sm text-[var(--fg)] font-medium">{conv.participants[0]}</span>
                  <span className="text-[var(--fg-dim)] text-xs">↔</span>
                  <AliasAvatar alias={conv.participants[1]} size={16} />
                  <span className="text-sm text-[var(--fg)] font-medium">{conv.participants[1]}</span>
                </div>
                <span className="text-[10px] text-[var(--fg-dim)]">{conv.messages.length} messages</span>
              </div>
              <div className="px-4 py-2 space-y-2 max-h-64 overflow-y-auto">
                {conv.messages.map(m => (
                  <div key={m.id} className="flex items-start gap-2 text-xs py-1">
                    {m.from_alias && <AliasAvatar alias={m.from_alias} size={14} />}
                    <span className="shrink-0 font-medium text-[var(--fg)]">{m.from_alias}</span>
                    <span className="text-[var(--fg-muted)] flex-1 truncate" title={m.content || ''}>{previewContent(m.content).slice(0, 120)}</span>
                    <span className="text-[9px] text-[var(--fg-dim)] shrink-0">{timeAgo(m.created_at || '')}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((message: MessageItem, index) => {
            const previous = filtered[index - 1];
            const gapExceeded = previous
              ? normalizeDate(message.created_at) - normalizeDate(previous.created_at) > 5 * 60 * 1000
              : false;
            const variant = bubbleVariant(message);
            // Cluster: same sender + same direction + same to_alias and no
            // time-gap divider → tighter spacing and hide repeated header.
            const samePrev = !!previous
              && !gapExceeded
              && bubbleVariant(previous) === variant
              && (previous.from_alias || '') === (message.from_alias || '')
              && (previous.to_alias || '') === (message.to_alias || '');
            const fromAlias = message.from_alias || '?';

            return (
              <div key={message.id}>
                {/* R6 of #190 mobile polish: gap divider was my-4 (=16px
                    each side), and with multi-hour message lulls it
                    fired several times per session, eating ~32px each.
                    Halve it on mobile. */}
                {gapExceeded && (
                  <div className="my-2 sm:my-4 flex items-center gap-3">
                    <div className="h-px flex-1 bg-white/[0.06]" />
                    <div className="text-[13px] font-medium text-[var(--fg-muted)]">{formatDividerLabel(message.created_at)}</div>
                    <div className="h-px flex-1 bg-white/[0.06]" />
                  </div>
                )}

                {/* Broadcasts span full width — no avatar gutter. R6 mobile:
                    tighter padding + tighter header margin + snug leading
                    on the content so each bubble is ~25-30% shorter at
                    390px. Desktop unchanged from sm: up. */}
                {variant === 'broadcast' ? (
                  <div className={samePrev ? 'mt-0.5 sm:mt-1' : 'mt-2 sm:mt-3'}>
                    <div className="rounded-2xl border border-white/[0.06] border-l-2 border-l-[var(--hl)] bg-[var(--bubble-in)] px-3 py-2 sm:px-4 sm:py-3 shadow-sm w-full">
                      <div className="mb-1 sm:mb-2 flex flex-wrap items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded-md border ${TYPE_COLORS[message.type || ''] || 'bg-gray-500/10 text-[var(--fg-muted)] border-gray-500/20'}`}>
                          {message.type || 'unknown'}
                        </span>
                        <span className="text-sm font-medium text-[var(--fg)]">{fromAlias}</span>
                        {message.to_alias && <span className="text-xs text-[#CBD5E1]">to {message.to_alias}</span>}
                        {message.priority === 'high' && <span className="text-xs text-[var(--danger)]">HIGH</span>}
                        <span className="ml-auto text-[11px] text-[var(--fg-muted)]">{message.created_at ? timeAgo(message.created_at) : '--'}</span>
                      </div>
                      {/* Round 79: break-words + overflow-wrap:anywhere so
                          long unbroken runs (URLs, ASCII rules like
                          `═══════════════`) wrap instead of pushing the
                          chat bubble past the mobile viewport. */}
                      <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-snug sm:leading-relaxed text-[var(--fg)]">
                        {renderHighlighted(message.content, search)}
                      </div>
                      {/* #492: broadcast may carry attachments too. */}
                      {extractAttachments(message).map((att, i) => (
                        <AttachmentBlock key={`att-b-${message.id}-${att.file_id ?? i}`} attachment={att} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className={`${samePrev ? 'mt-0.5 sm:mt-1' : 'mt-2 sm:mt-3'} flex gap-2 ${variant === 'outgoing' ? 'flex-row-reverse' : 'flex-row'}`}>
                    {/* Avatar gutter — fixed width keeps bubble columns aligned even on streaks */}
                    <div className="w-8 shrink-0 pt-1">
                      {!samePrev && <AliasAvatar alias={fromAlias} size={32} />}
                    </div>
                    <div className={`min-w-0 max-w-[min(640px,65%)] rounded-2xl border border-white/[0.06] px-3 py-2 sm:px-4 sm:py-3 shadow-sm ${
                      variant === 'outgoing'
                        ? 'bg-[var(--bubble-out)]'
                        : 'bg-[var(--bubble-in)]'
                    }`}>
                      {!samePrev && (
                        <div className="mb-1 sm:mb-2 flex flex-wrap items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-md border ${TYPE_COLORS[message.type || ''] || 'bg-gray-500/10 text-[var(--fg-muted)] border-gray-500/20'}`}>
                            {message.type || 'unknown'}
                          </span>
                          <span className={`text-sm font-medium ${variant === 'outgoing' ? 'text-[var(--fg)]' : 'text-[var(--fg)]'}`}>
                            {fromAlias}
                          </span>
                          <span className="text-xs text-[var(--fg-muted)]">&rarr;</span>
                          <span className="text-sm text-[#CBD5E1]">{message.to_alias || '--'}</span>
                          {message.priority === 'high' && <span className="text-xs text-[var(--danger)]">HIGH</span>}
                          <span className="ml-auto text-[11px] text-[var(--fg-muted)]">{message.created_at ? timeAgo(message.created_at) : '--'}</span>
                        </div>
                      )}

                      {/* Round 79: break-words + overflow-wrap:anywhere so
                          long unbroken runs (URLs, ASCII rules like
                          `═══════════════`) wrap instead of pushing the
                          chat bubble past the mobile viewport. */}
                      <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-snug sm:leading-relaxed text-[var(--fg)]">
                        {renderHighlighted(message.content, search)}
                      </div>

                      {/* #492: attachment blocks from meta.attachments —
                          historical messages render automatic (data is
                          in the row, not on the wire event). Download
                          via the /api/hub/files/<id> proxy: Bearer added
                          server-side, blob-based `<a download>` on
                          client, sanitized filename, byte-preserving. */}
                      {extractAttachments(message).map((att, i) => (
                        <AttachmentBlock key={`att-msg-${message.id}-${att.file_id ?? i}`} attachment={att} />
                      ))}

                      {/* When in a streak, surface the timestamp inline-right so users still know cadence */}
                      {samePrev && (
                        <div className="mt-1 text-[11px] text-[var(--fg-muted)] text-right">
                          {message.created_at ? timeAgo(message.created_at) : ''}
                        </div>
                      )}

                      {debug && (
                        <div className="mt-3 border-t border-white/10 pt-3 text-[11px] text-[var(--fg-muted)] space-y-1">
                          <div>ID: {message.id}</div>
                          {message.task_id && <div>Task ID: {message.task_id}</div>}
                          <div>Created: {message.created_at}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
