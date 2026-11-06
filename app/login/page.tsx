'use client';

import { FormEvent, useState } from 'react';
import { DASHBOARD_VERSION } from '../lib/version';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError('');

    try {
      const res = await fetch('/api/auth/v3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: mode, username, password }),
      });
      const data = await res.json();

      if (data.ok) {
        // Store V3 auth data for client-side features
        if (data.token) {
          sessionStorage.setItem('anet_v3_auth', JSON.stringify({
            user: data.user,
            token: data.token,
            networks: data.networks || [],
            currentNetwork: data.network_id || data.networks?.[0]?.network_id || '',
          }));
        }
        window.location.assign('/');
        return;
      }

      setError(data.error || 'Login failed');
    } catch {
      setError('Connection failed');
    }
    setPending(false);
  };

  return (
    <main className="min-h-screen bg-[#0b0b0d] text-gray-100 flex items-center justify-center relative overflow-hidden px-4 py-10 sm:py-16">
      {/* Subtle off-grid background — restraint over AI-glow.
          Dark themes get a faint radial wash; light themes show a low-contrast
          dotted grid for surface texture without noise. */}
      <div className="absolute inset-0 pointer-events-none anet-login-bg" aria-hidden />
      {/* Soft brand glow behind the card — adds depth to the flat near-black
          field without competing with the form (design-polish #17 R1). */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] h-[460px] rounded-full bg-cyan-500/[0.045] blur-[110px] pointer-events-none" aria-hidden />

      <div className="relative w-full max-w-sm">
        <div className="text-center mb-7">
          {/* Brand mark — uses the favicon 3-node mesh SVG which IS the
              agent-network concept (nodes + edges). Replaces the previous
              flat emerald square placeholder.
              注意：登录页是**固定深色**的品牌屏（不跟随用主题），这里的颜色
              写死是有意的 —— 换成 --accent-text 在浅色主题下会变成深青压在
              深底上。scripts/check-accent-text-ratchet.mjs 对 app/login/**
              做了豁免，新增前请先想清楚是不是还要固定深色。 */}
          <div className="inline-flex items-center justify-center w-16 h-16 mb-4 rounded-2xl bg-[#161618] border border-[#26262b] anet-login-mark">
            <svg className="w-9 h-9" viewBox="0 0 32 32" aria-hidden>
              <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" className="text-cyan-400 anet-login-mark-ring" />
              <line x1="16" y1="10" x2="10" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.5" className="text-cyan-400 anet-login-mark-edge" />
              <line x1="16" y1="10" x2="22" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.5" className="text-cyan-400 anet-login-mark-edge" />
              <line x1="10" y1="20" x2="22" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.5" className="text-cyan-400 anet-login-mark-edge" />
              <circle cx="16" cy="10" r="3" fill="currentColor" className="text-cyan-400 anet-login-mark-node-a" />
              <circle cx="10" cy="20" r="3" fill="currentColor" className="text-green-400 anet-login-mark-node-b" />
              <circle cx="22" cy="20" r="3" fill="currentColor" className="text-violet-400 anet-login-mark-node-c" />
            </svg>
          </div>
          <h1 className="text-[22px] sm:text-2xl font-semibold text-white tracking-tight">Agent Network</h1>
          <p className="text-[12px] text-gray-400 mt-1.5 leading-snug">
            {mode === 'login'
              ? <>Welcome back · <span className="text-gray-500">Tasks · Mesh · Messages</span></>
              : <>Create your account · <span className="text-gray-500">Free preview · no credit card</span></>}
          </p>
        </div>

        {/* Mode toggle */}
        <div className="flex rounded-lg border border-[#26262b] bg-[#161618] p-1 mb-4">
          {(['login', 'register'] as const).map(m => (
            <button key={m} type="button" onClick={() => { setMode(m); setError(''); }}
              className={`flex-1 rounded-md px-3 py-2 text-sm transition-colors ${mode === m ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-500 hover:text-gray-200'}`}>
              {m === 'login' ? 'Sign in' : 'Register'}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="border border-[#26262b] bg-[#161618]/80 backdrop-blur-sm rounded-xl p-6 shadow-2xl shadow-black/30">
          <label htmlFor="username" className="block text-xs text-gray-500 mb-2 uppercase tracking-wider">
            Username
          </label>
          <input id="username" type="text" value={username} onChange={e => setUsername(e.target.value)} autoFocus
            placeholder="Enter username"
            className="w-full bg-[#0e0e10] border border-[#26262b] rounded-lg px-4 py-3 text-base sm:text-sm text-white placeholder-gray-600 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 focus:outline-none transition-all mb-4" />

          <label htmlFor="password" className="block text-xs text-gray-500 mb-2 uppercase tracking-wider">
            Password
          </label>
          <div className="relative">
            <input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full bg-[#0e0e10] border border-[#26262b] rounded-lg px-4 pr-11 py-3 text-base sm:text-sm text-white placeholder-gray-600 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 focus:outline-none transition-all" />
            <button
              type="button"
              onClick={() => setShowPassword(s => !s)}
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex items-center justify-center min-w-[44px] px-3 text-gray-600 hover:text-gray-300 transition-colors"
            >
              {showPassword ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>

          {error && (
            <div className="mt-3 text-sm text-red-300 bg-red-500/5 border border-red-500/10 rounded-lg px-3 py-2">{error}</div>
          )}

          <button type="submit" disabled={pending || !password || !username.trim()}
            className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-gray-800 disabled:to-gray-800 disabled:text-gray-600 text-white text-sm font-medium rounded-lg transition-all shadow-lg shadow-cyan-500/10 hover:shadow-cyan-500/20 disabled:shadow-none">
            {pending && (
              <svg aria-hidden className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            )}
            <span>{pending ? (mode === 'login' ? 'Signing in…' : 'Registering…') : (mode === 'login' ? 'Sign in' : 'Create account')}</span>
          </button>
        </form>

        <p className="text-center text-[11px] text-gray-700 mt-6">
          Sleep2AGI · Apache-2.0 · <a href="https://anet.sh" className="hover:text-gray-500 transition-colors">anet.sh</a>
          <span className="mx-1 text-gray-800">·</span>
          <span className="font-mono" title="@sleep2agi/agent-network-dashboard">v{DASHBOARD_VERSION}</span>
        </p>
      </div>
    </main>
  );
}
