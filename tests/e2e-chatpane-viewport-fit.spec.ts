import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const BASE = process.env.TEST_URL || 'http://localhost:3100';

// Regression: chat-pane bottom clipped + "auto-jump to bottom".
//
// Symptom (Vincent, 07-31): on /nodes, select a node, scroll the left rail to
// its bottom — the right chat column did NOT reach the bottom of the window
// (composer below the fold, reachable only by scrolling the *page*), and after
// scrolling the thread to the top, a few seconds later the view snapped back
// to the bottom on its own.
//
// Two independent causes, both fixed:
//  A. Height chain. AppShell was `min-h-[100dvh]` (content-driven) with the
//     HealthBanner in flow, and NodesView sized itself to `h-[100dvh]`, so the
//     document was banners+100dvh tall → the page scrolled and the chat
//     composer sat below the fold. AppShell is now a fixed `h-[100dvh]` column
//     whose content wrapper is the scroll container; pages use `h-full`.
//  B. Auto-scroll used `messagesEndRef.scrollIntoView()`, which scrolls EVERY
//     scrollable ancestor — the 15 s history poll therefore dragged the
//     document (and the thread) to the bottom. It is container-relative now.

// Plan B (one network per project): every hub read is network-scoped —
// `useNetworkId()` resolves a network id (sessionStorage, else GET
// /api/hub/networks and auto-pick) and `useSessions`/`useNodes` send the
// request only once `ready` is true and a network id exists. Mocking
// /api/hub/status alone therefore yields a *silent* page: no request is made,
// sessions stay empty, /nodes renders the `npx … init` quickstart and the chat
// column never mounts. Serve a network, or the test asserts on a page that
// was never asked to render the thing under test.
const HUB_NETWORKS = { networks: [{ network_id: 'net_fit', network_name: 'default' }] };

// HOW THIS SPEC MUST BE RUN (measured 2026-11-06, do not trust the mocks).
//
// `page.route` intercepts only *browser* requests. The dashboard reads the hub
// through server-side proxy routes (app/api/hub/* call hubFetch(COMMHUB_URL)
// in RSC/server-route code), so intercepted mocks are never consulted: with
// COMMHUB_URL pointing at nothing, /api/hub/status is never issued by the
// browser, sessions stay empty, /nodes renders the `npx … init` quickstart and
// [data-testid="chat-pane"] never mounts. That is the failure this spec
// produced when run against mocks — an empty page, not a layout bug.
//
// Run it against a live hub, which is also the only shape that reproduces the
// real green HealthBanner:
//   E2E_LIVE_HUB=1 TEST_URL=http://127.0.0.1:3199 npx playwright test \
//     --config playwright.e2e.config.ts tests/e2e-chatpane-viewport-fit.spec.ts
// The hub needs >= 1 session, >= 1 network, and enough tasks for the thread to
// overflow. Without E2E_LIVE_HUB the suite skips itself and says why, instead
// of "passing" against a page that was never asked to render the pane.

const LIVE_HUB = !!process.env.E2E_LIVE_HUB;

const HUB_STATUS = {
  sessions: [
    { alias: 'fit-1', status: 'idle', network_id: 'net_fit', runtime: 'claude-agent-sdk', last_seen: new Date().toISOString() },
    { alias: 'fit-2', status: 'working', network_id: 'net_fit', runtime: 'codex-sdk', last_seen: new Date().toISOString() },
  ],
};
const HUB_NODES = {
  nodes: [
    { alias: 'fit-1', team: null, tags: [], lifecycle_state: 'online', network_id: 'net_fit' },
    { alias: 'fit-2', team: null, tags: [], lifecycle_state: 'online', network_id: 'net_fit' },
  ],
};
const HUB_HEALTH = {
  ok: true,
  version: '0.9.0-test',
  sse_connections: 2,
  sse_sessions: { 'net_fit:fit-1': 1, 'net_fit:fit-2': 1 },
};
// A healthy hub is the exact state that reproduces the clip: the green
// HealthBanner renders in flow (~28px) and used to push the page past the fold.
const HUB_STATS = { nodes: { total: 2 }, tasks: { by_status: [] } };

function makeTasks(n: number, offset = 0) {
  const base = Date.now() - (n + offset) * 60_000;
  return Array.from({ length: n }, (_, i) => ({
    task_id: `fit-${offset + i}`,
    from_name: 'Dashboard',
    to_name: 'fit-1',
    status: 'replied',
    priority: 'normal',
    // Long enough that 12 bubbles overflow the column: the thread must be
    // scrollable for the auto-scroll assertions to mean anything.
    content: `filler message ${offset + i} — `.repeat(8),
    result: `filler reply ${offset + i} — `.repeat(8),
    created_at: new Date(base + (offset + i) * 60_000).toISOString(),
  }));
}

let cachedSessionCookie: string | null = null;
async function login(context: BrowserContext) {
  if (!cachedSessionCookie) {
    const res = await context.request.post(`${BASE}/api/auth/login`, {
      data: { password: process.env.ANET_DASHBOARD_PASSWORD || 'admin123' },
    });
    const m = (res.headers()['set-cookie'] || '').match(/anet_dashboard_session=([^;]+)/);
    if (m) cachedSessionCookie = decodeURIComponent(m[1]);
  }
  if (cachedSessionCookie) {
    await context.addCookies([{
      name: 'anet_dashboard_session',
      value: cachedSessionCookie,
      domain: new URL(BASE).hostname,
      path: '/',
    }]);
  }
}

