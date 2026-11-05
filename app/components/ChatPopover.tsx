'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AliasAvatar } from './AliasAvatar';
import { TaskChatPanel } from './TaskChatPanel';
import { useSessions, useHealth } from '../lib/hooks';
import { relativeAgo } from '../lib/time';
import { isOnline as presenceIsOnline } from '../lib/presence';
import { useReturnFocus } from '../lib/useReturnFocus';

interface ChatPopoverProps {
  /** Node alias to chat with. Changing it switches the conversation. */
  alias: string;
  onClose: () => void;
}

const MAX_W = 380;
const MAX_H = 520;
const MIN_W = 300;
const MIN_H = 320;
const MARGIN = 16;
const MOBILE_BP = 640;

/**
 * Issue #100: a floating, draggable chat window opened by clicking a node
 * avatar in the topology graph. Singleton — the parent (TopoGraph) keeps a
 * single `chatAlias`, so clicking another node just swaps `alias` here and
 * the conversation switches in place.
 *
 * Issue #106: a bottom-right handle resizes the window (drag to change w/h,
 * clamped to MIN_W/MIN_H .. the viewport). Coexists with the header move-drag
 * and the close button — each interaction lives on a distinct element and
 * stops its own pointerdown from reaching the others.
 *
 * One consistent design across viewports: a floating draggable card sized to
 * fit (`min(380, vw-32) × min(520, vh-96)`). On a phone it ends up near
 * full-width, so it's docked low on open — the graph above stays visible, and
 * to chat with a different node you drag it down / tap an exposed avatar.
 *
 * The chat body reuses TaskChatPanel's `inline` mode — send / SSE-receive /
 * history are already solved there; this component only adds the floating
 * shell + drag/resize behaviour.
 */
/** Round 37 / Loop: surface node metadata (cwd + last-seen) inside the
 *  ChatPopover header. The SVG <title> tooltip (Rounds 33-34) only shows
 *  on hover-over-node, which is lost once the popover is open and
 *  potentially dragged away. Lifting cwd and last-seen into the popover
 *  header keeps the context where the user actually needs it.
 *
 *  Round 38: relativeAgo factored to app/lib/time.ts so this file shares
 *  the same TZ-safe parser as TopoGraph (was a duplicated mirror until
 *  this round). */

