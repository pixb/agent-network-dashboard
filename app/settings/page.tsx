'use client';

// Settings — information architecture aligned with the desktop client's
// settings model (client `src/settings-model.ts`): 账号 → 用户管理 →
// Agent 组织架构 → 本地 Hub → 外观 → 通知 → 快捷键 → 关于.
//
// Dashboard only owns the subset it can actually back with real data:
//   账号（改密码 / 退出）         ← client 账号
//   连接（Hub 地址 / 凭据 / 版本） ← client 本地 Hub·状态
//   成员与组织（/admin、/org）     ← client 用户管理 + Agent 组织架构
//   外观（主题）                   ← client 外观·主题
//   资源（tokens / networks / …）  ← Dashboard 特有
//   关于（版本 / 数据层）           ← client 关于
// 通知、语音输入、快捷键三组客户端有、Dashboard 没有对应能力，这里不画
// 假开关（宁可缺组，也不做点了没反应的设置项）。
//
// Styling follows client docs/design/minimal-2026-09.md: 靠底色分层不靠
// 边框（信息卡不描边）、字重上限 600、选中态用中性 rowActive 而不是
// 强调色块。

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useAnetConfig, useHealth } from '../lib/hooks';
import { applyTheme } from '../components/ThemeSwitcher';
import { DENSITY_OPTIONS, applyDensity, useDensity } from '../lib/density';
import { FONT_OPTIONS, applyFontScale, useFontScale } from '../lib/font-scale';
import { DASHBOARD_VERSION } from '../lib/version';
import { clearPrivateChatStorage } from '../lib/chat-outbox';
import { SETTINGS_SECTIONS, SETTINGS_LINKS, SETTINGS_THEMES } from '../lib/settings-model';
import { readNotifyPreference, writeNotifyPreference } from '../lib/desktop-notify';

function GroupHeading({ id, label }: { id: string; label: string }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <h2 id={`${id}-heading`} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-muted)]">
        {label}
      </h2>
      <div className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}

// 通知开关存在 localStorage；用 useSyncExternalStore 读取，避免「effect 里 setState」
// 带来的级联渲染（lint 会报 react-hooks/set-state-in-effect），SSR 快照固定 false。
const notifyListeners = new Set<() => void>();
function subscribeNotify(listener: () => void) {
  notifyListeners.add(listener);
  return () => { notifyListeners.delete(listener); };
}
function notifySnapshot(): boolean {
  return readNotifyPreference(typeof window !== 'undefined' ? window.localStorage : null);
}
function setNotifyPreference(enabled: boolean): boolean {
  const ok = writeNotifyPreference(typeof window !== 'undefined' ? window.localStorage : null, enabled);
  for (const listener of notifyListeners) listener();
  return ok;
}

