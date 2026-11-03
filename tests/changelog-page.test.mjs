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

console.log(`changelog page contract ok (${versions.length} versions)`);
