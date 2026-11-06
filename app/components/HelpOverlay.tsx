'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

/** Help overlay — press `?` to see keyboard shortcuts.
 *  Restrained: no animation noise, single column, all global keys in one
 *  place. Closes on Esc or `?` again or click-outside.
 */

interface Shortcut {
  keys: string[];
  label: string;
}

// vim 风格 `g` + 单键的跳转表。帮助面板的「Navigate」分组直接由这张表生成，
// 免得再加页面时只改一处、另一处忘掉（军团/需求就是这样漏掉的）。
// 大小写有意义：`g l` 去军团（常用），`g L`（Shift+L）才是审计日志。
const GO_TARGETS: Record<string, { href: string; label: string }> = {
  o: { href: '/', label: 'Overview' },
  t: { href: '/tasks', label: 'Tasks' },
  n: { href: '/nodes', label: 'Nodes' },
  r: { href: '/requirements', label: 'Requirements' },
  l: { href: '/legion', label: 'Legion' },
  m: { href: '/messages', label: 'Messages' },
  w: { href: '/settings/networks', label: 'Networks' },
  a: { href: '/admin', label: 'Admin' },
  s: { href: '/settings', label: 'Settings' },
  L: { href: '/logs', label: 'Audit Log' },
};

const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: 'Global',
    items: [
      { keys: ['⌘', 'K'], label: 'Open command palette (also Ctrl+K)' },
      { keys: ['/'], label: 'Open command palette' },
      { keys: ['?'], label: 'Toggle this help overlay' },
      { keys: ['Esc'], label: 'Close any open modal' },
    ],
  },
  {
    group: 'Navigate (vim-style: g then…)',
    items: Object.entries(GO_TARGETS).map(([key, target]) => ({ keys: ['g', key], label: `Go to ${target.label}` })),
  },
  {
    group: 'Requirements list',
    items: [
      { keys: ['/'], label: 'Focus the search box' },
      { keys: ['j', 'k'], label: 'Move between rows (↑/↓ too)' },
      { keys: ['w'], label: 'Toggle “due this week” filter (loaded rows only)' },
    ],
  },
  {
    group: 'Command palette',
    items: [
      { keys: ['↑', '↓'], label: 'Move selection' },
      { keys: ['↵'], label: 'Activate selected command' },
      { keys: ['type'], label: 'Filter — searches commands, agents, tasks' },
    ],
  },
  // Round 25 / Loop: TopoGraph keys + mouse gestures from rounds 21-23
  // were only surfaced in button titles. Consolidating here gives the
  // Help overlay (the canonical discovery surface) a single place to
  // learn the canvas controls.
  {
    group: 'Legion (2D / 3D)',
    items: [
      { keys: ['↑', '↓', '←', '→'], label: '2D: move between nodes · 3D: orbit the camera' },
      { keys: ['+', '−'], label: '3D: zoom in / out' },
      { keys: ['R'], label: '3D: reset the camera' },
      { keys: ['↵'], label: 'Open the selected node (agent page / org)' },
      { keys: ['Space'], label: 'Collapse or expand the selected department' },
      { keys: ['/'], label: 'Search nodes on this page' },
      { keys: ['Esc'], label: 'Clear the node filter' },
      { keys: ['list'], label: 'The graph has one Tab stop; use the node list for the rest' },
    ],
  },
  {
    group: 'Topology canvas',
    items: [
      { keys: ['+'], label: 'Zoom in (also =)' },
      { keys: ['−'], label: 'Zoom out' },
      { keys: ['0'], label: 'Reset zoom + pan' },
      { keys: ['f'], label: 'Fit topology to canvas' },
      { keys: ['l'], label: 'Toggle layout (ring ↔ grid)' },
      { keys: ['⌘', 'wheel'], label: 'Zoom toward cursor (Ctrl on Windows/Linux)' },
      { keys: ['drag'], label: 'Pan the canvas (cursor → grabbing)' },
      { keys: ['dbl-click'], label: 'Reset zoom + pan (empty canvas only)' },
      { keys: ['click'], label: 'Open chat popover on a node (Esc to close)' },
      // Round 59 / Loop: discoverability for the interactions added in
      // R52 (hub click), R55 (legend status hover), R56 (recent-signal
      // row hover). All three live inside the topology canvas, so this
      // is the right group for the new entries.
      { keys: ['click hub'], label: 'Fit topology to canvas' },
      { keys: ['hover legend'], label: 'Highlight nodes of a status' },
      { keys: ['hover signal'], label: 'Highlight one flow edge' },
      // Round 62 / Loop: R60 + R61 added click-to-pin on the pressure
      // chip and legend rows; R62 added Esc to release the pin. Pin
      // gives users a sticky filter (vs R55 transient hover).
      { keys: ['click chip'], label: 'Pin a status filter' },
      { keys: ['Esc'], label: 'Clear pinned filter — or close chat' },
      // Round 65 / Loop: R63 added group-pin via group label click; R64
      // added active-filter pills in the chip row with per-pill ×
      // clear. Both compose with the R62 Esc keystroke (single press
      // clears everything pinned).
      { keys: ['click group'], label: 'Pin a team focus' },
      { keys: ['click ×'], label: 'Clear one filter — Esc clears all' },
      // Round 70 / Loop: R69 added 4 Cmd+K palette actions that pin/
      // clear topology filters from anywhere. Surface them so keyboard
      // power users find the shortcut without spelunking the palette.
      { keys: ['⌘', 'K'], label: 'Pin / clear filters via palette → "Pin topology filter…"' },
      // Round 74 / Loop: palette also exposes layout + view actions —
      // a search-friendly alternative to the `l` (R32) and `f` (R29)
      // keyboard shortcuts for users who can't remember them.
      { keys: ['⌘', 'K'], label: 'Toggle layout / Fit canvas via palette' },
      // Round 78 / Loop: surface R73 (whole pill body is a click target)
      // and R77 (active-links chip hover → boost all flow edges) —
      // both are real user gestures that weren't in the help overlay.
      { keys: ['click pill'], label: 'Clear filter — click anywhere on the pill body' },
      { keys: ['hover chip'], label: 'Brighten all active flows — hover "N active links"' },
      // Round 81 / Loop: catch up on the two newest chip-row affordances
      // — R79 working/online chips and R80 vendor-letter chips. All
      // four chip hovers feed the same dim mechanic the R55 legend
      // rows use.
      { keys: ['hover N working'], label: 'Highlight working nodes — chip-row sibling of legend' },
      { keys: ['hover vendor'], label: 'Highlight one vendor — hover A/O/书/? in the chip row' },
      // Round 87 / Loop: catch up on the two newest hover-preview
      // gestures that close click-only gaps from earlier rounds.
      // R83 added preview-before-pin on the pressure-bar segments;
      // R86 did the same for group labels. Both compose with their
      // existing click-pin (R60 / R63) — hover transient, click
      // sticky, Esc clears (R62).
      { keys: ['hover seg'], label: 'Preview a status filter — hover a pressure-bar segment' },
      { keys: ['hover group'], label: 'Preview a team focus — hover a group label' },
      // Round 91 / Loop: catch up on vendor pin (R88) and granular
      // Cmd+K vendor-clear (R90). Vendor was the last filter
      // dimension without a sticky pin; the click-to-pin gesture
      // and palette clear command both deserve discovery entries.
      // R89's third "filter:" pill is already covered by the
      // generic "click pill" (R73) and "click ×" (R64) entries.
      { keys: ['click vendor'], label: 'Pin a vendor filter — click A/O/书/? in the chip row' },
      { keys: ['⌘', 'K'], label: 'Clear vendor pin only via palette → "Clear topology vendor filter"' },
      // Round 109 / Loop: catch up on R108 — palette gained
      // pin-vendor commands for the three major vendors. Mirror of
      // R69's pin-status entry; closes the symmetric gap so the
      // palette can both pin AND clear every filter dimension.
      { keys: ['⌘', 'K'], label: 'Pin vendor: Anthropic/OpenAI/书生 via palette → "Pin topology filter…"' },
      // Round 118 / Loop: catch up on R116 (recent-signal row click
      // pins the edge — the 4th pin dim, completing the hover→pin
      // sweep) and R117 (granular Cmd+K clear-edge command).
      { keys: ['click row'], label: 'Pin a flow filter — click a recent-signal row to lock the edge' },
      { keys: ['⌘', 'K'], label: 'Clear edge pin only via palette → "Clear topology edge pin"' },
      // Round 123 / Loop: catch up on R121 — the edge midpoint count
      // badge (R100) became a click-to-pin affordance, giving the
      // canvas side a peer to R116's row-pin. R122 made hovering the
      // badge mirror line hover; doesn't need its own entry — it's
      // the natural hover partner of this click gesture.
      { keys: ['click badge'], label: 'Pin a flow filter from the canvas — click an edge midpoint count badge' },
      // Round 134 / Loop: catch up on R133 — the recent-signal panel's
      // "+ N more flows" truncation footer (R128) became a clickable
      // nav to /messages. First TopoGraph affordance that reaches OUT
      // of the canvas; every prior gesture composes back into local
      // state. Help overlay should surface the cross-page jump so
      // operators know the path exists. R124-R132 were all passive
      // visuals / motion / readouts with no new gestures, so this is
      // the only new entry since R123.
      { keys: ['click footer'], label: 'See all flows — click "+ N more flows" in the recent-signal panel' },
      // Round 137 / Loop: catch up on R136 — the "N active links"
      // chip in the chip row gained a real onClick → /messages
      // navigation (it already had cursor:pointer since R77 but the
      // handler was missing, the cursor was lying). Pairs with R133
      // footer-nav at a different surface: R133 lives on the canvas-
      // side panel and only shows when flowLinks > 3; R136 lives at
      // the chip row and triggers whenever flowLinks > 0 — a broader
      // entry point for the same "show me the full list" jump.
      { keys: ['click chip'], label: 'See all flows — click the "N active links" chip in the chip row' },
      // Round 141 / Loop: catch up on R139 + R140 — the chip-row
      // "N working" and "N online" chips finally honour the cursor:
      // pointer they've carried since R79. Working pins
      // pinnedStatus='working' (composes with R60 pressure-bar + R61
      // legend rows — three surfaces, one pin); online navigates to
      // /nodes (pinning 'idle' would misrepresent the chip, which
      // semantically means working+idle). Two entries this round
      // because two new gestures landed since R137's catch-up.
      { keys: ['click chip'], label: 'Pin "working" status — click "N working" in the chip row' },
      { keys: ['click chip'], label: 'Open the agent list — click "N online" in the chip row' },
      // Round 153 / Loop: catch up on R151 — node <g> gained role=button
      // + tabIndex=0 + aria-pressed + onKeyDown so keyboard-only users
      // can Tab to a node and press Enter / Space to open the chat
      // popover (same path as mouse click). Was the FIRST true keyboard
      // gesture added since R141 (R142-R150 were visual / motion / hover
      // refinements; R151 + R152 added/closed keyboard handlers — R152
      // wired Enter on the group label which is just the keyboard parallel
      // of the existing R63 click-group entry, so it doesn't earn a new
      // line). The chat-open path didn't exist as a keyboard gesture
      // before R151, so this is the discoverability entry for it.
      { keys: ['Tab', 'Enter'], label: 'Open chat on a focused node (also Space) — keyboard parallel of click-to-chat' },
    ],
  },
];


