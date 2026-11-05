'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { timeAgo } from '../../components/utils';
import { EmptyState } from '../../components/EmptyState';
import { AliasAvatar } from '../../components/AliasAvatar';
import useSWR from 'swr';

// Without the res.ok check a 401 or 500 carrying a JSON body resolves as a
// successful load, so SWR reports no error and the page renders whatever the
// error payload happened to contain — or an empty list, which is
// indistinguishable from "you have no networks".
const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

interface Network {
  network_id: string;
  network_name: string;
  owner_id: string;
  description: string;
  created_at: string;
}

interface Member {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  joined_at: string;
}

export default function NetworksPage() {
  const { data, error, mutate } = useSWR('/api/hub/networks', fetcher, { refreshInterval: 10000 });
  const networks: Network[] = data?.networks || [];
  // 读失败不能落到「No networks found + 建一个」：那条文案会让人以为
  // 自己没有任何网络，从而重复创建。loading 也要排除 error，否则转圈不休。
  const loadFailed = Boolean(error);
  const unsupported = Boolean(data?.unavailable);
  const loading = !data && !loadFailed;

  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [result, setResult] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expandedNetwork, setExpandedNetwork] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteCode, setInviteCode] = useState('');

  const getToken = () => {
    try {
      const saved = sessionStorage.getItem('anet_v3_auth');
      if (saved) return JSON.parse(saved).token;
    } catch {}
    return '';
  };

  const createNetwork = async () => {
    if (!newName.trim()) return;
    const token = getToken();
    if (!token) { setResult('V3 auth required — sign in via Agent Network login'); return; }
    const res = await fetch('/api/hub/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_network', token, name: newName, description: newDesc }),
    });
    const d = await res.json();
    setResult(d.ok ? `Created: ${d.network_id}` : `Failed: ${d.error}`);
    if (d.ok) { setNewName(''); setNewDesc(''); mutate(); }
    setTimeout(() => setResult(''), 5000);
  };

  const deleteNetwork = async (networkId: string) => {
    const token = getToken();
    if (!token) return;
    const res = await fetch('/api/hub/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_network', token, network_id: networkId }),
    });
    const d = await res.json();
    setResult(d.ok ? 'Deleted' : `Failed: ${d.error}`);
    setConfirmDelete(null);
    if (d.ok) mutate();
    setTimeout(() => setResult(''), 5000);
  };

  const fetchMembers = async (networkId: string) => {
    const token = getToken();
    if (!token) return;
    const res = await fetch(`/api/hub/auth?endpoint=/api/networks/${networkId}/members&token=${token}`);
    const d = await res.json();
    setMembers(prev => ({ ...prev, [networkId]: d.members || [] }));
  };

  const generateInvite = async (networkId: string) => {
    const token = getToken();
    if (!token) return;
    const res = await fetch('/api/hub/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invite_member', token, network_id: networkId, role: inviteRole }),
    });
    const d = await res.json();
    if (d.ok && d.invite_code) setInviteCode(d.invite_code);
    else setResult(`Invite failed: ${d.error}`);
  };

  return (
    <div className="min-h-screen bg-[#0b0b0d] text-gray-100 p-4 sm:p-6">
      {/* #217 D9: back link stacks above the title instead of sitting
          beside it — the old single row read as an off-balance
          "← Settings   Networks" pair on phones. */}
      <div className="mb-6">
        <Link href="/settings" className="inline-block text-[var(--fg-muted)] hover:text-[var(--fg)] text-sm lg:ml-0 ml-10 mb-1">&larr; Settings</Link>
        <h1 className="text-2xl font-bold text-[var(--fg)]">Networks</h1>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Create */}
        <section className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-[var(--fg)] mb-3">Create Network</h2>
          <div className="space-y-3">
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Network name"
              className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-base sm:text-sm text-[var(--fg)] placeholder-gray-600 focus:border-cyan-500/50 focus:outline-none" />
            <input type="text" value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Description (optional)"
              className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-base sm:text-sm text-[var(--fg)] placeholder-gray-600 focus:border-cyan-500/50 focus:outline-none" />
            <button onClick={createNetwork} disabled={!newName.trim()}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-800 text-[var(--fg)] text-sm rounded-lg transition-colors">
              Create
            </button>
          </div>
          {result && <div className={`mt-2 text-xs ${result.startsWith('Failed') || result.startsWith('V3') || result.startsWith('Invite') ? 'text-[var(--danger)]' : 'text-[var(--success)]'}`}>{result}</div>}
        </section>

        {/* List */}
        <section className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-[var(--fg)]">My Networks</h2>
            {/* #217 D9: "N TOTAL" counter dropped below 4 rows — counting
                a visibly one-item list is noise (D6 conditional rule). */}
            {networks.length > 3 && (
              <span className="text-[11px] text-[var(--fg-dim)] uppercase tracking-wide">{networks.length} total</span>
            )}
          </div>
          {loadFailed ? (
            <div role="alert" data-testid="networks-load-error" className="rounded-lg bg-[var(--bg-secondary)] px-3 py-3 text-sm">
              <div className="text-[var(--fg)]">读不到网络列表</div>
              <div className="mt-1 text-xs text-[var(--fg-muted)]">
                {error instanceof Error ? error.message : String(error)} · 这不代表你没有网络，请先确认 Hub 可达，不要重复创建。
              </div>
              <button
                type="button"
                onClick={() => mutate()}
                className="mt-2 rounded-md bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--fg)] hover:bg-[var(--hover-tint)]"
              >
                重试
              </button>
            </div>
          ) : unsupported ? (
            <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-3 text-sm text-[var(--fg-muted)]">
              这版 Hub 没有网络管理接口（`/api/networks` 404），这里不显示网络列表。
            </div>
          ) : loading ? (
            <div className="animate-pulse space-y-2">{[1,2].map(i => <div key={i} className="h-14 bg-gray-800/20 rounded" />)}</div>
          ) : networks.length === 0 ? (
            <EmptyState
              variant="networks"
              compact
              sub="Create your first network above, or sign in with V3 auth to see existing ones."
            />
          ) : (
            <div className="space-y-3">
              {networks.map(n => (
                <div key={n.network_id} className="bg-[var(--bg)] rounded-lg px-4 py-3 border border-[var(--border)]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <AliasAvatar alias={n.network_name} size={28} />
                      <div className="min-w-0">
                        <div className="text-sm text-[var(--fg)] font-medium truncate">{n.network_name}</div>
                        <div className="text-[11px] text-[var(--fg-muted)] font-mono truncate" title={n.network_id}>{n.network_id} · {timeAgo(n.created_at)}</div>
                        {n.description && <div className="text-xs text-[var(--fg-muted)] mt-1">{n.description}</div>}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => {
                        if (expandedNetwork === n.network_id) { setExpandedNetwork(null); return; }
                        setExpandedNetwork(n.network_id);
                        fetchMembers(n.network_id);
                      }} className="text-xs text-cyan-400 hover:text-cyan-300 px-2 py-1 rounded border border-cyan-800/30 hover:bg-cyan-500/10">
                        {expandedNetwork === n.network_id ? 'Hide' : 'Members'}
                      </button>
                      {confirmDelete === n.network_id ? (
                        <>
                          <button onClick={() => deleteNetwork(n.network_id)} className="text-xs text-[var(--danger)] px-2 py-1 rounded border border-red-800/30 bg-red-500/10">Confirm</button>
                          <button onClick={() => setConfirmDelete(null)} className="text-xs text-[var(--fg-muted)]">Cancel</button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmDelete(n.network_id)} className="text-xs text-[var(--danger)] hover:text-red-300 px-2 py-1 rounded border border-red-800/30 hover:bg-red-500/10">
                          Delete
                        </button>
                      )}
                    </div>
                  </div>

                  {expandedNetwork === n.network_id && (
                    <div className="mt-3 pt-3 border-t border-[var(--border)]">
                      <div className="text-xs text-[var(--fg-muted)] mb-2">Members ({(members[n.network_id] || []).length})</div>
                      {(members[n.network_id] || []).length === 0 ? (
                        <div className="text-[11px] text-[var(--fg-dim)]">No members or V3 auth required</div>
                      ) : (
                        (members[n.network_id] || []).map(m => {
                          const name = m.username || m.display_name || '?';
                          return (
                          <div key={m.user_id} className="flex items-center gap-2 justify-between text-xs py-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <AliasAvatar alias={name} size={16} />
                              <span className="text-[var(--fg)] truncate">{name}</span>
                            </div>
                            <span className={`px-1.5 py-0.5 rounded border text-[11px] shrink-0 ${
                              m.role === 'owner' ? 'text-yellow-300 border-yellow-500/20' : 'text-[var(--fg-muted)] border-gray-600/20'
                            }`}>{m.role}</span>
                          </div>
                          );
                        })
                      )}

                      {/* Invite */}
                      <div className="mt-3 pt-3 border-t border-[var(--border)]">
                        <div className="text-xs text-[var(--fg-muted)] mb-2">Invite</div>
                        <div className="flex gap-2">
                          <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                            className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-base sm:text-xs text-[var(--fg)] focus:outline-none">
                            <option value="member">member</option>
                            <option value="admin">admin</option>
                            <option value="viewer">viewer</option>
                          </select>
                          <button onClick={() => generateInvite(n.network_id)}
                            className="px-2 py-1 bg-green-600 hover:bg-green-500 text-[var(--fg)] text-xs rounded">
                            Generate Code
                          </button>
                        </div>
                        {inviteCode && (
                          <div className="mt-2 bg-green-500/5 border border-green-500/20 rounded px-3 py-2">
                            <div className="flex items-center justify-between mb-1">
                              <div className="text-[11px] text-[var(--success)] uppercase tracking-wide">Invite code</div>
                              <button
                                type="button"
                                onClick={() => { navigator.clipboard?.writeText(inviteCode).catch(() => {}); }}
                                className="text-[11px] text-green-300 hover:text-green-200 px-1.5 py-0.5 rounded border border-green-500/20 hover:bg-green-500/10"
                              >
                                Copy
                              </button>
                            </div>
                            <code className="text-xs text-green-300 select-all break-all">{inviteCode}</code>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
