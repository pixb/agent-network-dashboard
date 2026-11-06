'use client';

import { useEffect, type RefObject } from 'react';

/**
 * #Chat-pane-bottom / the shell scroll container
 *
 * AppShell owns the viewport (`h-[100dvh]`) and its children wrapper is the
 * scroll container, so pages no longer scroll the document. Consequences:
 *
 *  1. Anything that used `window.scrollTo` must target that container.
 *  2. Route changes must rewind it manually — a persistent scroll container
 *     keeps the previous page's offset (the document scroll used to reset
 *     for free).
 *  3. The pages that clamp their own height to "whatever is left below the
 *     banners" can no longer measure with `rect.top + window.scrollY`:
 *     `window.scrollY` is pinned at 0 and `rect.top` moves with the
 *     container's scroll, so that formula was no longer scroll-invariant
 *     (the self-exciting growth loop #Stage D removed, re-armed). Measuring
 *     `container visible bottom − element top` is invariant: scroll by Δ
 *     shifts both terms by the same −Δ.
 */
export const APP_MAIN_SCROLL_SELECTOR = '[data-testid="app-main-scroll"]';

export function getMainScroll(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(APP_MAIN_SCROLL_SELECTOR);
}

/** Scroll the shell's content area to the top. Drop-in replacement for the
 *  old `window.scrollTo({ top: 0, behavior })` on pages inside the shell. */
export function scrollMainTop(behavior: ScrollBehavior = 'smooth') {
  if (typeof window === 'undefined') return;
  getMainScroll()?.scrollTo({ top: 0, behavior });
  // No-op while AppShell owns the viewport; keeps the old behavior outside
  // the shell (e.g. /login).
  window.scrollTo({ top: 0, behavior });
}

/** Height that fills from the element's current top down to the bottom of the
 *  visible content area (shell banners and the MobileNav reserve excluded). */
export function fillRemainingHeight(el: HTMLElement, min = 240): number {
  if (typeof window === 'undefined') return min;
  const elTop = el.getBoundingClientRect().top;
  const container = el.closest<HTMLElement>(APP_MAIN_SCROLL_SELECTOR) ?? getMainScroll();
  let bottom = container ? container.getBoundingClientRect().bottom : window.innerHeight;
  if (container) {
    // The wrapper's bottom padding is the MobileNav / safe-area reserve; the
    // fill must stop above it, not behind the fixed tab bar.
    bottom -= parseFloat(getComputedStyle(container).paddingBottom) || 0;
  }
  return Math.max(min, Math.round(bottom - elTop));
}

/**
 * Keep `ref`'s height = fillRemainingHeight, re-measured whenever the space
 * above/below it changes (HealthBanner / UpdateBanner appearing, collapsing
 * or being dismissed is exactly the case the old `ResizeObserver(body)`
 * missed: body is pinned at min-height:100%, so removing a banner never
 * resized it, and the clamp stayed stale — the page ran past the fold and
 * the document scrolled, hiding the chat composer).
 *
 * Observing the *wrapper* is loop-free: its height is flex-driven off the
 * shell's fixed viewport height, so writing our own height never resizes it.
 */
export function useFillViewportHeight(ref: RefObject<HTMLElement | null>, min = 240) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      el.style.height = `${fillRemainingHeight(el, min)}px`;
    };
    const raf = requestAnimationFrame(apply);
    const ro = new ResizeObserver(apply);
    // Observe the immediate parent AND the shell's scroll host: the banners
    // live in the shell, so a page nested deeper than one level only sees the
    // change through the host's box (the host's height is flex-driven off the
    // fixed viewport, so measuring + writing our height can never resize it).
    const parent = el.parentElement;
    if (parent) ro.observe(parent);
    const host = el.closest<HTMLElement>(APP_MAIN_SCROLL_SELECTOR);
    if (host && host !== parent) ro.observe(host);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, [ref, min]);
}
