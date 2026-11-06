'use client';

import useSWR from 'swr';
import { useState } from 'react';
import Link from 'next/link';
import { parseHubTime } from '../lib/time';
import { presenceStatus, type SseSessionsMap } from '../lib/presence';

interface StatsResponse {
  ok?: boolean;
  tasks?: { by_status?: { status: string; count: number }[] };
  nodes?: { total?: number };
  health?: { version?: string };
  error?: string;
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

/**
 * Thin, collapsible global-health banner. Visible across every page
 * (mounted in AppShell). Pulls from /api/hub/stats + /api/hub/health
 * via SWR — both endpoints are cheap and already polled elsewhere, so
 * the request dedupes free.
 *
 * Three states, never more than one shown at a time:
 *   green  — all systems go
 *   amber  — N failed task(s) in the recent window
 *   red    — CommHub unreachable
 *
 * Dismissible per-session (sessionStorage key `anet-hb-dismissed`).
 * Never blocks content; sits as a 28px-tall sticky strip above page.
 */
export function HealthBanner() {
  const { data: stats, error: statsErr } = useSWR<StatsResponse>('/api/hub/stats', fetcher, {
    refreshInterval: 15000,
    dedupingInterval: 5000,
    shouldRetryOnError: false,
  });
  const { data: health, error: healthErr } = useSWR<{
    ok?: boolean;
    sse_connections?: number;
    sse_sessions?: SseSessionsMap;
  }>('/api/hub/health', fetcher, {
    refreshInterval: 15000,
    dedupingInterval: 5000,
    shouldRetryOnError: false,
  });

  // #217 S4 (less is more): the amber count used the all-time `failed`
  // total from /api/hub/stats, so the banner said "N failed recently"
  // forever — a permanent warning is no warning. Only fetch the actual
  // failed tasks when stats reports any, and count just the last 24 h.
  const allTimeFailed = stats?.tasks?.by_status?.find(s => s.status === 'failed')?.count || 0;
  // 只需要「近 24h 失败数」，不需要失败任务本体。
  // 旧实现拉 tasks?status=failed&limit=100（含 result 全文，生产实测约 400 KB），
  // 再在前端按时间过滤计数；现在服务端数好只回一个数字。
  const { data: failedStat } = useSWR<{ ok: boolean; recent?: number }>(
    allTimeFailed > 0 ? '/api/hub/task-stats?status=failed&sinceHours=24' : null,
    fetcher,
    { refreshInterval: 60000, dedupingInterval: 30000, shouldRetryOnError: false },
  );

  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem('anet-hb-dismissed') === '1';
  });

  if (dismissed) return null;

  // Determine current state — priority: red > presence-blind > amber > empty > green
  const hubDown = (statsErr && healthErr) || (health && health.ok === false);
  // #53: hub responded, but the auth-gated sse_sessions map is missing
  // AND hub still reports live connections. That contradiction is the
  // strongest "you're anonymous / wrong scope" signal we have — rendering
  // 0 online everywhere without saying so is exactly the failure mode
  // #53 was opened for.
  const presenceBlind = !hubDown && health && presenceStatus(health.sse_sessions, health) === 'blind';
  // Coarse 24h window for the failed-task banner; poll-level freshness.
  const failed = failedStat?.recent ?? 0;
  const fleetEmpty = stats?.nodes?.total === 0;

  let kind: 'red' | 'amber' | 'green';
  let message: string;
  let cta: { label: string; href: string } | null = null;

  if (hubDown) {
    kind = 'red';
    message = 'CommHub unreachable — agents may be offline';
    cta = { label: 'Open Settings', href: '/settings' };
  } else if (presenceBlind) {
    // #53: red (not amber) because the visible count in the header/
    // sidebar/topology is now unreliable; user sees "0 online" but
    // hub reports live SSE connections. Point at Settings so an
    // admin can re-scope the network or refresh their v3 token.
    kind = 'red';
    message = `Unable to read presence — hub reports ${health?.sse_connections ?? '?'} live SSE, but the session map is missing (auth or network scope)`;
    cta = { label: 'Open Settings', href: '/settings' };
  } else if (failed > 0) {
    kind = 'amber';
    message = `${failed} task${failed > 1 ? 's' : ''} failed in the last 24h`;
    cta = { label: 'Review failures', href: '/tasks?status=failed' };
  } else if (fleetEmpty) {
    // Round 70 — was "All systems go" before, which is misleading when
    // the fleet is empty. Reuses the green palette (it's not a failure
    // state) but with onboarding copy + CTA-less for restraint.
    kind = 'green';
    message = 'Waiting for first agent';
    cta = null;
  } else {
    kind = 'green';
    message = 'All systems go';
    cta = null; // green = no CTA, the banner can be auto-dismissed by user
  }

  // Green state is the calm default — only show it if we haven't yet
  // confirmed at least one stats response, otherwise it's noise.
  // (When CommHub returns data, kind stays 'green' and this passes.)
  if (kind === 'green' && !stats) return null;

  const styles = {
    red:   'bg-red-500/8   border-red-500/25   text-red-300',
    amber: 'bg-amber-500/8 border-amber-500/25 text-amber-300',
    green: 'bg-emerald-500/6 border-emerald-500/20 text-emerald-300',
  }[kind];

  const dot = {
    red:   'bg-red-400',
    amber: 'bg-amber-400 anet-brand-pulse',
    green: 'bg-emerald-400',
  }[kind];

  return (
    <div
      role="status"
      className={`anet-health-banner sticky top-0 z-30 border-b ${styles} pl-14 pr-3 sm:pl-14 sm:pr-6 lg:px-6 py-1.5 text-[12px] flex items-center justify-between gap-3 backdrop-blur-sm`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} aria-hidden />
        <span className="truncate">{message}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {cta && (
          <Link
            href={cta.href}
            className="text-[11px] font-medium underline-offset-2 hover:underline opacity-90 hover:opacity-100 hidden sm:inline"
          >
            {cta.label} →
          </Link>
        )}
        {/* R9 of #190 mobile polish: the inline `→` CTA and the `×`
            dismiss were ~14px tap targets — below iOS 44px and worst
            for the right-edge dismiss where a thumb-miss either does
            nothing or fires the CTA next to it. The banner is
            intentionally 28px tall (design comment above), so make the
            tap area larger without making the banner taller: an
            invisible `::before` pseudo-element extends the hit zone to
            ~44×40px around each control. Visual size stays as is. */}
        {cta && (
          <Link
            href={cta.href}
            aria-label={cta.label}
            className="sm:hidden text-[12px] font-medium opacity-90 hover:opacity-100 relative leading-none px-1.5 before:absolute before:inset-y-[-10px] before:inset-x-[-8px] before:content-['']"
          >
            →
          </Link>
        )}
        <button
          onClick={() => {
            setDismissed(true);
            try { sessionStorage.setItem('anet-hb-dismissed', '1'); } catch {}
          }}
          aria-label="Dismiss banner"
          className="opacity-60 hover:opacity-100 leading-none px-1.5 text-base relative rounded-md hover:bg-[var(--hover-tint)] before:absolute before:inset-y-[-10px] before:inset-x-[-8px] before:content-['']"
        >
          ×
        </button>
      </div>
    </div>
  );
}