export function ChatPopover({ alias, onClose }: ChatPopoverProps) {
  useReturnFocus();
  // Position + size are resolved on mount (SSR-safe defaults here).
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: MAX_W, h: MAX_H });
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; baseX: number; baseY: number }>({
    active: false, startX: 0, startY: 0, baseX: 0, baseY: 0,
  });
  const resizeRef = useRef<{ active: boolean; startX: number; startY: number; baseW: number; baseH: number }>({
    active: false, startX: 0, startY: 0, baseW: 0, baseH: 0,
  });

  // Round 37 / Loop: pull the target session out of the SWR cache that
  // TopoGraph already populates — same URL, so no extra network fetch.
  const { sessions } = useSessions();
  const { health } = useHealth();
  const session = useMemo(() => sessions.find(s => s.alias === alias), [sessions, alias]);
  // #515: presence via SSE-reachability, same source of truth as the
  // stats card / sidebar / topology halos. Old predicate was pure
  // `status !== 'offline'`, which for the chat popover directly
  // contradicted #214 F2's stated reason ("a card you can't chat with
  // shouldn't say 'online'"). SWR dedupes /api/hub/health with page.tsx.
  const isOnline = !!session && presenceIsOnline(session, health?.sse_sessions);
  const lastSeenLine = !isOnline ? relativeAgo(session?.last_seen_at) : null;

  const clamp = useCallback((x: number, y: number, w: number, h: number) => {
    const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
    return {
      x: Math.min(Math.max(MARGIN, x), maxX),
      y: Math.min(Math.max(MARGIN, y), maxY),
    };
  }, []);

  useEffect(() => {
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(MAX_W, vw - MARGIN * 2);
      const h = Math.min(MAX_H, vh - MARGIN * 6);
      setSize({ w, h });
      const mobile = vw < MOBILE_BP;
      // Desktop: top-right of the graph. Mobile: docked low so the graph
      // above stays visible — switch nodes by tapping an exposed avatar.
      const x = mobile ? MARGIN : vw - w - 24;
      const y = mobile ? vh - h - MARGIN : 96;
      setPos(clamp(x, y, w, h));
    };
    place();
    // Keep the popover on-screen if the window is resized.
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [clamp]);

  // Esc closes — matches the rest of the dashboard's overlay convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active) return;
    setPos(clamp(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY), size.w, size.h));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); } catch {}
  };

  // Resize from the bottom-right handle. stopPropagation keeps the header
  // move-drag out of it; the popover is top-left anchored so growing it can
  // only push the bottom/right edges, which we clamp to the viewport.
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    resizeRef.current = { active: true, startX: e.clientX, startY: e.clientY, baseW: size.w, baseH: size.h };
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r.active) return;
    e.stopPropagation();
    const maxW = Math.max(MIN_W, window.innerWidth - pos.x - MARGIN);
    const maxH = Math.max(MIN_H, window.innerHeight - pos.y - MARGIN);
    setSize({
      w: Math.min(maxW, Math.max(MIN_W, r.baseW + (e.clientX - r.startX))),
      h: Math.min(maxH, Math.max(MIN_H, r.baseH + (e.clientY - r.startY))),
    });
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current.active) return;
    resizeRef.current.active = false;
    e.stopPropagation();
    try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); } catch {}
  };

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] shadow-2xl shadow-black/60 anet-fade-in"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
      role="dialog"
      aria-label={`Chat with ${alias}`}
    >
      {/* Drag handle — the whole header bar moves the window. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)] bg-[var(--bg-secondary)] rounded-t-xl cursor-grab active:cursor-grabbing select-none touch-none"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <AliasAvatar alias={alias} size={28} />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)] truncate">{alias}</div>
            {/* Round 37: cwd / last-seen lines surface the same metadata
                the SVG <title> tooltip carries (rounds 33-34), but inside
                the popover where it stays accessible after dragging the
                window away from the node. Fall back to the drag-hint
                when no metadata is reported. */}
            {session?.project_dir ? (
              <div className="text-[11px] text-[var(--fg-muted)] truncate font-mono" title={session.project_dir} data-popover-cwd>
                cwd: {session.project_dir}
              </div>
            ) : null}
            {lastSeenLine ? (
              <div className="text-[11px] text-[var(--fg-muted)] truncate" data-popover-lastseen>
                last seen: {lastSeenLine}
              </div>
            ) : null}
            {!session?.project_dir && !lastSeenLine ? (
              <div className="text-[11px] text-[var(--fg-muted)]">Drag to move · Esc to close</div>
            ) : null}
          </div>
        </div>
        <button
          onClick={onClose}
          // Without this the header's drag handler captures the pointer and
          // Chromium retargets the click to the header — the button never fires.
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Close chat"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--fg-muted)] hover:text-[var(--fg)] rounded-lg hover:bg-[var(--bg-elevated)] shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Chat body — TaskChatPanel inline mode owns send / SSE / history. */}
      <div className="flex-1 min-h-0">
        <TaskChatPanel alias={alias} onClose={onClose} inline />
      </div>

      {/* Issue #106: bottom-right resize handle. */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        aria-label="Resize chat"
        className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize touch-none z-10"
        style={{ touchAction: 'none' }}
      >
        <svg className="absolute bottom-0.5 right-0.5 w-3 h-3 text-[var(--fg-dim)]" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
          <path d="M11 5L5 11M11 9L9 11" />
        </svg>
      </div>
    </div>
  );
}
