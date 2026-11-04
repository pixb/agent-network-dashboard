'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useUserInbox } from '../../lib/hooks';
import { useNetworkId } from '../../lib/network-context';
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

export default function InboxPage() {
  const t = useT();
  const { networkId } = useNetworkId();
  const [unackedOnly, setUnackedOnly] = useState(false);
  const [acking, setAcking] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const { rows, isLoading, error, mutate } = useUserInbox({ unackedOnly });

  /**
   * 把一个发件人发来的行全部标已读 —— 走 Hub 的 `{agent}` 形态。
   *
   * 为什么不是逐条点：Hub 的未读分母是**全部**未 ack 的行，而这一屏只看得
   * 到最近 N 条（生产 admin：user_inbox 522 行）—— 逐条点永远清不完。
   * 为什么标完要 mutate：不刷新就看不到已读真的生效了，而「按钮点了、数不变」
   * 就是这一屏要避免的事故形状。
   */
  const ackSender = async (sender: string) => {
    setAcking(sender);
    setAckError(null);
    try {
      const res = await fetch('/api/hub/messages-ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: sender, ...(networkId ? { network_id: networkId } : {}) }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: 'non_json_response' }));
      if (!res.ok || data.ok === false) {
        setAckError(`${data.error || `http_${res.status}`}`);
      }
      await mutate();
    } catch (e) {
      setAckError(String((e as Error)?.message || e));
    } finally {
      setAcking(null);
    }
  };

  const sorted = useMemo(() => groupUserInboxBySender(rows), [rows]);
  const unread = countUnreadUserInbox(rows);
  const summary = summarizeUserInbox(rows);

  return (
    <div data-testid="inbox-shell" className="min-h-screen bg-[var(--col-chat)] text-[var(--fg)] p-4 sm:p-6">
      <div className="flex items-center gap-3 mb-4 sm:mb-6 flex-wrap">
        <h1 className="text-2xl font-bold lg:ml-0 ml-10">{t('我的收件箱', 'My inbox')}</h1>
        <span
          className="text-xs bg-[var(--accent)]/10 text-[var(--accent-text)] px-2 py-0.5 rounded-full border border-[var(--accent)]/25 tabular-nums shrink-0"
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
            className={`text-xs px-2 py-1 rounded-full border tabular-nums ${kindTone(entry.kind)}`}
          >
            {kindLabel(entry.kind)} · {entry.count}
          </span>
        ))}
      </div>

      {error ? (
        <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 border border-[var(--danger)]/20 rounded-lg p-4 mb-3">
          {t('收件箱读取失败：', 'Inbox read failed: ')}
          {String((error as { message?: string })?.message || error)}
        </div>
      ) : null}
      {ackError ? (
        <div className="text-xs text-[var(--danger)] bg-[var(--danger)]/10 border border-[var(--danger)]/20 rounded-lg px-3 py-2 mb-3">
          {t('标已读失败：', 'Mark-read failed: ')}{ackError}
        </div>
      ) : null}
      {isLoading && rows.length === 0 ? (
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
                {group.unread > 0 && (
                  <button
                    type="button"
                    onClick={() => ackSender(group.sender)}
                    disabled={acking !== null}
                    className="ml-2 text-[11px] px-2 py-1 rounded-lg border border-[var(--border)]/50 text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors shrink-0 disabled:opacity-50"
                    title={t('把这个发件人发来的行全部标已读（Hub 侧 acked=1）', 'Mark everything from this sender as read (sets acked=1 on the hub)')}
                  >
                    {acking === group.sender ? t('标已读中…', 'Marking…') : t('标已读', 'Mark read')}
                  </button>
                )}
              </header>
              <ul className="divide-y divide-[var(--border)]/30">
                {group.rows.map((row, index) => (
                  <li key={row.message_id || `${group.sender}-${index}`} className="px-3 py-2.5">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${kindTone(row.kind)}`}>
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
