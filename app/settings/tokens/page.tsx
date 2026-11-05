'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { timeAgo } from '../../components/utils';
import { EmptyState } from '../../components/EmptyState';

interface Token {
  token_id: string;
  name: string;
  scope: string;
  network_id: string;
  last_used_at: string;
  created_at: string;
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<{ token?: string; error?: string }>({});

  const fetchTokens = useCallback(async () => {
    // A swallowed failure here used to render the empty state, which tells the
    // user they have no tokens and invites them to create one — indistinguishable
    // from a hub that is down, and it invites duplicates. Surface it instead.
    setLoadError(null);
    try {
      const res = await fetch('/api/hub/tokens');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTokens(data.tokens || []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '请求失败');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  const createToken = async () => {
    if (!newName.trim()) return;
    try {
      const saved = sessionStorage.getItem('anet_v3_auth');
      if (!saved) return;
      const { token } = JSON.parse(saved);
      const res = await fetch('/api/hub/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_token', token, name: newName }),
      });
      const data = await res.json();
      if (data.ok) {
        setCreateResult({ token: data.token });
        setNewName('');
        fetchTokens();
      } else {
        setCreateResult({ error: data.error });
      }
    } catch { setCreateResult({ error: 'Failed' }); }
  };

  const revokeToken = async (tokenId: string) => {
    try {
      const saved = sessionStorage.getItem('anet_v3_auth');
      if (!saved) return;
      const { token } = JSON.parse(saved);
      await fetch('/api/hub/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke_token', token, token_id: tokenId }),
      });
      fetchTokens();
    } catch {}
  };

  return (
    <div className="min-h-screen bg-[#0b0b0d] text-gray-100 p-4 sm:p-6">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/settings" className="text-[var(--fg-muted)] hover:text-[var(--fg)] text-sm lg:ml-0 ml-10">&larr; Settings</Link>
        <h1 className="text-2xl font-bold text-[var(--fg)]">API Tokens</h1>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Create token */}
        <section className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-[var(--fg)] mb-3">Create Token</h2>
          <div className="flex gap-2">
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="Token name (e.g. my-cli)"
              className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-base sm:text-sm text-[var(--fg)] placeholder-gray-600 focus:border-[var(--accent)]/50 focus:outline-none" />
            <button onClick={createToken} disabled={!newName.trim()}
              className="px-4 py-2 bg-[var(--accent)] hover:opacity-90 disabled:bg-[var(--bg-elevated)] text-[var(--accent-fg)] disabled:text-[var(--fg-dim)] text-sm rounded-lg transition-colors">
              Create
            </button>
          </div>
          {createResult.token && (
            <div className="mt-3 bg-green-500/5 border border-green-500/20 rounded-lg px-3 py-2">
              <div className="text-xs text-[var(--success)] mb-1">Token created (copy now, shown only once):</div>
              <code className="text-sm text-green-300 break-all select-all">{createResult.token}</code>
            </div>
          )}
          {createResult.error && <div className="mt-2 text-xs text-[var(--danger)]">{createResult.error}</div>}
        </section>

        {/* Token list */}
        <section className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-[var(--fg)] mb-3">Active Tokens ({tokens.length})</h2>
          {loading ? (
            <div className="animate-pulse space-y-2">{[1,2].map(i => <div key={i} className="h-12 bg-[var(--bg-elevated)]/20 rounded" />)}</div>
          ) : loadError ? (
            <div
              data-testid="tokens-load-error"
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-3 text-sm text-[var(--fg-muted)]"
            >
              <div className="text-[var(--fg)]">无法加载 token 列表({loadError})</div>
              <div className="mt-1 text-xs">这不代表你没有 token —— 请先确认 hub 可达,不要重复创建。</div>
              <button
                onClick={() => { setLoading(true); fetchTokens(); }}
                className="mt-2 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
              >重试</button>
            </div>
          ) : tokens.length === 0 ? (
            <EmptyState
              variant="tokens"
              compact
              sub="Tokens authenticate CLI tools and external integrations. Sign in with V3 auth, then create one above."
            />
          ) : (
            <div className="space-y-2">
              {tokens.map(t => (
                <div key={t.token_id} className="flex items-center justify-between bg-[var(--bg)] rounded-lg px-3 py-2 border border-[var(--border)]">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-[var(--fg)] font-medium">{t.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        t.scope === 'full' ? 'text-[var(--accent-text)] border-[var(--accent)]/20 bg-[var(--accent)]/5' : 'text-[var(--fg-muted)] border-gray-600/20'
                      }`}>{t.scope}</span>
                    </div>
                    <div className="text-[10px] text-[var(--fg-muted)]">{t.token_id} · network: {t.network_id?.slice(0, 12) || '--'} · used {timeAgo(t.last_used_at)}</div>
                  </div>
                  <button onClick={() => revokeToken(t.token_id)}
                    className="text-xs text-[var(--danger)] hover:text-red-300 px-2 py-1 rounded border border-red-800/30 hover:bg-[var(--danger)]/10 transition-colors">
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
