'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { applyTheme } from './ThemeSwitcher';
import { useRouter } from 'next/navigation';
import { clearPrivateChatStorage } from '../lib/chat-outbox';

/** Command palette — ⌘K / Ctrl+K / `/` opens; Esc closes;
 *  ↑↓ navigates results; Enter activates.
 *
 *  This is round 14 (scaffold) of the polish loop:
 *  - Modal shell, search input, keyboard shortcuts
 *  - Static command list: page navigation across the dashboard
 *
 *  Future rounds will extend `commands` with actions (open Dispatch,
 *  toggle theme, sign out) and per-page surfaces (jump to task by alias,
 *  jump to node by name).
 */

interface Command {
  id: string;
  title: string;
  hint?: string;
  group: 'Recents' | 'Agents' | 'Tasks' | 'Actions' | 'Navigate';
  icon: React.ReactNode;
  perform: (router: ReturnType<typeof useRouter>) => void;
  /** Matched char indices (set by fuzzy filter for highlight render). */
  _titleHi?: number[];
  _hintHi?: number[];
}

interface SessionRow { alias?: string; status?: string; agent?: string }
interface TaskRow    { task_id?: string; from_name?: string; to_name?: string; content?: string; status?: string }

const RECENTS_KEY = 'anet-cmdk-recents';
const RECENTS_MAX = 4;

function readRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function pushRecent(id: string) {
  try {
    const list = readRecents().filter(x => x !== id);
    list.unshift(id);
    sessionStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {}
}

/** Fuzzy match: returns score + matched char positions in `hay`. -1 score
 *  means no match. Round 18 introduced fuzzy; round 20 returns indices so
 *  the UI can highlight matched chars (Linear / Raycast style). */
interface FuzzyResult { score: number; indices: number[]; }
function fuzzyMatch(hay: string, needle: string): FuzzyResult {
  if (!needle) return { score: 0, indices: [] };
  const H = hay.toLowerCase();
  const N = needle.toLowerCase();
  let hi = 0, ni = 0, score = 0, streak = 0;
  const indices: number[] = [];
  while (hi < H.length && ni < N.length) {
    if (H[hi] === N[ni]) {
      score += 2 + streak;
      streak++;
      indices.push(hi);
      if (hi === 0 || /[\s·:_/-]/.test(H[hi - 1])) score += 4;
      ni++;
    } else {
      streak = 0;
    }
    hi++;
  }
  if (ni < N.length) return { score: -1, indices: [] };
  return { score: score - Math.max(0, H.length - N.length) * 0.05, indices };
}

/** Renders `text` with the chars at `indices` wrapped in <mark>. Handles
 *  unicode (Chinese aliases, emoji) by iterating code points via Array.from. */
function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const chars = Array.from(text);
  return (
    <>
      {chars.map((ch, i) =>
        set.has(i)
          ? <mark key={i} className="anet-cmdk-mark">{ch}</mark>
          : <span key={i}>{ch}</span>
      )}
    </>
  );
}

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