export default function SettingsPage() {
  const { config } = useAnetConfig();
  const { health, error: healthError } = useHealth();
  // 首帧必须和 SSR 一致（cyber），否则浅色/Slack 用户一进 /settings 就报
  // hydration 不匹配：服务端渲染 cyber，客户端首帧读 localStorage 得到 light。
  // 挂载后再同步到真实选择（这时已经 hydrate 完，不会打架）。
  const [theme, setTheme] = useState<string>('cyber');
  const density = useDensity();
  const fontScale = useFontScale();
  const [notifyHint, setNotifyHint] = useState('');
  // 登录设备（对齐客户端「账号 → 登录设备」）：只读列表 + 两个退出动作。
  const [devices, setDevices] = useState<Array<Record<string, unknown>> | null>(null);
  const [devicesNote, setDevicesNote] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/hub/auth-sessions')
      .then(async res => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && Array.isArray(data?.sessions)) setDevices(data.sessions);
        else if (data?.error === 'user_token_required') {
          // 节点 token 登录的 Dashboard 拿不到「用户会话」——这是能力边界，不是故障。
          setDevicesNote('当前登录取自节点 token，Hub 不提供该账号的登录设备列表。');
        } else {
          setDevicesNote(`读取失败：${data?.message || data?.error || `HTTP ${res.status}`}`);
        }
      })
      .catch(() => { if (!cancelled) setDevicesNote('读取失败：Hub 不可达'); });
    return () => { cancelled = true; };
  }, []);
  const notifyOn = useSyncExternalStore(subscribeNotify, notifySnapshot, () => false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('anet-theme');
      // Hydration-safe restore, as in UserBar: keep the first render identical to SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setTheme(saved);
    } catch {}
  }, []);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdResult, setPwdResult] = useState('');
  const rowClass = 'flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between';
  const valueClass = 'break-all sm:max-w-[320px] sm:text-right';
  const cardClass = 'rounded-2xl bg-[var(--bg-secondary)] p-5';

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4 text-[var(--fg)] sm:p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-4 ml-10 text-xl font-semibold text-[var(--fg)] lg:ml-0">Settings</h1>

        {/* 分段锚点：与下面六组标题一一对应。字重/描边按 minimal 规范收掉，
            但保留 44px 触控高度（移动端可点性不靠边框表达）。 */}
        <nav aria-label="Settings sections" className="mb-6 -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {SETTINGS_SECTIONS.map(s => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 text-xs text-[var(--fg-muted)] transition-colors hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              {s.label}
            </a>
          ))}
        </nav>

        <div className="space-y-8">
          {/* ── Account（客户端第一组：账号）──────────────────────── */}
          <section id="account" data-settings-group="account" aria-labelledby="account-heading" className="space-y-3 scroll-mt-6">
            <GroupHeading id="account" label="Account" />

            <div className={cardClass}>
              <h3 className="mb-4 text-sm font-semibold">Change password</h3>
              <div className="space-y-3">
                <input type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} placeholder="Current password" aria-label="Current password"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--fg)] placeholder:text-[var(--fg-dim)] focus:border-[var(--hl)] focus:outline-none sm:text-sm" />
                <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="New password" aria-label="New password"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--fg)] placeholder:text-[var(--fg-dim)] focus:border-[var(--hl)] focus:outline-none sm:text-sm" />
                <button onClick={async () => {
                  if (!oldPwd || !newPwd) return;
                  const saved = sessionStorage.getItem('anet_v3_auth');
                  if (!saved) { setPwdResult('Not logged in with V3 auth'); return; }
                  const { token } = JSON.parse(saved);
                  const res = await fetch('/api/hub/auth', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'change_password', token, current_password: oldPwd, new_password: newPwd }),
                  });
                  const data = await res.json();
                  setPwdResult(data.ok ? 'Password changed' : `Failed: ${data.error}`);
                  if (data.ok) {
                    if (data.token) {
                      const auth = JSON.parse(saved);
                      sessionStorage.setItem('anet_v3_auth', JSON.stringify({ ...auth, token: data.token }));
                    }
                    setOldPwd('');
                    setNewPwd('');
                  }
                  setTimeout(() => setPwdResult(''), 5000);
                }} disabled={!oldPwd || !newPwd}
                  className="rounded-lg bg-[var(--hl)] px-4 py-2 text-sm font-medium text-[var(--bg)] transition-opacity hover:opacity-90 disabled:bg-[var(--bg-elevated)] disabled:text-[var(--fg-dim)]">
                  Change password
                </button>
              </div>
              {pwdResult && <div className={`mt-2 text-xs ${pwdResult.startsWith('Failed') ? 'text-[var(--danger)]' : 'text-[var(--success)]'}`}>{pwdResult}</div>}
            </div>

            <div className={cardClass} data-login-devices>
              <h3 className="mb-1 text-sm font-semibold">登录设备</h3>
              <p className="mb-3 text-xs text-[var(--fg-muted)]">
                这些设备正以你的账号登录 Hub。退出后该设备需要重新登录。
              </p>
              {devicesNote && <p className="text-xs text-[var(--fg-muted)]" data-devices-note>{devicesNote}</p>}
              {!devicesNote && devices === null && <p className="text-xs text-[var(--fg-muted)]">读取中…</p>}
              {!devicesNote && devices?.length === 0 && <p className="text-xs text-[var(--fg-muted)]">没有其他登录设备。</p>}
              {!devicesNote && !!devices?.length && (
                <ul className="space-y-2">
                  {devices.map((d, i) => {
                    const id = String(d.id ?? d.session_id ?? i);
                    const label = String(d.device ?? d.user_agent ?? d.label ?? '未知设备');
                    const when = String(d.last_seen_at ?? d.created_at ?? '');
                    return (
                      <li key={id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2" data-device-row>
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-[var(--fg)]">{label}</span>
                          {when && <span className="block text-[11px] text-[var(--fg-dim)]">{when}</span>}
                        </span>
                        <button
                          onClick={async () => {
                            const res = await fetch(`/api/hub/auth-sessions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
                            if (res.ok) { setDevices(prev => (prev ? prev.filter((_, idx) => idx !== i) : prev)); setDevicesNote(''); }
                            else setDevicesNote('退出失败：Hub 拒绝了该请求');
                          }}
                          className="shrink-0 rounded-lg bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg)]"
                        >退出</button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!devicesNote && !!devices?.length && devices.length > 1 && (
                <button
                  onClick={async () => {
                    const res = await fetch('/api/hub/auth-sessions?action=revoke-others', { method: 'POST' });
                    if (res.ok) { setDevices(prev => (prev ? prev.slice(0, 1) : prev)); setDevicesNote('已退出其他设备'); }
                    else setDevicesNote('退出其他设备失败：Hub 拒绝了该请求');
                  }}
                  className="mt-3 rounded-lg bg-[var(--bg-elevated)] px-4 py-2 text-sm text-[var(--fg-muted)] transition-colors hover:text-[var(--fg)]"
                >退出其他所有设备</button>
              )}
            </div>

            <div className={cardClass}>
              <h3 className="mb-1 text-sm font-semibold">Sign out</h3>
              <p className="mb-3 text-xs text-[var(--fg-muted)]">Signing out clears your dashboard session cookie. You&apos;ll return to the login page.</p>
              <button
                onClick={async () => {
                  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
                  clearPrivateChatStorage();
                  sessionStorage.removeItem('anet_v3_auth');
                  window.location.assign('/login');
                }}
                className="rounded-lg bg-[var(--bg-elevated)] px-4 py-2 text-sm text-[var(--fg-muted)] transition-colors hover:text-[var(--fg)]"
              >
                Sign out
              </button>
            </div>
          </section>

          {/* ── Connection（客户端「本地 Hub」组的状态视图）──────── */}
          <section id="connection" data-settings-group="connection" aria-labelledby="connection-heading" className="space-y-3 scroll-mt-6">
            <GroupHeading id="connection" label="Connection" />

            <div className={cardClass}>
              <h3 className="mb-4 text-sm font-semibold">CommHub connection</h3>
              <div className="space-y-3 text-sm">
                <div className={rowClass}>
                  <span className="shrink-0 text-[var(--fg-muted)]">Hub URL</span>
                  <span className={`text-[var(--hl)] ${valueClass}`}>{config?.hub || 'not configured'}</span>
                </div>
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Config source</span>
                  <span className={`text-[var(--fg)] ${valueClass}`}>
                    {config?.source === 'file' ? 'Local file (~/.anet/config.json)' : config?.source === 'runtime-env' ? 'Vercel env vars' : 'Missing'}
                  </span>
                </div>
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Auth token</span>
                  <span className={`${config?.tokenConfigured ? 'text-[var(--success)]' : 'text-[var(--danger)]'} ${valueClass}`}>
                    {config?.tokenConfigured ? `Configured (${config.tokenPreview})` : 'Not configured'}
                  </span>
                </div>
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Server auth</span>
                  <span className={`${health?.auth === 'enabled' ? 'text-[var(--success)]' : 'text-[var(--warning)]'} sm:text-right`}>
                    {health?.auth || '--'}
                  </span>
                </div>
                {config?.error && (
                  <div className="border-t border-[var(--border)] pt-3 text-xs text-[var(--fg-muted)]">
                    {config.error}
                  </div>
                )}
                {/* #214 F5: the red HealthBanner's "Open Settings" CTA used to
                    land on a read-only page with no next step. When the hub is
                    unreachable, give the user actual recovery commands. */}
                {(healthError || health?.ok === false) && (
                  <div className="space-y-1.5 border-t border-[var(--danger)]/30 pt-3 text-xs" role="alert">
                    <div className="font-medium text-[var(--danger)]">CommHub unreachable — how to recover:</div>
                    <div className="text-[var(--fg-muted)]">1. Check the hub process on the server: <code className="rounded bg-[var(--code-bg)] px-1.5 py-0.5 font-mono">anet hub status</code></div>
                    <div className="text-[var(--fg-muted)]">2. Start it if stopped: <code className="rounded bg-[var(--code-bg)] px-1.5 py-0.5 font-mono">anet hub start</code></div>
                    <div className="text-[var(--fg-muted)]">3. Confirm the Hub URL above matches where the hub actually listens.</div>
                  </div>
                )}
              </div>
            </div>

            <div className={cardClass}>
              <h3 className="mb-4 text-sm font-semibold">Server</h3>
              <div className="space-y-3 text-sm">
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Hub version</span>
                  <span className={`font-mono text-[var(--fg)] ${valueClass}`}>{health?.version || '--'}</span>
                </div>
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Sessions</span>
                  <span className={`text-[var(--fg)] ${valueClass}`}>{health?.sessions ?? '--'}</span>
                </div>
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">SSE streams</span>
                  <span className={`text-[var(--fg)] ${valueClass}`}>{health?.sse_connections ?? '--'}</span>
                </div>
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Uptime</span>
                  <span className={`text-[var(--fg)] ${valueClass}`}>{health?.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : '--'}</span>
                </div>
              </div>
            </div>
          </section>

          {/* ── Team（客户端：用户管理 + Agent 组织架构）────────── */}
          <section id="team" data-settings-group="team" aria-labelledby="team-heading" className="space-y-3 scroll-mt-6">
            <GroupHeading id="team" label="Team" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {SETTINGS_LINKS.filter(l => l.group === 'team').map(l => (
                <Link key={l.href} href={l.href} className="rounded-2xl bg-[var(--bg-secondary)] p-5 transition-colors hover:bg-[var(--bg-elevated)]">
                  <h3 className="text-sm font-semibold">{l.title}</h3>
                  <p className="mt-2 text-xs text-[var(--fg-muted)]">{l.desc}</p>
                  <span className="mt-3 inline-block text-xs text-[var(--hl)]">{l.action} &rarr;</span>
                </Link>
              ))}
            </div>
          </section>

          {/* ── Appearance（客户端外观组：主题）────────────────── */}
          <section id="appearance" data-settings-group="appearance" aria-labelledby="appearance-heading" className="space-y-3 scroll-mt-6">
            <GroupHeading id="appearance" label="Appearance" />
            <div className={cardClass}>
              <h3 className="mb-4 text-sm font-semibold">Theme</h3>
              <div className="grid grid-cols-2 gap-3">
                {SETTINGS_THEMES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => {
                      try { localStorage.setItem('anet-theme', t.id); } catch {}
                      applyTheme(t.id);
                      setTheme(t.id);
                    }}
                    aria-pressed={theme === t.id}
                    className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm transition-colors ${
                      theme === t.id
                        ? 'bg-[var(--bg-elevated)] text-[var(--fg)]'
                        : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'
                    }`}
                  >
                    <span
                      aria-hidden
                      className="inline-block h-5 w-5 shrink-0 rounded-full border border-black/20"
                      style={{ background: t.swatch }}
                    />
                    {t.label}
                    {theme === t.id && (
                      <svg aria-hidden className="ml-auto h-4 w-4 text-[var(--hl)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* 字体大小：与密度解耦（客户端同样是两个开关） */}
            <div className={cardClass}>
              <h3 className="mb-1 text-sm font-semibold">字体大小</h3>
              <p className="mb-4 text-[12px] text-[var(--fg-muted)]">
                只缩放文字，不改列表疏密（疏密在下面的「界面密度」）。
              </p>
              <div className="grid grid-cols-4 gap-3" data-font-picker>
                {FONT_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => {
                      try { localStorage.setItem('anet-font-scale', opt.key); } catch {}
                      applyFontScale(opt.key);
                    }}
                    aria-pressed={fontScale === opt.key}
                    data-font-option={opt.key}
                    className={`rounded-lg px-3 py-2.5 text-sm transition-colors ${
                      fontScale === opt.key
                        ? 'bg-[var(--bg-elevated)] text-[var(--fg)]'
                        : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 界面密度：与字号解耦（客户端同样拆成两个开关） */}
            <div className={cardClass}>
              <h3 className="mb-1 text-sm font-semibold">界面密度</h3>
              <p className="mb-4 text-[12px] text-[var(--fg-muted)]">
                只调整列表与侧栏的行高，字号不变。
              </p>
              <div className="grid grid-cols-3 gap-3" data-density-picker>
                {DENSITY_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => {
                      try { localStorage.setItem('anet-density', opt.key); } catch {}
                      applyDensity(opt.key);
                    }}
                    aria-pressed={density === opt.key}
                    title={opt.hint}
                    data-density-option={opt.key}
                    className={`rounded-lg px-3 py-2.5 text-sm transition-colors ${
                      density === opt.key
                        ? 'bg-[var(--bg-elevated)] text-[var(--fg)]'
                        : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* ── 通知（对齐客户端 NotifySettings 的最小实现：默认关闭）── */}
          <section id="notify" data-settings-group="notify" aria-labelledby="notify-heading" className="space-y-3 scroll-mt-6">
            <GroupHeading id="notify" label="Notifications" />
            <div className={cardClass}>
              <h3 className="mb-2 text-sm font-semibold">桌面通知</h3>
              <p className="mb-3 text-[11px] text-[var(--fg-dim)]">
                页面在后台时，收到发给你的新消息会弹系统通知。默认关闭；开启需要浏览器授权，权限可随时在浏览器设置里撤销。
              </p>
              <button
                type="button"
                data-testid="settings-desktop-notify"
                aria-pressed={notifyOn}
                onClick={async () => {
                  if (notifyOn) {
                    setNotifyPreference(false);
                    return;
                  }
                  if (!('Notification' in window)) { setNotifyHint('当前浏览器不支持通知'); return; }
                  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
                  if (permission !== 'granted') { setNotifyHint('未获得授权，通知保持关闭'); return; }
                  setNotifyPreference(true);
                  setNotifyHint('');
                }}
                className={`inline-flex min-h-11 items-center rounded-lg px-3 text-xs transition-colors ${
                  notifyOn ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]' : 'bg-[var(--bg-elevated)] text-[var(--fg)] hover:bg-[var(--hover-tint)]'
                }`}
              >
                {notifyOn ? '已开启 · 点击关闭' : '开启桌面通知'}
              </button>
              {notifyOn && (
                <button
                  type="button"
                  data-testid="settings-desktop-notify-test"
                  onClick={() => {
                    // 权限类功能没这个按钮，用户只能等真实消息才知道有没有生效。
                    try {
                      const n = new Notification('Agent Network · 测试通知', { body: '看到这条说明桌面通知已经生效。', tag: 'anet-test' });
                      n.onclick = () => { try { window.focus(); n.close(); } catch { /* 忽略 */ } };
                      setNotifyHint('');
                    } catch { setNotifyHint('发送失败，请检查浏览器通知权限'); }
                  }}
                  className="ml-2 inline-flex min-h-11 items-center rounded-lg px-3 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]"
                >
                  发送测试通知
                </button>
              )}
              {notifyHint && <p role="status" className="mt-2 text-[11px] text-[var(--warning)]">{notifyHint}</p>}
            </div>
          </section>

          {/* ── Resources（Dashboard 特有：低频页面入口）───────── */}
          <section id="resources" data-settings-group="resources" aria-labelledby="resources-heading" className="space-y-3 scroll-mt-6">
            <GroupHeading id="resources" label="Resources" />
            {/* #209 (per Vincent 521/522): the low-frequency pages 通信龙
                moved out of the sidebar (Messages, Audit Log, Server Logs)
                need a discovery surface that isn't the primary nav. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {SETTINGS_LINKS.filter(l => l.group === 'resource').map(l => (
                <Link key={l.href} href={l.href} className="rounded-2xl bg-[var(--bg-secondary)] p-5 transition-colors hover:bg-[var(--bg-elevated)]">
                  <h3 className="text-sm font-semibold">{l.title}</h3>
                  <p className="mt-2 text-xs text-[var(--fg-muted)]">{l.desc}</p>
                  <span className="mt-3 inline-block text-xs text-[var(--hl)]">{l.action} &rarr;</span>
                </Link>
              ))}
            </div>
          </section>

          {/* ── About（客户端最后一组）────────────────────────── */}
          <section id="about" data-settings-group="about" aria-labelledby="about-heading" className="space-y-3 scroll-mt-6">
            <GroupHeading id="about" label="About" />
            <div className={cardClass}>
              <div className="space-y-3 text-sm">
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Dashboard version</span>
                  <span className={`font-mono text-[var(--fg)] ${valueClass}`} title="From package.json @sleep2agi/agent-network-dashboard">
                    {DASHBOARD_VERSION}
                  </span>
                </div>
                <div className={rowClass}>
                  <span className="text-[var(--fg-muted)]">Data layer</span>
                  <span className={`text-[var(--fg)] ${valueClass}`}>SWR (5s refresh, 3s dedup)</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
