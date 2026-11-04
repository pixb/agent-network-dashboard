'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Session } from './types';
import { AliasAvatar } from './AliasAvatar';
import { setAvatarUrl, useAvatarUrl } from '../lib/avatars';
import { useNodeLifecycle } from '../lib/hooks';
import { toggleMute, useMuted } from '../lib/chat-mute';
import { togglePin, usePinned } from '../lib/chat-pin';
import { useLifecycleCaps } from './NodeLifecycleMenu';

/**
 * Per-node settings panel (issue #260 → v0.11 flagship #262, Vincent tg
 * 2026-06-24, "must actually work").
 *
 * STATUS (PR C rebased onto #31 — LIVE, wired to the RFC-024 backend):
 *  - **Wired (real, takes effect)**: A 接入 Channel enable/disable (#31) +
 *    B 模型 select + C flags (permissionMode / dangerouslySkipPermissions /
 *    maxTurns / budget / timeout — teammateMode dropped, not in the hub
 *    allowlist). Loaded on mount from `GET /api/anet/node-config` (a masked
 *    snapshot with `config_revision`), saved via `POST` → hub MCP
 *    `update_node_config` with a minimal diff `patch` + `base_revision`.
 *    Channels ride inside the same patch — the tool schema is
 *    { model?, flags?, channels? }.
 *  - **Apply lifecycle (node ack via revision bump)**: saving → applying →
 *    applied | timeout | error. After the POST is accepted the panel polls the
 *    config snapshot and treats `config_revision > base_revision` as applied.
 *    That revision bump is written after the node-side get_config_update /
 *    ack_config_update path completes. `apply_mode` (hot / restart) flavours
 *    the progress copy. Stale-hardened (runId guard + first-terminal-wins +
 *    hard 30s ceiling). update_node_config error codes map to UI messages.
 *  - **Channel red-line**: only the on/off flip is on the wire. Per-channel
 *    bot token / app secret / allowFrom stay in the node's local config.json
 *    and are shown here as masked read-only (StubField).
 *  - **Still P2 stub**: D 运维 ops buttons other than restart (rename/stop/
 *    delete) — gated on RFC-024 rename + RFC-027 stop/delete backends.
 *
 * If the hub/config tools are unreachable the panel disables Save with an
 * honest note. `config_update_capable:false`
 * (node not under a W1 supervisor) surfaces a "重启类改动可能不生效" warning.
 * Runtime + imageCapable stay read-only (auto-derived).
 */

// B. Runtime → selectable model presets (from anet VENDORS, bin/cli.ts).
// Runtime itself is read-only this round; only the model is editable.
const RUNTIME_MODELS: Record<string, string[]> = {
  'claude-agent-sdk': ['deepseek-v4-pro', 'MiniMax-M3', 'MiniMax-M2.7', 'claude-sonnet-4-6', 'claude-opus-4-x', 'intern', 'mimo'],
  'claude-code-cli': ['（由 CLI 管理）'],
  'codex-sdk': ['gpt-5.5'],
  'grok-build-acp': ['grok-build'],
};

// C. config.flags contract (per 通信龙). permissionMode is a select; two
// booleans; three numeric bounds. These six are the entire editable flag set.
const PERMISSION_MODES = ['auto', 'default', 'bypassPermissions'];

// A. Channel bindings — enable/disable is editable; the per-channel secret
// fields below stay read-only (`StubField`, masked). `roadmap` = greyed "即将
// 支持". Keep this list in sync with EDITABLE_CHANNELS in
// app/lib/node-config-patch.ts, which in turn mirrors the hub's list in
// server/src/config-apply-validate.ts. commhub is deliberately absent:
// it is the RPC transport every node speaks, not a per-node channel (#38).
const CHANNELS: { key: string; label: string; roadmap?: boolean; fields: { label: string; value?: string }[] }[] = [
  {
    key: 'telegram', label: 'Telegram',
    fields: [
      { label: 'Bot Token', value: '••••••••••••' },
      { label: '允许的 chat id (allowFrom)', value: '—' },
      { label: '状态目录', value: '~/.anet/channels/telegram' },
    ],
  },
  {
    key: 'feishu', label: '飞书 Feishu',
    fields: [
      { label: 'App ID', value: 'cli_••••••' },
      { label: 'App Secret', value: '••••••••••••' },
      { label: '允许的 open_id (allowFrom)', value: '—' },
      { label: '允许的群 chat_id (allowChats)', value: '—' },
      { label: '群触发策略', value: 'mention' },
    ],
  },
  { key: 'wechat', label: 'WeChat', roadmap: true, fields: [] },
];

// D. Node ops — still P2 no-op stubs this round. `danger` = destructive styling.

// Editable flag form shape. Numeric fields are kept as strings for controlled
// inputs and coerced (or dropped when blank) at save time.
type FlagsForm = {
  permissionMode: string;
  dangerouslySkipPermissions: boolean;
  maxTurns: string;
  budget: string;
  timeout: string;
};

const DEFAULT_FLAGS: FlagsForm = {
  permissionMode: 'default',
  dangerouslySkipPermissions: false,
  maxTurns: '',
  budget: '',
  timeout: '',
};

