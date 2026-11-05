// 一键跑完三项无障碍审计，输出人类可读摘要 + 机器可读 JSON。
//
//   node tools/a11y/run-all.mjs --base https://your.dashboard \
//        --config ~/.anet/nodes/<alias>/config.json \
//        --routes /,/nodes,/requirements --samples 2 --out /tmp/a11y.json
//
// 为什么要一个入口：
//  - 三项审计要一起看才完整（对比度合格但触控过小、或名字为空，都算缺陷）；
//  - 线上页面内容随时序变化，`--samples` 必须能统一传下去；
//  - 结果要能归档（JSON），而不是只留在终端里。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib.mjs';

const args = parseArgs();
if (!args.base) { console.error('need --base <url>'); process.exit(2); }
if (!args.config && !args.password) { console.error('need --config <node config.json> or --password <pwd>'); process.exit(2); }

const here = path.dirname(new URL(import.meta.url).pathname);
const common = [
  '--base', args.base,
  ...(args.config ? ['--config', String(args.config)] : ['--password', String(args.password)]),
  ...(args.routes ? ['--routes', String(args.routes)] : []),
  ...(args.wait ? ['--wait', String(args.wait)] : []),
];

const runs = [
  { name: 'contrast', argv: [...common, '--themes', String(args.themes || 'light,cyber'), '--samples', String(args.samples || 2)] },
  { name: 'tap-targets', argv: [...common, '--width', String(args.width || 390), '--min', String(args.min || 24)] },
  { name: 'accessible-names', argv: [...common] },
];

const summary = { base: args.base, at: new Date().toISOString(), results: {} };
for (const run of runs) {
  const proc = spawnSync(process.execPath, [path.join(here, `${run.name}.mjs`), ...run.argv], { encoding: 'utf8' });
  // 工具的退出码可能与断言重叠，这里以输出末行的 PASS/FAIL 为准
  const out = `${proc.stdout || ''}${proc.stderr || ''}`;
  const verdict = /: PASS\b/.test(out.split('\n').filter(Boolean).slice(-1)[0] || '') ? 'PASS' : 'FAIL';
  summary.results[run.name] = { verdict, output: out.trim() };
  console.log(`\n===== ${run.name}: ${verdict} =====`);
  console.log(out.trim());
}

const failed = Object.entries(summary.results).filter(([, r]) => r.verdict !== 'PASS').map(([k]) => k);
console.log(`\n===== SUMMARY =====`);
for (const [name, r] of Object.entries(summary.results)) console.log(`${name}: ${r.verdict}`);
console.log(failed.length === 0 ? 'ALL PASS' : `FAIL: ${failed.join(', ')}`);

if (args.out) {
  fs.writeFileSync(String(args.out), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`json → ${args.out}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
