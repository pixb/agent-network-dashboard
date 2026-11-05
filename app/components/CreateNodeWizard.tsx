'use client';

import { useEffect, useState } from 'react';
import { useNetworkId } from '../lib/network-context';
import { DaemonOption, HostSupervisorPicker } from './HostSupervisorPicker';

/**
 * Create-node wizard (node-lifecycle UI M2/PR4 — RFC-026 §3.1).
 * 6 steps now: ⓪ host (PR4 #338) ① name ② runtime ③ model ④ flags ⑤ confirm
 * → POST /api/anet/node-create with `daemon_node_id` set to the chosen host.
 *
 * PR4 (#338 main lane PR4) folds RFC-026 §9.4 host_supervisor picker in front
 * of the existing 5 steps. Three states the picker resolves internally:
 *   - count=0 → onboarding (no daemon, show install command + block forward)
 *   - count=1 → auto-pick + forward immediately
 *   - count≥2 → user picks, then forward
 * The wizard now ALWAYS passes daemon_node_id to /api/anet/node-create (the
 * route's `resolveLocalDaemonNodeId` fallback only fires if daemon_node_id is
 * absent — kept for back-compat with non-wizard callers but no longer used
 * from this flow). Per 「文档宣称的能力必须对着代码路径逐条验证」这条判据 —
 * the API contract is exercised locally before any prod hub touches the path.
 */

// IDs MUST match the hub validator enums (server/src/create-node-validate.ts).
// Caught via local /mcp probe during mobile wizard build (#338 plan B):
// pre-fix RUNTIMES had 'codex' + 'grok' but hub accepts 'codex-sdk' +
// 'grok-build-acp'; pre-fix PERMISSION_MODES had 'auto' but hub rejects it
// (flag_value_invalid). The wizard has been silently shipping invalid combos
// for any non-claude-agent-sdk pick since M2 — only worked end-to-end with
// the default claude path.
//
// `defaultModel` — hub's `create_node.node_spec.model` schema is
// `z.string().min(1).max(100)`; the wizard's "默认" option leaves the state
// empty, so pre-fix the POST body dropped `model` entirely and hub rejected
// with `Invalid input: expected string, received undefined`. `defaultModel`
// gets substituted before submit (and shown in the dropdown label so the
// operator knows what "默认" will actually become).
const RUNTIMES: { id: string; label: string; models: string[]; defaultModel: string }[] = [
  { id: 'claude-agent-sdk', label: 'Claude Agent SDK', models: ['deepseek-v4-pro', 'MiniMax-M3', 'claude-sonnet-4-6', 'claude-opus-4-x'], defaultModel: 'claude-sonnet-4-6' },
  { id: 'codex-sdk', label: 'Codex SDK', models: ['gpt-5.5'], defaultModel: 'gpt-5.5' },
  { id: 'grok-build-acp', label: 'Grok (build-acp)', models: ['grok-build'], defaultModel: 'grok-build' },
];
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const STEPS = ['服务器', '名字', 'Runtime', '模型', '参数', '确认'];

type Phase = 'form' | 'creating' | 'done' | 'unconfirmed' | 'error';

