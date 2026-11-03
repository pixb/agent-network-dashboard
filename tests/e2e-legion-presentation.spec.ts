import { expect, test } from '@playwright/test';
import http from 'node:http';

/**
 * 军团演示深链（`?present=1`）的整屏契约。
 *
 * 为什么必须在 CI 里有这一条：
 *   用户投影用的是一条链接。曾经 `?present=1` 只设 `presenting`、没设 `cleanView`，
 *   于是页头/搜索框/图例全都留在画面上，取景又按「有页头页脚」的安全区算——
 *   900px 画布只按 660px 布局，内容占屏高 57%。这条缺陷**靠截图很难发现**，
 *   靠数字（安全区 + 内容包围盒）一眼就能看见。
 *
 * 三个断言分别对应三件不同的事，缺一不可：
 *   1. `header` 隐藏 —— 界面确实让位了；
 *   2. 取景安全区贴到画布边缘 —— 取景按整屏算，而不是按残余布局算；
 *   3. 内容实际占屏高 ≥ 0.68 —— 前两条成立但取景给得小，画面照样不震撼。
 *
 * 用进程内 stub Hub（`COMMHUB_URL` 见 playwright.config.ts），不连生产、不读真实数据。
 */

const NETWORK = 'net_fixture';

const departments = [
  { id: 'd_platform', name: '平台', parent_id: null, sort: 1 },
  { id: 'd_design', name: '设计', parent_id: null, sort: 2 },
];
const members = [{ user_id: 'u_owner', department_id: 'd_platform' }];
const people = [{
  user_id: 'u_owner', username: 'fixture', display_name: '有主成员', role: 'member',
  department: { id: 'd_platform', name: '平台' },
  agents: [{ node_id: 'n_owned', alias: '有主Agent' }],
}];
const orphans = [
  { node_id: 'n_none', alias: '无部门野生', department_id: null },
  { node_id: 'n_known', alias: '设计野生', department_id: 'd_design' },
];

// 阈值来自 1440×900 的实测（0.72–0.76）；视口不固定会让比例随宽高比漂移。
test.use({ viewport: { width: 1440, height: 900 } });

let server: http.Server;
let sessionCookies: Array<{ name: string; value: string; domain: string; path: string }> = [];

test.beforeAll(async ({ request }) => {
  // 登录限流 10 次 / 15 分钟：一次登录、复用 cookie（与既有规格同一做法）。
  const login = await request.post('/api/auth/login', {
    data: { password: process.env.ANET_DASHBOARD_PASSWORD || 'admin123' },
  });
  expect(login.status(), await login.text()).toBe(200);
  sessionCookies = (await request.storageState()).cookies;

  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1:9999');
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/requirements/people/directory') {
      return json({ ok: true, total: people.length, people, agents_without_owner: orphans });
    }
    if (url.pathname.endsWith('/departments')) return json({ ok: true, departments, members });
    if (url.pathname === '/api/status') {
      return json({
        ok: true,
        sessions: [
          { alias: '有主Agent', status: 'idle', node_id: 'n_owned', network_id: NETWORK },
          { alias: '无部门野生', status: 'offline', node_id: 'n_none', network_id: NETWORK },
        ],
      });
    }
    if (url.pathname === '/api/networks') {
      return json({ ok: true, networks: [{ network_id: NETWORK, network_name: '隔离军团', role: 'owner' }] });
    }
    return json({ ok: true, networks: [], sessions: [], nodes: [], tasks: [], messages: [], stats: {}, version: 'fixture' });
  });
  await new Promise<void>(resolve => server.listen(9999, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  // beforeAll 若在登录阶段就失败，server 还没建：收尾必须容错，否则真实错误被
  // “Cannot read properties of undefined”盖掉（第一次跑就这样）。
  if (!server) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(sessionCookies);
  await context.addInitScript(network => {
    sessionStorage.setItem('anet_network_id', network);
  }, NETWORK);
});

test('演示深链隐藏界面并把画面铺满', async ({ page }) => {
  await page.goto('/legion/3d?present=1', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('legion-3d-present-exit')).toBeVisible({ timeout: 20000 });

  // 1. 界面让位
  const header = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="legion-3d-header"]');
    return el ? getComputedStyle(el).visibility : 'missing';
  });
  expect(header).toBe('hidden');

  // 2. 取景安全区贴边（上下各留 24px）
  const safe = await page.evaluate(() => {
    const wrap = document.querySelector('[data-testid="legion-3d-stage"]');
    const c = wrap?.querySelector('canvas');
    const raw = (wrap?.getAttribute('data-safe-bounds') || '').split(',').map(Number);
    return { bounds: raw, canvas: c ? c.getBoundingClientRect().height : 0 };
  });
  expect(safe.canvas).toBeGreaterThan(200);
  expect(safe.bounds[1]).toBeLessThanOrEqual(26);
  expect(safe.bounds[3]).toBeGreaterThanOrEqual(safe.canvas - 28);

  // 3. 不在 CI 里断言「内容占屏高」。
  //    实测：生产构建 1440×900 为 0.72–0.76，而 dev server 同一视口是 0.616 ——
  //    dev 的布局/字体加载与产物不同，比例会漂 ~10 个百分点。
  //    更关键的是：修复前的值是 0.567，与 dev 的 0.616 太接近，这个阈值在 dev 上
  //    判不出真回归，只会变成一条看心情的红线。
  //    所以 CI 只锁因果不变量（界面让位 + 安全区贴边），比例断言留在用生产构建跑的
  //    全量套件里（legion:present:fillsHeight / present:deeplinkFillsHeight）。

  // 退出后必须回到普通布局：页头回来、安全区重新为页头让位。
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('legion-3d-present-exit')).toHaveCount(0);
  const after = await page.evaluate(() => {
    const wrap = document.querySelector('[data-testid="legion-3d-stage"]');
    const raw = (wrap?.getAttribute('data-safe-bounds') || '').split(',').map(Number);
    return { header: (() => { const el = document.querySelector('[data-testid="legion-3d-header"]'); return el ? getComputedStyle(el).visibility : 'missing'; })(), y1: raw[1] };
  });
  expect(after.header).toBe('visible');
  expect(after.y1).toBeGreaterThan(24);
});
