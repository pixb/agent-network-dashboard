'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ProviderFormModal, type ProviderDraft } from '../components/ProviderFormModal';
import { ReachabilityMatrix } from '../components/ReachabilityMatrix';

/**
 * Model providers (RFC-028 P1 — CRUD). Lists providers from
 * /api/anet/providers, with create/edit (ProviderFormModal), an enabled
 * toggle, soft-delete (enabled:0), and a per-row "Test" placeholder for the
 * P2 connectivity matrix. Keys are write-only — the list only shows a
 * key/no-key indicator, never a value.
 *
 * When the hub predates RFC-028 (#308 not merged / hub not upgraded) the API
 * returns `unconfirmed` — we surface an honest banner instead of faking data.
 * Set MOCK_PROVIDERS=1 on the dashboard server to preview the populated UI.
 */

interface Provider {
  provider_id?: string;
  name: string;
  type: string;
  base_url: string;
  models?: string[];
  enabled?: boolean;
  hasKey?: boolean;
}

function hostOf(url: string) {
  try { return new URL(url).host; } catch { return url; }
}

// Humanize the raw vendor enum for the row badge so it matches the create
// modal's wording. A DeepSeek/MiniMax row tagged bare "anthropic" reads as
// wrong — they're Anthropic-*compatible* endpoints, not Anthropic itself.
const TYPE_LABELS: Record<string, string> = {
  anthropic: 'Anthropic 兼容',
  'openai-compatible': 'OpenAI 兼容',
  grok: 'Grok',
  custom: 'Custom',
};
const typeLabel = (t: string) => TYPE_LABELS[t] || t;

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [mock, setMock] = useState(false);
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/anet/providers', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      setProviders(Array.isArray(data?.providers) ? data.providers : []);
      setUnconfirmed(data?.unconfirmed ? (data?.error || 'backend not available') : null);
      setMock(!!data?.mock);
    } catch { setUnconfirmed('request failed'); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  const openCreate = () => { setEditing(null); setShowForm(true); };
  // Edit / enable-disable wired to update_provider (#317). vendor + key are
  // immutable on the backend, so the edit form patches name/base_url/models
  // only (changing the key is a separate secret-first flow).
  const openEdit = (p: Provider) => {
    setEditing({ provider_id: p.provider_id, name: p.name, type: p.type, base_url: p.base_url, models: p.models || [], enabled: p.enabled ?? true, hasKey: p.hasKey });
    setShowForm(true);
  };
  const toggleEnabled = async (p: Provider) => {
    setProviders(prev => prev.map(x => (x.provider_id || x.name) === (p.provider_id || p.name) ? { ...x, enabled: !x.enabled } : x)); // optimistic
    setToggleError(null);
    // The optimistic flip above is corrected by the refetch below, so a failed
    // write used to show as the switch quietly sliding back with no reason
    // given — indistinguishable from a mis-click. Say what happened instead.
    try {
      const res = await fetch('/api/anet/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider_id: p.provider_id, enabled: !p.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setToggleError(`${p.name}: ${e instanceof Error ? e.message : '请求失败'}`);
    }
    fetchProviders();
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4 text-[var(--fg)] sm:p-6">
      <div className="flex items-center gap-4 mb-6">
        <h1 className="ml-10 text-xl font-semibold text-[var(--fg)] lg:ml-0">Model Providers</h1>
        {mock && <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/5 text-amber-300">preview fixture</span>}
        <button
          onClick={openCreate}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--hl)] px-3 py-1.5 text-sm font-medium text-[var(--bg)] hover:opacity-90"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
          新增供应商
        </button>
      </div>
      {toggleError && (
        <div
          data-testid="providers-toggle-error"
          className="mb-4 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--fg-muted)]"
        >
          <span className="text-[var(--fg)]">启用状态未能保存({toggleError})</span>
          <span className="ml-2 text-xs">开关已回到服务端的实际状态,请确认 hub 可达后重试。</span>
        </div>
      )}

      <div className="max-w-3xl space-y-4">
        <p className="text-sm text-[var(--fg-muted)]">
          Configure model providers and per-server reachability. API keys are stored write-only in the secret vault and never displayed.
        </p>

        {unconfirmed && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">
            供应商后端（RFC-028）尚未在当前 hub 就绪：{unconfirmed}。UI 已就位；待 #308 合并 + hub 升级后接真后端。
            <span className="text-amber-400/70">（开发预览可设 MOCK_PROVIDERS=1 看填充态。）</span>
          </div>
        )}

        <section className="rounded-2xl bg-[var(--bg-secondary)] p-5">
          {loading ? (
            <div className="animate-pulse space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-14 rounded bg-[var(--bg-elevated)]" />)}</div>
          ) : providers.length === 0 ? (
            <EmptyState
              variant="generic"
              title="No model providers"
              sub="Add a provider to register its models and test per-server reachability."
              cta={{ label: '新增供应商', onClick: openCreate }}
            />
          ) : (
            <div className="space-y-2">
              {providers.map(p => {
                const rid = p.provider_id || p.name;
                const isOpen = expandedId === rid;
                return (
                <div key={rid} className={`rounded-lg bg-[var(--bg)] ${p.enabled ? '' : 'opacity-60'}`} data-provider={p.name}>
                  <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${p.enabled ? 'bg-[var(--success)]' : 'bg-[var(--fg-dim)]'}`} title={p.enabled ? 'enabled' : 'disabled'} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="truncate text-sm font-semibold text-[var(--fg)]">{p.name}</span>
                          <span className="shrink-0 text-[10px] text-[var(--fg-muted)]" title={p.type}>{typeLabel(p.type)}</span>
                          {p.hasKey
                            ? <span className="shrink-0 text-[10px] text-[var(--success)]">key set</span>
                            : <span className="shrink-0 text-[10px] text-[var(--fg-muted)]">no key</span>}
                        </div>
                        <div className="truncate text-[11px] text-[var(--fg-muted)]">
                          {hostOf(p.base_url)} · {(p.models?.length || 0)} model{(p.models?.length || 0) === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                    <div className="flex w-full shrink-0 items-center justify-end gap-1.5 border-t border-[var(--border)] pt-2 sm:w-auto sm:justify-normal sm:self-auto sm:border-t-0 sm:pt-0">
                      <button
                        type="button"
                        onClick={() => setExpandedId(isOpen ? null : rid)}
                        disabled={!p.enabled}
                        title={p.enabled ? '连通性测试（模型 × 服务器 可达矩阵）' : '供应商已停用，启用后可测连通性'}
                        className={`rounded px-2 py-1 text-[11px] transition-colors ${!p.enabled ? 'cursor-not-allowed text-[var(--fg-dim)]' : isOpen ? 'bg-[var(--bg-elevated)] text-[var(--fg)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'}`}
                      >Test{isOpen ? ' ▾' : ''}</button>
                      <button type="button" onClick={() => openEdit(p)} title="编辑（名称 / base_url / 模型）" className="rounded px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">Edit</button>
                      <button type="button" onClick={() => toggleEnabled(p)} title={p.enabled ? '停用（软删，可重新启用）' : '启用'} className="rounded px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]">
                        {p.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    (p.models?.length || 0) > 0
                      ? <ReachabilityMatrix providerId={p.provider_id} models={p.models || []} />
                      : <div className="border-t border-[var(--border)] px-3 py-3 text-[11px] text-[var(--fg-muted)]">该供应商未配置模型——先 Edit 添加模型再测可达性。</div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </section>

        <p className="text-[11px] text-[var(--fg-muted)]">
          按 <span className="text-[var(--fg)]">Test</span> 展开「模型 × 服务器」连通性矩阵（对每个模型实时探测可达性）。创建节点向导的模型下拉将从此处的 registry 拉取（即将支持）。
        </p>
      </div>

      {showForm && (
        <ProviderFormModal
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={fetchProviders}
        />
      )}
    </div>
  );
}
