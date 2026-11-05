// 可访问名审计：找出「无障碍树里名字为空」的表单控件与按钮。
//
//   node tools/a11y/accessible-names.mjs --base http://127.0.0.1:3000 --password xxx --routes /,/settings
//
// 为什么必须读无障碍树：Chrome 会用 placeholder 兜底出名字，
// 只查 DOM 上的 aria-label / label 会把「其实能被读屏念出来」的控件判成缺陷（本项目踩过）。
// 反过来，SVG <g role=button> 用 innerText 取不到文字，也会误报——所以这里统一用 CDP 的 AX 树。
import { cookieFromNodeConfig, cookieFromPassword, parseArgs, report } from './lib.mjs';

const args = parseArgs();
const base = args.base;
if (!base) { console.error('need --base <url>'); process.exit(2); }
const routes = String(args.routes || '/,/nodes,/requirements,/settings').split(',').map(s => s.trim()).filter(Boolean);
const cookieValue = args.config ? cookieFromNodeConfig(args.config)
  : args.password ? cookieFromPassword(String(args.password))
  : null;
if (!cookieValue) { console.error('need --config or --password'); process.exit(2); }

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await ctx.addCookies([{ name: 'anet_dashboard_session', url: base, httpOnly: true, sameSite: 'Lax', value: cookieValue }]);
await ctx.addInitScript(() => { localStorage.setItem('anet-theme', 'light'); });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);

const FORM_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'checkbox', 'radio', 'slider', 'spinbutton']);
const rows = [];

for (const route of routes) {
  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(args.wait || 1600));
  const { nodes } = await client.send('Accessibility.getFullAXTree');
  const nameless = nodes
    .filter(n => !n.ignored && (FORM_ROLES.has(n.role?.value) || n.role?.value === 'button'))
    .filter(n => !(n.name?.value || '').trim())
    .map(n => n.role.value);
  rows.push({ target: route, findings: nameless.length, details: nameless.slice(0, 10).map(r => `${r}: (no accessible name)`) });
}

await browser.close();
report('accessible names', rows);
