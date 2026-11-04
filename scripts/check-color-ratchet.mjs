#!/usr/bin/env node
// Color-class ratchet (issue #70 follow-up ②, 通信龙 dispatch 08-01).
//
// ~439 hardcoded Tailwind color classes (bg|text|border|ring)-[#hex] are
// being token-migrated in batches (batches 2-7). This ratchet keeps the
// number from growing WHILE the migration runs:
//   - per-file baseline (scripts/color-ratchet-baseline.json)
//   - FAIL only when a file exceeds its baseline or a NEW file introduces
//     hardcoded colors — it does NOT demand zero (an instantly-red gate
//     would just get disabled)
//   - improvements pass with a hint to tighten: node …/check-color-ratchet.mjs --update
//   - denominator always printed; scanning ZERO files is a scope
//     regression and FAILS (the "0 hits ≠ checked" lesson).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'color-ratchet-baseline.json');
// Two ratcheted families:
//   1. arbitrary hex classes (bg|text|border|ring)-[#…]
//   2. white/black opacity utilities (batch-3 "6th class"): bg-white/5 on a
//      light surface composites to a ~0 shift — theme-blind by construction.
//      Legit uses exist (modal backdrops, on-image chrome — 24 spots ruled
//      KEEP in batch 3), so like family 1 this only blocks INCREASES.
const RE = /(bg|text|border|ring)-\[#[0-9a-fA-F]{3,8}\]|(bg|text|border|ring|divide)-(white|black)\/\d+/g;
// 第三族：命名调色板类（text-gray-400 / bg-cyan-500 …）。
// 它们既不走 token，也不在深色兜底层里，切换主题时颜色纹丝不动；
// 此前门禁只扫 hex 类与 white/black 透明度类，这一族完全没覆盖（实测 13 族、1117 处）。
// 第四族：偏离设计刻度的大小类。圆角 `rounded-md`(6px) 不在 2/4/8/12/16/18/999 内；
// 字号 `text-[9px]|[10px]|[13px]` 不在 11/12/14/16/20 内。实测这两组一周内还在净增
// （rounded-md 178→206、text-[10px] 144→208），所以先拦新增、再分批迁移。
const SCALE_RE = /\brounded-md\b|\btext-\[(?:9|10|13)px\](?![0-9a-zA-Z])/g;
const PALETTE_RE = /(?:bg|text|border|ring|divide|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
// 基线放在同一个文件里（{ hardcoded, palette }），不新增 scripts 文件：
// OSS readiness 只允许已评审的 scripts 清单，新增数据文件会被判 unknown。

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules' && name !== '.next') yield* walk(p); }
    else if (/\.tsx$/.test(name)) yield p;
  }
}

// 统计前先去掉注释：R2 实测 TopoGraph 里 21 处「命中」有 3 处只是注释文本，
// 注释里的类名既不会渲染、也无法「迁移」，计入分母会让门禁数字虚高。
// 只去块注释与整行 // 注释——行内 // 可能是 URL（https://…），不能一概截断。
function stripComments(text) {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      return !(s.startsWith('//') || s.startsWith('*'));
    })
    .join('\n');
}

const counts = {};
const paletteCounts = {};
const scaleCounts = {};
let scanned = 0, total = 0, paletteTotal = 0, scaleTotal = 0;
for (const f of walk(join(ROOT, 'app'))) {
  scanned++;
  const src = stripComments(readFileSync(f, 'utf8'));
  const n = (src.match(RE) || []).length;
  if (n > 0) { counts[relative(ROOT, f)] = n; total += n; }
  const pn = (src.match(PALETTE_RE) || []).length;
  if (pn > 0) { paletteCounts[relative(ROOT, f)] = pn; paletteTotal += pn; }
  const sn = (src.match(SCALE_RE) || []).length;
  if (sn > 0) { scaleCounts[relative(ROOT, f)] = sn; scaleTotal += sn; }
}
if (scanned === 0) {
  console.error('color-ratchet: 🔴 scanned ZERO files — scope regression, refusing to pass.');
  process.exit(2);
}

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ hardcoded: counts, palette: paletteCounts, scale: scaleCounts }, null, 2) + '\n');
  console.log(`color-ratchet: baseline updated — ${scanned} files scanned, ${total} hardcoded color classes across ${Object.keys(counts).length} files; ${paletteTotal} named-palette classes across ${Object.keys(paletteCounts).length} files; ${scaleTotal} off-scale size classes across ${Object.keys(scaleCounts).length} files.`);
  process.exit(0);
}

