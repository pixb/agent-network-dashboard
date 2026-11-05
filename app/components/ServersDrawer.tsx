'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';

/** Issue #119 — server-side panel listing the hub's hosts + CPU/RAM bars.
 *
 * Steps 1+2 (SDK马 host telemetry + CommHub aggregation) shipped with
 * commhub-server v0.8.1-preview.2. Step 3 (this file, Round 20 of the
 * dashboard /loop) swaps the original mock seed for a SWR fetch of
 * `/api/hub/servers` (which proxies to the hub's `/api/servers`).
 *
 * Collapsed by default to a thin vertical icon strip so it never competes
 * with the topology graph for horizontal real-estate. State persists to
 * localStorage just like the other dashboard drawers.
 *
 * Backward-compat: if the upstream hub predates v0.8.1-preview.2 the
 * proxy returns `{ servers: [], unavailable: true }`. The drawer
 * surfaces a friendly "not yet available" hint instead of an empty list,
 * so old hubs don't read as "something broke".
 */

interface ServerAgent {
  alias: string;
  runtime: string | null;
  status: 'working' | 'idle' | 'offline';
  last_seen_at?: string | null;
  progress?: number | null;  // 0..1
}

interface ServerCard {
  hostname: string;
  ip?: string | null;
  cpu_load_1min: number | null;
  cpu_cores: number;
  mem_used_gb: number | null;
  mem_total_gb: number | null;
  /** Hero 1 v0.10.0: disk usage. Optional — older hubs don't report. */
  disk_used_gb?: number | null;
  disk_total_gb?: number | null;
  /** Hero 1 v0.10.0: short history for sparklines (5-min sliding window).
   *  Each is the rolling 1-min average sampled at ~30s cadence (so ~10
   *  data points for 5-min). Optional — older hubs don't report. */
  cpu_history?: number[];
  mem_history?: number[];
  /** v0.10.2 RFC-014 — disk usage 5-min rolling history. Optional;
   *  older agent-node (< 2.4.1-preview.0) doesn't ship it. */
  disk_history?: number[];
  /** Hero 2 v0.10.0: per-server agent rollup. Optional — older hubs
   *  send only aggregate agent_count. */
  agents?: ServerAgent[];
  agent_count: number;
  status: 'online' | 'offline';
  note?: string;
}

interface ServersResponse {
  servers: ServerCard[];
  unavailable?: boolean;
}

const fetcher = async (url: string): Promise<ServersResponse> => {
  const res = await fetch(url);
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.assign('/login');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`hub ${res.status}`);
  return res.json();
};

// Bar tint by usage — green ≤60%, amber 60–85%, red >85%. Keeps the eye
// going to whichever box is actually about to tip over.
function barTint(pct: number) {
  if (pct >= 85) return { fill: '#ef4444', track: 'rgb(239 68 68 / 0.16)' };
  if (pct >= 60) return { fill: '#f59e0b', track: 'rgb(245 158 11 / 0.16)' };
  return { fill: '#10b981', track: 'rgb(16 185 129 / 0.16)' };
}

function Bar({ pct, label }: { pct: number; label: string }) {
  const t = barTint(pct);
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[11px] text-[var(--fg-muted)] font-mono">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(clamped)}%</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: t.track }}>
        <div
          className="h-full transition-[width] duration-300 ease-out"
          style={{ width: `${clamped}%`, background: t.fill }}
        />
      </div>
    </div>
  );
}

/** Hero 1 v0.10.0 — inline SVG sparkline for 5-min rolling history.
 *  Zero-dep (no recharts). Renders a stroked polyline + filled area.
 *  Values are percentages (0..100); clamps inside. */
