import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'anet_dashboard_session';

export function proxy(request: NextRequest) {
  const isLogin = request.nextUrl.pathname === '/login';
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (!hasSession && !isLogin) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (hasSession && isLogin) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

// ROUTE GATE — read carefully before editing.
//
// This is NOT authentication. It's a cookie-presence redirect:
// `request.cookies.has(SESSION_COOKIE)` at line 8 checks only that
// the cookie EXISTS, not that its value is valid. Any garbage
// (e.g. `anet_dashboard_session=xyz`) passes this gate and lands
// on the page. Real authentication lives in the /api/hub layer,
// which validates the token content when the page tries to fetch
// data.
//
// So this matcher's job is narrower than it looks: it decides
// which paths bounce no-cookie visitors to /login for a nicer UX.
// It does NOT prevent access to page bytes by a visitor who
// forges any cookie value ("has a cookie" is not "is authenticated").
// Do not write code that trusts this gate for authorization —
// always call the hub for data and check the response.
//
// 07-31 通信龙 catch: `/nodes/:path*` was missing. Every other
// page route with a dynamic child had it (`/tasks/:path*`,
// `/settings/:path*`), so this was a slip, not a design choice.
// Verified in prod: a no-session-cookie GET to `/nodes/<alias>`
// was REACHABLE — returned 200 with the full 36KB shell; every
// other matcher entry returned 307 → /login as intended.
//
// Blast radius today: /nodes/[alias] page happens to not run a
// server-side data fetch — 通信龙 hit it with a nonexistent alias
// `ZZZ-not-a-real-agent-9999` and got 200 + 36108 bytes back (only
// 16 bytes bigger = the alias-length difference echoed in the
// shell). Since the page doesn't query, no DB row leaks. This is
// STRUCTURAL, not sensitive: if the page ever gains a server-side
// data fetch, the leak begins immediately. Fix now, don't wait.
//
// If you add a new page route with a dynamic child, add its
// `:path*` variant here AND add its bare path to the test list
// in `tests/e2e-proxy-auth-boundary.spec.ts` — the test
// enumerates matcher entries and asserts each redirects the
// no-cookie case, so it catches this class of miss for the next
// time. (The test's filename says "auth-boundary" for continuity
// with #69; the actual behavior it tests is cookie-presence,
// same as this comment describes.)
export const config = {
  matcher: [
    '/',
    '/node',
    '/tasks', '/tasks/:path*',
    '/nodes', '/nodes/:path*',
    '/messages', '/messages/:path*',
    '/logs',
    '/settings', '/settings/:path*',
    '/admin',
    '/scheduled-tasks',
  ],
};
