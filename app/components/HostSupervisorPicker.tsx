'use client';

import { useEffect, useState } from 'react';

/**
 * PR4 #338 — host_supervisor daemon picker (RFC-026 §9.4 locked mockup).
 *
 * Three states (the only branching the wizard ever sees):
 *
 *   count=0  → onboarding: explain what a daemon is + give the install command.
 *              No daemon = nothing to dispatch to; create flow is blocked here
 *              until the user runs `anet daemon init <name>` somewhere.
 *
 *   count=1  → auto-pick: just show "using <alias>" + a quiet `换一个 →` link
 *              (which switches to the picker view if the user really wants).
 *
 *   count≥2  → picker grid: cards for each daemon w/ runtimes + alert chip,
 *              click selects. Desktop = up to 3 columns; mobile = single column.
 *
 * Data shape mirrors `/api/anet/host-supervisors`, which in turn mirrors the
 * hub's GET /api/host-supervisors (#338 PR2 — needs commhub-server@0.9.0-preview.8+).
 * On `unconfirmed` (older hub), we degrade honestly to an upgrade hint — never
 * show a fake empty list. Per 「文档宣称的能力必须对着代码路径逐条验证」这条判据.
 */

export interface DaemonOption {
  // Hub canonical key is `daemon_node_id` (PR2 v2 §9.2 contract). We keep the
  // same name end-to-end so the value the wizard passes back to create_node
  // as `daemon_node_id` doesn't need a rename layer.
  daemon_node_id: string;
  alias: string;
  hostname?: string | null;
  online?: boolean;
  last_seen_at?: string | null;
  runtimes_supported?: string[];
  host_telemetry?: {
    alert_level?: 'green' | 'yellow' | 'red' | 'gray';
    cpu_cores?: number | null;
    mem_gb?: number | null;
    ip_internal?: string | null;
  };
}

interface HostOption {
  hostname: string;
  status?: 'online' | 'offline';
  daemon: DaemonOption | null;
  has_daemon: boolean;
}

interface PickResponse {
  ok: boolean;
  unconfirmed?: boolean;
  error?: string;
  count: number;
  daemons: DaemonOption[];
  hosts?: HostOption[];
  selected?: string | null;
}

type LoadState = 'loading' | 'ready' | 'error' | 'unconfirmed';

