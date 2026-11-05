'use client';

import { AliasAvatar } from './AliasAvatar';
import { relativeAgo } from '../lib/time';
import { previewContent } from './utils';
import { STATUS_DOT_HEX } from '../lib/status';

// Task-list rail for the /tasks two-column layout (类飞书 "list + detail").
// Rendered inside TasksView's <aside> — this file is intentionally small
// and only owns the list-row shape, so the same component can back both
// desktop rail and (later) a mobile drawer without duplicating the row
// template.
//
// #Stage-tasks: mirrors NodeList.tsx narrow-rail pattern. Row click calls
// onSelect(task_id) so the parent can drive URL/state; row does NOT know
// about routing.

export interface TaskListItem {
  task_id: string;
  network_id?: string;
  from_name: string;
  to_name: string;
  status: string;
  priority: string;
  content: string;
  created_at: string;
}

// 同 TaskDetail:统一到 lib/time,关掉 ISO→"…ZZ"→NaN 那条路径。
// 注意这里的输出**不带 " ago" 后缀**(列表里空间紧),所以要把后缀去掉,
// 保持既有视觉不变。
function timeAgo(dateStr: string): string {
  const v = relativeAgo(dateStr);
  return v === null ? '--' : v.replace(/ ago$/, '');
}

export function TaskList({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: TaskListItem[];
  selectedId: string | null;
  onSelect: (task_id: string) => void;
}) {
  return (
    <div
      data-testid="task-list-rail"
      className="flex flex-col h-full max-h-screen overflow-y-auto"
    >
      {tasks.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--fg-muted)]">
          没有匹配的任务
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--border)]">
          {tasks.map((t) => {
            const active = t.task_id === selectedId;
            return (
              <li key={t.task_id}>
                <button
                  type="button"
                  data-task-row
                  data-task-id={t.task_id}
                  data-selected={active ? 'true' : 'false'}
                  onClick={() => onSelect(t.task_id)}
                  className={`w-full px-3 py-2.5 text-left transition-colors ${
                    active
                      ? 'bg-[var(--bg-elevated)]'
                      : 'hover:bg-[var(--hover-tint)]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {/* status dot + label */}
                    <span
                      aria-hidden
                      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: STATUS_DOT_HEX[t.status] || '#6b7280' }}
                    />
                    <span className="text-[11px] text-[var(--fg-muted)]">{t.status}</span>
                    {t.priority === 'high' && (
                      <span className="text-[11px] text-red-400 shrink-0">HIGH</span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--fg-muted)]">
                      {timeAgo(t.created_at)}
                    </span>
                  </div>
                  <div className="mb-1 flex min-w-0 items-center gap-1 text-xs text-[var(--fg-muted)]">
                    {t.from_name && <AliasAvatar alias={t.from_name} size={14} />}
                    <span className="truncate max-w-[35%]">{t.from_name || '--'}</span>
                    <span className="shrink-0 text-[var(--fg-muted)]" aria-hidden="true">→</span>
                    {t.to_name && <AliasAvatar alias={t.to_name} size={14} />}
                    <span className="truncate max-w-[35%]">{t.to_name || '--'}</span>
                  </div>
                  <div
                    className="line-clamp-2 text-[11px] leading-snug text-[var(--fg-muted)]"
                    title={t.content}
                  >
                    {previewContent(t.content) || <span className="italic">(no content)</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
