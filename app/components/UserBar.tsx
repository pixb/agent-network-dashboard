'use client';

import { useEffect, useState } from 'react';
import { useNetworkId } from '../lib/network-context';
import { clearPrivateChatStorage } from '../lib/chat-outbox';

interface User {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
}

interface Network {
  network_id: string;
  network_name: string;
  description: string;
}

interface AuthState {
  user: User | null;
  networks: Network[];
  currentNetwork: string;
  token: string;
}

export function UserBar() {
  const { setNetworkId } = useNetworkId();
  const [auth, setAuth] = useState<AuthState>({ user: null, networks: [], currentNetwork: '', token: '' });
  const [showLogin, setShowLogin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginPending, setLoginPending] = useState(false);

  // Try to restore from sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem('anet_v3_auth');
    if (saved) {
      // Hydration-safe restore: a lazy initializer would make server and
      // client first paints disagree; the one-shot effect keeps them equal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      try { setAuth(JSON.parse(saved)); } catch {}
    }
  }, []);

  const doAuth = async (action: 'login' | 'register') => {
    if (!username.trim() || !password.trim()) return;
    setLoginPending(true);
    setLoginError('');
    try {
      const res = await fetch('/api/hub/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, username, password }),
      });
      const data = await res.json();
      if (!data.ok) { setLoginError(data.error || 'Failed'); setLoginPending(false); return; }

      // Fetch user details
      const meRes = await fetch(`/api/hub/auth?token=${data.token}&endpoint=/api/auth/me`);
      const meData = await meRes.json();

      const newAuth: AuthState = {
        user: data.user,
        networks: meData.networks || [],
        currentNetwork: meData.current_network?.network_id || meData.networks?.[0]?.network_id || '',
        token: data.token,
      };
      setAuth(newAuth);
      sessionStorage.setItem('anet_v3_auth', JSON.stringify(newAuth));
      setShowLogin(false);
      setUsername('');
      setPassword('');
    } catch { setLoginError('Connection failed'); }
    setLoginPending(false);
  };

  const logout = () => {
    setAuth({ user: null, networks: [], currentNetwork: '', token: '' });
    clearPrivateChatStorage();
    sessionStorage.removeItem('anet_v3_auth');
  };

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');

  const updateProfile = async () => {
    try {
      const res = await fetch(`/api/hub/auth?token=${auth.token}&endpoint=/api/auth/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_profile', token: auth.token, display_name: editName, email: editEmail }),
      });
      // Use a direct PUT via a new proxy approach
      const putRes = await fetch('/api/hub/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_profile', token: auth.token, display_name: editName, email: editEmail }),
      });
      const data = await putRes.json();
      if (data.ok && data.user) {
        const updated = { ...auth, user: data.user };
        setAuth(updated);
        sessionStorage.setItem('anet_v3_auth', JSON.stringify(updated));
        setEditing(false);
      }
    } catch {}
  };

  // Don't show anything when not logged in — login page handles that
  if (!auth.user) return null;

  const initials = (auth.user.display_name || auth.user.username).slice(0, 2).toUpperCase();

  return (
    <div className="flex items-center justify-between bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-4 py-2.5 mb-4">
      {/* User info */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-xs font-bold text-[var(--fg)]">
          {initials}
        </div>
        <div>
          <div className="text-sm text-[var(--fg)] font-medium">{auth.user.display_name || auth.user.username}</div>
          <div className="text-[11px] text-[var(--fg-muted)]">{auth.user.role} · {auth.user.user_id}</div>
        </div>
      </div>

      {/* Network switcher */}
      <div className="flex items-center gap-3">
        {auth.networks.length > 0 && (
          <select
            value={auth.currentNetwork}
            onChange={e => {
              const updated = { ...auth, currentNetwork: e.target.value };
              setAuth(updated);
              setNetworkId(e.target.value);
              sessionStorage.setItem('anet_v3_auth', JSON.stringify(updated));
            }}
            className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-base sm:text-xs text-[var(--fg)] focus:outline-none"
          >
            {auth.networks.map(n => (
              <option key={n.network_id} value={n.network_id}>{n.network_name}</option>
            ))}
          </select>
        )}
        <button onClick={() => { setEditName(auth.user?.display_name || ''); setEditEmail(''); setEditing(!editing); }}
          className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] whitespace-nowrap"
          aria-label="Edit profile">
          <span className="hidden sm:inline">Edit</span>
          <svg className="sm:hidden w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487z" />
          </svg>
        </button>
        <button onClick={logout}
          className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] whitespace-nowrap"
          aria-label="Sign out">
          <span className="hidden sm:inline">Sign out</span>
          <svg className="sm:hidden w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
        </button>
      </div>
      {editing && (
        <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-[var(--border)]">
          <input type="text" value={editName} onChange={e => setEditName(e.target.value)} placeholder="Display name"
            className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-base sm:text-xs text-[var(--fg)] placeholder-gray-600 focus:outline-none w-32" />
          <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="Email"
            className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-base sm:text-xs text-[var(--fg)] placeholder-gray-600 focus:outline-none w-40" />
          <button onClick={updateProfile} className="px-2 py-1 bg-[var(--accent)] hover:opacity-90 text-[var(--accent-fg)] text-xs rounded">Save</button>
        </div>
      )}
    </div>
  );
}