function Sparkline({ values, tint, label }: { values: number[]; tint: string; label: string }) {
  if (!values || values.length < 2) return null;
  const w = 100, h = 18;
  const max = 100;
  const stride = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * stride;
    const y = h - (Math.max(0, Math.min(max, v)) / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const polyline = pts.join(' ');
  const area = `M0,${h} L${pts.join(' L')} L${w},${h} Z`;
  return (
    <svg
      width="100%" height={h} viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none" aria-label={`${label} 5-min history`}
      data-server-sparkline={label}
    >
      <path d={area} fill={tint} opacity="0.18" />
      <polyline points={polyline} fill="none" stroke={tint} strokeWidth="1.2" />
    </svg>
  );
}

/** Hero 1 v0.10.0 — single health badge derived from the worst of
 *  CPU / Mem / Disk percentages. Green ≤60%, amber 60-85%, red >85%
 *  (same thresholds as Bar). Returns null when no percentages available
 *  (e.g. offline server) so the card layout reads "n/a · offline" instead. */
function HealthBadge({ cpu, mem, disk }: { cpu: number | null; mem: number | null; disk: number | null }) {
  const vals = [cpu, mem, disk].filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return null;
  const worst = Math.max(...vals);
  const t = barTint(worst);
  const status = worst >= 85 ? 'red' : worst >= 60 ? 'amber' : 'green';
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: t.fill, boxShadow: `0 0 0 2px ${t.track}` }}
      data-server-health-badge={status}
      title={`worst: ${Math.round(worst)}%`}
    />
  );
}

/** Hero 2 v0.10.0 — per-server expandable agent list. Renders compact
 *  rows: alias · runtime · status chip · last_seen relative. progress
 *  bar appears when an agent reports progress (0..1). When the upstream
 *  hub doesn't report agents[], the row falls through to a small
 *  "agent list pending hub upgrade" hint. */
