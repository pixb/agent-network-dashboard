'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { timeAgo } from '../components/utils';
import { useNetworkId } from '../lib/network-context';
import { EmptyState } from '../components/EmptyState';
import { AliasAvatar } from '../components/AliasAvatar';

interface AuditLog {
  id: string;
  action: string;
  user_id: string;
  username: string;
  target_type: string;
  target_id: string;
  detail: string;
  ip: string;
  created_at: string;
}

const ACTION_COLORS: Record<string, string> = {
  register: 'bg-green-500/10 text-green-300 border-green-500/20',
  login: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  login_failed: 'bg-red-500/10 text-red-300 border-red-500/20',
  create_network: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
  send_task: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',
};

/** 2px left-rail stripe color per audit action — reuses the r32 server-logs
 *  pattern so failed logins / token rotations spike out of a wall of
 *  registers and logins without users reading every chip. Inline hex
 *  prevents Tailwind v4 from purging dynamic class names. */
const ACTION_STRIPE: Record<string, string> = {
  register: '#4ade80',
  login: '#60a5fa',
  login_failed: '#ef4444',
  create_network: '#a78bfa',
  send_task: '#22d3ee',
};

export default function LogsPage() {
  const { networkId } = useNetworkId();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterAction, setFilterAction] = useState('');

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (networkId) params.set('network_id', networkId);
      if (filterAction) params.set('action', filterAction);
      // Pass V3 user token if logged in
      const saved = sessionStorage.getItem('anet_v3_auth');
      if (saved) {
        try { const auth = JSON.parse(saved); if (auth.token) params.set('token', auth.token); } catch {}
      }

      const res = await fetch(`/api/hub/audit-log?${params.toString()}`);
      if (res.status === 401) { window.location.assign('/login'); return; }
      const data = await res.json();
      setLogs(data.logs || []);
      setError(data.error && !data.logs?.length ? data.error : '');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally { setLoading(false); }
  }, [filterAction, networkId]);

  useEffect(() => {
    setLoading(true);
    fetchLogs();
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  return (
    <div className="min-h-screen bg-[#0b0b0d] text-gray-100 p-4 sm:p-6">
      {/* #209 R36: mobile vertical rhythm — same R28/R30/R31 pattern,
          mb-6 → mb-4 sm:mb-6 here and on the action-filter strip below. */}
      <div className="flex items-center gap-4 mb-4 sm:mb-6">
        <h1 className="text-2xl font-bold text-white lg:ml-0 ml-10">Audit Log</h1>
        {/* Round 87: dropped {logs.length} header chip — r43 added
            `All <count>` to the action-filter strip below, which
            duplicated this value 40px away. Matches r86 /server-logs. */}
      </div>

      {/* Action filter chips (round 43) — same chip pattern as Tasks
          status tabs / Overview agent filter. Each chip carries its
          ACTION_STRIPE dot so the visual key matches the per-row left
          rail. Counts come from the currently loaded log set. */}
      <div className="mb-4 sm:mb-6 flex flex-wrap items-center gap-1 anet-tabstrip-wrap overflow-x-auto sm:overflow-x-visible">
        {(() => {
          const counts: Record<string, number> = {};
          logs.forEach(l => { counts[l.action] = (counts[l.action] || 0) + 1; });
          const chips: { key: string; label: string; dot?: string }[] = [
            { key: '',                label: 'All' },
            { key: 'login',           label: 'login',           dot: ACTION_STRIPE.login },
            { key: 'login_failed',    label: 'login_failed',    dot: ACTION_STRIPE.login_failed },
            { key: 'register',        label: 'register',        dot: ACTION_STRIPE.register },
            { key: 'create_network',  label: 'create_network',  dot: ACTION_STRIPE.create_network },
            { key: 'send_task',       label: 'send_task',       dot: ACTION_STRIPE.send_task },
          ];
          return chips.map(c => {
            const count = c.key === '' ? logs.length : counts[c.key] || 0;
            const isActive = filterAction === c.key;
            return (
              <button
                key={c.key || 'all'}
                type="button"
                onClick={() => setFilterAction(c.key)}
                disabled={count === 0 && c.key !== ''}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0 whitespace-nowrap ${
                  isActive
                    ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/30'
                    : 'text-gray-500 hover:text-gray-200 hover:bg-[#1c1c1f] border border-transparent'
                }`}
              >
                {c.dot && <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c.dot }} />}
                <span>{c.label}</span>
                <span className={`text-[11px] tabular-nums ${isActive ? 'text-cyan-400' : 'text-gray-600'}`}>{count}</span>
              </button>
            );
          });
        })()}
      </div>

      {error && (() => {
        // Don't dump raw error JSON to users — translate known patterns,
        // and give them a clickable recovery affordance.
        const isAuth = /unauthor|401|forbidden|403|admin/i.test(error);
        return (
          <div className="anet-warn-chip bg-yellow-900/20 border border-yellow-800/40 text-yellow-300 px-4 py-3 rounded-lg mb-6 text-sm flex items-start gap-3" role="alert">
            <span aria-hidden className="text-base leading-none">⚠</span>
            <div className="flex-1">
              {isAuth ? (
                <>
                  <div className="font-medium">需要 admin 权限查看审计日志</div>
                  <div className="text-xs opacity-80 mt-1">
                    审计日志记录用户注册 / 登录 / 网络变更等事件，需要 admin 角色。
                  </div>
                  <Link href="/login" className="inline-block mt-2 text-xs font-medium underline underline-offset-4 hover:opacity-80">
                    切到 admin 账号 →
                  </Link>
                </>
              ) : (
                <>
                  <div className="font-medium">加载失败</div>
                  <div className="text-xs opacity-80 mt-1">请检查 CommHub 是否在线，或稍后重试。</div>
                  <button onClick={() => window.location.reload()} className="inline-block mt-2 text-xs font-medium underline underline-offset-4 hover:opacity-80">
                    重新加载 →
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {loading ? (
        <div className="animate-pulse space-y-2">
          {[1,2,3,4,5].map(i => <div key={i} className="h-14 bg-gray-800/20 rounded-lg" />)}
        </div>
      ) : logs.length === 0 ? (
        <EmptyState variant="logs" />
      ) : (
        /* R18 of #190 mobile polish: /logs was 28,791 px on 390 px
           mobile; same dense-card pattern that R7/R8 hit on /nodes
           and /tasks. Tighten card padding and inter-card gap on
           mobile, sm:-gated so desktop stays comfortable. */
        <div className="space-y-1 sm:space-y-2">
          {logs.map(log => {
            const userName = log.username || log.user_id;
            return (
            <div key={log.id} className="relative bg-[#161618] border border-[#26262b] rounded-lg pl-3 pr-3 py-2 sm:pl-4 sm:pr-4 sm:py-3 hover:border-[#3a3a41] transition-colors overflow-hidden">
              {/* 2px left rail per action (round 33) — failed logins, token
                  rotations spike out of a wall of register/login rows. */}
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 w-0.5"
                style={{ backgroundColor: ACTION_STRIPE[log.action] || 'transparent' }}
              />
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className={`text-xs px-2 py-0.5 rounded-md border ${ACTION_COLORS[log.action] || 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
                  {log.action}
                </span>
                {userName && <AliasAvatar alias={userName} size={16} />}
                <span className="text-sm text-gray-200 font-medium">{userName}</span>
                {log.target_type && (
                  <>
                    <span className="text-xs text-gray-600">&rarr;</span>
                    <span className="text-xs text-gray-400">{log.target_type}{log.target_id ? `:${log.target_id.slice(0, 12)}` : ''}</span>
                  </>
                )}
                <span className="text-xs text-gray-600 ml-auto">{timeAgo(log.created_at)}</span>
              </div>
              {log.detail && <div className="text-xs text-gray-500">{log.detail}</div>}
              {log.ip && log.ip !== 'unknown' && <div className="text-[11px] text-gray-700">IP: {log.ip}</div>}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
