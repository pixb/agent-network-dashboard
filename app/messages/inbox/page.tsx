'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useUserInbox } from '../../lib/hooks';
import {
  countUnreadUserInbox,
  groupUserInboxBySender,
  isUnreadRow,
  kindLabel,
  kindTone,
  summarizeUserInbox,
} from '../../lib/user-inbox';
import { formatWeChatTime } from '../../lib/time';
import { EmptyState } from '../../components/EmptyState';
import { useT } from '../../lib/ui-lang';

/**
 * 我的收件箱 / My inbox。
 *
 * 为什么要有这一屏：Dashboard 的 Messages 页读 hub 的 `inbox` 表，hub 把「节点
 * 发给人的私信」（MCP `send_desktop_message` → `user_inbox`，kind='agent_message'）
 * 和 hub 代发的任务通知（task_expired / task_orphan_suspected）只放进 `user_inbox`，
 * 只有 `GET /api/messages?scope=user` 返回它们。前端此前没有任何调用带 scope=user
 * （2026-11-04 全仓 grep：app/ 下 0 命中），所以「节点给 manager 发了私信」在
 * Dashboard 上没有任何显示面 —— 数据在 hub 里（生产实测 admin 42 行、acked 全 0），
 * 缺的只是读它的那一屏。
 *
 * 读谁的收件箱由 hub 从 token 解出 userId（`app/api/hub/messages` 只透传参数，
 * 鉴权在 hub 侧），所以这一屏天然只显示登录者自己的行，不需要前端做过滤。
 */

const TONE_CLASS: Record<string, string> = {
  notice: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  mail: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  dm: 'bg-[var(--accent)]/10 text-[var(--accent-text)] border-[var(--accent)]/25',
  neutral: 'bg-[var(--bg-secondary)] text-[var(--fg-muted)] border-[var(--border)]/40',
};

export default function InboxPage() {
  const t = useT();
  const [unackedOnly, setUnackedOnly] = useState(false);
  const { rows, isLoading, error, mutate } = useUserInbox({ unackedOnly });

  const sorted = useMemo(() => groupUserInboxBySender(rows), [rows]);
  const unread = countUnreadUserInbox(rows);
  const summary = summarizeUserInbox(rows);

  return (
    <div data-testid="inbox-shell" className="min-h-screen bg-[var(--col-chat)] text-[var(--fg)] p-4 sm:p-6">
      <div className="flex items-center gap-3 mb-4 sm:mb-6 flex-wrap">
        <h1 className="text-2xl font-bold lg:ml-0 ml-10">{t('我的收件箱', 'My inbox')}</h1>
        <span
          className="text-xs bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded-full border border-blue-800/30 tabular-nums shrink-0"
          title={t('未读 = 还没被确认过的行（acked=0）', 'Unread = rows nobody acknowledged (acked=0)')}
        >
          {unread} {t('未读', 'unread')}
        </span>
        <Link
          href="/messages"
          className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] border border-[var(--border)]/50 px-2.5 py-1 rounded-lg transition-colors shrink-0"
        >
          {t('返回消息流', 'Back to messages')}
        </Link>
        <button
          type="button"
          onClick={() => mutate()}
          className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] border border-[var(--border)]/50 px-2.5 py-1 rounded-lg transition-colors shrink-0"
        >
          {t('刷新', 'Refresh')}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          onClick={() => setUnackedOnly(!unackedOnly)}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
            unackedOnly
              ? 'bg-[var(--accent)]/10 text-[var(--accent-text)] border-[var(--accent)]/30'
              : 'text-[var(--fg-muted)] border-[var(--border)]/50 hover:text-[var(--fg)]'
          }`}
        >
          {unackedOnly ? t('只看未读', 'Unread only') : t('全部', 'All')}
        </button>
        {summary.map((entry) => (
          <span
            key={entry.kind}
            className={`text-xs px-2 py-1 rounded-full border tabular-nums ${TONE_CLASS[kindTone(entry.kind)]}`}
          >
            {kindLabel(entry.kind)} · {entry.count}
          </span>
        ))}
      </div>

      {error ? (
        <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          {t('收件箱读取失败：', 'Inbox read failed: ')}
          {String((error as { message?: string })?.message || error)}
        </div>
      ) : isLoading && rows.length === 0 ? (
        <div className="text-sm text-[var(--fg-muted)]">{t('加载中…', 'Loading…')}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          variant="messages"
          title={t('没有收件箱消息', 'Nothing in your inbox')}
          sub={t(
            '节点用 send_desktop_message 发你的私信，以及 hub 的过期/孤儿任务通知，都会出现在这里。',
            'DMs sent via send_desktop_message and hub expiry/orphan notices land here.',
          )}
        />
      ) : (
        <div className="space-y-4">
          {sorted.map((group) => (
            <section key={group.sender} className="rounded-xl border border-[var(--border)]/60 bg-[var(--bg-secondary)]/60 overflow-hidden">
              <header className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]/40 text-sm">
                <span className="font-semibold text-[var(--fg)] truncate">{group.sender}</span>
                <span className="text-xs text-[var(--fg-muted)] tabular-nums shrink-0">{group.rows.length}</span>
                {group.unread > 0 && (
                  <span className="text-xs bg-[var(--accent)]/10 text-[var(--accent-text)] px-2 py-0.5 rounded-full shrink-0 tabular-nums">
                    {group.unread} {t('未读', 'new')}
                  </span>
                )}
                <span className="ml-auto text-xs text-[var(--fg-muted)] shrink-0">{formatWeChatTime(new Date(group.lastTime).toISOString())}</span>
              </header>
              <ul className="divide-y divide-[var(--border)]/30">
                {group.rows.map((row, index) => (
                  <li key={row.message_id || `${group.sender}-${index}`} className="px-3 py-2.5">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${TONE_CLASS[kindTone(row.kind)]}`}>
                        {kindLabel(row.kind)}
                      </span>
                      {isUnreadRow(row) && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0"
                          title={t('未读', 'unread')}
                        />
                      )}
                      <span className="text-xs text-[var(--fg-muted)] tabular-nums ml-auto shrink-0">
                        {formatWeChatTime(row.created_at)}
                      </span>
                    </div>
                    {row.title ? <div className="text-sm font-medium text-[var(--fg)] mb-0.5">{row.title}</div> : null}
                    <div className="text-sm text-[var(--fg-muted)] whitespace-pre-wrap break-words leading-relaxed">
                      {row.content || '--'}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