function AgentList({ agents }: { agents?: ServerAgent[] }) {
  if (!agents || agents.length === 0) {
    return (
      <div className="text-[9px] text-[var(--fg-dim)] font-mono italic px-1 py-1" data-server-agents-missing="true">
        {/* #157 fix — copy update. Pre-#157 the placeholder read
            "agent rollup pending hub ≥ 0.8.2-preview". commhub-server@
            0.8.2 is LIVE in prod (Vincent screenshot 5560 verified) but
            still doesn't ship `agents[]`. Version-specific text was
            misleading — implied upgrade-needed when hub already
            crossed the threshold. New copy drops the version pinning
            and just states the data-shape: hub hasn't reported the
            agent rollup for this server (could be hub-side feature
            gap or session-source gap). data-server-agents-missing
            attr surfaces the gate for tests. */}
        agent rollup not reported by hub
      </div>
    );
  }
  return (
    <ul className="space-y-1" data-server-agent-list>
      {agents.map(a => {
        const statusColor =
          a.status === 'working' ? '#10b981' :
          a.status === 'idle'    ? '#06b6d4' : '#6b7280';
        return (
          <li
            key={a.alias}
            className="flex items-center gap-1.5 text-[11px] font-mono"
            data-server-agent={a.alias}
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor }} />
            <span className="font-semibold truncate" style={{ color: 'var(--fg)' }}>{a.alias}</span>
            {a.runtime && (
              <span className="text-[9px] text-[var(--fg-dim)] shrink-0">· {a.runtime}</span>
            )}
            {typeof a.progress === 'number' && a.progress > 0 && (
              <span className="ml-auto text-[9px] tabular-nums text-[var(--fg-muted)]">
                {Math.round(a.progress * 100)}%
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function useServers(enabled = true) {
  const { data, error } = useSWR<ServersResponse>(
    enabled ? '/api/hub/servers' : null,
    fetcher,
    { refreshInterval: 5000, dedupingInterval: 3000 },
  );
  const servers = data?.servers ?? [];
  const unavailable = data?.unavailable === true;
  const onlineCount = servers.filter(s => s.status === 'online').length;
  const loading = enabled && !data && !error;
  return { data, error, servers, unavailable, onlineCount, loading };
}

export function ServersPanel({ enabled = true, className = '' }: { enabled?: boolean; className?: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem('anet-servers-drawer-expanded');
      // Expanded server rows are a client-only sticky preference; hydrate once
      // after mount so SSR stays deterministic.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setExpanded(new Set(JSON.parse(raw)));
    } catch {}
  }, []);
  const toggleExpanded = (hostname: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(hostname)) next.delete(hostname); else next.add(hostname);
    try { localStorage.setItem('anet-servers-drawer-expanded', JSON.stringify([...next])); } catch {}
    return next;
  });

  const { data, error, servers, unavailable, loading } = useServers(enabled);

  return (
    <div className={`min-h-0 overflow-y-auto px-2 py-2 space-y-2 ${className}`} data-servers-body>
      {loading && (
        <div className="text-[11px] text-[var(--fg-muted)] font-mono text-center py-4">
          loading servers…
        </div>
      )}
      {error && !data && (
        <div className="rounded-md border px-2.5 py-2 text-[11px] font-mono"
          style={{ background: 'rgb(239 68 68 / 0.06)', borderColor: 'rgb(239 68 68 / 0.25)', color: '#ef4444' }}>
          hub unreachable · retrying every 5s
        </div>
      )}
      {unavailable && (
        <div className="text-[11px] text-[var(--fg-muted)] font-mono text-center py-3 leading-relaxed">
          host telemetry not available<br/>
          <span className="text-[var(--fg-dim)]">upgrade commhub-server ≥ 0.8.1-preview.2</span>
        </div>
      )}
      {!loading && !error && !unavailable && servers.length === 0 && (
        <div className="text-[11px] text-[var(--fg-muted)] font-mono text-center py-4">
          no servers reporting yet
        </div>
      )}
      {servers.map(s => {
        const offline = s.status === 'offline';
        const cpuPct = s.cpu_load_1min != null && s.cpu_cores > 0 ? (s.cpu_load_1min / s.cpu_cores) * 100 : null;
        const memPct = s.mem_used_gb != null && s.mem_total_gb != null && s.mem_total_gb > 0 ? (s.mem_used_gb / s.mem_total_gb) * 100 : null;
        const diskPct = s.disk_used_gb != null && s.disk_total_gb != null && s.disk_total_gb > 0 ? (s.disk_used_gb / s.disk_total_gb) * 100 : null;
        const isExpanded = expanded.has(s.hostname);
        return (
          <div
            key={s.hostname}
            className="rounded-lg px-2.5 py-2 space-y-1.5"
            style={{
              background: 'var(--bg)',
              opacity: offline ? 0.55 : 1,
            }}
            data-server-card={s.hostname}
            data-server-expanded={isExpanded ? 'true' : 'false'}
            title={s.ip ? `${s.hostname} · ${s.ip}` : s.hostname}
          >
            {/* v0.10.0 Hero 1+2: header row — click toggles expanded
                detail view (sparklines + disk + agent rollup). */}
            <button
              type="button"
              onClick={() => toggleExpanded(s.hostname)}
              aria-expanded={isExpanded}
              className="w-full flex items-center justify-between gap-2 text-left"
              data-server-card-toggle={s.hostname}
            >
              <div className="min-w-0 flex items-center gap-1.5">
                {/* Hero 1 health badge — worst-of CPU/Mem/Disk */}
                {!offline && <HealthBadge cpu={cpuPct} mem={memPct} disk={diskPct} />}
                <span className="font-mono text-[12px] font-semibold truncate" style={{ color: 'var(--fg)' }}>{s.hostname}</span>
                {s.note && <span className="text-[9px] text-[var(--fg-muted)]">({s.note})</span>}
              </div>
              <span className="flex items-center gap-1 shrink-0">
                <span className="text-[11px] text-[var(--fg-muted)] font-mono tabular-nums">
                  {s.agent_count}&nbsp;agent{s.agent_count === 1 ? '' : 's'}
                </span>
                {/* Chevron — rotates 90° on expanded */}
                <svg
                  width="10" height="10" viewBox="0 0 10 10"
                  style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease-out' }}
                  aria-hidden
                >
                  <path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
            {!offline && cpuPct != null && (
              <Bar pct={cpuPct} label={`CPU ${s.cpu_load_1min!.toFixed(2)}/${s.cpu_cores}`} />
            )}
            {!offline && memPct != null && (
              <Bar pct={memPct} label={`RAM ${s.mem_used_gb!.toFixed(1)}/${s.mem_total_gb!.toFixed(1)}G`} />
            )}
            {offline && (
              <div className="text-[11px] text-[var(--fg-dim)] font-mono italic">CPU n/a · RAM n/a · offline</div>
            )}
            {/* v0.10.0 Hero 1+2: expanded detail — disk bar +
                5-min sparklines + agent rollup. Visible only when
                the user clicks the card. Renders gracefully when
                upstream hub hasn't shipped optional fields. */}
            {isExpanded && !offline && (
              <div className="pt-1 mt-1 border-t space-y-1.5" style={{ borderColor: 'var(--border)' }}>
                {diskPct != null ? (
                  <Bar pct={diskPct} label={`DISK ${s.disk_used_gb!.toFixed(1)}/${s.disk_total_gb!.toFixed(1)}G`} />
                ) : (
                  /* #157 sibling fix — same misleading version-pin copy
                     dropped at the disk-metric placeholder. Same
                     rationale as the agent-rollup copy above. */
                  <div className="text-[9px] text-[var(--fg-dim)] font-mono italic" data-server-disk-missing="true">disk metric not reported by hub</div>
                )}
                {s.cpu_history && s.cpu_history.length >= 2 && (
                  <div className="space-y-0.5">
                    <div className="text-[9px] text-[var(--fg-muted)] font-mono">CPU · 5-min</div>
                    <Sparkline values={s.cpu_history} tint="#10b981" label="CPU" />
                  </div>
                )}
                {s.mem_history && s.mem_history.length >= 2 && (
                  <div className="space-y-0.5">
                    <div className="text-[9px] text-[var(--fg-muted)] font-mono">RAM · 5-min</div>
                    <Sparkline values={s.mem_history} tint="#06b6d4" label="MEM" />
                  </div>
                )}
                {/* v0.10.2 RFC-014 §7 close gate #3 — disk usage
                   5-min curve. Amber tint matches the disk bar
                   tier convention (DISK > CPU/Mem in alert-
                   priority hierarchy since disk-full is a hard
                   failure mode). Render only when agent-node
                   2.4.1-preview.0+ has shipped disk_history;
                   backward-compat handles older agents silently
                   (no sparkline, no broken state). */}
                {s.disk_history && s.disk_history.length >= 2 && (
                  <div className="space-y-0.5">
                    <div className="text-[9px] text-[var(--fg-muted)] font-mono">DISK · 5-min</div>
                    <Sparkline values={s.disk_history} tint="#f59e0b" label="DISK" />
                  </div>
                )}
                <div className="pt-1">
                  <div className="text-[9px] text-[var(--fg-muted)] font-mono mb-0.5">agents</div>
                  <AgentList agents={s.agents} />
                </div>
              </div>
            )}
          </div>
        );
      })}
      {servers.length > 0 && (
        <div className="pt-1 text-[9px] text-[var(--fg-dim)] font-mono text-center">
          live · refreshing every 5s
        </div>
      )}
    </div>
  );
}

export function ServersDrawer() {
  const [open, setOpen] = useState(false);
  // Drawer state is per-user-machine — persist like the other dashboard
  // sticky toggles (`anet-topo-layout`, `anet-topo-view`, etc.).
  useEffect(() => {
    // Drawer openness is persisted in localStorage and can only be restored on
    // the client after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { if (localStorage.getItem('anet-servers-drawer') === '1') setOpen(true); } catch {}
  }, []);
  const toggle = () => setOpen(prev => {
    const next = !prev;
    try { localStorage.setItem('anet-servers-drawer', next ? '1' : '0'); } catch {}
    return next;
  });

  // Round 20 / #119 step 3 final delivery — real SWR fetch. 5s refresh
  // matches the other live drawers (HealthBanner, Sidebar) so an operator
  // sees host telemetry update in roughly the same beat as session state.
  // Only poll while expanded — collapsed icon strip doesn't need fresh data.
  const { servers, onlineCount } = useServers(open);

  return (
    <aside
      className="fixed right-0 top-20 z-40 hidden lg:flex flex-col rounded-l-xl border border-r-0 shadow-xl shadow-black/30 anet-fade-in"
      style={{
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
        width: open ? 296 : 40,
        maxHeight: 'calc(100vh - 6rem)',
        transition: 'width 200ms ease-out',
      }}
      aria-label="Servers panel"
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? 'Collapse servers panel' : 'Expand servers panel'}
        className="flex items-center gap-2 px-2.5 py-2 border-b text-[11px] font-semibold tracking-wide select-none"
        style={{ color: 'var(--fg)', borderColor: 'var(--border)' }}
      >
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="6" rx="1.5" />
          <rect x="3" y="14" width="18" height="6" rx="1.5" />
          <circle cx="7" cy="7" r="0.7" fill="currentColor" />
          <circle cx="7" cy="17" r="0.7" fill="currentColor" />
        </svg>
        {open && (
          <>
            <span className="flex-1 text-left">Servers</span>
            <span className="text-[11px] text-[var(--fg-muted)] font-mono">{onlineCount}/{servers.length}</span>
          </>
        )}
      </button>

      {open && (
        <ServersPanel enabled={open} className="flex-1" />
      )}
    </aside>
  );
}