// F3 apply lifecycle. A save flows:
//   idle → saving (POST in flight) → applying (config dispatched, node
//   restarting / taking effect) → applied | rejected | timeout.
// `error` = the save POST failed or the backend cannot confirm apply.
type ApplyPhase = 'idle' | 'saving' | 'applying' | 'applied' | 'rejected' | 'timeout' | 'error';

// Real-backend apply-status poll cadence + ceiling.
const APPLY_POLL_MS = 1500;
const APPLY_TIMEOUT_MS = 30000;
// Auto-dismiss the success strip after this long.
const SUCCESS_DISMISS_MS = 4000;
// Per-request ceiling so a hung hub proxy can't freeze the lifecycle — every
// POST/poll fetch is aborted past this (通信牛 review #11 blocker 2).
const FETCH_TIMEOUT_MS = 8000;

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** fetch + json with a hard AbortController timeout. Rejects (AbortError) if it
 *  doesn't resolve in `timeoutMs` — callers treat that as transient/abort. */
async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; data: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, data };
  } finally {
    clearTimeout(to);
  }
}

function channelSet(channels: Session['channels']): Set<string> {
  if (!channels) return new Set();
  const list = Array.isArray(channels) ? channels : String(channels).split(/[,\s]+/);
  return new Set(list.map(c => c.trim().toLowerCase()).filter(Boolean));
}

/** Coerce a snapshot flag value into the string form fields expect. */
function numStr(v: unknown): string {
  return v === undefined || v === null || v === '' ? '' : String(v);
}

/** Section heading. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)] mb-2">{children}</h3>;
}

/* R34 (微信消息免打扰): per-conversation mute switch. Muted = badge shows
   a dot instead of the count and the global total excludes it. */
function MuteSection({ alias }: { alias: string }) {
  const muted = useMuted(alias);
  const pinned = usePinned(alias);
  return (
    <section>
      <SectionTitle>聊天</SectionTitle>
      <button
        type="button"
        role="switch"
        aria-checked={pinned}
        onClick={() => togglePin(alias)}
        className="mb-2 flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5"
      >
        <span className="text-[12px] text-[var(--fg)]">置顶会话</span>
        <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${pinned ? 'bg-[var(--accent)]' : 'bg-[var(--control-off)]'}`}>
          <span className="inline-block h-4 w-4 rounded-full bg-white transition-transform" style={{ transform: pinned ? 'translateX(18px)' : 'translateX(2px)' }} />
        </span>
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={muted}
        onClick={() => toggleMute(alias)}
        className="flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5"
      >
        <span className="text-[12px] text-[var(--fg)]">消息免打扰</span>
        <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${muted ? 'bg-[var(--accent)]' : 'bg-[var(--control-off)]'}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${muted ? 'translate-x-4.5' : 'translate-x-0.5'}`} style={{ transform: muted ? 'translateX(18px)' : 'translateX(2px)' }} />
        </span>
      </button>
      <p className="mt-1.5 text-[11px] text-[var(--fg-dim)]">置顶=列表最前；静音=未读只显红点、不计入全局数字（均存本浏览器）</p>
    </section>
  );
}

/* R24 (Vincent 亲点: 头像换血) — per-node custom avatar. Stored browser-side
   (localStorage via app/lib/avatars) until the hub grows an RFC-024
   whitelist entry for avatar_url; the designed default set rides
   /avatars/manifest.json. Live preview through the SAME AliasAvatar every
   surface renders. */
function AvatarSection({ alias }: { alias: string }) {
  const current = useAvatarUrl(alias);
  const [draft, setDraft] = useState(current);
  useEffect(() => { setDraft(current); }, [current]);
  const dirty = draft.trim() !== current;
  // avatar 接线单 (通信龙 裁定): hub first, localStorage only as the echo
  // after success — the pre-wiring localStorage-only save was the root of
  // the "改了头像别人看不到" stuck-avatar report. `ref` = alias (the hub
  // resolves node_id/name/alias, same as the attrs proxy).
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMsg, setSaveMsg] = useState('');
  const { refreshNodes, nodeIdByAlias } = useNodeLifecycle();
  // 通信龙 判据 (avatar 接线单追加): UI 必须在用户动手之前说明"能不能改、
  // 为什么" — 生产 199 会话中有 40 个纯会话代理没有 nodes 行, hub 头像挂
  // 不上去 (PUT 必然 404), 不能让用户点保存才发现。有 nodes 行 = 可自定义;
  // 没有 = 禁用输入并注明原因, 而不是把失败原因藏进错误提示。
  const hasNodeRow = Boolean(nodeIdByAlias[alias]);
  const save = async (value: string) => {
    setSaveState('saving'); setSaveMsg('');
    try {
      const res = await fetch(`/api/hub/nodes/${encodeURIComponent(alias)}/avatar`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url: value.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setSaveState('error');
        setSaveMsg(body.message || `保存失败 (HTTP ${res.status})`);
        return;
      }
      setAvatarUrl(alias, value); // local echo after hub success
      refreshNodes();             // re-pull nodes → hub layer hydrates
      setSaveState('saved');
    } catch {
      setSaveState('error'); setSaveMsg('无法连接服务器');
    }
  };
  return (
    <section>
      <SectionTitle>头像</SectionTitle>
      <div className="flex items-start gap-3">
        <AliasAvatar alias={alias} size={44} />
        <div className="flex-1 space-y-1.5">
          {!hasNodeRow && (
            <p className="text-[11px] leading-relaxed text-amber-400/90" data-testid="avatar-no-node-note">
              该 agent 未注册为节点（hub 无 nodes 记录），头像暂不支持自定义 —— 当前显示的是默认插画。
            </p>
          )}
          <input
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!hasNodeRow}
            placeholder="图片 URL（留空恢复默认）"
            data-testid="avatar-url-input"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!hasNodeRow || !dirty || saveState === 'saving'}
              onClick={() => save(draft)}
              data-testid="avatar-save"
              className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2.5 py-1 text-[11px] text-[var(--accent-text)] hover:bg-[var(--accent)]/25 disabled:opacity-40"
            >
              {saveState === 'saving' ? '保存中…' : '保存'}
            </button>
            {current && (
              <button
                type="button"
                onClick={() => { setDraft(''); void save(''); }}
                data-testid="avatar-clear"
                className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
              >
                恢复默认
              </button>
            )}
            {saveState === 'error' ? (
              <span className="text-[10px] text-red-400" data-testid="avatar-save-error">{saveMsg}</span>
            ) : saveState === 'saved' ? (
              <span className="text-[10px] text-emerald-400" data-testid="avatar-save-ok">已保存，全设备同步</span>
            ) : (
              <span className="text-[11px] text-[var(--fg-dim)]">保存后跨设备同步（经 hub）</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Read-only label/value row. */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]">
      <span className="text-[var(--fg-muted)] shrink-0">{label}</span>
      <span className="text-[var(--fg)] truncate font-mono text-[11px]" title={value}>{value}</span>
    </div>
  );
}

