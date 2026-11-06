// 共用工具：会话 cookie、颜色取真实像素、对比度、可访问名判定。
//
// 这些函数被打包成可复用形态，是因为 2026-11-05 的审计手段值得别的线直接用：
//  - 对比度必须用「真实计算样式 + canvas 取像素」，不能解析字符串
//    （Chromium 新版会算成 color(srgb …) / lab(…)，正则解析会得出 4.5 还是 2.1 全凭运气）；
//  - 触控目标要量「有效热区」（含 ::before 扩大的部分），否则会把达标控件当缺陷；
//  - 可访问名要读无障碍树（CDP Accessibility.getFullAXTree），
//    因为 Chrome 会用 placeholder 兜底出名字，只看 DOM 的 aria-label 会误报。
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** 从节点配置读 token，拼成 Dashboard v3 会话 cookie（只读访问用）。 */
export function cookieFromNodeConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const token = cfg.token;
  if (typeof token !== 'string' || !/^(atok_|utok_|ntok_)/.test(token)) {
    throw new Error('node config has no usable V3 token');
  }
  return `v3:${token}`;
}

/** 老式口令登录：cookie = sha256(`anet-dashboard:${password}`)。 */
export function cookieFromPassword(password) {
  return createHash('sha256').update(`anet-dashboard:${password}`).digest('hex');
}

/** 在页面里评估：把任意 CSS 颜色渲染成 RGBA。 */
export const PAGE_COLOR_HELPERS = `
const __cv = document.createElement('canvas'); __cv.width = __cv.height = 1;
const __cx = __cv.getContext('2d', { willReadFrequently: true });
const px = css => {
  __cx.clearRect(0, 0, 1, 1); __cx.fillStyle = '#000'; __cx.fillStyle = css;
  __cx.fillRect(0, 0, 1, 1);
  const d = __cx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
};
const over = (f, b) => f.slice(0, 3).map((v, i) => Math.round(v * f[3] + b[i] * (1 - f[3])));
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const bgOf = el => {
  const stack = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const c = px(getComputedStyle(n).backgroundColor);
    if (c[3] > 0.01) stack.push(c);
    if (c[3] >= 0.99) break;
  }
  let base = [255, 255, 255];
  const docBg = px(getComputedStyle(document.body).backgroundColor);
  if (docBg[3] > 0.5) base = docBg.slice(0, 3);
  for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
  return base;
};
globalThis.__a11y = { px, over, lin, lum, contrast, bgOf };
`;

/** 把 `--key value` 参数解析成对象。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; }
    else out[key] = true;
  }
  return out;
}

/** 统一的结果输出：退出码非 0 表示有发现（便于接进 CI）。 */
export function report(title, rows, { failOnFindings = true } = {}) {
  const findings = rows.filter(r => r.findings > 0);
  console.log(`\n## ${title}`);
  for (const r of rows) {
    const head = `- ${r.target}: ${r.findings === 0 ? 'PASS' : `FAIL (${r.findings})`}`;
    console.log(head);
    for (const d of (r.details || []).slice(0, 5)) console.log(`    ${d}`);
  }
  const total = findings.reduce((n, r) => n + r.findings, 0);
  console.log(`\n${title}: ${total === 0 ? 'PASS' : `FAIL — ${total} finding(s)`}`);
  if (failOnFindings && total > 0) process.exitCode = 1;
}