async function mockHub(page: Page) {
  if (LIVE_HUB) return; // real hub behind the dashboard's proxy; mocks cannot reach server-side fetches
  await page.route('**/api/hub/networks**', r => r.fulfill({ json: HUB_NETWORKS }));
  await page.route('**/api/hub/status**', r => r.fulfill({ json: HUB_STATUS }));
  await page.route('**/api/hub/nodes**', r => r.fulfill({ json: HUB_NODES }));
  await page.route('**/api/hub/health', r => r.fulfill({ json: HUB_HEALTH }));
  await page.route('**/api/hub/stats**', r => r.fulfill({ json: HUB_STATS }));
  await page.route('**/api/hub/messages**', r => r.fulfill({ json: { messages: [] } }));
  await page.route('**/api/hub/tasks**', r => {
    const url = new URL(r.request().url());
    // `before=` is the scroll-to-top older page request; serve a full page so
    // the viewport-anchor path (not the exhausted path) is the one exercised.
    const body = url.searchParams.get('before')
      ? { ok: true, tasks: makeTasks(12, 100) }
      : { ok: true, tasks: makeTasks(12) };
    return r.fulfill({ json: body });
  });
  // SSE is a long-lived stream; abort so the 15 s poll is the live-update path.
  await page.route('**/api/hub/events**', r => r.abort());
}

const pane = (page: Page) => page.locator('[data-testid="chat-pane"]');
const scroller = (page: Page) => page.locator('[data-testid="chat-messages-scroll"]');

const geometry = (page: Page) => page.evaluate(() => {
  const doc = document.documentElement;
  const chat = document.querySelector('[data-testid="chat-pane"]')!.getBoundingClientRect();
  const composer = document.querySelector('[data-testid="chat-pane"] textarea')!.getBoundingClientRect();
  const list = document.querySelector('[data-testid="node-list-rail"]')!;
  const msgs = document.querySelector('[data-testid="chat-messages-scroll"]')!;
  return {
    innerHeight: window.innerHeight,
    docScrollHeight: doc.scrollHeight,
    docScrollTop: doc.scrollTop,
    paneBottom: Math.round(chat.bottom),
    composerBottom: Math.round(composer.bottom),
    railScrollable: list.scrollHeight > list.clientHeight,
    threadScrollable: msgs.scrollHeight > msgs.clientHeight,
  };
});

test.describe('#chat-pane viewport fit + no auto-jump', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.skip(!LIVE_HUB, '需要真实 hub：dashboard 的 hub 读走服务端代理（app/api/hub/* → hubFetch），page.route 拦不到；对着空壳页面跑这个断言等于没有断言');

  test('the chat column fills to the window bottom — the page itself does not scroll', async ({ page, context }) => {
    await login(context);
    await mockHub(page);
    await page.goto(`${BASE}/nodes`);
    // Desktop auto-selects the first conversation (#Vincent 07-31).
    await expect(pane(page)).toBeVisible({ timeout: 15_000 });
    await expect(scroller(page)).toBeVisible();
    // History landed (spinner replaced by bubbles) — the thread must overflow.
    await scroller(page).locator('[data-ev]').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600); // let the ResizeObserver height clamp settle

    const g = await geometry(page);
    expect(g.threadScrollable).toBe(true);
    // A: no document overflow → nothing below the fold.
    expect(g.docScrollHeight).toBeLessThanOrEqual(g.innerHeight + 1);
    // The column reaches the window bottom, and the composer is inside it.
    expect(g.paneBottom).toBeGreaterThanOrEqual(g.innerHeight - 2);
    expect(g.composerBottom).toBeLessThanOrEqual(g.innerHeight + 1);
  });

  test('scrolling the thread to the top is not undone by the 15s history poll', async ({ page, context }) => {
    test.setTimeout(45_000);
    await login(context);
    await mockHub(page);
    await page.goto(`${BASE}/nodes`);
    await expect(pane(page)).toBeVisible({ timeout: 15_000 });
    await scroller(page).locator('[data-ev]').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);

    // Park in the middle of the thread: the poll must not pull us to the
    // bottom, and the older-page anchor must not shove us anywhere.
    const mid = await scroller(page).evaluate(el => { el.scrollTop = el.clientHeight * 2; return el.scrollTop; });
    expect(mid).toBeGreaterThan(0);

    // Longer than the 15 s poll cadence, plus the scroll-to-top trigger.
    await scroller(page).evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(20_000);

    const after = await scroller(page).evaluate(el => el.scrollTop);
    const doc = await page.evaluate(() => ({
      top: document.documentElement.scrollTop,
      height: document.documentElement.scrollHeight,
      inner: window.innerHeight,
    }));
    expect(after).toBeLessThan(doc.inner);            // still reading history, not yanked
    expect(doc.top).toBe(0);                          // the page never scrolls
    expect(doc.height).toBeLessThanOrEqual(doc.inner + 1);
  });
});
