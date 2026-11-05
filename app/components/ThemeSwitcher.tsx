'use client';

import { useEffect } from 'react';

// #217 S6 — verified themes: cyber (dark), light (white), and slack
// (Vincent 2026-07-16 via api channel: "其他的就搞成那种 Slack 方式吧…快速搞一个"
// — Slack-style is now the DEFAULT look; the network/topology page keeps its
// showcase visuals, see TopoGraph's data-skin exemption).
//
// Mechanism: `slack` is implemented as a SKIN on top of the light theme —
// applyTheme sets `data-theme="light"` (so every existing light compat-shim
// in globals.css applies unchanged) plus `data-skin="slack"` which the
// slack-only overrides key on (aubergine rail, Slack-blue accent, de-noise).
// This keeps the fast first version to globals.css + three tiny component
// touches instead of a full hex→token sweep (that sweep stays scheduled as
// redesign Phase 0 next version).

export const THEMES = new Set(['cyber', 'light', 'slack', 'system']);

/** `system` 是「模式」不是外观：按操作系统的明暗偏好解析成具体主题。
 *  和客户端对齐（`agent-network-app/src/system-color-scheme-core.ts` 里
 *  web 用 matchMedia('(prefers-color-scheme: dark)')）。 */
export function resolveTheme(t: string): string {
  if (t !== 'system') return t;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'cyber';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'cyber' : 'light';
}

/** Apply a theme choice to <html>. Single owner of the data-theme/data-skin
 *  contract — Settings and Cmd+K call this too, so the skin attribute can
 *  never desync from the theme attribute. */
export function applyTheme(t: string) {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(t);
  const el = document.documentElement;
  if (resolved === 'slack') {
    el.setAttribute('data-theme', 'light');
    el.setAttribute('data-skin', 'slack');
  } else {
    el.setAttribute('data-theme', resolved);
    el.removeAttribute('data-skin');
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    // ROLLBACK (Vincent 07-20): the classic dark theme is the default again
    // — he prefers the original look and doesn't want a Slack copy as the
    // face of the product. 'slack' stays available as an explicit Settings
    // choice until the original agent-network theme replaces it. Users who
    // explicitly picked a theme keep their pick; everyone else returns to
    // cyber automatically (the slack-default window never wrote storage).
    let t = 'cyber';
    try {
      const saved = localStorage.getItem('anet-theme');
      if (saved && THEMES.has(saved)) t = saved;
    } catch {}
    applyTheme(t);
    // 选了「跟随系统」后，用户改 OS 明暗要立刻跟上（否则要刷新才生效）。
    if (t !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);  // 老 Safari
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return <>{children}</>;
}