export function HelpOverlay() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  /** Timestamp when `g` was last pressed. The next single letter within
   *  1500ms is interpreted as the target page. vim-style `g o`, `g t`, etc. */
  const gAtRef = useRef<number>(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement | null)?.isContentEditable;
      // `?` toggles — Shift+/ on US layout. Only when no input is focused.
      if (e.key === '?' && !inInput) {
        e.preventDefault();
        setOpen(prev => !prev);
        return;
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
      // Vim-style `g + letter` route shortcuts (round 35). Skip when modifier
      // keys are held (g is a perfectly fine letter when ⌘ is involved) and
      // when typing into a field.
      if (inInput || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') {
        gAtRef.current = Date.now();
        return;
      }
      if (Date.now() - gAtRef.current < 1500) {
        const target = GO_TARGETS[e.key];
        if (target) {
          e.preventDefault();
          gAtRef.current = 0;
          router.push(target.href);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, router]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="anet-help fixed inset-0 z-[101] flex items-center justify-center px-4"
      onClick={() => setOpen(false)}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden />
      <div
        className="relative w-full max-w-md rounded-xl border border-[#26262b] bg-[#111113] shadow-2xl shadow-black/40 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#26262b] px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" className="text-gray-500">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Keyboard shortcuts
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close help"
            className="text-gray-500 hover:text-gray-300 text-lg leading-none px-1"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3 max-h-[70vh] overflow-y-auto">
          {SHORTCUTS.map(g => (
            <div key={g.group} className="mb-3 last:mb-0">
              <div className="text-[11px] uppercase tracking-[0.12em] text-gray-600 mb-1.5">{g.group}</div>
              <ul className="space-y-1.5">
                {g.items.map((s, i) => (
                  <li key={i} className="flex items-center gap-3 text-xs">
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, ki) => (
                        <kbd key={ki} className="text-[11px] font-mono border border-[#26262b] rounded px-1.5 py-0.5 text-gray-400 bg-[#1c1c1f]/40">
                          {k}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-gray-400 flex-1">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-[#26262b] px-4 py-1.5 text-[11px] text-gray-600 flex items-center justify-between">
          <span>Press <kbd className="font-mono">?</kbd> to toggle</span>
          <span>or <kbd className="font-mono">esc</kbd> to close</span>
        </div>
      </div>
    </div>
  );
}
