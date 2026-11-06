'use client';

import Link from 'next/link';
import { applyTheme } from './ThemeSwitcher';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { useNetworkId } from '../lib/network-context';
import { isOnline as presenceIsOnline, presenceStatus } from '../lib/presence';
import { useHealth } from '../lib/hooks';
import { useChatUnread, badgeLabel } from '../lib/chat-unread';
import { clearPrivateChatStorage } from '../lib/chat-outbox';

// Sidebar has THREE render modes (通信龙 07-31 brief, dashboard 类飞书):
//   'expanded'  — w-52, icons + labels. Original default; unchanged.
//   'collapsed' — w-16, icons only, native `title=` tooltips. Existing
//                 pre-icon-rail form; kept intact for users on it.
//   'icon-rail' — w-14, Feishu-style narrow icon-only rail with
//                 UNREAD BADGES on nav items that can carry them, and
//                 tighter spacing. Distinguishes from 'collapsed' by
//                 the badges + width — collapsed has neither.
//
// Cycle order (single toggle button, bottom-left arrow): expanded →
// collapsed → icon-rail → expanded. localStorage key `anet-sidebar-mode`
// persists the choice across reloads. Migration: pre-existing users
// have no key set → default to 'expanded' (backward compat: nobody who
// hadn't touched it gets a surprise on next visit).
//
// The `collapsed` bool that existing markup consumes is derived
// (`mode !== 'expanded'`) — so all pre-icon-rail styling paths keep
// working exactly as before, with icon-rail adding only its extras
// (narrower width class + badges + a data attribute for tests).
type SidebarMode = 'expanded' | 'collapsed' | 'icon-rail';
const SIDEBAR_MODES: readonly SidebarMode[] = ['expanded', 'collapsed', 'icon-rail'] as const;
const SIDEBAR_MODE_STORAGE = 'anet-sidebar-mode';
const SIDEBAR_MODE_LABEL: Record<SidebarMode, string> = {
  expanded: '展开',
  collapsed: '折叠',
  'icon-rail': '图标',
};

