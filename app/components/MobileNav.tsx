'use client';

import { useEffect, useRef } from 'react';

import Link from 'next/link';
import { useChatUnread, badgeLabel } from '../lib/chat-unread';
import { usePathname } from 'next/navigation';

// #209 R25 (Vincent msg 529 "command 留着干嘛" / 530 "Agents 放到最前面？"
// / 531 "设置放到最后面" / 533+534 "A / 加一个设置啊"):
//   - drop the synthetic-Cmd+K Command tap (no Cmd/Ctrl key on phone — the
//     palette functions it surfaced are reachable from Settings on touch:
//     theme switch, sign-out, navigation to Messages/Logs are all there)
//   - reorder so Agents is the first-thumb tap (Vincent's primary surface)
//   - put Settings rightmost as the consolidated secondary-destinations hub
//     (R16 absorbed Messages / Audit Log / Server Logs into the Resources
//     card grid there, so /settings is the legitimate "everything else"
//     leaf on mobile)
// Stays at 4 cells (R24's grid-cols-4) — same width per tab.
// Settings icon path is copied from app/components/Sidebar.tsx:22 so the
// icon shape matches the desktop sidebar entry.
const MOBILE_NAV_ITEMS = [
  { href: '/nodes', label: 'Agents', icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01' },
  { href: '/', label: 'Overview', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { href: '/tasks', label: 'Tasks', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
  { href: '/scheduled-tasks', label: '定时', icon: 'M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z' },
  { href: '/skillhub', label: 'Skills', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5s3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18s-3.332.477-4.5 1.253' },
  { href: '/settings', label: 'Settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

export function MobileNav() {
  const pathname = usePathname();
  // R8: WeChat-style total unread on the Agents tab (a glance answers
  // "有没有人找我" from anywhere in the app).
  const { totalUnread, hasMutedUnread } = useChatUnread();
  // R45: red dot on the favicon while unreads exist — narrow tabs truncate
  // the "(N)" title prefix, the icon dot survives. Original icon restored
  // at zero. Same-origin SVG → canvas → data URL.
  const originalIconRef = useRef<string | null>(null);
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
      link.href = '/favicon.svg';
    }
    if (originalIconRef.current === null) originalIconRef.current = link.href || '/favicon.svg';
    if (totalUnread <= 0) {
      if (link.href !== originalIconRef.current) link.href = originalIconRef.current;
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      if (!g) return;
      g.drawImage(img, 0, 0, 64, 64);
      g.beginPath();
      g.arc(48, 16, 13, 0, Math.PI * 2);
      g.fillStyle = '#ef4444';
      g.fill();
      g.lineWidth = 5;
      g.strokeStyle = '#0b0b0d';
      g.stroke();
      try { link!.href = c.toDataURL('image/png'); } catch {}
    };
    img.src = originalIconRef.current;
  }, [totalUnread]);

  // R43 (微信标签页计数): browser tab shows "(N) …" while unreads exist —
  // WeChat's title-count habit. Idempotent strip+re-prefix so route-level
  // title changes and repeated runs never stack prefixes.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s/, '');
    document.title = totalUnread > 0 ? `(${badgeLabel(totalUnread)}) ${base}` : base;
  }, [totalUnread]);
  // Match Sidebar.tsx isActive — /settings must be exact-match because
  // Settings subpages (/settings/tokens, /settings/networks) have their
  // own headers; startsWith would keep the bottom-nav highlighted there
  // and steal back-affordance from the user.
  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    if (href === '/settings') return pathname === '/settings';
    return pathname.startsWith(href);
  };

  return (
    <nav data-app-shell-nav="mobile" className="fixed inset-x-0 bottom-0 z-40 border-t border-[#26262b] bg-[#111113]/95 px-1 pb-[calc(env(safe-area-inset-bottom)+0.35rem)] pt-1.5 backdrop-blur lg:hidden">
      <div className="mx-auto grid max-w-lg grid-cols-6 gap-1">
        {MOBILE_NAV_ITEMS.map(item => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[11px] transition-colors ${
                active
                  ? 'bg-cyan-500/12 text-cyan-300 before:absolute before:top-0 before:left-3 before:right-3 before:h-0.5 before:rounded-full before:bg-cyan-400'
                  : 'text-gray-500 active:bg-[#232327] active:text-gray-200'
              }`}
            >
              <span className="relative inline-flex">
                <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                </svg>
                {item.href === '/nodes' && totalUnread === 0 && hasMutedUnread && (
                  <span aria-label="有未读（已静音）" className="absolute -top-0.5 right-1 h-2 w-2 rounded-full bg-red-500/80" />
                )}
                {item.href === '/nodes' && totalUnread > 0 && (
                  <span className="absolute -top-1 -right-2.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[11px] font-semibold leading-[15px] text-center">
                    {badgeLabel(totalUnread)}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
