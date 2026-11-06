'use client';

/**
 * Loading skeleton — mirrors the actual Overview layout structure so the
 * page doesn't appear to "shift" once data arrives. Uses the same
 * `anet-skeleton-pulse` rhythm as the brand pulse (1.6s opacity drift,
 * no scale, no blur, no glow) so the loading animation feels native to
 * the rest of the dashboard rather than a generic spinner.
 *
 * Bars are theme-aware: anet-skeleton-bar (existing CSS shim resolves this to
 * var(--bg-elevated) on light/mint), so light theme shows soft grey blocks
 * on white cards and dark theme shows lighter blocks on navy cards.
 */
export function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)] p-4 sm:p-6">
      {/* KPI top strip — 4 cards matching StatsBar.
          #209 R38: mb-8 → mb-4 sm:mb-8 to track the live StatsBar
          wrapper after R29 mobile-tighten. Without this the skeleton
          and the loaded page jump by 16 px on mobile when data arrives. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 sm:mb-8 anet-skeleton-pulse">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
            <Bar w="2.5rem" h="1.75rem" />
            <Bar w="3.5rem" h="0.75rem" className="mt-2" />
            <Bar w="5rem" h="0.625rem" className="mt-1" />
          </div>
        ))}
      </div>

      {/* Dispatch + UserBar row.
          #209 R38: mb-3 → mb-4 — live page uses mb-4 here, skeleton
          was 4 px tighter and triggered a small jump on load. */}
      <div className="flex items-center gap-3 mb-4 anet-skeleton-pulse">
        <Bar w="6rem" h="2.5rem" rounded="0.75rem" />
        <div className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full anet-skeleton-bar" />
          <div className="flex-1">
            <Bar w="6rem" h="0.875rem" />
            <Bar w="10rem" h="0.625rem" className="mt-1" />
          </div>
        </div>
      </div>

      {/* Config bar.
          #209 R38: mb-6 → mb-4 sm:mb-6 to track the R28 mobile tighten. */}
      <div className="mb-4 sm:mb-6 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 anet-skeleton-pulse">
        <Bar w="14rem" h="0.875rem" />
      </div>

      {/* Stat strip 3 cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-3 anet-skeleton-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3">
            <Bar w="2rem" h="1.25rem" />
            <Bar w="2.5rem" h="0.75rem" className="mt-1" />
            <Bar w="3.5rem" h="0.625rem" className="mt-px" />
          </div>
        ))}
      </div>

      {/* Nav rail 3 cards.
          #209 R38: mb-6 → mb-4 sm:mb-6 to track the R28 mobile tighten. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4 sm:mb-6 anet-skeleton-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 flex items-center justify-center gap-2">
            <div className="w-4 h-4 rounded anet-skeleton-bar" />
            <Bar w="4rem" h="0.75rem" />
          </div>
        ))}
      </div>

      {/* #209 R38: Broadcast bar skeleton dropped — the live page
          removed BroadcastBar in r70's "demote zero-data noise" pass
          (it lives behind /admin now) so the skeleton was a phantom
          row that did not exist in the loaded page. Caused a 56 px
          downward shift on data arrival. */}

      {/* Agent card grid.
          #209 R38: breakpoints synced with the live AgentCard grid
          (R48 set lg:grid-cols-3 — skeleton was still on lg:grid-cols-2
          which made cards rearrange under hydration on 1024-1279 px). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3 sm:gap-4 anet-skeleton-pulse">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full anet-skeleton-bar" />
              <Bar w="6rem" h="0.875rem" />
            </div>
            <div className="space-y-2">
              <Bar w="100%" h="0.625rem" />
              <Bar w="75%" h="0.625rem" />
              <Bar w="55%" h="0.625rem" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Single shimmer bar — uses `anet-skeleton-bar` so theme-specific bar
 *  color (dark navy on dark themes, mid-grey on light) overrides the
 *  default. */
function Bar({ w, h, rounded, className }: { w: string; h: string; rounded?: string; className?: string }) {
  return (
    <div
      className={`anet-skeleton-bar ${className || ''}`}
      style={{ width: w, height: h, borderRadius: rounded || '0.375rem' }}
    />
  );
}

// EmptyState export removed in 0.4.5 — replaced by EmptyState.tsx with
// per-variant glyphs and a NodesEmptyState wrapper for the Overview
// hint-aware behavior. See app/components/EmptyState.tsx.