export function CreateNodeWizard({
  networkId,
  onClose,
  onCreated,
}: {
  networkId?: string;
  onClose: () => void;
  onCreated?: (result: unknown) => void;
}) {
  const [step, setStep] = useState(0);
  const [daemonNodeId, setDaemonNodeId] = useState<string | null>(null);
  // (#338 wizard-runtime-filter) keep the full daemon row so the Runtime
  // step can disable runtimes the chosen daemon doesn't declare support
  // for. Hub-side enforcement still wins; this is UX surfacing.
  const [daemon, setDaemon] = useState<DaemonOption | null>(null);
  const [name, setName] = useState('');
  const [runtimeId, setRuntimeId] = useState(RUNTIMES[0].id);
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('default');
  const [maxTurns, setMaxTurns] = useState('');
  const [budget, setBudget] = useState('');
  const [timeout, setTimeout] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [msg, setMsg] = useState('');
  const [childUp, setChildUp] = useState(false);
  const { networkId: ctxNetworkId } = useNetworkId();
  const netId = networkId || ctxNetworkId;

  // Escape closes the wizard (unless a create is mid-flight, so a stray key
  // can't drop the dialog while the request is settling).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'creating') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  // After dispatch, confirm the child actually came up by watching the node
  // list for it to register (RFC-026 progress signal — get_create_request is
  // daemon-only, so the dashboard confirms via /api/hub/status). Polls ~24s.
  useEffect(() => {
    if (phase !== 'done' || childUp) return;
    let alive = true;
    let tries = 0;
    const want = name.trim();
    const tick = async () => {
      tries += 1;
      try {
        const url = netId ? `/api/hub/status?network_id=${encodeURIComponent(netId)}` : '/api/hub/status';
        const r = await fetch(url, { cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        const list = Array.isArray(d?.sessions) ? d.sessions : Array.isArray(d) ? d : [];
        if (alive && list.some((s: { alias?: string }) => s?.alias === want)) { setChildUp(true); return; }
      } catch { /* transient — keep polling */ }
      if (alive && tries < 16) window.setTimeout(tick, 1500);
    };
    const t = window.setTimeout(tick, 1200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [phase, childUp, netId, name]);

  const runtime = RUNTIMES.find(r => r.id === runtimeId) || RUNTIMES[0];
  const nameValid = name.trim().length > 0;
  const canNext =
    (step === 0 && Boolean(daemonNodeId)) ||      // step 0: must have chosen a daemon
    (step === 1 && nameValid) ||                   // step 1: name non-empty
    (step >= 2 && step < STEPS.length);            // later steps: nothing required to advance
  const busy = phase === 'creating';

  async function handleCreate() {
    if (!daemonNodeId) {
      setPhase('error');
      setMsg('创建失败：请先选择一台有 daemon 在线的服务器');
      return;
    }
    setPhase('creating');
    setMsg('');
    const numOrUndef = (v: string) => (v.trim() === '' ? undefined : Number(v));
    // Hub's create_node.node_spec.model schema is z.string().min(1); the
    // wizard's "默认" option leaves state empty, so pick the runtime's
    // documented default here. This mirrors what agent-node itself defaults
    // to at boot (see agent-node cli.ts model resolution), so the "默认"
    // dropdown label + this fallback both point at the same model.
    const effectiveModel = model || runtime.defaultModel;
    const node_spec = {
      name: name.trim(),
      runtime: runtimeId,
      model: effectiveModel,
      flags: {
        permissionMode,
        maxTurns: numOrUndef(maxTurns),
        budget: numOrUndef(budget),
        timeout: numOrUndef(timeout),
      },
    };
    try {
      const r = await fetch('/api/anet/node-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_spec,
          daemon_node_id: daemonNodeId,
          ...(networkId ? { network_id: networkId } : {}),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data?.ok) {
        setPhase('done');
        setMsg('创建请求已下发，节点正在拉起…');
        onCreated?.(data.result);
      } else if (data?.unconfirmed) {
        setPhase('unconfirmed');
        setMsg(`后端 create_node 未就绪：${data?.error || '不可用'}（测试 hub 可能未含 #299）`);
      } else {
        setPhase('error');
        setMsg(data?.error ? `创建失败：${data.error}` : '创建失败');
      }
    } catch (e) {
      setPhase('error');
      setMsg(`创建失败：${e instanceof Error ? e.message : '网络错误'}`);
    }
  }

  const inputCls =
    'w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] focus:border-cyan-600 focus:outline-none';

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="新建节点"
        // RFC-026 §9.4 responsive: mobile single-screen (full width minus
        // gutter, taller); desktop ~3-col-friendly width when picker is shown.
        className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,440px)] md:w-[min(92vw,720px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="text-sm font-semibold text-[var(--fg)]">新建节点</div>
          <button onClick={onClose} aria-label="关闭" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 px-4 pt-3">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-1 flex-col items-center gap-1">
              <div className={`h-1 w-full rounded-full ${i <= step ? 'bg-[var(--accent)]' : 'bg-[var(--bg-elevated)]'}`} />
              <span className={`text-[11px] ${i === step ? 'text-[var(--accent-text)]' : 'text-[var(--fg-dim)]'}`}>{label}</span>
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="min-h-[180px] px-4 py-4">
          {phase !== 'form' ? (
            <div className="flex h-[180px] flex-col items-center justify-center gap-3 text-center">
              {busy && (
                <svg className="h-7 w-7 animate-spin text-[var(--accent-text)]" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              )}
              <div className={`text-sm ${phase === 'done' ? 'text-green-300' : phase === 'error' ? 'text-red-300' : phase === 'unconfirmed' ? 'text-[var(--warning)]' : 'text-[var(--fg)]'}`}>
                {busy ? '正在创建…' : phase === 'done' && childUp ? `✓ ${name.trim()} 已上线` : msg}
              </div>
              {/* Real progress: poll the node list for the child to register
                  (派单→fork→注册→✓). */}
              {phase === 'done' && (childUp ? (
                <p className="text-[11px] text-green-500/80">节点已注册，已出现在节点列表。</p>
              ) : (
                <p className="inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
                  <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  正在监测 {name.trim()} 注册…（最长 ~24s）
                </p>
              ))}
            </div>
          ) : (
            <>
              {step === 0 && (
                <div className="space-y-2">
                  <span className="text-xs text-[var(--fg-muted)]">在哪台机器上创建</span>
                  <HostSupervisorPicker
                    networkId={netId || undefined}
                    value={daemonNodeId}
                    onChange={(id, d) => {
                      setDaemonNodeId(id);
                      setDaemon(d);
                      // (#338 wizard-runtime-filter) If the current runtime
                      // pick isn't supported by the new daemon, reset so
                      // the user is forced to re-pick on step 2. Otherwise
                      // they could land on step 5 (确认) with an
                      // already-invalid combo that only hub rejection
                      // surfaces.
                      const supported = d?.runtimes_supported;
                      if (supported && supported.length > 0 && !supported.includes(runtimeId)) {
                        setRuntimeId(supported[0]);
                        setModel('');
                      }
                    }}
                  />
                  {!daemonNodeId && (
                    <p className="text-[11px] text-[var(--fg-dim)]">
                      没选服务器之前无法继续；如果列表是空的，按提示在目标机器上跑 <code className="rounded bg-[var(--code-bg)] px-1 py-0.5">anet daemon up &lt;name&gt;</code>。
                    </p>
                  )}
                </div>
              )}
              {step === 1 && (
                <label className="block space-y-1.5">
                  <span className="text-xs text-[var(--fg-muted)]">节点名字</span>
                  <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例如 my-agent-1" className={inputCls} />
                  {!nameValid && <span className="text-[11px] text-[var(--fg-dim)]">名字不能为空</span>}
                </label>
              )}
              {step === 2 && (
                <div className="space-y-2">
                  <span className="text-xs text-[var(--fg-muted)]">
                    Runtime{daemon ? `（${daemon.alias} 支持）` : ''}
                  </span>
                  {RUNTIMES.map(r => {
                    // (#338 wizard-runtime-filter) Permissive when the
                    // daemon didn't publish runtimes_supported at all
                    // (pre-PR3 daemons OR daemons not yet upgraded) — hub
                    // still validates. Restrictive only when the daemon
                    // explicitly told us its supported set.
                    const supported = daemon?.runtimes_supported;
                    const disabled = Array.isArray(supported) && supported.length > 0 && !supported.includes(r.id);
                    const selected = runtimeId === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => { if (!disabled) { setRuntimeId(r.id); setModel(''); } }}
                        title={disabled ? `${daemon?.alias || '该 daemon'} 未声明支持此 runtime` : undefined}
                        className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors ${
                          disabled
                            ? 'border-[var(--border)] bg-[#0a0a0c] text-[var(--fg-dim)] cursor-not-allowed'
                            : selected
                              ? 'border-cyan-600 bg-cyan-900/15 text-cyan-200'
                              : 'border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:border-[#3a3a41]'
                        }`}
                      >
                        <span>
                          {r.label}
                          {disabled && <span className="ml-2 text-[11px] text-gray-700">该 daemon 不支持</span>}
                        </span>
                        {selected && !disabled && (
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {step === 3 && (
                <label className="block space-y-1.5">
                  <span className="text-xs text-[var(--fg-muted)]">模型（{runtime.label}）</span>
                  <select value={model} onChange={e => setModel(e.target.value)} className={inputCls}>
                    <option value="">默认（{runtime.defaultModel}）</option>
                    {runtime.models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
              )}
              {step === 4 && (
                <div className="space-y-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs text-[var(--fg-muted)]">permissionMode</span>
                    <select value={permissionMode} onChange={e => setPermissionMode(e.target.value)} className={inputCls}>
                      {PERMISSION_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="space-y-1"><span className="text-[11px] text-[var(--fg-muted)]">maxTurns</span><input inputMode="numeric" value={maxTurns} onChange={e => setMaxTurns(e.target.value)} className={inputCls} /></label>
                    <label className="space-y-1"><span className="text-[11px] text-[var(--fg-muted)]">budget</span><input inputMode="numeric" value={budget} onChange={e => setBudget(e.target.value)} className={inputCls} /></label>
                    <label className="space-y-1"><span className="text-[11px] text-[var(--fg-muted)]">timeout</span><input inputMode="numeric" value={timeout} onChange={e => setTimeout(e.target.value)} className={inputCls} /></label>
                  </div>
                </div>
              )}
              {step === 5 && (
                <div className="space-y-2 text-sm">
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] divide-y divide-[#1c1c1f]">
                    {[
                      ['服务器', daemonNodeId ? `${daemonNodeId.slice(0, 24)}…` : '—'],
                      ['名字', name.trim() || '—'],
                      ['Runtime', runtime.label],
                      ['模型', model || `默认（${runtime.defaultModel}）`],
                      ['permissionMode', permissionMode],
                      ['maxTurns / budget / timeout', `${maxTurns || '—'} / ${budget || '—'} / ${timeout || '—'}`],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-start justify-between gap-3 px-3 py-2">
                        <span className="shrink-0 text-[var(--fg-muted)] text-xs">{k}</span>
                        <span className="text-right text-[var(--fg)] text-xs break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer nav */}
        {phase === 'form' ? (
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
            <button type="button" onClick={() => (step === 0 ? onClose() : setStep(step - 1))} className="rounded-md px-3 py-1.5 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]">
              {step === 0 ? '取消' : '上一步'}
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" disabled={!canNext} onClick={() => setStep(step + 1)} className={`rounded-md px-4 py-1.5 text-sm font-medium ${canNext ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90' : 'bg-[var(--bg-elevated)] text-[var(--fg-dim)] cursor-not-allowed'}`}>
                下一步
              </button>
            ) : (
              <button type="button" onClick={handleCreate} className="rounded-md bg-[var(--success)] px-4 py-1.5 text-sm font-medium text-[var(--accent-fg)] hover:opacity-90">
                创建节点
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-end border-t border-[var(--border)] px-4 py-3">
            <button type="button" onClick={onClose} className="rounded-md bg-[var(--bg-elevated)] px-4 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--bg-elevated)]">
              {phase === 'done' ? '完成' : '关闭'}
            </button>
            {(phase === 'error' || phase === 'unconfirmed') && (
              <button type="button" onClick={() => setPhase('form')} className="ml-2 rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm text-[var(--accent-fg)] hover:opacity-90">返回修改</button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
