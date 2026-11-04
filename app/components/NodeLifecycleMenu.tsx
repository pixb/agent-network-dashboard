'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { NodeAttrsEditor } from './NodeAttrsEditor';
import type { NodeAttrsSnapshot } from '../lib/hooks';

// RFC-027 PR2 — per-node ⋮ lifecycle menu + stop/delete modals.
//
// State-aware menu items (RFC-027 §3.1 table):
//   active            → 重启 / 停止 / 删除
//   stopping/deleting → loading (all disabled,菜单 surfaces "请稍候")
//   stopped           → 启动 / 删除 (停止 灰掉 — already stopped)
//   stop_failed       → 启动 / 删除 (warn — operator should investigate)
//
// Stop modal: low-friction confirm (RFC-027 §3.3)
// Delete modal: alias-input confirm + force-on-in-flight checkbox
//   (RFC-027 §3.2; mirrors hub's confirm_alias gate + force semantics).
//
// Error propagation per 通信龙 PR2 requirement: structured payloads
// from hub (node_not_active / cannot_delete_daemon_via_delete_node /
// node_busy_in_flight / confirm_alias_mismatch / forbidden_cross_tenant)
// land in `lastError` with their real fields surfaced in the UI — no
// generic "操作失败".
//
// React rules-of-hooks: all hooks declared BEFORE early returns.

export type LifecycleState =
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'stop_failed'
  | 'deleting'
  | string;   // forward-compat for unknown server values

export interface NodeLifecycleMenuProps {
  nodeId: string;
  alias: string;
  lifecycleState: LifecycleState | null | undefined;
  networkId?: string | null;
  /** Called when a lifecycle op completes successfully (caller refreshes nodes list). */
  onCompleted?: () => void;
  /** #492 goal-3: current display attrs from parent SWR cache.
   *  Optional — when absent, the "编辑属性" menu item hides so we
   *  don't render an editor with unknown baseline revision. */
  attrsSnapshot?: NodeAttrsSnapshot;
}

type LifecycleAction = 'restart' | 'stop' | 'delete';

type ApiReply = {
  ok?: boolean;
  error?: string;
  message?: string;
  in_flight_count?: number;
  hint?: string;
  lifecycle_state?: string;
  unconfirmed?: boolean;
  [k: string]: unknown;
};

const normalizeState = (s: LifecycleState | null | undefined): LifecycleState =>
  (typeof s === 'string' && s.length > 0 ? s : 'active');

/** Lifecycle capability probe (usability-audit rule: no dead buttons).
 *  GET /api/anet/node-lifecycle reports which hub tools actually exist —
 *  hubs behind the canonical train lack rename/stop/delete. SWR dedupes the
 *  probe across every menu instance on /nodes (one fetch, 60s server cache).
 *  `null` = unknown (loading / probe failed): callers keep today's behavior
 *  for known-live actions (restart) and stay conservative for new ones. */
export function useLifecycleCaps(): Record<string, boolean> | null {
  const { data } = useSWR<{ ok: boolean; tools?: Record<string, boolean> }>(
    '/api/anet/node-lifecycle',
    // Non-2xx must reject, or SWR treats an error payload as data.
    async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    { revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false },
  );
  return data?.ok && data.tools ? data.tools : null;
}