export function HostSupervisorPicker({
  networkId,
  value,
  onChange,
}: {
  networkId?: string | null;
  value: string | null;
  // (#338 wizard-runtime-filter) passes the full daemon row alongside the
  // id so the wizard can filter the Runtime step by daemon.runtimes_supported
  // — disabling combos the hub would reject anyway and surfacing why upfront.
  onChange: (nodeId: string | null, daemon: DaemonOption | null) => void;
}) {
  const [state, setState] = useState<LoadState>('loading');
  const [daemons, setDaemons] = useState<DaemonOption[]>([]);
  const [hosts, setHosts] = useState<HostOption[]>([]);
  const [errMsg, setErrMsg] = useState('');
  const [forcePicker, setForcePicker] = useState(false);

  useEffect(() => {
    let alive = true;
    setState('loading');
    setErrMsg('');
    const url = networkId
      ? `/api/anet/host-supervisors?network_id=${encodeURIComponent(networkId)}`
      : '/api/anet/host-supervisors';
    fetch(url, { cache: 'no-store' })
      .then(r => r.json().then(d => ({ status: r.status, body: d as PickResponse })))
      .then(({ status, body }) => {
        if (!alive) return;
        if (status === 501 || body?.unconfirmed) {
          setState('unconfirmed');
          setErrMsg(body?.error || 'hub /api/host-supervisors unavailable — upgrade to >=0.9.0-preview.8');
          setDaemons([]);
          setHosts([]);
          return;
        }
        if (!body?.ok) {
          setState('error');
          setErrMsg(body?.error || `hub ${status}`);
          setDaemons([]);
          setHosts([]);
          return;
        }
        const list = Array.isArray(body.daemons) ? body.daemons : [];
        const hostList = Array.isArray(body.hosts) ? body.hosts : list.map(d => ({
          hostname: d.hostname || d.alias || d.daemon_node_id,
          daemon: d,
          has_daemon: true,
        }));
        setDaemons(list);
        setHosts(hostList);
        setState('ready');
        // count=1 auto-pick: preselect the only daemon. count≥2 leaves the
        // selection to the user (parent value stays null until click).
        if (list.length === 1 && !value) onChange(list[0].daemon_node_id, list[0]);
      })
      .catch(e => {
        if (!alive) return;
        setState('error');
        setErrMsg(e instanceof Error ? e.message : String(e));
        setDaemons([]);
        setHosts([]);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkId]);

  // ───── render branches ──────────────────────────────────────────────

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[#26262b] bg-[#0e0e10] px-3 py-3 text-xs text-gray-500">
        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        正在查询可用的 host_supervisor 节点…
      </div>
    );
  }

  if (state === 'unconfirmed') {
    return (
      <div className="rounded-md border border-amber-700/40 bg-amber-900/10 px-3 py-3 text-xs text-amber-200">
        <div className="font-semibold mb-1">hub 暂未升级</div>
        <div className="text-amber-200/80">{errMsg}</div>
        <div className="mt-1 text-[11px] text-amber-200/60">
          升级到 <code className="rounded bg-[var(--code-bg)] px-1 py-0.5">@sleep2agi/commhub-server@0.9.0-preview.8</code> 后选服务器功能才会出现。
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="rounded-md border border-red-700/40 bg-red-900/10 px-3 py-3 text-xs text-red-200">
        查询 host_supervisor 节点失败：{errMsg}
      </div>
    );
  }

  // count=0 — onboarding
  if (daemons.length === 0 && hosts.length === 0) {
    return (
      <div className="rounded-md border border-[#26262b] bg-[#0e0e10] px-3 py-4 text-xs text-gray-300">
        <div className="text-sm font-semibold text-gray-200">还没有可用的 host_supervisor 节点</div>
        <p className="mt-1 text-gray-500">
          要在某台机器上创建节点，先在那台机器上跑一次 daemon 初始化命令：
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-[var(--code-bg)] p-2 text-[11px] text-[var(--code-fg)]">{`# 任选一台目标机器（你的笔记本 / 一台服务器都行）
anet daemon up my-daemon`}</pre>
        <p className="mt-2 text-gray-500">
          注册成功后这里会自动出现，无需刷新。
        </p>
      </div>
    );
  }

  // count=1 — auto-pick (collapsed). User can opt into picker via "换一个 →".
  if (daemons.length === 1 && hosts.length === 1 && !forcePicker) {
    const d = daemons[0];
    return (
      <div className="rounded-md border border-cyan-700/40 bg-cyan-900/10 px-3 py-3 text-xs text-cyan-100">
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-cyan-400/80">将在</span>{' '}
            <span className="font-semibold">{d.alias}</span>
            <span className="text-cyan-300/60"> ({d.hostname || '—'}) </span>
            <span className="text-cyan-400/80">上创建</span>
          </div>
          {/* Single-daemon networks can still let the user enter picker view; */}
          {/* useful if they want to see telemetry before committing. */}
          <button
            type="button"
            onClick={() => setForcePicker(true)}
            className="text-[11px] text-cyan-400 hover:text-cyan-200 underline-offset-2 hover:underline"
          >
            详情 →
          </button>
        </div>
        <RuntimeList runtimes={d.runtimes_supported} className="mt-1" />
      </div>
    );
  }

  // count≥2 (or forcePicker=true) — grid picker. Desktop up to 3 columns,
  // mobile = single column. Locked per RFC-026 §9.4 mockup.
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>选择一台服务器（{daemons.length} 台 daemon 在线）</span>
        {forcePicker && daemons.length === 1 && hosts.length === 1 && (
          <button
            type="button"
            onClick={() => setForcePicker(false)}
            className="text-[11px] text-gray-500 hover:text-gray-300"
          >
            ← 折叠
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
        {hosts.map(h => (
          <HostCard
            key={h.hostname}
            host={h}
            selected={Boolean(h.daemon && h.daemon.daemon_node_id === value)}
            onPick={() => h.daemon && onChange(h.daemon.daemon_node_id, h.daemon)}
          />
        ))}
      </div>
    </div>
  );
}

// ───── subcomponents ──────────────────────────────────────────────────

function HostCard({
  host,
  selected,
  onPick,
}: {
  host: HostOption;
  selected: boolean;
  onPick: () => void;
}) {
  const daemon = host.daemon;
  const alert = daemon?.host_telemetry?.alert_level || (host.status === 'online' ? 'green' : 'gray');
  return (
    <div
      className={`flex w-full flex-col gap-1.5 rounded-md border px-3 py-2.5 text-left text-xs transition-colors ${
        selected
          ? 'border-cyan-600 bg-cyan-900/15 text-cyan-100'
          : 'border-[#26262b] bg-[#0e0e10] text-gray-300 hover:border-[#3a3a41]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold">{host.hostname}</span>
        <AlertChip level={alert} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
        <span>{host.status === 'online' ? 'online' : host.status === 'offline' ? 'offline' : 'status unknown'}</span>
      </div>
      {daemon ? (
        <>
          <div className="truncate text-[11px] text-gray-500">daemon: {daemon.alias}</div>
          <RuntimeList runtimes={daemon.runtimes_supported} />
          <button
            type="button"
            onClick={onPick}
            aria-pressed={selected}
            className="mt-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium"
            style={{
              background: selected ? '#0891b2' : '#1c1c1f',
              color: selected ? '#ffffff' : '#67e8f9',
            }}
          >
            {selected ? '已选择这台服务器' : '在这台服务器创建'}
          </button>
        </>
      ) : (
        <div
          className="mt-1 rounded-md border px-2 py-2"
          style={{ borderColor: 'rgb(245 158 11 / 0.35)', background: 'rgb(245 158 11 / 0.10)', color: '#fef3c7' }}
        >
          <div className="font-semibold">无 daemon，不能在这里创建节点</div>
          <div className="mt-0.5 text-[11px]" style={{ color: 'rgb(253 230 138 / 0.75)' }}>
            去这台服务器的终端安装并启动 daemon 后再回来选择。
          </div>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(`anet daemon up ${host.hostname}-daemon`).catch(() => {})}
            className="mt-2 rounded-md px-2 py-1 text-[11px] font-medium"
            style={{ background: 'rgb(217 119 6 / 0.20)', color: '#fde68a' }}
          >
            复制安装命令
          </button>
        </div>
      )}
    </div>
  );
}

function RuntimeList({ runtimes, className = '' }: { runtimes?: string[]; className?: string }) {
  if (!runtimes || runtimes.length === 0) {
    return <div className={`text-[11px] text-gray-600 ${className}`}>runtimes_supported: —</div>;
  }
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {runtimes.map(r => (
        <span key={r} className="rounded bg-[#1c1c1f] px-1.5 py-0.5 text-[11px] text-gray-400">{r}</span>
      ))}
    </div>
  );
}

function AlertChip({ level }: { level: 'green' | 'yellow' | 'red' | 'gray' }) {
  const cls = {
    green: 'bg-green-600/20 text-green-300 border-green-700/40',
    yellow: 'bg-amber-600/20 text-amber-300 border-amber-700/40',
    red: 'bg-red-600/20 text-red-300 border-red-700/40',
    gray: 'bg-gray-600/20 text-gray-400 border-gray-700/40',
  }[level];
  const label = { green: '正常', yellow: '注意', red: '警报', gray: '离线' }[level];
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${cls}`}>{label}</span>
  );
}
