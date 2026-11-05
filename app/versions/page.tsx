'use client';

import Link from 'next/link';
import { useSessions } from '../lib/hooks';
import type { Session } from '../components/types';

/** Published agent-node preview this page compares against. Not fetched from npm. */
const PUBLISHED_AGENT_NODE = '2.5.0-preview.151';

function online(s: Session) {
  return s.status === 'idle' || s.status === 'working';
}

function isAgentNode(s: Session) {
  return (s.agent || '').startsWith('agent-node');
}

export default function VersionsPage() {
  const { sessions, isLoading, error, mutate } = useSessions();
  const live = sessions.filter(online);
  const nodes = live.filter(isAgentNode);
  const current = nodes.filter(s => s.version === PUBLISHED_AGENT_NODE);
  const missing = nodes.filter(s => !s.version);
  const behind = nodes.filter(s => s.version && s.version !== PUBLISHED_AGENT_NODE);
  const groups = new Map<string, number>();
  for (const s of live) {
    const key = s.version || '(未上报)';
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1] - a[1]);

  // 读失败时不能画「在线 0 / 落后 0」：那看起来像「一切都好」，实际是没读到。
  // 三种状态互斥：读失败 → 错误卡；首次加载 → 骨架；读到空 → 空态。
  const failed = Boolean(error);
  const showBody = !failed && !isLoading;

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 text-[var(--fg)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">版本</h1>
        {/* 版本对照看完，下一个问题通常是「这版改了什么」——直接给入口。 */}
        <Link
          href="/changelog"
          data-testid="versions-changelog-link"
          className="inline-flex min-h-11 items-center rounded-md px-2.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] sm:min-h-0 sm:py-1"
        >
          更新日志 →
        </Link>
      </div>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">
        只读。对照已发布的 agent-node <code className="font-mono">{PUBLISHED_AGENT_NODE}</code>。这里没有升级按钮。
      </p>

      {failed && (
        <div role="alert" className="mt-4 rounded-2xl bg-[var(--bg-secondary)] p-4 text-sm">
          <p className="font-medium text-[var(--danger)]">读不到会话列表</p>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            版本对比需要 Hub 的 /api/status；Hub 不可达或返回非 2xx 时这里不会显示任何「0」，避免把失败读成健康。
          </p>
          <button
            type="button"
            onClick={() => mutate()}
            className="mt-3 rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
          >
            重试
          </button>
        </div>
      )}

      {isLoading && !failed && (
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[0, 1, 2].map(i => <div key={i} className="h-16 animate-pulse rounded-lg bg-[var(--bg-secondary)]" />)}
        </div>
      )}

      {showBody && live.length === 0 && (
        <div className="mt-4 rounded-2xl bg-[var(--bg-secondary)] p-6 text-center text-sm text-[var(--fg-muted)]">
          当前网络没有在线会话，无法对照版本。
          <Link href="/nodes" className="ml-1 text-[var(--hl)]">去看节点</Link>
        </div>
      )}

      {showBody && live.length > 0 && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-lg bg-[var(--bg-secondary)] p-3">在线 {live.length}</div>
            <div className="rounded-lg bg-[var(--bg-secondary)] p-3">已是 {PUBLISHED_AGENT_NODE.split('.').pop()}：{current.length}</div>
            <div className="rounded-lg bg-[var(--bg-secondary)] p-3">agent-node 落后或未上报：{behind.length + missing.length}</div>
          </div>
          <h2 className="mt-6 text-sm font-semibold">在线版本分布</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {ranked.map(([ver, n]) => (
              <li key={ver} className="flex justify-between gap-4 font-mono">
                <span>{ver}</span><span>{n}</span>
              </li>
            ))}
          </ul>
          <h2 className="mt-6 text-sm font-semibold">agent-node 不是 {PUBLISHED_AGENT_NODE}</h2>
          {behind.length + missing.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--fg-muted)]">全部已对齐。</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {[...behind, ...missing].map(s => (
                <li key={s.alias}>
                  <Link className="text-[var(--hl)]" href={`/node?alias=${encodeURIComponent(s.alias)}`}>{s.alias}</Link>
                  <span className="ml-2 text-[var(--fg-muted)]">{s.version || '未上报'} · {s.server || s.agent}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
