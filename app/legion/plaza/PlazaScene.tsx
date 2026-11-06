'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { getAvatarUrl } from '../../lib/avatars';
import type { PlazaDepartment } from '../../lib/legion-directory';

const W = 340, D = 170, SKEW = 44, THICK = 16, ROW = 300;
const HUES = [206, 268, 330, 152, 20, 190, 300, 120, 240, 350, 45, 170];

export function PlazaScene({ platforms, selected, onSelect }: {
  platforms: PlazaDepartment[]; selected: string | null; onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const id = useId().replaceAll(':', '');
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(element);
    return () => ro.disconnect();
  }, []);
  const perRow = width >= 1200 ? 4 : width >= 850 ? 3 : width >= 580 ? 2 : 1;
  const viewW = perRow * 420;
  const viewH = 100 + Math.ceil(platforms.length / perRow) * ROW;
  const textScale = Math.max(1, viewW / Math.max(1, width));
  const slots = platforms.map((platform, i) => ({ platform, x: 60 + (i % perRow) * 420,
    y: 100 + Math.floor(i / perRow) * ROW, scale: Math.max(0.88, 1 - Math.floor(i / perRow) * 0.025) }));
  const byId = new Map(slots.map(s => [s.platform.id, s]));
  return (
    <div ref={container} className="max-h-[65dvh] overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]" data-testid="plaza-scene">
      <svg viewBox={`0 0 ${viewW} ${viewH}`} className="block h-auto w-full" role="group" aria-label="部门展台与真实编制连线" data-testid="legion-plaza-svg">
        <defs>
          <filter id={`${id}-glow`} x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" /></filter>
          <radialGradient id={`${id}-shadow`}><stop offset="0%" stopColor="var(--fg)" stopOpacity="0.18" /><stop offset="100%" stopColor="var(--fg)" stopOpacity="0" /></radialGradient>
          {platforms.map((p, i) => <linearGradient key={p.id} id={`${id}-plate-${i}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={`hsl(${HUES[i % HUES.length]} 62% 46%)`} /><stop offset="100%" stopColor={`hsl(${HUES[i % HUES.length]} 62% 34%)`} />
          </linearGradient>)}
        </defs>
        <g fill="none" stroke="var(--accent-text)" aria-hidden="true" data-testid="plaza-links">
          {slots.map(({ platform, x, y, scale }) => {
            const parent = platform.parentId ? byId.get(platform.parentId) : undefined;
            const tx = x + W * scale / 2, ty = y;
            // Cross-row edges use side gutters, never the department-caption band.
            let d;
            if (parent && parent.y === y) {
              const sx = parent.x + W * parent.scale / 2;
              d = `M ${sx} ${y} C ${sx} ${y - 50} ${tx} ${y - 50} ${tx} ${y}`;
            } else if (parent) {
              const sx = parent.x + (W - SKEW * 0.35) * parent.scale;
              const sy = parent.y + D * 0.35 * parent.scale;
              const rail = parent.x + W * parent.scale + 12;
              d = `M ${sx} ${sy} Q ${rail} ${sy} ${rail} ${sy + 12} V ${ty - 48} Q ${rail} ${ty - 32} ${rail - 16} ${ty - 32} H ${tx + 12} Q ${tx} ${ty - 32} ${tx} ${ty}`;
            } else {
              d = y === 100 ? `M ${viewW / 2} 42 Q ${tx} 42 ${tx} ${ty}`
                : `M ${viewW / 2} 42 H 24 Q 12 42 12 54 V ${ty - 48} Q 12 ${ty - 32} 28 ${ty - 32} H ${tx - 12} Q ${tx} ${ty - 32} ${tx} ${ty}`;
            }
            return <g key={platform.id} data-from={parent?.platform.id ?? 'network'} data-to={platform.id}>
              <path d={d} strokeWidth="7" opacity="0.5" filter={`url(#${id}-glow)`} />
              <path d={d} strokeWidth="1.8" opacity="0.9" />
              <circle cx={tx} cy={ty} r="4" fill="var(--accent-text)" />
            </g>;
          })}
        </g>
        <circle cx={viewW / 2} cy="42" r="8" fill="var(--accent-text)" filter={`url(#${id}-glow)`} />
        <circle cx={viewW / 2} cy="42" r="4" fill="var(--accent-text)" />
        <text x={viewW / 2} y="23" textAnchor="middle" fill="var(--fg-muted)" fontSize={12 * textScale}>当前网络</text>
        {slots.map(({ platform, x, y, scale }, i) => {
          const occupants = [...platform.people.map(p => ({ key: `p:${p.user_id}`, alias: p.username, label: p.display_name || p.username })),
            ...platform.agents.map(a => ({ key: `a:${a.node_id}`, alias: a.alias, label: a.alias || a.node_id }))];
          const shown = occupants.slice(0, 24), rest = occupants.length - shown.length;
          const cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(shown.length * 1.5))));
          const rows = Math.max(1, Math.ceil(shown.length / cols));
          const active = selected === platform.id, empty = !occupants.length;
          const maxName = Math.max(6, Math.floor((W * scale - 20) / (13 * textScale)));
          return <g key={platform.id} transform={`translate(${x} ${y}) scale(${scale})`} opacity={empty ? 0.55 : 1}
            role="button" tabIndex={0} aria-pressed={active} aria-label={`查看${platform.name}：${platform.people.length}人，${platform.agents.length}个Agent`}
            data-testid="plaza-department" data-department-id={platform.id} data-agent-count={platform.agents.length}
            className="cursor-pointer outline-none focus-visible:[&>path]:stroke-[var(--fg)]"
            onClick={() => onSelect(platform.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(platform.id); } }}>
            <title>{platform.name} · 点击查看全部节点与属性</title>
            <ellipse cx={W / 2 - SKEW / 2} cy={D + THICK + 18} rx={W * 0.55} ry="26" fill={`url(#${id}-shadow)`} />
            <path d={`M ${-SKEW} ${D} L ${W - SKEW} ${D} L ${W - SKEW} ${D + THICK} L ${-SKEW} ${D + THICK} Z`} fill={`url(#${id}-plate-${i})`} opacity="0.65" />
            <path d={`M 0 0 L ${W} 0 L ${W - SKEW} ${D} L ${-SKEW} ${D} Z`} fill={`url(#${id}-plate-${i})`}
              stroke={active ? 'var(--fg)' : 'var(--accent-text)'} strokeWidth={active ? 2.5 : 0.7} />
            {shown.map((m, n) => {
              const u = 0.08 + ((n % cols + 0.5) / cols) * 0.84;
              const v = 0.12 + ((Math.floor(n / cols) + 0.5) / rows) * 0.62;
              const url = getAvatarUrl(m.alias);
              return <g key={m.key} transform={`translate(${u * W - v * SKEW} ${v * D})`} aria-hidden="true">
                <circle r="15" fill="var(--bg)" opacity="0.9" />
                {url ? <image href={url} x="-13" y="-13" width="26" height="26" preserveAspectRatio="xMidYMid slice" style={{ clipPath: 'circle(50%)' }} />
                  : <text y="4" textAnchor="middle" fill="var(--fg)" fontSize="13">{(m.label || '?').slice(0, 1)}</text>}
              </g>;
            })}
            {rest > 0 && <text x={W - 55} y={D - 12} textAnchor="end" fill="white" fontSize={12 * textScale}>+{rest}</text>}
            <text x={W / 2 - SKEW / 2} y={D + THICK + 25} textAnchor="middle" fill="var(--fg)" fontSize={13 * textScale / scale} fontWeight="600">{platform.name.length > maxName ? `${platform.name.slice(0, maxName - 1)}…` : platform.name}</text>
            <text x={W / 2 - SKEW / 2} y={D + THICK + 48} textAnchor="middle" fill="var(--fg-muted)" fontSize={11 * textScale / scale}>{platform.people.length} 人 · {platform.agents.length} Agent</text>
          </g>;
        })}
      </svg>
    </div>
  );
}
