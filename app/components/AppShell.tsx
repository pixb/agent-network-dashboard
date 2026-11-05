'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { HealthBanner } from './HealthBanner';
import UpdateBanner from './UpdateBanner';
import { CommandPalette } from './CommandPalette';
import { HelpOverlay } from './HelpOverlay';
import { ServersDrawer } from './ServersDrawer';
import { MobileNav } from './MobileNav';
import { useRadiusTier } from '../lib/useRadiusTier';

const NO_SHELL_PATHS = ['/login'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // 小控件圆角（item=8）：客户端按渲染高度定义，CSS 选不到，只能在挂载后量一次。
  useRadiusTier();

  if (NO_SHELL_PATHS.includes(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-[100dvh] max-w-full overflow-x-hidden">
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
        className="flex-1 min-w-0 max-w-full overflow-x-hidden flex flex-col pt-[env(safe-area-inset-top)] outline-none"
      >
        <HealthBanner />
        <UpdateBanner />
        <div className="flex-1 min-w-0 max-w-full overflow-x-hidden pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</div>
      </main>
      <MobileNav />
      <CommandPalette />
      <HelpOverlay />
      <ServersDrawer />
    </div>
  );
}
