import { readFileSync } from 'node:fs';
import path from 'node:path';
import ChangelogView from './ChangelogView';

/**
 * 更新日志页（对齐客户端 `ChangelogScreen`）。
 *
 * 内容来源就是本仓的 `CHANGELOG.md`——那是**按版本给用户看的说明**（不是 commit 列表），
 * 也因此不需要任何 Hub 接口、不会因网络或权限失败而空白。
 *
 * 为什么在服务端读、把文本传给客户端组件：仓库里没有任何「运行时读文件」的先例，
 * 但打包成 standalone 后 `process.cwd()` 里不一定有 md 文件。构建期读进来最稳
 * （文件变了会触发重新构建，与版本号同一条流水线）。
 */
const source = path.join(process.cwd(), 'CHANGELOG.md');
const markdown = (() => {
  try {
    return readFileSync(source, 'utf8');
  } catch {
    // 读不到不要让整页 500：给一句可核验的说明，而不是空白。
    return '## CHANGELOG.md 未找到\n\n这是构建期错误：仓库根目录缺少 `CHANGELOG.md`。';
  }
})();

export const metadata = { title: '更新日志 · Agent Network' };

export default function ChangelogPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6" data-testid="changelog-page">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-[var(--fg)]">更新日志</h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          按版本列出的用户可见变化，来自仓库 <code className="rounded bg-[var(--hover-tint)] px-1">CHANGELOG.md</code>。
          preview 版本是开发通道的迭代，会在合入稳定版时折叠归档。
        </p>
      </header>
      <ChangelogView markdown={markdown} />
    </main>
  );
}
