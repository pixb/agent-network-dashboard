'use client';

// 更新日志正文的 Markdown 渲染。
//
// 与 `CommentMarkdown` 同一套依赖（react-markdown + remark-gfm），并按元素逐个给类：
// 本仓没装 @tailwindcss/typography，`prose` 在这里是空类，而 preflight 会把
// h1–h6 的字号/字重重置成继承、把列表标记清掉——结果就是「去了 # 号但没渲染」。
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  h1: props => <h1 className="mt-0 mb-2 text-base font-semibold text-[var(--fg)] [overflow-wrap:anywhere]" {...props} />,
  h2: props => (
    <h2
      className="mt-6 mb-2 border-t border-[var(--border)] pt-4 text-sm font-semibold text-[var(--fg)] [overflow-wrap:anywhere]"
      {...props}
    />
  ),
  h3: props => <h3 className="mt-3 mb-1 text-[13px] font-medium text-[var(--fg)] [overflow-wrap:anywhere]" {...props} />,
  // 窄屏实测：长串（版本号、`?present=1&tour=1` 这类内联代码）不换行，320px 下
  // 列表项横向溢出（ul 内容 496px 挤在 254px 里）。anywhere 让它优先换行而不是撑破。
  p: props => <p className="my-1.5 text-xs leading-relaxed text-[var(--fg-muted)] [overflow-wrap:anywhere]" {...props} />,
  ul: props => <ul className="my-1.5 list-disc space-y-1 pl-5 text-xs text-[var(--fg-muted)]" {...props} />,
  ol: props => <ol className="my-1.5 list-decimal space-y-1 pl-5 text-xs text-[var(--fg-muted)]" {...props} />,
  li: props => <li className="leading-relaxed [overflow-wrap:anywhere]" {...props} />,
  hr: () => <hr className="my-4 border-[var(--border)]" />,
  code: props => (
    <code className="rounded bg-[var(--hover-tint)] px-1 py-0.5 font-mono text-[11px] text-[var(--fg)] [overflow-wrap:anywhere]" {...props} />
  ),
  a: props => (
    <a className="text-[var(--hl)] underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />
  ),
};

export default function ChangelogView({ markdown }: { markdown: string }) {
  return (
    <article data-testid="changelog-body" className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/60 px-4 py-3">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
