// 对比度审计：逐页扫描可见文本，报告低于 WCAG AA 的项。
//
//   node tools/a11y/contrast.mjs --base https://dm.vansin.top --config ~/.anet/nodes/<alias>/config.json \
//        --routes /,/nodes,/requirements --themes light,cyber
//
// 判定：正文 (<18.66px，或 <24px 且非粗体) 需 ≥ 4.5:1；大字需 ≥ 3:1。
// 颜色一律走「真实计算样式 + canvas 取像素」，不解析字符串。
import { PAGE_COLOR_HELPERS, cookieFromNodeConfig, cookieFromPassword, parseArgs, report } from './lib.mjs';

const args = parseArgs();
const base = args.base;
if (!base) { console.error('need --base <url>'); process.exit(2); }
const routes = String(args.routes || '/,/nodes,/requirements,/settings').split(',').map(s => s.trim()).filter(Boolean);
const themes = String(args.themes || 'light,cyber').split(',').map(s => s.trim()).filter(Boolean);
const samplesPerRoute = Math.max(1, Number(args.samples || 1));
const cookieValue = args.config ? cookieFromNodeConfig(args.config)
  : args.password ? cookieFromPassword(String(args.password))
  : null;
if (!cookieValue) { console.error('need --config <node config.json> or --password <dashboard password>'); process.exit(2); }

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const rows = [];

for (const theme of themes) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: 'anet_dashboard_session', url: base, httpOnly: true, sameSite: 'Lax', value: cookieValue }]);
  await ctx.addInitScript(t => { localStorage.setItem('anet-theme', t); sessionStorage.setItem('anet_network_id', ''); }, theme);
  const page = await ctx.newPage();

  for (const route of routes) {
    await page.goto(base + route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(Number(args.wait || 1800));
    const union = new Set();
    for (let s = 0; s < samplesPerRoute; s++) {
      if (s > 0) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(Number(args.wait || 1800));
      }
      const foundOnce = await page.evaluate(helpers => {
      new Function(helpers)(); // eslint-disable-line no-new-func
      const { px, over, contrast, bgOf } = globalThis.__a11y;
      const res = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length) continue;
        const text = (el.textContent || '').trim();
        if (text.length < 2 || text.length > 60) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.top > innerHeight || r.bottom < 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.5) continue;
        const fgRaw = px(cs.color);
        if (fgRaw[3] < 0.05) continue;
        // 元素自身的 opacity 会等比削弱文字：只读 color 会高估对比度
        //（实测：10px 文本报 4.09，实际因祖先 opacity 更低）。逐级相乘后再合成。
        let chain = 1;
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const o = Number(getComputedStyle(n).opacity);
          if (Number.isFinite(o)) chain *= o;
          if (chain < 0.02) break;
        }
        fgRaw[3] = fgRaw[3] * chain;
        const bg = bgOf(el);
        const fg = over(fgRaw, bg);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 600);
        const ratio = contrast(fg, bg);
        const need = large ? 3 : 4.5;
        if (ratio < need) {
          const cls = (el.className || '').toString().replace(/\s+/g, ' ').slice(0, 70);
          res.push(`"${text.slice(0, 26)}" ${ratio.toFixed(2)}:1 (need ${need}, ${size}px) [${cls}]`);
        }
      }
      return res.slice(0, 10);
      }, PAGE_COLOR_HELPERS);
      for (const f of foundOnce) union.add(f);
    }
    rows.push({ target: `${theme} ${route}`, findings: union.size, details: [...union] });
  }
  await ctx.close();
}

await browser.close();
report('contrast (WCAG AA)', rows);
