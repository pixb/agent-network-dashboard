'use client';

// 更新日志正文的 Markdown 渲染。
//
// 与 `CommentMarkdown` 同一套依赖（react-markdown + remark-gfm），并按元素逐个给类：
// 本仓没装 @tailwindcss/typography，`prose` 在这里是空类，而 preflight 会把
// h1–h6 的字号/字重重置成继承、把列表标记清掉——结果就是「去了 # 号但没渲染」。
//
// 分节折叠：243 个版本全展开时，1440 下页面高约 50,000px、320 下 86,572px，
// 用户要找某一版只能一路滚。按 `## ` 拆成 <details>，默认只展开最新 3 版，
// 其余点开看——首屏就能看到最新变更，页面高度也降到可操作范围。
import { useMemo } from 'react';
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

function renderMarkdown(text: string) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

/** 按 `## ` 把整份 CHANGELOG 拆成「前言 + 每个版本一节」。 */
function splitSections(markdown: string) {
  const lines = markdown.split('\n');
  const preamble: string[] = [];
  const sections: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push({ title: current.title, body: current.body.join('\n') });
      current = { title: line.slice(3).trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) sections.push({ title: current.title, body: current.body.join('\n') });
  return { preamble: preamble.join('\n'), sections };
}

export default function ChangelogView({ markdown }: { markdown: string }) {
  const { preamble, sections } = useMemo(() => splitSections(markdown), [markdown]);
  return (
    <article
      data-testid="changelog-body"
      data-sections={sections.length}
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/60 px-4 py-3"
    >
      {preamble.trim() ? <div className="mb-2">{renderMarkdown(preamble)}</div> : null}
      {sections.map((section, index) => (
        <details
          key={section.title}
          data-testid="changelog-section"
          // 只展开最新 3 版：再往前用户通常用浏览器查找，不需要一次铺满。
          open={index < 3}
          className="group border-t border-[var(--border)]/60 py-2 first:border-t-0"
        >
          <summary
            className="cursor-pointer list-none text-xs font-medium text-[var(--fg)] marker:hidden hover:text-[var(--hl)] [overflow-wrap:anywhere]"
          >
            <span className="mr-1 inline-block w-3 text-[var(--fg-dim)] group-open:hidden">▸</span>
            <span className="mr-1 hidden w-3 text-[var(--fg-dim)] group-open:inline-block">▾</span>
            {section.title}
          </summary>
          <div className="pl-4">{renderMarkdown(section.body)}</div>
        </details>
      ))}
    </article>
  );
}