// 与 /api/hub/status 同一个坑：这个 key 也被设置页共用。吞掉非 2xx 会让
// 「读不到网络」变成「你没有网络」，并把这份假空写进 SWR 全局缓存。
const networkFetcher = async (url: string) => {
  const res = await fetch(url);
  if (res.status === 401) {
    window.location.assign('/login');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
};

// Cleanup (issue #4): sidebar collapsed to the 6 core destinations. The
// low-frequency / unverified entries (Messages, Networks, Audit Log,
// Server Logs) were removed from primary nav — those pages still exist
// and stay reachable via direct URL and the command palette (⌘K); they
// were just cluttering the main rail. Restore here if usage warrants.
const NAV_ITEMS = [
  { href: '/nodes', label: 'Nodes', icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01' },
  // 军团拓扑（2D `/legion` + 3D `/legion/3d`）。作者 通信Dash欧；此处只补导航入口。
  { href: '/legion', label: 'Legion', icon: 'M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7l7-4zM12 8v5m0 0l3 2m-3-2l-3 2' },
  { href: '/versions', label: 'Versions', icon: 'M7 7h10M7 12h10M7 17h6' },
  { href: '/changelog', label: 'Changelog', icon: 'M6 4h9l4 4v12H6zM15 4v4h4' },
  { href: '/', label: 'Overview', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { href: '/scheduled-tasks', label: 'Schedules', icon: 'M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z' },
  { href: '/skillhub', label: 'SkillHub', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5s3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18s-3.332.477-4.5 1.253' },
  { href: '/tasks', label: 'Tasks', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
  // #1633 — 需求池/进行中/完成。Tasks 是「谁派给谁」，这里是「大家在做的需求」。
  { href: '/requirements', label: 'Requirements', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 9h6M9 13h6M9 17h3' },
  // #1635 — 人 + 部门 + 名下 Agent（数据源与 MCP requirements_people 同源）。
  { href: '/org', label: 'Organization', icon: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a3 3 0 10-2.6-4.5M9 7a3 3 0 10-2.6 4.5' },
  { href: '/servers', label: 'Servers', icon: 'M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v1A2.5 2.5 0 0117.5 10h-11A2.5 2.5 0 014 7.5v-1zM4 16.5A2.5 2.5 0 016.5 14h11a2.5 2.5 0 012.5 2.5v1a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5v-1zM7 7h.01M7 17h.01' },
  { href: '/providers', label: 'Providers', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
  { href: '/admin', label: 'Admin', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
  { href: '/settings', label: 'Settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

interface SidebarNetwork {
  network_id: string;
  network_name: string;
  role?: string;
  /** Round 107: live agent count, derived from /api/status sessions. */
  agentCount?: number;
  /** Name shown in the list; carries a short id suffix when names collide. */
  displayName?: string;
}

const ROLE_ICON: Record<string, string> = { owner: '⭐', admin: '🔧', member: '👤', viewer: '👁' };

export function Sidebar() {
  const pathname = usePathname();
  // Default = 'icon-rail' per Vincent 07-31 "飞书同版体验": nobody clicks
  // a toggle to make their sidebar narrow — the narrow form IS the
  // experience. Existing user preferences (whoever has already picked
  // expanded or collapsed via the cycle button) are preserved via the
  // useEffect below, which is the ONLY thing standing between "sane
  // new-user default" and "silently overwriting an existing choice" —
  // the second failure is the one that reads to users as "the app
  // forgot my setting" and it has no error surface, so it needs its
  // own witnessed-red assertion (see e2e-sidebar-default.spec.ts).
  // 08-09 (Vincent「左侧标签栏要显示完全/都没有展开」): default back to
  // 'expanded' so first-visit users see icons + labels in full. This reverses
  // the 07-31 'icon-rail' default; the cycle button + localStorage still let
  // anyone pick icon-rail/collapsed and that choice is preserved (useEffect below).
  const [mode, setMode] = useState<SidebarMode>('expanded');
  useEffect(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_MODE_STORAGE);
      if (v && (SIDEBAR_MODES as readonly string[]).includes(v)) setMode(v as SidebarMode);
    } catch {}
  }, []);
  const cycleMode = () => {
    setMode(current => {
      const idx = SIDEBAR_MODES.indexOf(current);
      const next = SIDEBAR_MODES[(idx + 1) % SIDEBAR_MODES.length];
      try { localStorage.setItem(SIDEBAR_MODE_STORAGE, next); } catch {}
      return next;
    });
  };
  // Derived: existing markup uses `collapsed` (any non-expanded state
  // hides text + narrows). icon-rail behaves like collapsed by default
  // but adds badges + narrower width class further down.
  const collapsed = mode !== 'expanded';
  const iconRail = mode === 'icon-rail';
  // Only pulled in icon-rail mode so the SWR fetch cost (which happens
  // anyway on other pages via useChatUnread) isn't duplicated for
  // no visual gain when badges aren't drawn.
  const { totalUnread } = useChatUnread();
  // Which nav entries carry a badge in icon-rail mode. Kept as an
  // exact map (not a fuzzy lookup) so a future nav-item rename can't
  // silently orphan a badge onto the wrong route.
  const NAV_BADGE: Partial<Record<string, number>> = {
    '/nodes': totalUnread,
  };
  // Theme switcher (Vincent 07-20 "主题还不能切换吗" — the Settings entry was
  // too buried; a sidebar control is findable from every page). Cycle order
  // matches Settings: 深色(默认) → 浅色 → Slack.
  const THEME_CYCLE = ['cyber', 'light', 'slack', 'system'] as const;
  const THEME_LABEL: Record<string, string> = { cyber: '深色', light: '浅色', slack: 'Slack', system: '跟随系统' };
  const [theme, setTheme] = useState('cyber');
  useEffect(() => {
    try { const t = localStorage.getItem('anet-theme'); if (t && THEME_LABEL[t]) setTheme(t); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cycleTheme = () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme as typeof THEME_CYCLE[number]) + 1) % THEME_CYCLE.length];
    applyTheme(next);
    try { localStorage.setItem('anet-theme', next); } catch {}
    setTheme(next);
  };
  const [mobileOpen, setMobileOpen] = useState(false);
  const [netOpen, setNetOpen] = useState(false);
  const netRef = useRef<HTMLDivElement | null>(null);
  const { networkId, setNetworkId } = useNetworkId();
  const { data: netData } = useSWR<{ networks: SidebarNetwork[] }>('/api/hub/networks', networkFetcher, { refreshInterval: 15000, dedupingInterval: 10000 });
  // Round 107 (issue #92): /api/networks can be scope-limited (a hub owner's
  // token may only list "default" even when agents live in other networks).
  // The unfiltered /api/status response carries every visible session with
  // its network_id, so derive networks from there and merge them in — the
  // admin can then switch to any network that actually has agents.
  // 只需 network_id 来推导网络列表；/api/hub/status 会回 710 KB 的全量对象
  //（实测），这里换成投影后的紧凑端点（约 18 KB）。
  const { data: statusData } = useSWR<StatusData>(
    '/api/hub/session-status', statusFetcher, { refreshInterval: 15000, dedupingInterval: 10000 },
  );
  const apiNetworks = netData?.networks || [];
  const networks: SidebarNetwork[] = (() => {
    const agentCount = new Map<string, number>();
    for (const s of statusData?.sessions || []) {
      if (s.network_id) agentCount.set(s.network_id, (agentCount.get(s.network_id) || 0) + 1);
    }
    const known = new Set(apiNetworks.map(n => n.network_id));
    const derived: SidebarNetwork[] = [...agentCount.keys()]
      .filter(id => !known.has(id))
      .map(id => ({ network_id: id, network_name: id }));
    const merged = [...apiNetworks, ...derived]
      .map(n => ({ ...n, agentCount: agentCount.get(n.network_id) || 0 }));
    // Every registration used to mint a network literally named "default",
    // so an admin on a hub with many users saw a wall of identical rows
    // (23 on the live hub, 22 of them empty). Registration now names the
    // network after its owner, but existing rows keep their old name — so
    // surface the ones that matter first and keep same-named rows apart.
    const nameCount = new Map<string, number>();
    for (const n of merged) nameCount.set(n.network_name, (nameCount.get(n.network_name) || 0) + 1);
    return merged
      .map(n => ({
        ...n,
        // Only disambiguate when the name is actually ambiguous, so a hub
        // with unique names stays clean.
        displayName: (nameCount.get(n.network_name) || 0) > 1
          ? `${n.network_name} · ${n.network_id.replace(/^net_/, '').slice(0, 6)}`
          : n.network_name,
      }))
      .sort((a, b) => (b.agentCount || 0) - (a.agentCount || 0));
  })();
  // One row instead of one row *per network*. A hub with 25 networks used to
  // spend the entire sidebar listing them (24 of which had no agents), which
  // is what the switcher below replaces: show the active one, put the rest
  // behind a click.
  const activeNetwork = networks.find(n => n.network_id === networkId) || networks[0];

  // Close the switcher on outside click / Escape. Bound only while open so
  // the sidebar adds no global listeners at rest.
  useEffect(() => {
    if (!netOpen) return;
    const onDown = (e: MouseEvent) => {
      if (netRef.current && !netRef.current.contains(e.target as Node)) setNetOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNetOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [netOpen]);

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    if (href === '/settings') return pathname === '/settings';
    return pathname.startsWith(href);
  };

  const nav = (
    <nav
      className={`flex flex-col ${iconRail ? 'gap-2 px-0 py-2 items-center' : 'gap-1 px-2 py-4'}`}
      data-sidebar-nav
    >
      {NAV_ITEMS.map(item => {
        const badge = iconRail ? (NAV_BADGE[item.href] ?? 0) : 0;
        const active = isActive(item.href);
        if (iconRail) {
          // Dashboard UI SPEC v1 §3 (设计负责人, 07-31):
          //   - Container: 44×44 tap area (icon 24 + 10px padding all sides)
          //   - Icon SVG: 24×24, centered
          //   - Default icon color: #64748B; hover: #E2E8F0 + bg rgba(255,255,255,0.04)
          //   - Selected: icon #7DD3FC + bg rgba(125,211,252,0.12) rounded 8px 40×40 + 3px left bar length 20px
          //   - Gap between items: 8px (nav's gap-2)
          //   - No border between rail and next column (contrast via bg brightness)
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={() => setMobileOpen(false)}
              title={item.label}
              aria-label={item.label}
              data-nav-item
              data-nav-href={item.href}
              data-nav-active={active ? 'true' : undefined}
              data-badge={badge > 0 ? String(badge) : undefined}
              className="relative flex items-center justify-center w-11 h-11 group anet-nav-item-rail"
            >
              {/* 3px left indicator bar for selected — 20px length, 2px
                  round, matches spec. Positioned absolute so it hangs
                  off the container without moving the icon. */}
              {active && (
                <span
                  aria-hidden
                  data-nav-active-bar
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-[2px] bg-[var(--hl)]"
                />
              )}
              {/* 40×40 icon background square (selected only) — inner
                  visual, centered inside the 44×44 tap container. */}
              <span
                className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${
                  active
                    ? 'bg-[rgba(125,211,252,0.12)] text-[var(--hl)]'
                    : 'text-[var(--fg-dim)] hover:text-[var(--fg)] hover:bg-[rgba(255,255,255,0.04)]'
                }`}
              >
                <svg className="w-6 h-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                </svg>
              </span>
              {badge > 0 && (
                <span
                  aria-label={`${item.label} — ${badgeLabel(badge)} unread`}
                  data-nav-badge
                  className="absolute top-0 right-0 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[11px] font-semibold leading-4 text-center pointer-events-none"
                >
                  {badgeLabel(badge)}
                </span>
              )}
            </Link>
          );
        }
        // Non-icon-rail (expanded / collapsed) — unchanged legacy behavior.
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            onClick={() => setMobileOpen(false)}
            title={collapsed ? item.label : undefined}
            aria-label={item.label}
            data-nav-item
            data-nav-href={item.href}
            data-nav-active={active ? 'true' : undefined}
            className={`relative flex items-center gap-3 rounded-lg text-sm transition-colors active:bg-[var(--bg-elevated)] ${
              active
                ? 'bg-[var(--accent)]/10 text-[var(--accent-text)] border border-cyan-500/20 anet-nav-active'
                : 'text-[var(--fg-muted)] hover:text-gray-200 hover:bg-[var(--bg-elevated)]'
            } ${collapsed ? 'justify-center px-0 py-3' : 'px-3 py-3'}`}
          >
            <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
            </svg>
            {!collapsed && <span>{item.label}</span>}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile hamburger — R13 of #190: was p-2.5 = ~40px tap target,
          just below the iOS 44px guideline. Bump padding and add an
          explicit min-w/min-h so it can never be miss-tapped. */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-3 left-3 z-50 lg:hidden bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-[var(--fg-muted)] hover:text-white active:bg-[var(--bg-elevated)]"
        aria-label="Toggle menu"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {mobileOpen
            ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            : <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />}
        </svg>
      </button>

      {/* Mobile overlay — round 47: fades in via anet-fade-in (150ms ease-out)
          matching the TaskDrawer / TaskChatPanel backdrop. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden anet-fade-in"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — `bg-[var(--bg)]` resolves to var(--bg) in dark themes,
          but in light/mint we want a distinct surface, so we layer
          `lg:bg-white` / `lg:dark:bg-[var(--bg)]` via the theme attribute.
          The CSS shim in globals.css upgrades sidebar bg to bg-secondary
          in light themes so the sidebar reads as its own card.
          Round 47: explicit ease-out curve + slight shadow so the drawer
          edge "leaves a trail" as it slides in. */}
      <aside
        data-app-shell-nav="sidebar"
        data-anet-sidebar="true"
        data-sidebar-mode={mode}
        data-total-unread={totalUnread}
        className={`
        fixed top-0 left-0 h-full z-40 flex flex-col
        transition-transform duration-200 ease-out
        ${mode === 'expanded' ? 'w-52 bg-[var(--bg)] border-r border-[var(--border)]' : mode === 'icon-rail' ? 'w-14 bg-[#0A0C14]' : 'w-16 bg-[var(--bg)] border-r border-[var(--border)]'}
        ${mobileOpen ? 'translate-x-0 shadow-2xl shadow-black/40 lg:shadow-none' : '-translate-x-full'}
        lg:translate-x-0 lg:static lg:shrink-0 lg:shadow-none
        /* 手机底部有固定的 Tab 栏（约 56px + 安全区），抽屉若占满 100dvh，
           最底部的「Sign out」会被它压住、点不到。这里留出同样的高度。 */
        pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0
      `}>
        {/* Brand header — round 4: 3-node mesh mark matches /login,
            with an inline live "online" pulse so every page surfaces
            fleet health without leaving for /nodes. */}
        <SidebarBrand collapsed={collapsed} />
        <div className={`border-b border-[var(--border)]`} />

        {/* Scrollable middle: networks + nav grow and scroll together so
            nothing is cut off when there are many networks / short viewports
            (goal: 左侧标签栏「显示完全」). Brand stays pinned top, footer bottom. */}
        <div className="flex-1 min-h-0 overflow-y-auto">

        {/* Network list */}
        {!collapsed && networks.length > 0 && (
          <div className="px-2 py-3 border-b border-[var(--border)]">
            <div className="px-3 text-[11px] text-[var(--fg-dim)] uppercase mb-2">Network</div>
            <div className="relative" ref={netRef}>
              <button
                type="button"
                onClick={() => setNetOpen(v => !v)}
                data-testid="network-switcher"
                aria-haspopup="listbox"
                aria-expanded={netOpen}
                title={activeNetwork?.network_id}
                className="w-full flex items-center gap-2 px-3 py-2.5 lg:py-1.5 rounded-md text-xs text-left transition-colors bg-[var(--bg-elevated)] text-[var(--fg)] hover:text-gray-100"
              >
                <span>{ROLE_ICON[activeNetwork?.role || 'member'] || '👤'}</span>
                <span className="truncate flex-1">
                  {activeNetwork?.displayName || activeNetwork?.network_name || '—'}
                </span>
                {/* Round 107 (issue #92): keep the live agent count visible so
                    an admin can still tell at a glance whether the network
                    they are looking at is the one holding the fleet. */}
                {activeNetwork?.agentCount ? (
                  <span className="shrink-0 tabular-nums text-[11px] text-[var(--fg-dim)]">{activeNetwork.agentCount}</span>
                ) : null}
                <span className={`shrink-0 text-[11px] text-[var(--fg-dim)] transition-transform ${netOpen ? 'rotate-180' : ''}`}>▼</span>
              </button>

              {netOpen && (
                <div
                  role="listbox"
                  data-testid="network-switcher-panel"
                  className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg py-1"
                >
                  {networks.map((n: SidebarNetwork) => (
                    <button
                      key={n.network_id}
                      role="option"
                      aria-selected={networkId === n.network_id}
                      data-testid="network-option"
                      onClick={() => { setNetworkId(n.network_id); setNetOpen(false); setMobileOpen(false); }}
                      title={n.network_id}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 lg:py-1.5 text-xs transition-colors text-left ${
                        networkId === n.network_id
                          ? 'bg-[var(--accent)]/10 text-[var(--accent-text)]'
                          : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-elevated)]'
                      }`}
                    >
                      <span>{ROLE_ICON[n.role || 'member'] || '👤'}</span>
                      <span className="truncate flex-1">{n.displayName || n.network_name}</span>
                      {n.agentCount ? (
                        <span className="shrink-0 tabular-nums text-[11px] text-[var(--fg-dim)]">{n.agentCount}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* #209 R26 (Vincent msg 540 screenshot — "设置页面没展示全"): the
            absolute-bottom footer below stacks 3 rows (Quick search /
            Sign out / collapse) ≈ 92-100px tall, but this spacer was
            pb-20 (80px), so the last nav entry (Settings on /settings)
            was being eaten by the footer overlay. Bump to pb-28 (112px)
            to clear the actual footer height. */}
        <div className="pb-3">
          {nav}
        </div>
        </div>{/* end scrollable middle */}

        {/* Sign out + collapse — round 27: collapsed-state gets icon-only
            variants so users still have Sign out / Quick search access at
            56px width, plus title= tooltips. Pinned bottom of the flex column
            (shrink-0) so it never overlaps content; the middle region above
            scrolls instead of hiding tabs behind it. */}
        <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg)]">
          <button
            onClick={cycleTheme}
            title={collapsed ? `主题：${THEME_LABEL[theme]}（点击切换）` : undefined}
            className={`w-full flex items-center text-[11px] text-[var(--fg-dim)] hover:text-[var(--fg-muted)] hover:bg-[var(--bg-elevated)] transition-colors ${
              collapsed ? 'justify-center px-0 py-2.5' : 'justify-between gap-2 px-5 py-3 lg:py-2'
            }`}
            aria-label={`切换主题（当前：${THEME_LABEL[theme]}）`}
          >
            <span className={`flex items-center ${collapsed ? '' : 'gap-2'}`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88" />
              </svg>
              {!collapsed && '主题'}
            </span>
            {!collapsed && <span className="text-[11px] border border-current rounded px-1.5 py-0.5">{THEME_LABEL[theme]}</span>}
          </button>
          <button
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }));
            }}
            title={collapsed ? 'Quick search (⌘K)' : undefined}
            className={`w-full flex items-center text-[11px] text-[var(--fg-dim)] hover:text-[var(--fg-muted)] hover:bg-[var(--bg-elevated)] transition-colors ${
              collapsed ? 'justify-center px-0 py-2.5' : 'justify-between gap-2 px-5 py-3 lg:py-2'
            }`}
            aria-label="Open command palette"
          >
            <span className={`flex items-center ${collapsed ? '' : 'gap-2'}`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {!collapsed && 'Quick search'}
            </span>
            {!collapsed && <kbd className="text-[11px] border border-current rounded px-1 py-0.5 font-mono">⌘K</kbd>}
          </button>
          <button
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
              clearPrivateChatStorage();
              sessionStorage.removeItem('anet_v3_auth');
              window.location.assign('/login');
            }}
            title={collapsed ? 'Sign out' : undefined}
            className={`w-full flex items-center text-xs text-[var(--fg-muted)] hover:text-red-400 hover:bg-red-500/5 transition-colors ${
              collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-5 py-3'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            {!collapsed && 'Sign out'}
          </button>
          <div className={`flex items-center ${collapsed ? 'flex-col px-0 py-2' : 'px-3 py-2 justify-end'}`}>
            <button
              onClick={cycleMode}
              title={`当前：${SIDEBAR_MODE_LABEL[mode]} — 点击切换（展开 → 折叠 → 图标）`}
              data-testid="sidebar-mode-cycle"
              className="hidden lg:flex p-1.5 rounded text-[var(--fg-dim)] hover:text-[var(--fg-muted)] transition-colors items-center gap-1"
              aria-label={`Cycle sidebar mode (current: ${mode})`}
            >
              {/* Chevron rotates to hint at direction — expanded →
                  points left (will collapse); collapsed → left too
                  (will narrow further); icon-rail → right (will
                  expand back to full width, wrapping the cycle). */}
              <svg
                className={`w-4 h-4 transition-transform ${mode === 'icon-rail' ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

interface StatusData {
  sessions?: Array<{ status?: string; alias?: string; network_id?: string }>;
}

// 这个 fetcher 与 app/lib/hooks.ts 的 useSessions 共用 SWR key
// `/api/hub/status`。旧实现把非 2xx 吞成 `{sessions: []}`，于是全局缓存里
// 存的是一份「读失败但看起来像空」的数据：任何页面（/nodes、/versions…）
// 拿到的都是空数组而不是 error，空态就把「Hub 读不到」说成「队伍还没建」。
// 失败必须抛出，让错误沿同一条 key 传下去，各页面自己决定怎么显示。
const statusFetcher = async (url: string) => {
  const res = await fetch(url);
  if (res.status === 401) {
    window.location.assign('/login');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json() as Promise<StatusData>;
};

function SidebarBrand({ collapsed }: { collapsed: boolean }) {
  const { networkId, ready } = useNetworkId();
  // 网络未解析完不发请求（否则先打一枪无作用域的，见 .383 的修复）。
  const overviewKey = ready && networkId
    ? `/api/hub/overview?network_id=${encodeURIComponent(networkId)}`
    : null;
  // 首屏只取「计数」：/api/hub/status 会回全部 session 对象（生产实测 709 KB），
  // 公网约 240 KB/s，光这一份就要 3 秒。聚合端点让浏览器只收几百字节。
  const { data, error, isLoading } = useSWR<{ ok: boolean; total: number; online: number; presence: 'ready' | 'blind' | 'loading' }>(
    overviewKey as string | null,
    statusFetcher as (url: string) => Promise<{ ok: boolean; total: number; online: number; presence: 'ready' | 'blind' | 'loading' }>,
    { refreshInterval: 10000, dedupingInterval: 4000 },
  );
  // 三态（ready/blind/loading）由服务端用同一个 presence.ts 判定，
  // 避免侧栏、统计卡、拓扑各算一套（#53 的老问题）。
  const presenceState = data?.presence ?? 'loading';
  const online = data?.online ?? 0;
  const onlineDisplay: number | string = presenceState === 'ready' ? online : '?';
  const total = data?.total ?? 0;

  if (collapsed) {
    return (
      <Link href="/" className="block px-3 py-4 flex justify-center hover:opacity-80 transition-opacity" aria-label="Agent Network — home">
        <BrandMark size={32} />
      </Link>
    );
  }

  return (
    <Link
      href="/"
      className="block px-4 py-4 flex items-center gap-3 hover:bg-[var(--bg-secondary)]/40 transition-colors rounded-r-xl"
      aria-label="Agent Network — home"
    >
      <BrandMark size={32} />
      <div className="min-w-0">
        <div className="text-white text-[12px] font-semibold leading-tight">Agent Network</div>
        <div className="text-[11px] text-[var(--fg-muted)] flex items-center gap-1.5 mt-0.5">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${isLoading && total === 0 ? 'bg-[var(--fg-dim)]/60' : error && total === 0 ? 'bg-[var(--danger)]' : online > 0 ? 'bg-emerald-400 anet-brand-pulse' : 'bg-gray-600'}`}
            aria-hidden
          />
          {isLoading && total === 0 ? (
            // 数据还没到：既不是「空」也不是「挂」，只是一个尚未知的状态。
            <span aria-live="polite">loading…</span>
          ) : error && total === 0 ? (
            // 取失败：必须说清是「读不到」，不能伪装成空舰队。
            <span className="text-[var(--danger)]" title={String(error?.message || error)}>status unavailable</span>
          ) : total === 0 ? (
            <span>waiting for agents</span>
          ) : (
            <span><span className="text-[var(--fg)] font-medium tabular-nums">{onlineDisplay}</span><span className="text-[var(--fg-dim)]">/{total}</span> online</span>
          )}
        </div>
      </div>
    </Link>
  );
}

/** 3-node mesh mark — same SVG as /login, reusable. */
function BrandMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.2" className="text-[var(--accent-text)]" />
      <line x1="16" y1="10" x2="10" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.45" className="text-[var(--accent-text)]" />
      <line x1="16" y1="10" x2="22" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.45" className="text-[var(--accent-text)]" />
      <line x1="10" y1="20" x2="22" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.45" className="text-[var(--accent-text)]" />
      <circle cx="16" cy="10" r="2.5" fill="currentColor" className="text-[var(--accent-text)]" />
      <circle cx="10" cy="20" r="2.5" fill="currentColor" className="text-green-400" />
      <circle cx="22" cy="20" r="2.5" fill="currentColor" className="text-[var(--accent-text)]" />
    </svg>
  );
}
