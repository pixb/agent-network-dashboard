// 触控目标审计：找出「有效热区」小于 24×24 的可交互控件（WCAG 2.2 AA 最低线）。
//
//   node tools/a11y/tap-targets.mjs --base http://127.0.0.1:3000 --password xxx --routes /,/nodes
//
// 关键：::before / ::after 常被用来扩大热区（本项目关闭按钮就是 20×44 + 伪元素 → 36×64）。
// 只量 border-box 会把达标的控件当缺陷，所以这里把伪元素偏移算进去。
import { cookieFromNodeConfig, cookieFromPassword, parseArgs, report } from './lib.mjs';

const args = parseArgs();
const base = args.base;
if (!base) { console.error('need --base <url>'); process.exit(2); }
const routes = String(args.routes || '/,/nodes,/requirements,/settings').split(',').map(s => s.trim()).filter(Boolean);
const width = Number(args.width || 390);
const minSize = Number(args.min || 24);
const cookieValue = args.config ? cookieFromNodeConfig(args.config)
  : args.password ? cookieFromPassword(String(args.password))
  : null;
if (!cookieValue) { console.error('need --config or --password'); process.exit(2); }

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN', isMobile: width < 800, hasTouch: width < 800, reducedMotion: 'reduce' });
await ctx.addCookies([{ name: 'anet_dashboard_session', url: base, httpOnly: true, sameSite: 'Lax', value: cookieValue }]);
await ctx.addInitScript(() => { localStorage.setItem('anet-theme', 'light'); });
const page = await ctx.newPage();
const rows = [];

for (const route of routes) {
  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(args.wait || 1600));
  const found = await page.evaluate(min => {
    const res = [];
    const expand = el => {
      const r = el.getBoundingClientRect();
      let { width: w, height: h, left, top } = { width: r.width, height: r.height, left: r.left, top: r.top };
      for (const pe of ['::before', '::after']) {
        const cs = getComputedStyle(el, pe);
        if (cs.content === 'none' || cs.position !== 'absolute') continue;
        const num = v => (v && v.endsWith('px') ? parseFloat(v) : 0);
        // 只有「负 inset」才是扩大热区（inset-x:[-8px] → +16 宽）。
        // 正的 inset 表示伪元素比本体更小，不能当成缩小本体——否则会把 60×48
        // 的底部标签算成 36×2（线上实测过的误报）。
        const ex = Math.max(0, -(num(cs.left) + num(cs.right)));
        const ey = Math.max(0, -(num(cs.top) + num(cs.bottom)));
        w += ex; h += ey; left -= ex / 2; top -= ey / 2;
      }
      return { w, h, left, top };
    };
    for (const el of document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top > innerHeight || r.bottom < 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      // 1×1 的多半是「跳到主内容」这类 skip link，聚焦后才展开，不是指针目标。
      if (r.width <= 2 && r.height <= 2) continue;
      // 输入框本体小但外层可点时（本项目给它加了 cursor-text + 点击聚焦），
      // 不该按本体的 160×20 报缺陷。
      if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
        const host = el.parentElement;
        if (host && getComputedStyle(host).cursor === 'text') continue;
      }
      const eff = expand(el);
      if (eff.w < min || eff.h < min) {
        const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 24);
        res.push(`${label} → effective ${Math.round(eff.w)}×${Math.round(eff.h)}`);
      }
    }
    return res.slice(0, 10);
  }, minSize);
  rows.push({ target: `${width}px ${route}`, findings: found.length, details: found });
}

await browser.close();
report(`tap targets (min ${minSize}×${minSize})`, rows);