const COMMANDS: Command[] = [
  { id: 'go-overview', title: 'Go to Overview', hint: 'Fleet at a glance', group: 'Navigate',
    icon: <NavIcon d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3" />,
    perform: r => r.push('/') },
  { id: 'go-tasks', title: 'Go to Tasks', hint: 'All task statuses', group: 'Navigate',
    icon: <NavIcon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />,
    perform: r => r.push('/tasks') },
  { id: 'go-tasks-failed', title: 'Go to Failed tasks', hint: 'Filter status=failed', group: 'Navigate',
    icon: <NavIcon d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />,
    perform: r => r.push('/tasks?status=failed') },
  { id: 'go-nodes', title: 'Go to Nodes', hint: 'Agent fleet', group: 'Navigate',
    icon: <NavIcon d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />,
    perform: r => r.push('/nodes') },
  // 侧栏之外/之后加的页（军团、需求、组织、版本、定时、SkillHub、服务器、
  // Provider）一直只有直链，命令面板里搜不到 —— 而侧栏自己写着「低频页仍可
  // 通过 ⌘K 到达」，等于承诺了没兑现。这里补齐导航项，别让新页藏起来。
  { id: 'go-legion', title: 'Go to Legion', hint: '2D 军团组织架构图', group: 'Navigate',
    icon: <NavIcon d="M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7l7-4zM12 8v5m0 0l3 2m-3-2l-3 2" />,
    perform: r => r.push('/legion') },
  { id: 'go-legion-3d', title: 'Go to Legion (3D)', hint: '3D 军团拓扑', group: 'Navigate',
    icon: <NavIcon d="M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7l7-4zM12 8v5m0 0l3 2m-3-2l-3 2" />,
    perform: r => r.push('/legion/3d') },
  { id: 'go-requirements', title: 'Go to Requirements', hint: '需求池 / 进行中 / 完成', group: 'Navigate',
    icon: <NavIcon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 9h6M9 13h6M9 17h3" />,
    perform: r => r.push('/requirements') },
  { id: 'go-org', title: 'Go to Organization', hint: '人 · 部门 · 名下 Agent', group: 'Navigate',
    icon: <NavIcon d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a3 3 0 10-2.6-4.5M9 7a3 3 0 10-2.6 4.5" />,
    perform: r => r.push('/org') },
  { id: 'go-versions', title: 'Go to Versions', hint: '组件版本对照', group: 'Navigate',
    icon: <NavIcon d="M7 7h10M7 12h10M7 17h6" />,
    perform: r => r.push('/versions') },
  { id: 'go-changelog', title: 'Go to Changelog', hint: '更新日志', group: 'Navigate',
    icon: <NavIcon d="M6 4h9l4 4v12H6zM15 4v4h4" />,
    perform: r => r.push('/changelog') },
  { id: 'go-schedules', title: 'Go to Schedules', hint: '定时任务', group: 'Navigate',
    icon: <NavIcon d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z" />,
    perform: r => r.push('/scheduled-tasks') },
  { id: 'go-skillhub', title: 'Go to SkillHub', hint: '技能库', group: 'Navigate',
    icon: <NavIcon d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5s3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18s-3.332.477-4.5 1.253" />,
    perform: r => r.push('/skillhub') },
  { id: 'go-servers', title: 'Go to Servers', hint: 'daemon 主机', group: 'Navigate',
    icon: <NavIcon d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v1A2.5 2.5 0 0117.5 10h-11A2.5 2.5 0 014 7.5v-1zM4 16.5A2.5 2.5 0 016.5 14h11a2.5 2.5 0 012.5 2.5v1a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5v-1zM7 7h.01M7 17h.01" />,
    perform: r => r.push('/servers') },
  { id: 'go-providers', title: 'Go to Providers', hint: '模型 Provider 注册表', group: 'Navigate',
    icon: <NavIcon d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />,
    perform: r => r.push('/providers') },
  { id: 'go-messages', title: 'Go to Messages', hint: 'Inter-agent chat', group: 'Navigate',
    icon: <NavIcon d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />,
    perform: r => r.push('/messages') },
  { id: 'go-networks', title: 'Go to Networks', hint: 'Manage networks', group: 'Navigate',
    icon: <NavIcon d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />,
    perform: r => r.push('/settings/networks') },
  { id: 'go-logs', title: 'Go to Audit Log', hint: 'Register / login / actions', group: 'Navigate',
    icon: <NavIcon d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />,
    perform: r => r.push('/logs') },
  { id: 'go-server-logs', title: 'Go to Server Logs', hint: 'CommHub stdout/stderr', group: 'Navigate',
    icon: <NavIcon d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
    perform: r => r.push('/server-logs') },
  { id: 'go-admin', title: 'Go to Admin', hint: 'Server overview + broadcast', group: 'Navigate',
    icon: <NavIcon d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />,
    perform: r => r.push('/admin') },
  { id: 'go-settings', title: 'Go to Settings', hint: 'Connection / Account / Resources', group: 'Navigate',
    icon: <NavIcon d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
    perform: r => r.push('/settings') },

  // ── Actions group (round 15) ─────────────────────────────────
  { id: 'act-toggle-theme', title: 'Toggle theme', hint: 'dark ↔ light', group: 'Actions',
    icon: <NavIcon d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />,
    perform: () => {
      // classic dark ↔ light. applyTheme owns the data-skin contract (it
      // clears the slack skin attribute when leaving that theme).
      const isDark = (document.documentElement.getAttribute('data-theme') || 'cyber') === 'cyber';
      const next = isDark ? 'light' : 'cyber';
      applyTheme(next);
      try { localStorage.setItem('anet-theme', next); } catch {}
    } },
  { id: 'act-copy-url', title: 'Copy current URL', hint: 'page link to clipboard', group: 'Actions',
    icon: <NavIcon d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />,
    perform: () => {
      try { navigator.clipboard.writeText(window.location.href); } catch {}
    } },
  { id: 'act-sign-out', title: 'Sign out', hint: 'clear session', group: 'Actions',
    icon: <NavIcon d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />,
    perform: () => {
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      clearPrivateChatStorage();
      try { sessionStorage.removeItem('anet_v3_auth'); } catch {}
      window.location.assign('/login');
    } },
  { id: 'act-help', title: 'Show keyboard shortcuts', hint: 'press ? — works on mobile too', group: 'Actions',
    icon: <NavIcon d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
    perform: () => {
      // Dispatch synthetic `?` keydown so HelpOverlay's global listener opens
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    } },

  // ── Round 69 / Loop: topology filter actions ────────────────
  // Write the pin directly into sessionStorage (the same key R66
  // hydrates from) and broadcast a `storage`-like custom event
  // so TopoGraph picks it up without a reload. Keyboard-accessible
  // filter trigger from anywhere on the dashboard.
  { id: 'act-pin-working', title: 'Pin topology filter: working', hint: 'highlight working nodes only', group: 'Actions',
    icon: <NavIcon d="M4 6h16M4 12h8m-8 6h16" />,
    perform: () => {
      try { sessionStorage.setItem('anet-topo-pinned-status', 'working'); } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'status', value: 'working' } }));
    } },
  { id: 'act-pin-idle', title: 'Pin topology filter: idle', hint: 'highlight idle (online) nodes only', group: 'Actions',
    icon: <NavIcon d="M4 6h16M4 12h8m-8 6h16" />,
    perform: () => {
      try { sessionStorage.setItem('anet-topo-pinned-status', 'idle'); } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'status', value: 'idle' } }));
    } },
  { id: 'act-pin-offline', title: 'Pin topology filter: offline', hint: 'highlight offline / no-SSE nodes', group: 'Actions',
    icon: <NavIcon d="M4 6h16M4 12h8m-8 6h16" />,
    perform: () => {
      try { sessionStorage.setItem('anet-topo-pinned-status', 'offline'); } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'status', value: 'offline' } }));
    } },
  // Round 108 / Loop: pin-vendor palette actions. R88 made vendor
  // letters clickable in the chip row, R89 added the filter pill,
  // R90 added clear-vendor here — but PIN-vendor was missing. Three
  // static commands for the major vendors (Anthropic / OpenAI /
  // 书生) cover the common case; users with unusual vendors still
  // have the chip-row click + cmdk clear path. TopoGraph's R108
  // listener handles kind='vendor' to set the pin. The R88 stale-
  // purge useEffect cleans up if the targeted vendor isn't actually
  // in the fleet, so these commands are safe to invoke any time.
  { id: 'act-pin-vendor-A', title: 'Pin topology filter: Anthropic', hint: 'highlight A vendor only', group: 'Actions',
    icon: <NavIcon d="M4 6h16M4 12h8m-8 6h16" />,
    perform: () => {
      try { sessionStorage.setItem('anet-topo-pinned-vendor', 'A'); } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'vendor', value: 'A' } }));
    } },
  { id: 'act-pin-vendor-O', title: 'Pin topology filter: OpenAI', hint: 'highlight O vendor only', group: 'Actions',
    icon: <NavIcon d="M4 6h16M4 12h8m-8 6h16" />,
    perform: () => {
      try { sessionStorage.setItem('anet-topo-pinned-vendor', 'O'); } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'vendor', value: 'O' } }));
    } },
  { id: 'act-pin-vendor-S', title: 'Pin topology filter: 书生', hint: 'highlight 书 vendor only', group: 'Actions',
    icon: <NavIcon d="M4 6h16M4 12h8m-8 6h16" />,
    perform: () => {
      try { sessionStorage.setItem('anet-topo-pinned-vendor', '书'); } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'vendor', value: '书' } }));
    } },
  { id: 'act-clear-topo-pins', title: 'Clear topology filters', hint: 'release pinned status + group + vendor + edge', group: 'Actions',
    icon: <NavIcon d="M6 18L18 6M6 6l12 12" />,
    perform: () => {
      try {
        sessionStorage.removeItem('anet-topo-pinned-status');
        sessionStorage.removeItem('anet-topo-pinned-group');
        // Round 90 / Loop: R88 added pinnedVendor as the third filter
        // dimension. The clear-all command must clear it too or it
        // silently retains the vendor pin, which a user would read
        // as a stuck filter.
        // Round 117 / Loop: R116 added pinnedEdgeKey as the fourth pin
        // dim — no sessionStorage (per-tab transient), but the
        // dispatched `clear` event still needs to flip it. The
        // TopoGraph listener handles that.
        sessionStorage.removeItem('anet-topo-pinned-vendor');
      } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'clear' } }));
    } },
  // Round 117 / Loop: granular edge-only clear, mirror of R90
  // clear-vendor. Releases the pinnedEdgeKey without disturbing
  // status/group/vendor pins. pinnedEdgeKey lives only in React
  // state (no sessionStorage), so the perform is just a dispatch.
  { id: 'act-clear-topo-edge', title: 'Clear topology edge pin', hint: 'release pinned recent-signal row only', group: 'Actions',
    icon: <NavIcon d="M6 18L18 6M6 6l12 12" />,
    perform: () => {
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'clear-edge' } }));
    } },
  // Round 90 / Loop: granular vendor-only clear. R88 added per-letter
  // toggle and Esc-clears-all; this fills the keyboard-only middle
  // ground (release the vendor pin without disturbing status/group).
  // Listed only when the user types "vendor" — fuzzy match still
  // surfaces it under broader queries like "clear".
  { id: 'act-clear-topo-vendor', title: 'Clear topology vendor filter', hint: 'release pinned vendor only', group: 'Actions',
    icon: <NavIcon d="M6 18L18 6M6 6l12 12" />,
    perform: () => {
      try { sessionStorage.removeItem('anet-topo-pinned-vendor'); } catch {}
      window.dispatchEvent(new CustomEvent('anet:topo-pin', { detail: { kind: 'clear-vendor' } }));
    } },

  // ── Round 74 / Loop: layout + view shortcuts via the palette ──
  // Sister to R69 pin actions. Layout toggle and fit-to-canvas already
  // have keyboard shortcuts (l / f, per R29 R32) but users who forget
  // the keys can search "layout" / "fit" in the palette instead.
  // Layout: write localStorage in lockstep then broadcast — the storage
  // write matters for SSR (init reader uses it) and the event keeps the
  // mounted canvas in sync without a reload.
  { id: 'act-topo-toggle-layout', title: 'Toggle topology layout', hint: 'ring ↔ grid (or press `l`)', group: 'Actions',
    icon: <NavIcon d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />,
    perform: () => {
      window.dispatchEvent(new CustomEvent('anet:topo-layout', { detail: { kind: 'toggle' } }));
    } },
  { id: 'act-topo-fit', title: 'Fit topology to canvas', hint: 'auto-zoom to content (or press `f`)', group: 'Actions',
    icon: <NavIcon d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />,
    perform: () => {
      window.dispatchEvent(new CustomEvent('anet:topo-view', { detail: { kind: 'fit' } }));
    } },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Global hotkey ⌘K / Ctrl+K / `/`
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
        return;
      }
      // `/` opens only when no input is currently focused
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && !open) {
        e.preventDefault();
        setOpen(true);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Reset state on open + auto-focus input
  const lastFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      // 记住打开前的焦点元素：关闭时归还。否则按 Esc 后焦点掉到 <body>，
      // 键盘用户会丢失位置，只能从头 Tab（WCAG 2.4.3 焦点顺序）。
      lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
      return;
    }
    const back = lastFocusRef.current;
    lastFocusRef.current = null;
    if (back && document.contains(back)) {
      // 等遮罩卸载后再还，preventScroll 避免页面被拽动
      setTimeout(() => { try { back.focus({ preventScroll: true }); } catch { /* 元素已不可聚焦 */ } }, 0);
    }
  }, [open]);

  // Read recents on open
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => { if (open) setRecentIds(readRecents()); }, [open]);

  // Round 16: per-page surfaces. Pull agents + tasks on palette open so the
  // user can type an alias / task content and jump directly to it. Both
  // endpoints are already cached by SWR elsewhere, so this is cheap.
  const [dynamic, setDynamic] = useState<Command[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [sRes, tRes] = await Promise.all([
          fetch('/api/hub/status').then(r => r.ok ? r.json() : { sessions: [] }),
          fetch('/api/hub/tasks?limit=20').then(r => r.ok ? r.json() : { tasks: [] }),
        ]);
        if (cancelled) return;
        const agentCmds: Command[] = (sRes.sessions as SessionRow[] || [])
          .filter(s => s.alias)
          .slice(0, 20)
          .map(s => ({
            id: `agent-${s.alias}`,
            title: `Go to agent ${s.alias}`,
            hint: `${s.agent || 'agent'} · ${s.status || 'unknown'}`,
            group: 'Agents',
            icon: <NavIcon d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
            perform: (r) => r.push(`/node?alias=${encodeURIComponent(s.alias!)}`),
          }));
        const taskCmds: Command[] = (tRes.tasks as TaskRow[] || [])
          .filter(t => t.task_id)
          .slice(0, 15)
          .map(t => ({
            id: `task-${t.task_id}`,
            title: `Open task: ${(t.content || t.task_id || '').slice(0, 50)}`,
            hint: `${t.from_name || '?'} → ${t.to_name || '?'} · ${t.status || ''}`,
            group: 'Tasks',
            icon: <NavIcon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />,
            perform: (r) => r.push(`/tasks/${encodeURIComponent(t.task_id!)}`),
          }));
        setDynamic([...agentCmds, ...taskCmds]);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Filtered results — when no query, prepend recents as their own group
  const results = useMemo(() => {
    const pool = [...COMMANDS, ...dynamic];
    if (!query.trim()) {
      const recentCmds: Command[] = recentIds
        .map(id => pool.find(c => c.id === id))
        .filter((c): c is Command => Boolean(c))
        .map(c => ({ ...c, group: 'Recents' }));
      const restIds = new Set(recentIds);
      // Default view: Recents → Navigate → Actions (no dynamic agents/tasks
      // until user actually types — keeps the empty-search list short).
      return [...recentCmds, ...COMMANDS.filter(c => !restIds.has(c.id))];
    }
    // Fuzzy match — `stg` matches `Settings`, `taska` matches `Task all-time`.
    // Score against title (weight 1.0), hint (0.6), id (0.3). Drop unmatched.
    // Round 20: keep matched indices for title + hint so we can highlight.
    const scored = pool
      .map(c => {
        const mt = fuzzyMatch(c.title, query);
        const mh = c.hint ? fuzzyMatch(c.hint, query) : { score: -1, indices: [] };
        const mi = fuzzyMatch(c.id, query);
        const best = Math.max(
          mt.score >= 0 ? mt.score * 1.0 : -Infinity,
          mh.score >= 0 ? mh.score * 0.6 : -Infinity,
          mi.score >= 0 ? mi.score * 0.3 : -Infinity,
        );
        return {
          c,
          score: best,
          _titleHi: mt.score >= 0 ? mt.indices : [],
          _hintHi: mh.score >= 0 ? mh.indices : [],
        };
      })
      .filter(x => x.score > -Infinity);
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => ({ ...x.c, _titleHi: x._titleHi, _hintHi: x._hintHi }));
  }, [query, recentIds, dynamic]);

  // Clamp selected when results shrink
  useEffect(() => {
    if (selected >= results.length) setSelected(0);
  }, [results.length, selected]);

  // Keyboard inside modal
  const onModalKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const c = results[selected];
      if (c) { pushRecent(c.id); c.perform(router); setOpen(false); }
    }
  };

  if (!open) return null;

  // Group results by `group` field
  const grouped: Record<string, Command[]> = {};
  for (const c of results) {
    (grouped[c.group] ||= []).push(c);
  }
  // Index map so click handlers know which "selected" each item is
  let runningIdx = 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="anet-cmdk fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] sm:pt-[15vh] px-4"
      onClick={() => setOpen(false)}
      onKeyDown={onModalKey}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden />
      <div
        className="relative w-full max-w-xl rounded-xl border border-[#26262b] bg-[#111113] shadow-2xl shadow-black/40 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[#26262b] px-3 py-2.5">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" className="text-gray-500 shrink-0">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0); }}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-base sm:text-sm text-gray-200 placeholder-gray-600 focus:outline-none"
          />
          <kbd className="text-[11px] text-gray-600 border border-[#26262b] rounded px-1.5 py-0.5 font-mono">esc</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-gray-600">
              No commands match &quot;{query}&quot;
            </div>
          ) : (
            Object.entries(grouped).map(([groupName, items]) => (
              <div key={groupName} className="mb-2 last:mb-0">
                <div className="text-[11px] uppercase tracking-[0.12em] text-gray-600 px-3 py-1">{groupName}</div>
                {items.map(c => {
                  const idx = runningIdx++;
                  const isActive = idx === selected;
                  return (
                    <button
                      key={c.id}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => { pushRecent(c.id); c.perform(router); setOpen(false); }}
                      className={`anet-cmdk-row w-full flex items-center gap-3 px-3 py-2 text-left text-sm ${
                        isActive ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-300 hover:bg-[#1c1c1f]/50'
                      }`}
                    >
                      <span className={isActive ? 'text-cyan-400' : 'text-gray-500'}>{c.icon}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">
                          <Highlight text={c.title} indices={c._titleHi || []} />
                        </span>
                        {c.hint && (
                          <span className="block text-[11px] text-gray-600 truncate">
                            <Highlight text={c.hint} indices={c._hintHi || []} />
                          </span>
                        )}
                      </span>
                      {isActive && <span className="text-[11px] text-gray-500">↵</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-[#26262b] px-3 py-1.5 flex items-center justify-between text-[11px] text-gray-600">
          <span className="flex items-center gap-3">
            <span><kbd className="font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono">↵</kbd> select</span>
            <span><kbd className="font-mono">esc</kbd> close</span>
          </span>
          <span><kbd className="font-mono">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
