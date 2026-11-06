'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Sidebar } from './Sidebar';
import { HealthBanner } from './HealthBanner';
import UpdateBanner from './UpdateBanner';
import { CommandPalette } from './CommandPalette';
import { HelpOverlay } from './HelpOverlay';
import { ServersDrawer } from './ServersDrawer';
import { MobileNav } from './MobileNav';

const NO_SHELL_PATHS = ['/login'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const mainScrollRef = useRef<HTMLDivElement | null>(null);

  // The content wrapper is the scroll container (see height-chain note below),
  // so it persists across route changes and must be rewound manually — the
  // document scroll reset the browser used to give us for free.
  useEffect(() => {
    mainScrollRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  if (NO_SHELL_PATHS.includes(pathname)) {
    return <>{children}</>;
  }

  // Height chain (chat-pane bottom-clipped bug):
  // html.h-full → body.min-h-full → THIS (h-[100dvh], definite) →
  // main (flex item, stretched cross size = definite, min-h-0) →
  // the children wrapper (flex-1 + min-h-0 = definite height, and it is the
  // scroll container). Every page can then use `h-full` and get exactly the
  // space the shell leaves it, so a page that sizes itself to 100dvh no
  // longer stacks its own height ON TOP of the banners above it. With
  // `min-h-[100dvh]` the shell grew to banners + 100dvh, the document
  // scrolled, and the bottom of the right chat column (composer) sat below
  // the fold — the report "滚到左侧菜单最底部，右边聊天框没占到最底部".
  return (
    <div className="flex h-[100dvh] max-w-full overflow-x-hidden">
      {/* 键盘用户的第一站：跳过侧栏（20+ 个导航项）直达主内容。
          只在 Tab 聚焦时可见，视觉用户不受影响。 */}
      <a
        href="#anet-main-content"
        data-testid="skip-to-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-[var(--bg-elevated)] focus:px-3 focus:py-2 focus:text-sm focus:text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
      >
        跳到主内容
      </a>
      <Sidebar />
      {/* R25 of #190: pair the existing bottom safe-area padding with a
          top one so the HealthBanner clears the iOS status bar when
          launched as an installed PWA (statusBarStyle: black-translucent
          + viewportFit: cover, see app/layout.tsx). On non-PWA contexts
          env(safe-area-inset-top) is 0, so this is a no-op for browser
          tab visits. */}
      <main
        id="anet-main-content"
        tabIndex={-1}
        className="flex-1 min-w-0 min-h-0 max-w-full overflow-x-hidden flex flex-col pt-[env(safe-area-inset-top)] outline-none"
      >
        <HealthBanner />
        <UpdateBanner />
        <div ref={mainScrollRef} data-testid="app-main-scroll" className="flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</div>
      </main>
      <MobileNav />
      <CommandPalette />
      <HelpOverlay />
      <ServersDrawer />
    </div>
  );
}
