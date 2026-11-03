// 更新日志页的契约检查（对照客户端 ChangelogScreen）。
//
// 这一页最容易「悄悄坏」的方式不是样式，而是**内容源没了**：CHANGELOG.md 改名、
// 或者页面改成运行时读文件（standalone 产物里读不到，页面变空白但不报错）。
// 所以这里查三件事：文件存在且有内容、页面在构建期读它、导航里有入口。
import { readFileSync, existsSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

assert.ok(existsSync(new URL('CHANGELOG.md', root)), 'CHANGELOG.md 必须存在（更新日志页的内容源）');
const changelog = read('CHANGELOG.md');
assert.ok(/^# Changelog/m.test(changelog), 'CHANGELOG.md 应以 "# Changelog" 开头');
const versions = changelog.match(/^## \d+\.\d+\.\d+/gm) || [];
assert.ok(versions.length >= 5, `CHANGELOG.md 至少要有 5 条版本记录，实际 ${versions.length}`);

const page = read('app/changelog/page.tsx');
assert.ok(/readFileSync/.test(page), '页面必须在构建期读取 CHANGELOG.md（运行时读在 standalone 产物里会失败）');
assert.ok(/CHANGELOG\.md/.test(page), '页面必须显式引用 CHANGELOG.md');

const sidebar = read('app/components/Sidebar.tsx');
assert.ok(/href: '\/changelog'/.test(sidebar), '侧栏必须有 /changelog 入口，否则页面等于不存在');

// 窄屏换行：CHANGELOG 里有大量长串（版本号、?present=1&tour=1 这类内联代码）。
// 实测 320px 下曾有 5 个列表项横向溢出（ul 内容 496px 挤在 254px 里），
// 所以这里锁住「正文/列表/标题都允许任意断行」这条规则。
const view = read('app/changelog/ChangelogView.tsx');
for (const tag of ['p', 'li', 'h3']) {
  const line = view.split('\n').find(l => l.trim().startsWith(`${tag}:`));
  assert.ok(line, `ChangelogView 缺少 ${tag} 渲染分支`);
  assert.ok(/overflow-wrap:anywhere/.test(line), `${tag} 必须允许任意断行，否则窄屏会长串溢出`);
}

// 内容新鲜度：页面在、内容旧是最容易被忽略的坏法——`.319` 上线了页面，
// 但 CHANGELOG 最新条目停在 `.290`，页面展示了 33 个预览版之前的说明。
// 这里要求「最新条目」与 package.json 的 preview 号相差不超过 12。
const pkg = JSON.parse(read('package.json'));
const pkgPreview = Number((pkg.version || '').match(/preview\.(\d+)/)?.[1] ?? NaN);
const newest = Number([...changelog.matchAll(/^## \d+\.\d+\.\d+-preview\.(\d+)/gm)]
  .map(m => Number(m[1])).sort((a, b) => b - a)[0] ?? NaN);
assert.ok(Number.isFinite(pkgPreview), 'package.json 必须是 preview 版本号');
assert.ok(Number.isFinite(newest), 'CHANGELOG 里必须至少有一条 preview 条目');
const gap = pkgPreview - newest;
assert.ok(gap >= 0 && gap <= 12,
  `CHANGELOG 最新条目 .${newest} 落后 package.json .${pkgPreview} 共 ${gap} 个版本（上限 12）：请补写发布说明`);

console.log(`changelog page contract ok (${versions.length} versions, wrap guarded)`);
