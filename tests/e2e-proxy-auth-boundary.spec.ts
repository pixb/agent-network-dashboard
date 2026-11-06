import { test, expect, APIRequestContext } from '@playwright/test';

const BASE = process.env.TEST_URL || 'http://localhost:3100';

// 07-31 通信龙 catch — proxy.ts:22 matcher was missing `/nodes/:path*`.
// A no-cookie GET to `/nodes/<alias>` returned 200 with the full 36KB
// page shell, while every other matcher entry correctly returned
// 307 → /login.
//
// What this test verifies — and doesn't:
//
// This spec proves the ROUTE GATE (proxy.ts) redirects no-cookie
// requests. It does NOT prove authentication: `request.cookies.has()`
// checks presence only, so any garbage cookie value passes the gate.
// Real authentication is in /api/hub which validates the token
// contents when the page tries to fetch. See proxy.ts top comment
// for the full framing.
//
// The class of bug caught here: a matcher-list slip letting a
// dynamic-child route bypass the "no cookie → /login" bounce and
// serve page bytes to a visitor who has no cookie at all. Today
// /nodes/[alias] doesn't do a server-side data fetch (通信龙
// confirmed with a nonexistent alias — 200 + 36108 bytes, page
// echoes the alias but hits no DB), so no rows leak. Structural,
// not sensitive; leaks the moment the page grows a server-side
// fetch that uses its own credentials.
//
// The enumeration IS the contract: if you add a new page route
// with a dynamic child, add its :path* variant to proxy.ts AND
// add a representative case to CASES here.
//
// Uses playwright.request.newContext (no browser, no cookie state).
// maxRedirects:0 so we see the 307 directly instead of following it.

const CASES: Array<{ path: string; label: string }> = [
  // Static pages in matcher.
  { path: '/',         label: 'root landing' },
  { path: '/node',     label: 'legacy /node singular' },
  { path: '/tasks',    label: '/tasks index' },
  { path: '/nodes',    label: '/nodes index' },
  { path: '/messages', label: '/messages page' },
  { path: '/logs',     label: '/logs page' },
  { path: '/settings', label: '/settings index' },
  { path: '/admin',    label: '/admin page' },

  // Dynamic-child variants — one representative alias per, to prove
  // the `/:path*` glob catches typical values (unicode alias, hex id,
  // slugish segment). If a new dynamic route is added upstream,
  // ADD IT HERE too — the enumeration IS the contract.
  { path: '/nodes/node-alpha',   label: '/nodes/<alias> ascii  ← 07-31 regression case' },
  { path: '/nodes/%E6%94%AF%E4%BB%98%E5%8A%A9%E6%89%8B', label: '/nodes/<支付助手> unicode  ← prod-observed alias shape' },
  { path: '/tasks/abc123',       label: '/tasks/<id> hex' },
  { path: '/messages/inbox',   label: '/messages/inbox  ← 2026-11-04 从源码镜像实测抓到：matcher 只有裸 /messages 时子路由无 cookie 返回 200' },
  { path: '/settings/general',   label: '/settings/<subroute>' },
];

async function assertRedirectsToLogin(request: APIRequestContext, path: string, label: string) {
  const res = await request.get(`${BASE}${path}`, {
    // Do NOT follow the redirect — we want to see the 307 itself.
    maxRedirects: 0,
  });
  const status = res.status();
  const location = res.headers()['location'] || '';
  const bodyLen = (await res.body()).length;

  // Bundle both attributes in one assertion so we always see BOTH
  // when it fails — not "status wrong" then discover on next line
  // that location was also wrong. Message spells out the request so
  // a red doesn't force digging into locators.
  const actual = { status, location, bodyLen };
  void actual;  // referenced in the assertion below; explicit for readers
  expect({ status, location }, `${label} (${path}) — no-cookie GET must 307 → /login`).toMatchObject({
    status: 307,
    location: expect.stringMatching(/\/login/),
  });

  // Extra floor: a redirect response body is basically empty
  // (browsers ignore it). If bodyLen > 1024, the server is likely
  // rendering the page anyway and only "suggesting" a redirect via
  // a soft mechanism, which is not what proxy.ts is doing here —
  // that would still be a security regression.
  expect(bodyLen, `${label} redirect body should be small (<1KB), got ${bodyLen}B`).toBeLessThan(1024);
}

