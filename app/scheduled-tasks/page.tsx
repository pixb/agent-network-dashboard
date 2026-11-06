'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNetworkId } from '../lib/network-context';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin-match';
import { isHubTimeStale, relativeAgo } from '../lib/time';
import { scrollMainTop } from '../lib/main-scroll';

type NodeRow = { node_id: string; alias?: string | null; node_name?: string | null; lifecycle_state?: string | null; updated_at?: string | null };

const nodeLabel = (n: NodeRow) => `${n.alias} · ${n.node_id.slice(0, 12)}`;

/** The fleet has ~200 nodes, so the native <select> this replaces meant
 *  scrolling a 200-row popup to find one. Type to filter instead — by alias
 *  (pinyin and initials work, same helper the node list uses) or by node id,
 *  which is the half you can actually paste from a task or a log line. */
function NodePicker({ nodes, value, onChange }: {
  nodes: NodeRow[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pinyinReady = usePinyinReady();

  const selected = nodes.find(n => n.node_id === value);
  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return nodes;
    return nodes.filter(n =>
      n.node_id.toLowerCase().includes(q.toLowerCase()) ||
      pinyinMatch(n.alias || '', q));
    // pinyinReady is not read here on purpose: it is a re-render trigger for
    // when the dict finishes loading mid-typing, so a query typed before the
    // lazy load lands still re-filters once it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, query, pinyinReady]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 陈旧的排到后面。原因见 app/lib/time.ts 的 NODE_STALE_MS 注释:
  // 生产上约三分之二的条目是几个月前的死会话,而 lifecycle_state 全是 "active",
  // 所以不排序的话,一屏里最先看到的往往都是幽灵。
  // 只降权不隐藏 —— 给一个临时掉线的节点排任务是合法操作,藏起来会让人以为节点没了。
  const ordered = useMemo(() => {
    const stale = (n: NodeRow) => (isHubTimeStale(n.updated_at) ? 1 : 0);
    return [...matches].sort((a, b) => stale(a) - stale(b));
  }, [matches]);

  return (
    <div className="relative mt-1" ref={boxRef}>
      <input
        data-testid="schedule-node-picker-input"
        value={open ? query : (selected ? nodeLabel(selected) : '')}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setQuery(''); setOpen(true); }}
        placeholder="搜索节点（别名/拼音/node_id）"
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]"
      />
      {open && (
        <div
          role="listbox"
          data-testid="schedule-node-picker-panel"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--col-inset)] py-1 shadow-lg"
        >
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[var(--fg-dim)]">无匹配节点</div>
          ) : ordered.map(n => (
            <button
              key={n.node_id}
              type="button"
              role="option"
              aria-selected={n.node_id === value}
              data-testid="schedule-node-option"
              onClick={() => { onChange(n.node_id); setQuery(''); setOpen(false); }}
              className={`block w-full px-3 py-2 text-left text-sm ${
                n.node_id === value ? 'text-[var(--hl)]' : 'text-[var(--fg)]'
              } hover:bg-[var(--hover-tint)]`}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className={isHubTimeStale(n.updated_at) ? 'text-[var(--fg-dim)]' : ''}>
                  {nodeLabel(n)}
                </span>
                {/* 最后活动时间。这是 /api/nodes 里唯一能分辨死活的字段 ——
                    lifecycle_state 对三个月没动的节点同样返回 "active"(#751)。 */}
                {relativeAgo(n.updated_at) && (
                  <span
                    data-testid="schedule-node-option-lastseen"
                    className={`shrink-0 text-xs tabular-nums ${
                      isHubTimeStale(n.updated_at) ? 'text-[var(--fg-dim)]' : 'text-[var(--fg)]'
                    }`}
                  >
                    {relativeAgo(n.updated_at)}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
type ScheduleSpec =
  | { type: 'once'; run_at: string }
  | { type: 'interval'; every_seconds: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; time: string; weekdays: number[] };
type ScheduleRow = {
  schedule_id: string;
  name: string;
  target_node_id: string;
  target_alias: string;
  task_content: string;
  priority: string;
  schedule: ScheduleSpec;
  timezone: string;
  misfire_policy?: 'catch_up_once' | 'skip';
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  next_run_at?: string | null;
  last_run_at?: string | null;
  revision: number;
};
type RunRow = { run_id: string; scheduled_for: string; task_id?: string | null; status: string; error_code?: string | null; created_at: string };
type RunHistoryState = { status: 'loading' } | { status: 'ready'; runs: RunRow[] } | { status: 'error'; message: string };
type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function formatTime(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : value;
}

function describeSchedule(spec: ScheduleSpec, timezone: string) {
  if (spec.type === 'once') return `单次 · ${formatTime(spec.run_at)}`;
  if (spec.type === 'interval') {
    if (spec.every_seconds % 86400 === 0) return `每 ${spec.every_seconds / 86400} 天`;
    if (spec.every_seconds % 3600 === 0) return `每 ${spec.every_seconds / 3600} 小时`;
    return `每 ${spec.every_seconds / 60} 分钟`;
  }
  if (spec.type === 'daily') return `每天 ${spec.time} · ${timezone}`;
  return `每周 ${spec.weekdays.map(d => WEEKDAYS[d]).join('、')} ${spec.time} · ${timezone}`;
}

function describeMisfire(policy?: ScheduleRow['misfire_policy']) {
  return policy === 'skip' ? '错过后跳过' : '错过后补跑一次';
}

function toLocalDateTimeInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function intervalFormValue(seconds: number): { every: string; unit: IntervalUnit } {
  if (seconds % 86400 === 0) return { every: String(seconds / 86400), unit: 'days' };
  if (seconds % 3600 === 0) return { every: String(seconds / 3600), unit: 'hours' };
  if (seconds % 60 === 0) return { every: String(seconds / 60), unit: 'minutes' };
  return { every: String(seconds), unit: 'seconds' };
}

function ScheduleHistory({ networkId, scheduleId }: { networkId: string; scheduleId: string }) {
  const [state, setState] = useState<RunHistoryState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    // A retry starts a new read; only an accepted response may claim an empty history.
    setState({ status: 'loading' });
    const load = async () => {
      try {
        const res = await fetch(`/api/hub/scheduled-tasks/${encodeURIComponent(scheduleId)}/runs?network_id=${encodeURIComponent(networkId)}&limit=50`, {
          cache: 'no-store', signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          if (res.status === 401) throw new Error('登录状态已失效，请重新登录（HTTP 401）');
          const detail = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`;
          throw new Error(`读取执行记录失败：${detail}`);
        }
        if (!data || !Array.isArray(data.runs) || data.runs.some((run: RunRow | null) => !run ||
          typeof run.run_id !== 'string' || typeof run.scheduled_for !== 'string' || typeof run.status !== 'string' ||
          (run.task_id != null && typeof run.task_id !== 'string') || (run.error_code != null && typeof run.error_code !== 'string'))) {
          throw new Error('执行记录响应格式错误，请重试');
        }
        if (current) setState({ status: 'ready', runs: data.runs });
      } catch (e) {
        if (current) setState({ status: 'error', message: e instanceof Error ? e.message : '网络连接失败，请重试' });
      }
    };
    void load();
    // Closing, reopening or switching scopes disposes this request, even when
    // its response has already arrived and abort cannot cancel JSON parsing.
    return () => { current = false; controller.abort(); };
  }, [networkId, scheduleId, attempt]);

  return (
    <div className="mt-4 min-w-0 border-t border-[var(--border)] pt-4" aria-busy={state.status === 'loading'}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[var(--fg)]">执行记录</h3>
        <button type="button" aria-disabled={state.status === 'loading'}
          onClick={() => { if (state.status !== 'loading') setAttempt(value => value + 1); }}
          className="min-h-11 min-w-11 rounded-md px-3 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] aria-disabled:opacity-50">
          {state.status === 'loading' ? '读取中…' : state.status === 'error' ? '重试' : '刷新记录'}
        </button>
      </div>
      {state.status === 'loading' && <p role="status" className="text-sm text-[var(--fg-dim)]">正在读取执行记录…</p>}
      {state.status === 'error' && <p role="alert" className="text-sm text-[var(--danger)] [overflow-wrap:anywhere]">{state.message}</p>}
      {state.status === 'ready' && (state.runs.length === 0 ? <p className="text-sm text-[var(--fg-dim)]">暂无执行记录</p> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[var(--fg-dim)]"><tr><th className="pb-2">计划时间</th><th>状态</th><th>Task ID</th><th>错误</th></tr></thead><tbody>{state.runs.map(run => <tr key={run.run_id} className="border-t border-[var(--col-hairline)] text-[var(--fg-muted)]"><td className="py-2">{formatTime(run.scheduled_for)}</td><td>{run.status}</td><td className="font-mono">{run.task_id?.slice(0, 12) || '—'}</td><td className="text-[var(--danger)]">{run.error_code || '—'}</td></tr>)}</tbody></table></div>
      ))}
    </div>
  );
}

export default function ScheduledTasksPage() {
  const { networkId } = useNetworkId();
  // A network change starts a new page generation before paint, including when
  // two networks expose the same schedule ID. Old list/history reads cannot
  // repopulate the new scope or resurrect a previously expanded row.
  return <ScheduledTasks key={networkId} networkId={networkId} />;
}

function ScheduledTasks({ networkId }: { networkId: string }) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ScheduleRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [targetNodeId, setTargetNodeId] = useState('');
  const [task, setTask] = useState('');
  const [priority, setPriority] = useState('normal');
  const [kind, setKind] = useState<ScheduleSpec['type']>('once');
  const [onceAt, setOnceAt] = useState('');
  const [every, setEvery] = useState('1');
  const [unit, setUnit] = useState<IntervalUnit>('hours');
  const [clock, setClock] = useState('09:00');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [misfirePolicy, setMisfirePolicy] = useState<'catch_up_once' | 'skip'>('catch_up_once');
  const detectedTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [timezone, setTimezone] = useState(detectedTimezone);

  const query = networkId ? `?network_id=${encodeURIComponent(networkId)}` : '';
  const load = useCallback(async () => {
    if (!networkId) {
      setSchedules([]); setNodes([]); setLoading(false); setError('请先在左侧选择一个网络');
      return;
    }
    try {
      const [scheduleRes, nodeRes] = await Promise.all([
        fetch(`/api/hub/scheduled-tasks${query}`, { cache: 'no-store' }),
        fetch(`/api/hub/nodes${query}`, { cache: 'no-store' }),
      ]);
      const scheduleData = await scheduleRes.json();
      const nodeData = await nodeRes.json();
      if (!scheduleRes.ok) throw new Error(scheduleData.message || scheduleData.error || `HTTP ${scheduleRes.status}`);
      if (!nodeRes.ok) throw new Error(nodeData.message || nodeData.error || `HTTP ${nodeRes.status}`);
      setSchedules(scheduleData.schedules || []);
      setNodes((nodeData.nodes || []).filter((n: NodeRow) => n.node_id && n.alias));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [networkId, query]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const makeSchedule = (): ScheduleSpec => {
    if (kind === 'once') return { type: 'once', run_at: new Date(onceAt).toISOString() };
    if (kind === 'interval') {
      const multiplier = unit === 'seconds' ? 1 : unit === 'minutes' ? 60 : unit === 'hours' ? 3600 : 86400;
      return { type: 'interval', every_seconds: Number(every) * multiplier };
    }
    if (kind === 'daily') return { type: 'daily', time: clock };
    return { type: 'weekly', time: clock, weekdays };
  };

  const resetForm = () => {
    setEditing(null); setName(''); setTargetNodeId(''); setTask(''); setPriority('normal');
    setKind('once'); setOnceAt(''); setEvery('1'); setUnit('hours'); setClock('09:00');
    setWeekdays([1]); setMisfirePolicy('catch_up_once'); setTimezone(detectedTimezone);
  };

  const openCreate = () => {
    if (showForm && !editing) { setShowForm(false); resetForm(); return; }
    resetForm(); setShowForm(true); setError('');
  };

  const openEdit = (row: ScheduleRow) => {
    setEditing(row); setName(row.name); setTargetNodeId(row.target_node_id); setTask(row.task_content);
    setPriority(row.priority); setKind(row.schedule.type); setTimezone(row.timezone);
    setMisfirePolicy(row.misfire_policy || 'catch_up_once');
    if (row.schedule.type === 'once') setOnceAt(toLocalDateTimeInput(row.schedule.run_at));
    if (row.schedule.type === 'interval') {
      const value = intervalFormValue(row.schedule.every_seconds);
      setEvery(value.every); setUnit(value.unit);
    }
    if (row.schedule.type === 'daily') setClock(row.schedule.time);
    if (row.schedule.type === 'weekly') { setClock(row.schedule.time); setWeekdays(row.schedule.weekdays); }
    setShowForm(true); setError('');
    scrollMainTop('smooth');
  };

  const saveSchedule = async () => {
    setBusy(true); setError('');
    try {
      const path = editing
        ? `/api/hub/scheduled-tasks/${encodeURIComponent(editing.schedule_id)}${query}`
        : '/api/hub/scheduled-tasks';
      const res = await fetch(path, {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editing ? { revision: editing.revision } : { network_id: networkId }),
          name, target_node_id: targetNodeId, task, priority, timezone,
          misfire_policy: misfirePolicy, schedule: makeSchedule(),
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.error === 'revision_conflict') {
        setShowForm(false); resetForm(); await load();
        setError('计划已在其他设备更新，已刷新最新内容，请重新编辑。');
        return;
      }
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      setShowForm(false); resetForm();
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const mutate = async (row: ScheduleRow, action: 'toggle' | 'run' | 'cancel') => {
    // Cancel goes through POST /cancel, not DELETE. Some reverse proxies
    // strip or 405 DELETE, which surfaces as HTML from the proxy layer — and
    // that HTML then blew up `await res.json()` with "Unexpected token <",
    // hiding the actual failure from the user. See dispatch task 08342434.
    if (action === 'cancel' && typeof window !== 'undefined' && !window.confirm('确定取消这个定时计划？取消后不能恢复。')) return;
    setBusy(true); setError('');
    try {
      let path = `/api/hub/scheduled-tasks/${encodeURIComponent(row.schedule_id)}${query}`;
      let init: RequestInit;
      if (action === 'run') {
        path = `/api/hub/scheduled-tasks/${encodeURIComponent(row.schedule_id)}/run-now${query}`;
        init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
      } else if (action === 'cancel') {
        path = `/api/hub/scheduled-tasks/${encodeURIComponent(row.schedule_id)}/cancel${query}`;
        init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
      } else init = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: row.revision, status: row.status === 'active' ? 'paused' : 'active' }) };
      // Parse as text first so an empty body or an HTML error page (from a
      // misbehaving proxy) doesn't throw "Unexpected token <" before we ever
      // look at the status code. Empty body ⇒ {}; JSON parse errors surface
      // with the status + first chunk of the body so we know which layer
      // returned the non-JSON.
      type MutateResponse = { error?: string; message?: string; ok?: boolean };
      // 🔴 变量名保持 `res` / `raw`。tests/scheduled-tasks-module.test.mjs:30 那条
      //    契约检查断言的是源码里出现 `await res.text()` 和 `JSON.parse(raw)` ——
      //    我第一版把它们改名成 r / body，行为完全一样，但那条检查当场转红。
      //    正确的处理是改回名字，不是去放宽那条检查:它断言的东西是对的，
      //    我改的只是无关的命名。
      const send = async (p: string, i: RequestInit) => {
        const res = await fetch(p, i);
        const raw = await res.text();
        let parsed: MutateResponse = {};
        if (raw.trim().length > 0) {
          try { parsed = JSON.parse(raw) as MutateResponse; }
          catch {
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 120)}`);
          }
        }
        return { res, data: parsed };
      };

      let { res, data } = await send(path, init);

      // 🔴 老 hub 上没有 POST /cancel，回落到 DELETE。
      //
      //   服务端那条 POST 路由是 2026-08-18 才进 main 的（commit 40872732
      //   "accept POST /cancel alongside DELETE, both idempotent"）。而当天
      //   已发布的两个通道都早于它：
      //     commhub-server@latest  = 0.8.8            发布 2026-06-24
      //     commhub-server@preview = 0.9.0-preview.29 发布 2026-08-12
      //   （核过已发布产物：里面的 `/cancel` 全是注释和标识符里的子串，没有路由。）
      //
      //   所以只发 POST 不留兜底，会让"取消"在**今天所有已部署的 hub 上**直接坏掉。
      //   回落只认 404/405（路由不存在 / 方法不允许），不认 5xx —— 5xx 说明路由在、
      //   但服务端出错了，那时重试 DELETE 只会掩盖真正的失败。
      //
      //   两条路径都是幂等的（见上面那个 commit 的标题），所以即使 POST 其实已经
      //   生效、只是因为别的原因返回了 404，再发一次 DELETE 也不会造成二次伤害。
      if (action === 'cancel' && (res.status === 404 || res.status === 405)) {
        const legacyPath = `/api/hub/scheduled-tasks/${encodeURIComponent(row.schedule_id)}${query}`;
        ({ res, data } = await send(legacyPath, { method: 'DELETE' }));
      }
      if (res.status === 409 && data.error === 'revision_conflict') {
        await load(); setError('计划已在其他设备更新，已刷新最新内容，请重试。'); return;
      }
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const openHistory = (row: ScheduleRow) => {
    setHistoryFor(current => current === row.schedule_id ? null : row.schedule_id);
  };

  const saveDisabled = busy || !networkId || !name.trim() || !targetNodeId || !task.trim() || !timezone.trim() ||
    (kind === 'once' && !onceAt) || (kind === 'interval' && (!Number.isInteger(Number(every)) || Number(every) < (unit === 'seconds' ? 60 : 1))) ||
    (kind === 'weekly' && weekdays.length === 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-24 lg:px-8">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--fg)] lg:ml-0 ml-10">定时任务</h1>
          <p className="mt-1 text-sm text-[var(--fg-dim)]">由 Hub 统一调度；节点只接收普通任务，离线时自动排队。</p>
        </div>
        <button type="button" onClick={openCreate} className="rounded-lg bg-[var(--hl)] px-4 py-2 text-sm font-semibold text-[var(--bg)] hover:opacity-90">
          {showForm && !editing ? '收起' : '新建计划'}
        </button>
      </div>

      {error && <div className="mb-5 rounded-lg border border-[var(--danger)] bg-[var(--hover-tint)] px-4 py-3 text-sm text-[var(--danger)]">{error}</div>}

      {showForm && (
        <section className="mb-8 rounded-xl bg-[var(--bg-secondary)] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold text-[var(--fg)]">{editing ? '编辑计划' : '新建计划'}</h2>{editing && <button type="button" onClick={() => { setShowForm(false); resetForm(); }} className="text-sm text-[var(--fg-dim)]">取消编辑</button>}</div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm text-[var(--fg-muted)]">名称<input value={name} onChange={e => setName(e.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]" placeholder="例如：每日发布巡检" /></label>
            <div className="text-sm text-[var(--fg-muted)]">执行节点<NodePicker nodes={nodes} value={targetNodeId} onChange={setTargetNodeId} /></div>
            <label className="text-sm text-[var(--fg-muted)] md:col-span-2">任务内容<textarea value={task} onChange={e => setTask(e.target.value)} maxLength={10000} rows={4} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]" placeholder="节点收到的具体任务" /></label>
            <label className="text-sm text-[var(--fg-muted)]">计划类型<select value={kind} onChange={e => setKind(e.target.value as ScheduleSpec['type'])} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]"><option value="once">单次</option><option value="interval">固定间隔</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
            <label className="text-sm text-[var(--fg-muted)]">优先级<select value={priority} onChange={e => setPriority(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]"><option value="normal">普通</option><option value="high">高</option><option value="low">低</option></select></label>
            <label className="text-sm text-[var(--fg-muted)]">错过执行<select value={misfirePolicy} onChange={e => setMisfirePolicy(e.target.value as typeof misfirePolicy)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]"><option value="catch_up_once">恢复后补跑一次（适合新闻抓取）</option><option value="skip">跳过本次，等待下一周期</option></select><span className="mt-1 block text-xs text-[var(--fg-dim)]">Hub 延迟超过 60 秒才视为错过；补跑最多一次，不会集中重放。</span></label>
            <label className="text-sm text-[var(--fg-muted)]">时区<input value={timezone} onChange={e => setTimezone(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]" placeholder="Asia/Shanghai" /><span className="mt-1 block text-xs text-[var(--fg-dim)]">使用 IANA 时区名称，编辑时保留原计划时区。</span></label>
            {kind === 'once' && <label className="text-sm text-[var(--fg-muted)]">执行时间<input type="datetime-local" value={onceAt} onChange={e => setOnceAt(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]" /></label>}
            {kind === 'interval' && <div className="flex gap-2"><label className="flex-1 text-sm text-[var(--fg-muted)]">间隔<input type="number" min={unit === 'seconds' ? 60 : 1} value={every} onChange={e => setEvery(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]" /></label><label className="text-sm text-[var(--fg-muted)]">单位<select value={unit} onChange={e => setUnit(e.target.value as typeof unit)} className="mt-1 rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]"><option value="seconds">秒</option><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></label></div>}
            {(kind === 'daily' || kind === 'weekly') && <label className="text-sm text-[var(--fg-muted)]">时间<input type="time" value={clock} onChange={e => setClock(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--col-inset)] px-3 py-2 text-[var(--fg)]" /></label>}
            {kind === 'weekly' && <div className="flex flex-wrap items-end gap-2">{WEEKDAYS.map((day, index) => <button key={day} type="button" onClick={() => setWeekdays(v => v.includes(index) ? v.filter(x => x !== index) : [...v, index].sort())} className={`h-9 w-9 rounded-full text-sm ${weekdays.includes(index) ? 'bg-[var(--hl)] text-[var(--bg)]' : 'bg-[var(--hover-tint)] text-[var(--fg-muted)]'}`}>{day}</button>)}</div>}
          </div>
          <div className="mt-5 flex justify-end"><button disabled={saveDisabled} onClick={saveSchedule} className="rounded-lg bg-[var(--hl)] px-5 py-2 text-sm font-semibold text-[var(--bg)] disabled:cursor-not-allowed disabled:opacity-40">{busy ? '保存中…' : editing ? '保存修改' : '创建'}</button></div>
        </section>
      )}

      {loading ? <div className="py-20 text-center text-[var(--fg-dim)]">加载中…</div> : (() => {
        // Cancelled schedules are terminal — hide them from the default view.
        // Server still stores history for the audit trail, but the list is
        // meant for "what's on the calendar going forward", not "what ever
        // existed". Users who need the paper trail can consult run history
        // per schedule (record button); a dedicated show-cancelled toggle
        // was out of scope for this fix.
        const visible = schedules.filter(row => row.status !== 'cancelled');
        return visible.length === 0 ? (
          <div className="rounded-xl bg-[var(--bg-secondary)] py-20 text-center text-[var(--fg-dim)]">还没有 Hub 定时任务</div>
        ) : <div className="space-y-3">{visible.map(row => (
        <section key={row.schedule_id} className="rounded-xl bg-[var(--bg-secondary)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="font-semibold text-[var(--fg)]">{row.name}</h2><span className={`rounded-full bg-[var(--hover-tint)] px-2 py-0.5 text-xs ${row.status === 'active' ? 'text-[var(--success)]' : row.status === 'paused' ? 'text-[var(--warning)]' : 'text-[var(--fg-dim)]'}`}>{row.status}</span></div><p className="mt-1 text-sm text-[var(--hl)]">{row.target_alias}</p><p className="mt-2 line-clamp-2 text-sm text-[var(--fg-muted)]">{row.task_content}</p><p className="mt-3 text-xs text-[var(--fg-dim)]">{describeSchedule(row.schedule, row.timezone)} · {describeMisfire(row.misfire_policy)} · 下次 {formatTime(row.next_run_at)} · 上次 {formatTime(row.last_run_at)}</p></div>
            <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !['active','paused'].includes(row.status)} onClick={() => openEdit(row)} className="rounded-md px-3 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">编辑</button><button type="button" disabled={busy || !['active','paused'].includes(row.status)} onClick={() => mutate(row, 'toggle')} className="rounded-md px-3 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">{row.status === 'active' ? '暂停' : '恢复'}</button><button type="button" disabled={busy || row.status === 'cancelled'} onClick={() => mutate(row, 'run')} className="rounded-md px-3 py-1.5 text-xs text-[var(--hl)] hover:bg-[var(--hover-tint)]">立即执行</button><button type="button" onClick={() => openHistory(row)} aria-expanded={historyFor === row.schedule_id} aria-controls={`schedule-history-${row.schedule_id}`} className="min-h-11 min-w-11 rounded-md px-3 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">记录</button><button type="button" disabled={busy || row.status === 'cancelled'} onClick={() => mutate(row, 'cancel')} className="rounded-md px-3 py-1.5 text-xs text-[var(--danger)] hover:bg-[var(--hover-tint)]">取消</button></div>
          </div>
          {historyFor === row.schedule_id && <div id={`schedule-history-${row.schedule_id}`} role="region" aria-label={`${row.name}的执行记录`}><ScheduleHistory networkId={networkId} scheduleId={row.schedule_id} /></div>}
        </section>
      ))}</div>;
      })()}
    </main>
  );
}