async function callLifecycle(
  action: LifecycleAction,
  body: Record<string, unknown>,
): Promise<ApiReply & { httpStatus: number }> {
  try {
    const r = await fetch('/api/anet/node-lifecycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    const data = (await r.json().catch(() => ({}))) as ApiReply;
    return { ...data, httpStatus: r.status };
  } catch (e: unknown) {
    return {
      ok: false,
      error: 'network_error',
      message: e instanceof Error ? e.message : String(e),
      httpStatus: 0,
    };
  }
}

export function NodeLifecycleMenu({
  nodeId,
  alias,
  lifecycleState,
  networkId,
  onCompleted,
  attrsSnapshot,
}: NodeLifecycleMenuProps) {
  // All hooks above any early return (avoid hooks-order regression that
  // bit the mobile app at v0.1.29; 通信龙 explicit call-out for PR2).
  const caps = useLifecycleCaps();
  const [menuOpen, setMenuOpen] = useState(false);
  const [stopModal, setStopModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [attrsModal, setAttrsModal] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [lastError, setLastError] = useState<ApiReply | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape close the menu (focus management).
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onRestart = useCallback(async () => {
    setMenuOpen(false);
    setLastError(null);
    setRestartBusy(true);
    const r = await callLifecycle('restart', {
      node_id: nodeId,
      ...(networkId ? { network_id: networkId } : {}),
    });
    setRestartBusy(false);
    if (r.ok) {
      onCompleted?.();
      return;
    }
    setLastError(r);
  }, [nodeId, networkId, onCompleted]);

  const state = normalizeState(lifecycleState);
  const isLoading = state === 'stopping' || state === 'deleting';
  const isActive = state === 'active';
  const isStopped = state === 'stopped' || state === 'stop_failed';

  // Menu items per RFC-027 §3.1 table.
  const items: Array<{ label: string; key: string; danger?: boolean; onClick: () => void; disabled?: boolean }> = [];
  if (isLoading) {
    items.push({
      label: state === 'stopping' ? '停止中…' : '删除中…',
      key: 'loading', disabled: true, onClick: () => {},
    });
  } else if (isActive) {
    items.push({ label: restartBusy ? '重启中…' : '重启节点', key: 'restart', disabled: restartBusy, onClick: onRestart });
    // #492 goal-3: attribute editor — available in every non-loading
    // state (you can edit a stopped node's metadata too). Hidden when
    // parent didn't hand us a baseline snapshot (older callers).
    if (attrsSnapshot) items.push({ label: '编辑属性', key: 'edit-attrs', onClick: () => { setMenuOpen(false); setAttrsModal(true); } });
    if (caps === null || caps.stop) items.push({ label: '停止节点', key: 'stop', onClick: () => { setMenuOpen(false); setStopModal(true); } });
    if (caps === null || caps.delete) items.push({ label: '删除节点', key: 'delete', danger: true, onClick: () => { setMenuOpen(false); setDeleteModal(true); } });
  } else if (isStopped) {
    // stopped + stop_failed: "启动" = restart_node (hub resets lifecycle_state→active on success per PR1.2a)
    items.push({ label: restartBusy ? '启动中…' : '启动节点', key: 'restart', disabled: restartBusy, onClick: onRestart });
    if (attrsSnapshot) items.push({ label: '编辑属性', key: 'edit-attrs', onClick: () => { setMenuOpen(false); setAttrsModal(true); } });
    items.push({ label: '删除节点', key: 'delete', danger: true, onClick: () => { setMenuOpen(false); setDeleteModal(true); } });
  } else {
    // Unknown state — surface read-only badge, no destructive action.
    items.push({
      label: `状态 ${state} (不识别)`,
      key: 'unknown', disabled: true, onClick: () => {},
    });
  }

  return (
    <div ref={menuRef} className="relative inline-block" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`节点 ${alias} 生命周期操作`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(v => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {menuOpen && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-lg border border-[#26262b] bg-[#161618] shadow-xl">
          {items.map(item => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={item.onClick}
              className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                item.disabled
                  ? 'text-gray-600 cursor-not-allowed'
                  : item.danger
                    ? 'text-red-300 hover:bg-red-900/20'
                    : 'text-gray-200 hover:bg-[var(--hover-tint)]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Last error inline (under the button) — pass-through hub's structured fields */}
      {lastError && lastError.ok === false && !stopModal && !deleteModal && (
        <div className="absolute right-0 z-40 mt-1 w-72 rounded-md border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{lastError.error || 'error'}</div>
              {lastError.message ? <div className="mt-0.5 text-red-300/80">{lastError.message}</div> : null}
              {typeof lastError.in_flight_count === 'number' && (
                <div className="mt-0.5 text-red-300/80">in-flight: {lastError.in_flight_count}</div>
              )}
              {lastError.hint ? <div className="mt-1 text-red-300/60">{lastError.hint}</div> : null}
            </div>
            <button type="button" onClick={() => setLastError(null)} className="shrink-0 text-red-400 hover:text-red-200" aria-label="关闭">×</button>
          </div>
        </div>
      )}

      {stopModal && (
        <StopNodeModal
          alias={alias}
          nodeId={nodeId}
          networkId={networkId}
          onClose={() => setStopModal(false)}
          onCompleted={() => { setStopModal(false); onCompleted?.(); }}
        />
      )}
      {deleteModal && (
        <DeleteNodeModal
          alias={alias}
          nodeId={nodeId}
          networkId={networkId}
          onClose={() => setDeleteModal(false)}
          onCompleted={() => { setDeleteModal(false); onCompleted?.(); }}
        />
      )}
      {attrsModal && attrsSnapshot && (
        <NodeAttrsEditor
          alias={alias}
          nodeId={nodeId}
          snapshot={attrsSnapshot}
          onClose={() => setAttrsModal(false)}
          onSaved={() => { onCompleted?.(); }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────

interface ModalProps {
  alias: string;
  nodeId: string;
  networkId?: string | null;
  onClose: () => void;
  onCompleted: () => void;
}

function StopNodeModal({ alias, nodeId, networkId, onClose, onCompleted }: ModalProps) {
  const [busy, setBusy] = useState(false);
  const [force, setForce] = useState(false);
  const [reply, setReply] = useState<ApiReply | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const inFlight = reply && typeof reply.in_flight_count === 'number' ? reply.in_flight_count : 0;

  const onConfirm = async () => {
    setBusy(true);
    setReply(null);
    const r = await callLifecycle('stop', {
      node_id: nodeId,
      ...(networkId ? { network_id: networkId } : {}),
      ...(force ? { force: true } : {}),
    });
    setBusy(false);
    if (r.ok) { onCompleted(); return; }
    setReply(r);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={busy ? undefined : onClose} aria-hidden />
      <div role="dialog" aria-label={`停止节点 ${alias}`} className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[#26262b] bg-[#161618] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#26262b] px-4 py-3">
          <div className="text-sm font-semibold text-white">停止节点</div>
          <button onClick={busy ? undefined : onClose} aria-label="关闭" className="text-gray-500 hover:text-white">×</button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <div className="text-sm text-gray-300">
            将停止 <span className="font-mono text-cyan-300">{alias}</span> 子进程（SIGTERM，~10s 内）。配置目录保留，可通过「启动」恢复。
          </div>
          {/* Surface hub's structured payload field-by-field; never collapse to generic */}
          {reply && reply.ok === false && (
            <div className="rounded-md border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">
              <div className="font-semibold">{reply.error}</div>
              {reply.message ? <div className="mt-0.5 text-red-300/80">{reply.message}</div> : null}
              {typeof reply.in_flight_count === 'number' && (
                <div className="mt-0.5 text-red-300/80">
                  当前 in-flight 任务: {reply.in_flight_count}
                </div>
              )}
              {reply.hint ? <div className="mt-1 text-red-300/60">{reply.hint}</div> : null}
            </div>
          )}
          {(inFlight > 0 || force) && (
            <label className="flex items-start gap-2 rounded-md border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-xs text-amber-200">
              <input
                type="checkbox"
                checked={force}
                onChange={e => setForce(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-semibold text-amber-300">强制停止</span>{inFlight > 0 ? `（会丢弃 ${inFlight} 条待处理任务）` : '（覆盖 in-flight 拒绝；hub 会写 audit 行）'}
              </span>
            </label>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#26262b] px-4 py-3">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50">取消</button>
          <button
            type="button"
            disabled={busy || (inFlight > 0 && !force)}
            onClick={onConfirm}
            className="rounded-md bg-cyan-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? '停止中…' : '确认停止'}
          </button>
        </div>
      </div>
    </>
  );
}

function DeleteNodeModal({ alias, nodeId, networkId, onClose, onCompleted }: ModalProps) {
  const [busy, setBusy] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [force, setForce] = useState(false);
  const [keepConfig, setKeepConfig] = useState(false);
  const [reply, setReply] = useState<ApiReply | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const inFlight = reply && typeof reply.in_flight_count === 'number' ? reply.in_flight_count : 0;
  const confirmValid = confirmInput === alias;

  const onConfirm = async () => {
    if (!confirmValid) return;
    setBusy(true);
    setReply(null);
    const r = await callLifecycle('delete', {
      node_id: nodeId,
      confirm_alias: confirmInput,
      ...(networkId ? { network_id: networkId } : {}),
      ...(force ? { force: true } : {}),
      ...(keepConfig ? { delete_config: false } : {}),
    });
    setBusy(false);
    if (r.ok) { onCompleted(); return; }
    setReply(r);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={busy ? undefined : onClose} aria-hidden />
      <div role="dialog" aria-label={`删除节点 ${alias}`} className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-red-700/40 bg-[#161618] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#26262b] px-4 py-3">
          <div className="text-sm font-semibold text-red-300">删除节点</div>
          <button onClick={busy ? undefined : onClose} aria-label="关闭" className="text-gray-500 hover:text-white">×</button>
        </div>
        <div className="space-y-3 px-4 py-4 text-sm text-gray-300">
          <div>这将：</div>
          <ul className="list-inside list-disc space-y-1 pl-2 text-xs text-gray-400">
            <li>停止 <span className="font-mono text-cyan-300">{alias}</span> 子进程（SIGTERM ~10s）</li>
            <li>从 hub 注销该节点</li>
            <li>撤销该节点的 ntok</li>
            {!keepConfig && <li>配置文件备份到 <code className="text-amber-300">~/.anet/deleted/&lt;ts&gt;-{alias}/</code>（30 天后自动清除）</li>}
            {keepConfig && <li className="text-amber-300">配置文件保留原地（不备份不清理 — 你勾选了「保留配置」）</li>}
          </ul>

          {/* Surface hub's structured payload field-by-field */}
          {reply && reply.ok === false && (
            <div className="rounded-md border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">
              <div className="font-semibold">{reply.error}</div>
              {reply.message ? <div className="mt-0.5 text-red-300/80">{reply.message}</div> : null}
              {typeof reply.in_flight_count === 'number' && (
                <div className="mt-0.5 text-red-300/80">当前 in-flight 任务: {reply.in_flight_count}</div>
              )}
              {reply.hint ? <div className="mt-1 text-red-300/60">{reply.hint}</div> : null}
            </div>
          )}

          {(inFlight > 0 || force) && (
            <label className="flex items-start gap-2 rounded-md border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-xs text-amber-200">
              <input
                type="checkbox"
                checked={force}
                onChange={e => setForce(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-semibold text-amber-300">强制删除</span>{inFlight > 0 ? `（会丢弃 ${inFlight} 条待处理任务）` : '（覆盖 in-flight 拒绝）'}
              </span>
            </label>
          )}

          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={keepConfig} onChange={e => setKeepConfig(e.target.checked)} />
            保留配置目录（不备份；高级用法）
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-gray-400">输入节点名字 <span className="font-mono text-cyan-300">{alias}</span> 确认</span>
            <input
              autoFocus
              value={confirmInput}
              onChange={e => setConfirmInput(e.target.value)}
              placeholder={alias}
              className="w-full rounded-md border border-[#26262b] bg-[#0e0e10] px-3 py-2 text-sm text-gray-200 focus:border-red-500 focus:outline-none"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            {confirmInput && !confirmValid && (
              <span className="text-[11px] text-red-400">名字不匹配（区分大小写）</span>
            )}
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#26262b] px-4 py-3">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50">取消</button>
          <button
            type="button"
            disabled={busy || !confirmValid || (inFlight > 0 && !force)}
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? '删除中…' : `删除 ${alias}`}
          </button>
        </div>
      </div>
    </>
  );
}