test.describe('proxy.ts cookie-presence gate — no-cookie access redirects to /login', () => {
  test('every matcher-covered path redirects a no-cookie GET to /login (fresh cookieless request context)', async ({ playwright }) => {
    // Fresh, cookie-less request context. Not `page`/`context` from
    // the test fixture, which may have accumulated cookies via test
    // parallelism or a prior test in this session.
    const request = await playwright.request.newContext({
      baseURL: BASE,
      // Explicitly no storageState → no cookies. This is the whole
      // premise of the test.
    });
    try {
      // Sanity — verify the request context has no cookie. If a
      // stray cookie somehow leaks in, our redirects would all
      // become 200 and the loop would falsely pass. Check /nodes
      // first (a matcher-covered path) and confirm 307 before
      // running the enumeration.
      const sanity = await request.get(`${BASE}/nodes`, { maxRedirects: 0 });
      expect(sanity.status(), 'sanity: bare /nodes must 307 with no cookie (else test context has stray cookies)').toBe(307);

      for (const c of CASES) {
        await assertRedirectsToLogin(request, c.path, c.label);
      }
    } finally {
      await request.dispose();
    }
  });

  test('positive direction: with ANY cookie value, matcher-covered routes are NOT 307 (gate lets them through — else we broke logged-in users)', async ({ playwright }) => {
    // Reviewer's ask: the previous two tests only prove "no cookie
    // → gate redirects". A matcher like ['/(.*)'] would also make
    // those pass — while breaking every logged-in flow. This test
    // is the other direction of the two-direction discipline
    // (feedback_verify_both_directions_with_real_data): the gate
    // must LET THROUGH requests that hold the cookie.
    //
    // We assert "NOT 307" (not "== 200") deliberately. The gate is
    // upstream of page rendering — proving the redirect doesn't
    // fire is proving the gate let it pass. Whether the page then
    // renders 200 or 500 or 404 depends on backend state / dev
    // hardlink quirks / route existence — none of which is this
    // gate's job. Assert only what THIS layer controls.
    //
    // Cookie value here is INTENTIONALLY garbage — same as the
    // baseline 通信龙 established:
    //   Cookie: anet_dashboard_session=complete_garbage_xyz  → 200
    // "Has cookie" is the gate's whole judgment; value doesn't
    // matter to it. Using a garbage value here also documents that
    // fact in the test itself.
    const request = await playwright.request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: {
        cookie: 'anet_dashboard_session=audit-probe-not-a-real-token',
      },
    });
    try {
      // Sanity — the cookie header we set is actually attached.
      // If Playwright drops it (e.g. domain mismatch), every "not
      // 307" assertion below would false-pass on a redirect that
      // actually shouldn't happen. So: hit /login (NOT in matcher)
      // with the cookie, expect 307 → / (session redirects logged-
      // in users away from login) OR 200 (the login page itself).
      // Actually cleanest sanity: hit / with cookie and expect
      // NOT 307-to-/login — same shape as the assertions below.
      const sanity = await request.get(`${BASE}/`, { maxRedirects: 0 });
      const sanityLoc = sanity.headers()['location'] || '';
      expect(
        !(sanity.status() === 307 && sanityLoc.includes('/login')),
        `sanity: bare / with cookie must NOT redirect to /login (got ${sanity.status()} → ${sanityLoc}). If it did, the cookie header did not attach and the loop below is meaningless.`,
      ).toBe(true);

      for (const c of CASES) {
        const res = await request.get(`${BASE}${c.path}`, { maxRedirects: 0 });
        const status = res.status();
        const location = res.headers()['location'] || '';
        // "NOT 307 → /login" — either any status other than 307,
        // OR 307 that redirects somewhere other than /login (unlikely
        // but not our concern; a 307 → /foo isn't proxy.ts kicking
        // the user out).
        const bouncedByGate = status === 307 && location.includes('/login');
        expect(
          bouncedByGate,
          `${c.label} (${c.path}) — with cookie MUST NOT be gate-redirected. Got ${status} → ${location || '(no location)'}. This means proxy.ts is rejecting cookie-holders — the matcher is over-broad or the has() check is inverted.`,
        ).toBe(false);
      }
    } finally {
      await request.dispose();
    }
  });

  test('🔴 07-31 regression: no-cookie /nodes/<alias> MUST redirect (this was reachable in prod v52)', async ({ playwright }) => {
    // Standalone version of the specific case that broke, so a red
    // here anchors the historical incident. If someone loosens the
    // matcher again, this test names the exact prod URL that broke.
    const request = await playwright.request.newContext({ baseURL: BASE });
    try {
      const res = await request.get(`${BASE}/nodes/node-alpha`, { maxRedirects: 0 });
      const status = res.status();
      const location = res.headers()['location'] || '';
      const bodyLen = (await res.body()).length;
      expect({ status, location, bodyLen }).toMatchObject({
        status: 307,
        location: expect.stringMatching(/\/login/),
      });
      // Pre-fix behavior: status 200, bodyLen ~= 36000. Assert an
      // upper floor as belt-and-suspenders (the toMatchObject above
      // catches the primary status miss; this catches "someone made
      // proxy.ts return a soft redirect with a full-body page").
      expect(bodyLen).toBeLessThan(1024);
    } finally {
      await request.dispose();
    }
  });
});