let baselineFile;
try { baselineFile = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); }
catch {
  console.error(`color-ratchet: 🔴 baseline missing/unreadable at ${BASELINE_PATH}. Generate with --update.`);
  process.exit(2);
}

// 兼容旧格式（整份就是 hardcoded 映射）以及新格式（{ hardcoded, palette }）。
const baseline = baselineFile.hardcoded ?? baselineFile;
const paletteBaseline = baselineFile.palette ?? null;
const regressions = [];
for (const [file, n] of Object.entries(counts)) {
  // Baseline omits zero-count files, so a missing entry means "was clean
  // (or didn't exist)" — either way its budget is 0.
  const base = baseline[file] ?? 0;
  if (n > base) regressions.push(`${file}: ${base} → ${n} (+${n - base})${baseline[file] === undefined ? ' (was clean/new)' : ''}`);
}
const improved = Object.entries(baseline).filter(([f, b]) => (counts[f] ?? 0) < b);

console.log(`color-ratchet: scanned ${scanned} files, ${total} hardcoded color classes (baseline ${Object.values(baseline).reduce((a, b) => a + b, 0)}).`);
if (regressions.length) {
  console.error('color-ratchet: 🔴 hardcoded color classes INCREASED — use the token table at the top of globals.css instead:');
  for (const r of regressions) console.error('  ' + r);
  process.exit(1);
}
if (improved.length) {
  console.log(`color-ratchet: ${improved.length} file(s) improved below baseline — tighten with: node scripts/check-color-ratchet.mjs --update`);
}

// 命名调色板族（第三族）单独判定：它与 hex 族的迁移节奏不同，混在一起会互相淹没。
if (!paletteBaseline) {
  console.error(`color-ratchet: 🔴 palette baseline missing in ${BASELINE_PATH}. Generate with --update.`);
  process.exit(2);
}
const paletteRegressions = [];
for (const [file, n] of Object.entries(paletteCounts)) {
  const base = paletteBaseline[file] ?? 0;
  if (n > base) paletteRegressions.push(`${file}: ${base} → ${n} (+${n - base})${paletteBaseline[file] === undefined ? ' (was clean/new)' : ''}`);
}
const paletteBaselineTotal = Object.values(paletteBaseline).reduce((a, b) => a + b, 0);
console.log(`color-ratchet: ${paletteTotal} named-palette classes in ${Object.keys(paletteCounts).length} files (baseline ${paletteBaselineTotal}).`);
if (paletteRegressions.length) {
  console.error('color-ratchet: 🔴 named palette classes INCREASED — 它们不走 token 也不在深色兜底层，换主题不会变色：');
  for (const r of paletteRegressions) console.error('  ' + r);
  process.exit(1);
}
// 刻度族（圆角 / 小字号）单独判定，理由同调色板族：迁移节奏不同。
const scaleBaseline = baselineFile.scale ?? null;
if (!scaleBaseline) {
  console.error(`color-ratchet: 🔴 scale baseline missing in ${BASELINE_PATH}. Generate with --update.`);
  process.exit(2);
}
const scaleRegressions = [];
for (const [file, n] of Object.entries(scaleCounts)) {
  const base = scaleBaseline[file] ?? 0;
  if (n > base) scaleRegressions.push(`${file}: ${base} → ${n} (+${n - base})${scaleBaseline[file] === undefined ? ' (was clean/new)' : ''}`);
}
const scaleBaselineTotal = Object.values(scaleBaseline).reduce((a, b) => a + b, 0);
console.log(`color-ratchet: ${scaleTotal} off-scale size classes in ${Object.keys(scaleCounts).length} files (baseline ${scaleBaselineTotal}).`);
if (scaleRegressions.length) {
  console.error('color-ratchet: 🔴 off-scale size classes INCREASED — 圆角用 2/4/8/12/16/18/999，字号用 11/12/14/16/20：');
  for (const r of scaleRegressions) console.error('  ' + r);
  process.exit(1);
}
console.log('color-ratchet: ✓ no file exceeds its baseline.');
