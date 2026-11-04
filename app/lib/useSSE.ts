'use client';

import { useEffect, useRef, useState } from 'react';

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

interface UseSSEOptions {
  /** SSE endpoint URL */
  url: string;
  /** Callback for each event */
  onEvent?: (event: SSEEvent) => void;
  /** Auto-reconnect delay in ms (default 3000) */
  reconnectDelay?: number;
  /** Enable/disable (default true) */
  enabled?: boolean;
}

/* ────────────────────────────────────────────────────────────────────
   WeChat-optimization loop R1 (性能主线 · HOL 根治第一步):

   Previously every mounted consumer owned its own EventSource — Overview
   plus EACH open chat panel/tab meant N+1 long-lived connections. On
   HTTP/1.1 the browser caps ~6 connections per host, so a few chat tabs
   saturated the pool and every later fetch (chat history, RSC payloads,
   SWR polls) queued behind them → the "整页超时" class of jank.

   Now a module-level CHANNEL is shared per URL: one probe, one
   EventSource, one reconnect loop — any number of subscribers. The hook
   keeps its exact public API ({connected, lastEvent, supported}), so
   consumers are untouched. The channel tears down when the last
   subscriber unmounts (refcount), preserving the old leak-free
   navigation behavior.
   ──────────────────────────────────────────────────────────────────── */

type ChannelState = {
  es: EventSource | null;
  probeAbort: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  unsupported: boolean;
  connected: boolean;
  supported: boolean | null;
  reconnectDelay: number;
  subscribers: Set<{
    onEvent?: (e: SSEEvent) => void;
    onStatus: (connected: boolean, supported: boolean | null) => void;
  }>;
};

const channels = new Map<string, ChannelState>();

function broadcastStatus(ch: ChannelState) {
  for (const s of ch.subscribers) s.onStatus(ch.connected, ch.supported);
}

function connectChannel(url: string) {
  const ch = channels.get(url);
  if (!ch || ch.unsupported || ch.subscribers.size === 0) return;
  if (ch.es) { ch.es.close(); ch.es = null; }
  if (ch.probeAbort) ch.probeAbort.abort();

  const probeUrl = url.includes('?') ? `${url}&probe=1` : `${url}?probe=1`;
  const probeController = new AbortController();
  ch.probeAbort = probeController;
  const probeTimeout = setTimeout(() => probeController.abort(), 5000);

  fetch(probeUrl, { method: 'HEAD', cache: 'no-store', signal: probeController.signal })
    .finally(() => clearTimeout(probeTimeout))
    .then((res) => {
      if (ch.subscribers.size === 0) return; // everyone left mid-probe
      if (res.headers.get('x-anet-sse-available') !== 'true') {
        ch.unsupported = true;
        ch.connected = false;
        ch.supported = false;
        broadcastStatus(ch);
        return;
      }
      ch.probeAbort = null; // 探测结束：留着它会让后续 needsConnect 永远为 false
      ch.supported = true;
      const es = new EventSource(url);
      ch.es = es;

      es.onopen = () => { ch.connected = true; broadcastStatus(ch); };

      es.onmessage = (e) => {
        try {
          const data: SSEEvent = JSON.parse(e.data);
          for (const s of ch.subscribers) s.onEvent?.(data);
        } catch {}
      };

      es.onerror = () => {
        ch.connected = false;
        broadcastStatus(ch);
        es.close();
        ch.es = null;
        if (ch.subscribers.size > 0) {
          ch.reconnectTimer = setTimeout(() => connectChannel(url), ch.reconnectDelay);
        }
      };
    })
    .catch(() => {
      if (ch.subscribers.size === 0) return;
      ch.probeAbort = null;
      ch.connected = false;
      ch.supported = false;
      broadcastStatus(ch);
      // 探测失败（典型：断网、Hub 重启）此前只改状态、不重试，SSE 会一直死到刷新页面。
      // 与 onerror 同一套重连节流：清掉旧定时器再排一次，避免多处同时排。
      if (ch.reconnectTimer) clearTimeout(ch.reconnectTimer);
      ch.reconnectTimer = setTimeout(() => {
        ch.reconnectTimer = null;
        if (ch.subscribers.size > 0) connectChannel(url);
      }, ch.reconnectDelay);
    });
}

function teardownChannel(url: string) {
  const ch = channels.get(url);
  if (!ch) return;
  if (ch.probeAbort) { ch.probeAbort.abort(); ch.probeAbort = null; }
  if (ch.es) { ch.es.close(); ch.es = null; }
  if (ch.reconnectTimer) { clearTimeout(ch.reconnectTimer); ch.reconnectTimer = null; }
  channels.delete(url);
}

/**
 * Hook to subscribe to CommHub SSE events.
 * Falls back gracefully — if SSE fails, SWR polling continues working.
 * All subscribers to the same URL share ONE EventSource (see header note).
 */
export function useSSE({ url, onEvent, reconnectDelay = 3000, enabled = true }: UseSSEOptions) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);

  // Hold onEvent in a ref so callers can pass an inline callback without it
  // resubscribing every render (page.tsx re-renders on each SWR mutate —
  // pre-fix this churned real connections; now it would only churn the
  // subscriber entry, but stability still costs nothing to keep).
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    if (!enabled || !url) {
      return;
    }

    let ch = channels.get(url);
    if (!ch) {
      ch = {
        es: null, probeAbort: null, reconnectTimer: null,
        unsupported: false, connected: false, supported: null,
        reconnectDelay, subscribers: new Set(),
      };
      channels.set(url, ch);
    }

    const sub = {
      onEvent: (e: SSEEvent) => { setLastEvent(e); onEventRef.current?.(e); },
      onStatus: (c: boolean, s: boolean | null) => { setConnected(c); setSupported(s); },
    };
    ch.subscribers.add(sub);
    // reflect current channel state immediately (late joiners) — one-shot
    // sync FROM the external channel store at subscribe time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConnected(ch.connected);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(ch.supported);

    const needsConnect = !ch.es && !ch.probeAbort && !ch.unsupported;
    if (needsConnect) connectChannel(url);

    return () => {
      const c = channels.get(url);
      if (!c) return;
      c.subscribers.delete(sub);
      if (c.subscribers.size === 0) teardownChannel(url);
    };
  }, [url, enabled, reconnectDelay]);

  // Disabled/urlless hooks report a derived quiet state instead of writing
  // it back via setState-in-effect (lint: react-hooks/set-state-in-effect).
  const active = enabled && !!url;
  return { connected: active ? connected : false, lastEvent, supported: active ? supported : (enabled ? null : false) };
}