/** Disabled text field (P2 channel display). */
function StubField({ label, value }: { label: string; value?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
      <input
        type="text" disabled readOnly value={value ?? ''} placeholder="未配置"
        className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] cursor-not-allowed disabled:opacity-100"
      />
    </label>
  );
}

/** Live controlled toggle. */
function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--fg)] transition-colors ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-[var(--bg-elevated)]'}`}
    >
      <span className="text-left pr-3">{label}</span>
      <span className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-[var(--accent)]' : 'bg-[var(--control-off)]'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

/** Live controlled select. */
function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="mt-0.5 w-full appearance-none rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] hover:border-[var(--border-hover)] focus:border-[var(--accent)] focus:outline-none"
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

/** Live controlled numeric field (kept as string; coerced at save). */
function NumberField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        placeholder={placeholder ?? '默认'}
        onChange={e => onChange(e.target.value)}
        className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
      />
    </label>
  );
}

export function NodeSettingsPanel({ session: s, onClose, positioning = 'fixed' }: {
  session: Session;
  onClose: () => void;
  /** 07-31 通信龙 判定: 'fixed' (default) is the legacy fullscreen
   *  drawer used by AgentCard (covers whole viewport). 'absolute'
   *  scopes the drawer to its nearest positioned ancestor + shrinks
   *  to 360px, used by ChatPane so it only covers the chat column
   *  (SPEC §12: settings should not steal from the reclaimed 1104px
   *  chat width; fourth-column would push chat back to 664px).
   *  Absolute mode also drops the black backdrop — clicking outside
   *  the drawer inside the chat pane still closes, but the rest of
   *  the app stays interactive. */
  positioning?: 'fixed' | 'absolute';
}) {
  const runtime = s.runtime || '—';
  const initialModel = s.model || s.agent || '';
  // imageCapable: read-only, auto from model (MiniMax-M3 / Claude = yes).
  const imageCapable = /minimax-m3|claude/i.test(initialModel);
  // Model options for this runtime; always include the current value so a
  // server-set model outside the preset list stays selectable.
  const presetModels = RUNTIME_MODELS[runtime] || [];
  const modelOptions = Array.from(new Set([initialModel, ...presetModels].filter(Boolean)));

  const nodeKey = s.node_id || s.alias;

  // ---- Editable form state (A channels + B model + C flags) ----
  const [model, setModel] = useState(initialModel);
  const [flags, setFlags] = useState<FlagsForm>(DEFAULT_FLAGS);
  // Enabled channel keys — Set for O(1) toggle, serialized to array at save.
  // Seeded from the session prop so the panel renders coherent state before
  // the load effect resolves; hub snapshot overrides once available.
  const [channels, setChannels] = useState<Set<string>>(() => channelSet(s.channels));
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  // RFC-024 snapshot context: base_revision for the next write, whether the
  // node can take config updates, whether a readable snapshot exists at all,
  // and the loaded baselines used to build a minimal diff patch.
  const revisionRef = useRef<number | null>(null);
  const loadedModelRef = useRef(initialModel);
  const loadedFlagsRef = useRef<FlagsForm>(DEFAULT_FLAGS);
  // Channels baseline for the diff patch (#31 + RFC-024): seeded from the
  // session, re-synced from every snapshot read.
  const loadedChannelsRef = useRef<Set<string>>(channelSet(s.channels));
  const [capable, setCapable] = useState(true);
  const [snapUnavailable, setSnapUnavailable] = useState(false);
  // ---- apply lifecycle (node ack observed through config_revision) ----
  const [phase, setPhase] = useState<ApplyPhase>('idle');
  const [phaseMsg, setPhaseMsg] = useState('');
  // ---- M1 node lifecycle actions (restart wired to RFC-024 restart_node;
  // rename/stop/delete gated on backend → shown as 即将支持). Self-contained,
  // independent of the config apply lifecycle above.
  const [lcBusy, setLcBusy] = useState(false);
  const [lcResult, setLcResult] = useState<{ tone: 'info' | 'ok' | 'warn' | 'err'; text: string } | null>(null);
  // D1 rename entry — rendered only when the hub actually has rename_node
  // (capability probe), per the no-dead-buttons rule.
  const lifecycleCaps = useLifecycleCaps();
  const [renameVal, setRenameVal] = useState('');
  const [applyMode, setApplyMode] = useState<string | null>(null);
  // Outstanding lifecycle timers (real poll, auto-dismiss);
  // cleared on unmount and at the start of each new save so a stale timer can't
  // overwrite a fresh result.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);
  const after = useCallback((ms: number, fn: () => void) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);
  // Avoid setState after unmount (panel closes mid-request). Set the flag on
  // each mount as well as clear on unmount — React strict-mode double-invokes
  // effects in dev, which without the mount reset would leave mounted=false
  // after the second attach and starve every subsequent state update (the
  // loading spinner would never resolve, blocking the whole panel).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimers(); };
  }, [clearTimers]);

  // Monotonic run id, bumped on every save. Each async lifecycle callback
  // captures the run id it belongs to and bails if a newer save superseded it —
  // this guards the callback that has ALREADY passed `await fetch` and so can't
  // be cancelled by clearTimers() (通信牛 review #11 blocker 1: stale poll
  // overwriting a fresh save).
  const applySeqRef = useRef(0);
  // "First terminal wins" within a run: once applied/rejected/timeout is set, a
  // late result can't overwrite it — this makes the 30s ceiling truly hard
  // (通信牛 review #11 blocker 2).
  const settledRef = useRef(false);
  const isCurrent = useCallback((runId: number) => mounted.current && runId === applySeqRef.current, []);
  const settle = useCallback((runId: number, apply: () => void) => {
    if (!isCurrent(runId) || settledRef.current) return;
    settledRef.current = true;
    apply();
  }, [isCurrent]);

  const setFlag = useCallback(<K extends keyof FlagsForm>(key: K, v: FlagsForm[K]) => {
    setFlags(f => ({ ...f, [key]: v }));
    setDirty(true);
  }, []);

  const toggleChannel = useCallback((key: string) => {
    setChannels(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDirty(true);
  }, []);

  // Read a snapshot payload into the form + the loaded baselines. Used on mount
  // and again after an apply, so dirty + base_revision re-sync to the new state.
  const syncFromSnapshot = useCallback((data: Record<string, unknown>) => {
    const m = data?.model ? String(data.model) : initialModel;
    const f = (data?.flags && typeof data.flags === 'object' ? data.flags : {}) as Record<string, unknown>;
    const nextFlags: FlagsForm = {
      permissionMode: typeof f.permissionMode === 'string' && PERMISSION_MODES.includes(f.permissionMode) ? f.permissionMode : DEFAULT_FLAGS.permissionMode,
      dangerouslySkipPermissions: !!f.dangerouslySkipPermissions,
      maxTurns: numStr(f.maxTurns),
      budget: numStr(f.budget),
      timeout: numStr(f.timeout),
    };
    setModel(m); loadedModelRef.current = m;
    setFlags(nextFlags); loadedFlagsRef.current = nextFlags;
    // Channels (#31): the hub snapshot is authoritative when present. If the
    // field is absent (older hub), keep the session-derived seed so nodes
    // with obviously-wired channels aren't shown an empty list.
    if (Array.isArray(data?.channels)) {
      const next = new Set<string>(
        (data.channels as unknown[]).filter((c): c is string => typeof c === 'string').map(c => c.trim().toLowerCase()),
      );
      setChannels(next);
      loadedChannelsRef.current = next;
    }
    if (typeof data?.config_revision === 'number') revisionRef.current = data.config_revision;
    if (typeof data?.config_update_capable === 'boolean') setCapable(data.config_update_capable as boolean);
    setDirty(false);
  }, [initialModel]);

  // Load current config snapshot on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/anet/node-config?node_id=${encodeURIComponent(nodeKey)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !mounted.current) return;
        // No readable revision (hub/config tool error) → can't
        // safely write; flag so Save disables with an honest note.
        if (data?.ok === false || typeof data?.config_revision !== 'number') {
          setSnapUnavailable(true);
        }
        syncFromSnapshot(data);
      } catch {
        if (!cancelled && mounted.current) setSnapUnavailable(true);
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [nodeKey, syncFromSnapshot]);

  // Terminal "applied" state + auto-dismiss of the success strip.
  const finishApplied = useCallback((runId: number) => {
    settle(runId, () => {
      setPhase('applied');
      setPhaseMsg('配置已生效');
      after(SUCCESS_DISMISS_MS, () => {
        if (isCurrent(runId)) setPhase(p => (p === 'applied' ? 'idle' : p));
      });
    });
  }, [after, isCurrent, settle]);

  const markTimeout = useCallback((runId: number) => {
    settle(runId, () => {
      setPhase('timeout');
      setPhaseMsg('未在 30s 内确认生效，请稍后在节点详情核对');
    });
  }, [settle]);

  // Map an RFC-024 update_node_config error payload → a UI message.
  function mapUpdateError(d: Record<string, unknown>): string {
    const err = String(d?.error || '');
    switch (err) {
      case 'revision_conflict': return '他人已修改该节点，已为你刷新最新值，请重试';
      case 'insufficient_role_for_security_flag': return `需要 admin 权限才能修改 ${d?.field || '该安全项'}`;
      case 'invalid_patch': return `字段非法：${d?.field || ''}${d?.reason ? ` (${d.reason})` : ''}`;
      case 'update_in_flight': {
        const ageMs = typeof d?.age_ms === 'number' ? d.age_ms : 0;
        const wait = Math.max(1, Math.ceil((60000 - ageMs) / 1000));
        return `上一次改动正在生效，约 ${wait}s 后可再改`;
      }
      case 'cross_network_node': return '无权限：该节点不在你的 network';
      case 'node_not_found': return '节点不存在';
      case 'empty_patch': return '无改动';
      case 'hub_unreachable': return 'Hub 不可达，请稍后重试';
      default: return err ? `保存失败：${err}` : '保存失败';
    }
  }

  // Build a minimal diff patch vs the loaded snapshot (RFC-024 patch semantics:
  // only changed fields are sent — never force-writes untouched flags, and so
  // never trips invalid_patch on a field the user didn't touch).
  function buildPatch(): { model?: string; flags?: Record<string, unknown>; channels?: string[] } {
    const patch: { model?: string; flags?: Record<string, unknown>; channels?: string[] } = {};
    if (model !== loadedModelRef.current) patch.model = model;
    const lf = loadedFlagsRef.current;
    const changed: Record<string, unknown> = {};
    if (flags.permissionMode !== lf.permissionMode) changed.permissionMode = flags.permissionMode;
    if (flags.dangerouslySkipPermissions !== lf.dangerouslySkipPermissions) changed.dangerouslySkipPermissions = flags.dangerouslySkipPermissions;
    for (const k of ['maxTurns', 'budget', 'timeout'] as const) {
      const cur = flags[k].trim();
      if (cur !== lf[k].trim() && cur !== '') changed[k] = Number(cur);
    }
    if (Object.keys(changed).length > 0) patch.flags = changed;
    // Channels (#31): included only when the set actually changed — same
    // diff-patch semantics as model/flags. The full desired list is sent
    // (channels is a replace-set, not a per-key merge).
    const lc = loadedChannelsRef.current;
    const cur = Array.from(channels).sort();
    const base = Array.from(lc).sort();
    if (cur.length !== base.length || cur.some((c, i) => c !== base[i])) {
      patch.channels = cur;
    }
    return patch;
  }

  function handleSave() {
    clearTimers();
    const runId = ++applySeqRef.current;
    settledRef.current = false;
    setApplyMode(null);

    const patch = buildPatch();
    if (patch.model === undefined && !patch.flags && !patch.channels) {
      setPhase('idle'); setPhaseMsg(''); setDirty(false); return;
    }
    const baseRevision = revisionRef.current;
    if (typeof baseRevision !== 'number') {
      settledRef.current = true; setPhase('error'); setPhaseMsg('无法读取节点配置版本，Hub 可能不可达'); return;
    }

    setPhase('saving');
    setPhaseMsg('');

    // Apply = config_revision bump. The node performs get_config_update /
    // ack_config_update; the dashboard observes the resulting snapshot fact.
    const poll = (startedAt: number) => {
      after(APPLY_POLL_MS, async () => {
        if (!isCurrent(runId) || settledRef.current) return;
        let snap: Record<string, unknown> | null = null;
        try {
          const { res, data } = await fetchJson(`/api/anet/node-config?node_id=${encodeURIComponent(nodeKey)}&base_revision=${encodeURIComponent(String(baseRevision))}`, { cache: 'no-store' }, FETCH_TIMEOUT_MS);
          if (!res.ok || data?.ok === false) {
            settle(runId, () => {
              setPhase('error');
              setPhaseMsg(`${mapUpdateError(data)}。当前请用 anet node 在目标机器上修改。`);
            });
            return;
          }
          if (typeof data?.config_revision === 'number') snap = data;
        } catch { /* transient — retry until the 30s ceiling */ }
        if (!isCurrent(runId) || settledRef.current) return;
        if (snap && (snap.config_revision as number) > baseRevision) {
          syncFromSnapshot(snap);
          finishApplied(runId);
          return;
        }
        if (Date.now() - startedAt >= APPLY_TIMEOUT_MS) { markTimeout(runId); return; }
        poll(startedAt);
      });
    };

    (async () => {
      let d: Record<string, unknown> = {};
      try {
        const r = await fetchJson('/api/anet/node-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: nodeKey, base_revision: baseRevision, ...(s.network_id ? { network_id: s.network_id } : {}), ...patch }),
        }, FETCH_TIMEOUT_MS);
        if (!isCurrent(runId)) return;
        d = r.data;
        if (!r.res.ok || d?.ok === false) {
          settledRef.current = true;
          setPhase('error');
          setPhaseMsg(`${mapUpdateError(d)}。当前请用 anet node 在目标机器上修改。`);
          // On a revision conflict, refresh the snapshot so a retry uses the
          // latest base_revision (and the form shows the other writer's values).
          if (d?.error === 'revision_conflict') {
            try {
              const g = await fetch(`/api/anet/node-config?node_id=${encodeURIComponent(nodeKey)}`, { cache: 'no-store' });
              const gd = await g.json().catch(() => ({}));
              if (mounted.current && typeof gd?.config_revision === 'number') syncFromSnapshot(gd);
            } catch { /* leave as-is */ }
          }
          return;
        }
      } catch (e) {
        if (!isCurrent(runId)) return;
        settledRef.current = true;
        setPhase('error');
        setPhaseMsg(isAbort(e) ? '保存超时，请重试' : e instanceof Error ? `保存失败：${e.message}。当前请用 anet node 在目标机器上修改。` : '保存失败。当前请用 anet node 在目标机器上修改。');
        return;
      }

      // Accepted → optimistic "applying"; apply_mode flavours the progress copy.
      setDirty(false);
      setApplyMode(typeof d.apply_mode === 'string' ? (d.apply_mode as string) : null);
      setPhase('applying');
      // Hard 30s ceiling regardless of poll/hub state (通信牛 review #11 blocker 2).
      after(APPLY_TIMEOUT_MS, () => markTimeout(runId));
      poll(Date.now());
    })();
  }

  async function handleRestart() {
    if (lcBusy) return;
    if (typeof window !== 'undefined' && !window.confirm(`重启节点「${s.alias}」？当前会话会中断，节点将以现有配置重新启动。`)) return;
    setLcBusy(true);
    setLcResult({ tone: 'info', text: '重启指令下发中…' });
    try {
      const r = await fetch('/api/anet/node-lifecycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Pass the node's own network so multi-network users (whose default
        // network may differ from this node's) restart the right node.
        body: JSON.stringify({ node_id: nodeKey, action: 'restart', ...(s.network_id ? { network_id: s.network_id } : {}) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!mounted.current) return;
      if (r.ok && data?.ok) {
        setLcResult({ tone: 'ok', text: '重启已下发，节点正在重启生效中…' });
      } else if (data?.unconfirmed) {
        setLcResult({ tone: 'warn', text: `后端工具未上线：${data?.error || 'restart_node 不可用'}` });
      } else {
        setLcResult({ tone: 'err', text: data?.error ? `重启失败：${data.error}` : '重启失败' });
      }
    } catch (e) {
      if (mounted.current) setLcResult({ tone: 'err', text: `重启失败：${e instanceof Error ? e.message : '网络错误'}` });
    } finally {
      if (mounted.current) setLcBusy(false);
    }
  }

  const scoped = positioning === 'absolute';
  return (
    <>
      {/* Backdrop — 'fixed' mode covers the whole viewport;
          'absolute' mode scopes to the positioned ancestor
          (ChatPane's <aside>) so it only dims the chat column, not
          the sidebar or rail. */}
      <div
        className={scoped
          ? 'absolute inset-0 bg-black/40 z-40'
          : 'fixed inset-0 bg-black/40 z-40'}
        onClick={onClose}
        aria-hidden
      />

      <div
        role="dialog"
        aria-label={`${s.alias} 节点设置`}
        className={scoped
          ? 'absolute top-0 right-0 h-full w-full sm:w-[360px] max-w-[360px] bg-[var(--bg)] border-l border-[var(--border)] z-50 flex flex-col animate-slide-in'
          : 'fixed top-0 right-0 h-[100dvh] w-full sm:w-[440px] bg-[var(--bg)] border-l border-[var(--border)] z-50 flex flex-col shadow-2xl shadow-black/60 animate-slide-in'}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)]">
          <AliasAvatar alias={s.alias} size={26} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--fg)] truncate" title={s.alias}>{s.alias}</div>
            <div className="text-[11px] text-[var(--fg-muted)]">节点设置</div>
          </div>
          <button onClick={onClose} aria-label="关闭设置" className="inline-flex h-9 w-9 items-center justify-center text-[var(--fg-muted)] hover:text-[var(--fg)] rounded-md hover:bg-[var(--hover-tint)]">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {/* E. 基础信息（只读） */}
          <section>
            <SectionTitle>基础信息</SectionTitle>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] divide-y divide-[var(--border)]">
              <InfoRow label="别名" value={s.alias} />
              <InfoRow label="node_id" value={s.node_id || '—'} />
              <InfoRow label="所属 network" value={s.network_id || '—'} />
              <InfoRow label="当前 session" value={s.session_id || '—'} />
              <InfoRow label="在线状态" value={s.status || '—'} />
            </div>
          </section>

          <AvatarSection alias={s.alias} />

          <MuteSection alias={s.alias} />

          {/* B. Runtime + 模型 (model editable) */}
          <section>
            <SectionTitle>Runtime · 模型</SectionTitle>
            <div className="space-y-2.5">
              <div>
                <span className="text-[11px] text-[var(--fg-muted)]">Runtime（只读）</span>
                <div className="mt-0.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[12px] text-[var(--fg-muted)] font-mono">{runtime}</div>
              </div>
              {modelOptions.length > 1 ? (
                <Select label="模型 / Preset" value={model} options={modelOptions} onChange={v => { setModel(v); setDirty(true); }} />
              ) : (
                <label className="block">
                  <span className="text-[11px] text-[var(--fg-muted)]">模型 / Preset</span>
                  <input
                    type="text" value={model} onChange={e => { setModel(e.target.value); setDirty(true); }}
                    placeholder="未配置"
                    className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>
              )}
              <div className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
                <span>图片能力 (imageCapable)</span>
                <span className={`px-1.5 py-0.5 rounded ${imageCapable ? 'bg-green-900/30 text-[var(--success)]' : 'bg-[var(--control-off)] text-[var(--fg-muted)]'}`}>
                  {imageCapable ? '支持' : '不支持'} · 只读
                </span>
              </div>
            </div>
          </section>

          {/* C. 运行模式 / flags (editable) */}
          <section>
            <SectionTitle>运行模式 · flags</SectionTitle>
            <div className="space-y-2">
              <Select
                label="权限模式 permissionMode"
                value={flags.permissionMode}
                options={PERMISSION_MODES}
                onChange={v => setFlag('permissionMode', v)}
              />
              <Toggle
                label="跳过权限确认 dangerouslySkipPermissions"
                checked={flags.dangerouslySkipPermissions}
                onChange={v => setFlag('dangerouslySkipPermissions', v)}
              />
              <div className="grid grid-cols-3 gap-2 pt-0.5">
                <NumberField label="maxTurns" value={flags.maxTurns} onChange={v => setFlag('maxTurns', v)} />
                <NumberField label="budget" value={flags.budget} onChange={v => setFlag('budget', v)} />
                <NumberField label="timeout(s)" value={flags.timeout} onChange={v => setFlag('timeout', v)} />
              </div>
            </div>
          </section>

          {/* Save bar + apply lifecycle (optimistic → applying → revision bump) */}
          <section>
            {(() => {
              const busy = phase === 'saving' || phase === 'applying';
              const btnDisabled = loading || busy || !dirty || snapUnavailable;
              const btnLabel = phase === 'saving' ? '保存中…'
                : phase === 'applying' ? '应用中…'
                : loading ? '加载中…'
                : snapUnavailable ? '配置不可读'
                : dirty ? '保存设置'
                : '无改动';
              return (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={btnDisabled}
                  className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    btnDisabled ? 'bg-[var(--bg-elevated)] text-[var(--fg-dim)] cursor-not-allowed' : 'bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90'
                  }`}
                >
                  {busy && (
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  )}
                  {btnLabel}
                </button>
              );
            })()}

            {/* Lifecycle status strip — the "toast" for the apply outcome. */}
            {phase !== 'idle' && (() => {
              const map: Record<Exclude<ApplyPhase, 'idle'>, { tone: string; icon: string; text: string }> = {
                saving:   { tone: 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]', icon: '·', text: '正在提交配置…' },
                applying: { tone: 'border-cyan-800/50 bg-cyan-900/15 text-[var(--accent-text)]', icon: '↻', text: applyMode === 'hot' ? '已下发，正在热应用…' : applyMode === 'restart' || applyMode === 'restart_only' ? '已下发，节点重启生效中…' : '已下发，正在应用…' },
                applied:  { tone: 'border-green-800/50 bg-green-900/15 text-[var(--success)]', icon: '✓', text: phaseMsg || '配置已生效' },
                rejected: { tone: 'border-red-800/50 bg-red-900/15 text-[var(--danger)]', icon: '✗', text: phaseMsg || '应用被拒绝' },
                timeout:  { tone: 'border-amber-700/50 bg-[var(--warning)]/15/15 text-[var(--warning)]', icon: '⚠', text: phaseMsg || '应用超时未确认' },
                error:    { tone: 'border-red-800/50 bg-red-900/15 text-[var(--danger)]', icon: '✗', text: phaseMsg || '保存失败' },
              };
              const v = map[phase];
              return (
                <div role="status" aria-live="polite" className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] ${v.tone}`}>
                  <span className={`shrink-0 leading-5 ${phase === 'applying' ? 'inline-block animate-spin' : ''}`} aria-hidden>{v.icon}</span>
                  <span>{v.text}</span>
                </div>
              );
            })()}
            {snapUnavailable && (
              <p className="mt-1 text-[11px] text-[var(--warning)]/80">无法读取该节点的配置快照（Hub 不可达或节点离线），暂不能保存。</p>
            )}
            {!snapUnavailable && !capable && (
              <p className="mt-1 text-[11px] text-[var(--fg-dim)]">该节点未在 W1 supervisor 下运行，重启类改动可能不生效。</p>
            )}
          </section>

          {/* A. 接入 Channel — enable/disable editable; per-channel secrets
              stay masked read-only (bot token / app secret / allowFrom live in
              the node's local config.json, not on the wire from this UI). */}
          <section>
            <SectionTitle>接入 Channel</SectionTitle>
            <div className="space-y-2">
              {CHANNELS.map(ch => {
                const enabled = channels.has(ch.key);
                const editable = !ch.roadmap && !loading;
                return (
                  <div key={ch.key} className={`rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] ${ch.roadmap ? 'opacity-50' : ''}`}>
                    <label className={`flex items-center justify-between px-3 py-2 text-sm text-[var(--fg)] ${editable ? 'cursor-pointer hover:bg-[var(--bg-elevated)]' : 'cursor-not-allowed'}`}>
                      <span className="flex items-center gap-2">
                        {ch.label}
                        {ch.roadmap && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--control-off)] text-[var(--fg-muted)]">即将支持</span>}
                      </span>
                      <input
                        type="checkbox"
                        checked={!ch.roadmap && enabled}
                        onChange={editable ? () => toggleChannel(ch.key) : undefined}
                        disabled={!editable}
                        aria-label={`${editable ? '启用/关闭' : '（暂不可切换）'} ${ch.label}`}
                        className={`h-4 w-4 accent-cyan-500 ${editable ? '' : 'cursor-not-allowed'}`}
                      />
                    </label>
                    {!ch.roadmap && enabled && ch.fields.length > 0 && (
                      <div className="px-3 pb-3 pt-1 space-y-2 border-t border-[#1c1c1f]">
                        {ch.fields.map(f => <StubField key={f.label} label={f.label} value={f.value} />)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-[var(--fg-dim)]">勾选启用/关闭该 Channel；per-channel 的 token / secret / allowFrom 仍保存在节点本地 config.json，不在此处编辑。</p>
          </section>

          {/* D. 节点操作 (M1 lifecycle — restart wired to RFC-024 restart_node;
              rename/stop/delete gated on backend, shown as 即将支持). */}
          <section>
            <SectionTitle>节点操作</SectionTitle>
            <button
              type="button"
              onClick={handleRestart}
              disabled={lcBusy}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[13px] font-medium transition-colors ${
                lcBusy
                  ? 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg-dim)] cursor-not-allowed'
                  : 'border-amber-700/50 bg-[var(--warning)]/15/15 text-[var(--warning)] hover:bg-[var(--warning)]/15/25'
              }`}
            >
              {lcBusy && (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              )}
              重启节点
            </button>
            {lcResult && (() => {
              const tone = lcResult.tone === 'ok' ? 'border-green-800/50 bg-green-900/15 text-[var(--success)]'
                : lcResult.tone === 'warn' ? 'border-amber-700/50 bg-[var(--warning)]/15/15 text-[var(--warning)]'
                : lcResult.tone === 'err' ? 'border-red-800/50 bg-red-900/15 text-[var(--danger)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]';
              return (
                <div role="status" aria-live="polite" className={`mt-2 rounded-lg border px-3 py-2 text-[12px] ${tone}`}>
                  {lcResult.text}
                </div>
              );
            })()}
            {/* Usability audit (Vincent 07-16 "看到的必须能用"): the greyed
                重命名/停止/删除 tiles claimed "即将支持 / 后端待上线" — no longer
                true for stop/delete (RFC-027 shipped; the per-node ⋮ menu on
                /nodes runs them for real) and dead tiles violate the no-dead-
                controls rule. Tiles removed; copy points at the live surface.
                Rename ships with the D1 remainder (RFC-010 backend is ready)
                and returns here as a real control then. */}
            {lifecycleCaps?.rename && (
              <div className="mt-3">
                <span className="text-[11px] text-[var(--fg-muted)]">重命名节点（RFC-010，全网别名同步更新）</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    value={renameVal}
                    onChange={e => setRenameVal(e.target.value)}
                    placeholder={s.alias}
                    disabled={lcBusy}
                    className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[12px] text-[var(--fg)] placeholder:text-[var(--fg-dim)] focus:border-cyan-500/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={lcBusy || !renameVal.trim() || renameVal.trim() === s.alias}
                    onClick={async () => {
                      const newName = renameVal.trim();
                      if (!newName || newName === s.alias) return;
                      setLcBusy(true);
                      setLcResult({ tone: 'info', text: `重命名中 → ${newName}…` });
                      try {
                        const res = await fetch('/api/anet/node-lifecycle', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            node_id: nodeKey,
                            action: 'rename',
                            new_name: newName,
                            ...(s.network_id ? { network_id: s.network_id } : {}),
                          }),
                        });
                        const d = await res.json().catch(() => ({}));
                        if (res.ok && d?.ok !== false) {
                          setLcResult({ tone: 'ok', text: `已重命名为「${newName}」— 各界面将随 node.renamed 事件自动更新` });
                          setRenameVal('');
                        } else {
                          setLcResult({ tone: 'err', text: d?.unconfirmed ? '当前 hub 尚未支持重命名（工具未部署）' : `重命名失败：${d?.error || res.status}` });
                        }
                      } catch (e) {
                        setLcResult({ tone: 'err', text: `重命名失败：${e instanceof Error ? e.message : String(e)}` });
                      } finally {
                        setLcBusy(false);
                      }
                    }}
                    className="shrink-0 rounded-md border border-cyan-700/50 bg-cyan-900/20 px-3 py-1.5 text-[12px] text-[var(--accent-text)] transition-colors hover:bg-cyan-900/35 disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-[var(--bg-elevated)] disabled:text-[var(--fg-dim)]"
                  >
                    重命名
                  </button>
                </div>
              </div>
            )}
            <p className="mt-2 text-[11px] text-[var(--fg-dim)]">停止 / 删除请在节点列表的 ⋮ 菜单操作{lifecycleCaps?.rename ? '' : '；重命名功能即将在此提供'}。</p>
          </section>
        </div>
      </div>

      <style jsx global>{`
        @keyframes node-settings-slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in { animation: node-settings-slide-in 0.2s ease-out; }
      `}</style>
    </>
  );
}
