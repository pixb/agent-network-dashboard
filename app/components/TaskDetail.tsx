'use client';

import { useState } from 'react';
import { relativeAgo } from '../lib/time';
import useSWR from 'swr';
import { AliasAvatar } from './AliasAvatar';
import { STATUS_CHIP_CLASS as STATUS_CHIP } from '../lib/status';

// Detail pane for the /tasks two-column layout.
//
// Feature-parity target (通信龙 07-31 parity 硬门, migrating from the
// old full-page /tasks/[id]/page.tsx): five blocks, each with its own
// positive assertion in tests + real data visible (not just "the div
// is there"):
//   1. Timeline card — steps: created / delivered / started / completed
//   2. Info card     — task_id / from / to / priority / status / expires
//   3. Content
//   4. Result
//   5. Events feed   — /api/hub/task-events?limit=50 (10s poll)
//
// Poll cadence — the old full-page useSWR was 5s (task) + 10s (events).
// Do NOT widen either interval: "page's there but data's stale" is worse
// than "page's not there" because it looks fine to anyone glancing at it.
// The intervals are part of parity — tests should assert both refetch.

interface TaskDetailData {
  task_id: string;
  network_id?: string;
  from_name: string;
  to_name: string;
  status: string;
  priority: string;
  content: string;
  result: string;
  created_at: string;
  updated_at: string;
  delivered_at: string;
  started_at: string;
  completed_at: string;
  expires_at: string;
}

interface TaskEvent {
  id: number;
  event_type?: string | null;
  actor?: string | null;
  from_status: string;
  to_status: string;
  detail?: string | null;
  created_at: string;
}

function taskEventLabel(event: TaskEvent): string {
  return event.event_type?.trim() || event.to_status?.trim() || 'event';
}

function isDeliveryStaleObservation(event: TaskEvent): boolean {
  return event.event_type?.startsWith('task.stale.') ?? false;
}

// 🔴 Poll cadences are declared as module-scope constants so the useSWR
// refreshInterval and the DOM `data-poll-*-ms` attribute are *literally*
// the same number. Two separate literals meant the attribute-based test
// assertion could go green even if someone widened refreshInterval —
// the assertion was watching the string, not the fact.
// (通信龙 07-31 catch: "断言的是声明, 不是事实.")
// Widen either interval only alongside a paired update to the test
// asserting cadence, and re-run witnessed-red by bumping one of these
// to a wrong value.
const POLL_TASK_MS = 5000;
const POLL_EVENTS_MS = 10000;

// Round 38 / Round 44 已经把时间戳解析统一到 lib/time;这里是漏网的一处。
// 旧的内联写法对**已经是 ISO** 的输入会补成 "…ZZ" → Date.parse 得 NaN
// → 后续 `NaN < 60` 全 false,一路落到最后一行显示 "NaNd ago"。
// 现在 hub 只发裸 SQL,所以那条路径尚未发生;这是提前关掉它。
// 同时拿到 relativeAgo 的时钟偏移兜底(未来时间戳 → 'just now',而不是负数)。

function timeAgo(dateStr: string): string {
  return relativeAgo(dateStr) ?? '--';
}

function priorityClass(priority: string) {
  if (priority === 'high') return 'text-[var(--danger)]';
  if (priority === 'low') return 'text-[var(--fg-dim)]';
  return 'text-[var(--fg-muted)]';
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (res.status === 401) {
    window.location.assign('/login');
    throw new Error('unauthorized');
  }
  return res.json();
};

export function TaskDetail({
  taskId,
  onClose,
  onRetried,
}: {
  taskId: string;
  /** X in the header — desktop returns pane to empty, mobile dismisses overlay.
   *  Either way the URL drops back to /tasks (parent handles). Preserves the
   *  返回入口 the old full-page detail had via its "← Tasks" link. */
  onClose?: () => void;
  /** After a successful retry so the parent list can refetch. */
  onRetried?: () => void;
}) {
  // 🔴 Poll intervals are part of parity: 5s task, 10s events. Do not widen
  // without updating the corresponding cadence assertion.
  const { data: taskData, isLoading, error, mutate: refetchTask } = useSWR<{
    tasks: TaskDetailData[];
  }>(
    `/api/hub/tasks?task_id=${encodeURIComponent(taskId)}`,
    fetcher,
    { refreshInterval: POLL_TASK_MS },
  );
  const { data: eventsData } = useSWR<{ events: TaskEvent[] }>(
    `/api/hub/task-events?task_id=${encodeURIComponent(taskId)}&limit=50`,
    fetcher,
    { refreshInterval: POLL_EVENTS_MS },
  );
  const [retrying, setRetrying] = useState(false);

  const task = taskData?.tasks?.[0];
  const events = eventsData?.events || [];

  const doRetry = async () => {
    if (!task) return;
    setRetrying(true);
    try {
      await fetch('/api/hub/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: task.to_name,
          task: task.content,
          priority: task.priority,
          ...(task.network_id ? { network_id: task.network_id } : {}),
        }),
      });
      refetchTask();
      onRetried?.();
    } finally {
      setRetrying(false);
    }
  };

  const timelineSteps: { label: string; time: string; color: string }[] = task
    ? [
        { label: 'Created', time: task.created_at, color: 'text-[var(--fg-muted)]' },
        { label: 'Delivered', time: task.delivered_at, color: 'text-blue-400' },
        { label: 'Started', time: task.started_at, color: 'text-[var(--success)]' },
        { label: 'Completed', time: task.completed_at, color: 'text-[var(--accent-text)]' },
      ]
    : [];

  return (
    <div
      data-testid="task-detail-pane"
      data-task-id={taskId}
      data-poll-task-ms={String(POLL_TASK_MS)}
      data-poll-events-ms={String(POLL_EVENTS_MS)}
      className="flex flex-col h-full max-h-screen overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <div className="text-xs text-[var(--fg-muted)] truncate" title={taskId}>
            <span className="text-[var(--fg-dim)]">Task ID:</span>{' '}
            <span className="font-mono">{taskId.slice(0, 12)}…</span>
          </div>
          {task && (
            <span
              data-testid="task-detail-status"
              className={`text-xs px-2 py-0.5 rounded-md border ${
                STATUS_CHIP[task.status] ||
                'bg-gray-500/10 text-[var(--fg-muted)] border-gray-500/20'
              }`}
            >
              {task.status}
            </span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail (返回 tasks 列表)"
            data-testid="task-detail-close"
            className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[#3a3a41]"
          >
            ←
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {isLoading && !task && (
          <div className="animate-pulse space-y-3">
            <div className="h-6 w-1/3 bg-[var(--bg-elevated)]/40 rounded" />
            <div className="h-24 bg-[var(--bg-elevated)]/40 rounded" />
            <div className="h-24 bg-[var(--bg-elevated)]/40 rounded" />
          </div>
        )}
        {error && (
          <div className="bg-red-900/20 border border-red-800/40 text-red-300 px-3 py-2 rounded text-sm">
            {error instanceof Error ? error.message : 'fetch failed'}
          </div>
        )}
        {!isLoading && !error && !task && (
          <div className="text-[var(--fg-muted)] text-sm">Task not found</div>
        )}

        {task && (
          <>
            {/* Block 1: Timeline card (parity #1) */}
            <section
              data-testid="task-detail-timeline"
              data-block="timeline"
              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-4"
            >
              <h2 className="text-sm font-semibold text-[var(--fg)] mb-4">Timeline</h2>
              <div className="relative">
                {timelineSteps.map((step, i) => {
                  const done = !!step.time;
                  const isLast = i === timelineSteps.length - 1;
                  return (
                    <div
                      key={step.label}
                      data-testid={`timeline-step-${step.label.toLowerCase()}`}
                      data-timeline-step={step.label.toLowerCase()}
                      data-timeline-done={done ? 'true' : 'false'}
                      className="flex gap-3 pb-4 last:pb-0"
                    >
                      <div className="flex flex-col items-center">
                        <div
                          className={`w-3 h-3 rounded-full border-2 shrink-0 ${
                            done ? `${step.color} border-current` : 'border-[var(--border)] bg-transparent'
                          }`}
                        />
                        {!isLast && (
                          <div
                            className={`w-0.5 flex-1 mt-1 ${
                              done && timelineSteps[i + 1]?.time
                                ? 'bg-[var(--accent)]/40'
                                : 'bg-[var(--bg-elevated)]'
                            }`}
                          />
                        )}
                      </div>
                      <div className="min-w-0 -mt-0.5">
                        <div className={`text-sm font-medium ${done ? 'text-[var(--fg)]' : 'text-[var(--fg-dim)]'}`}>
                          {step.label}
                        </div>
                        <div
                          className="text-xs text-[var(--fg-muted)]"
                          title={step.time || undefined}
                        >
                          {step.time ? `${timeAgo(step.time)} — ${step.time}` : 'Pending'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Block 2: Info card (parity #2) */}
            <section
              data-testid="task-detail-info"
              data-block="info"
              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-4"
            >
              <h2 className="text-sm font-semibold text-[var(--fg)] mb-3">Info</h2>
              <div className="space-y-2 text-xs">
                {[
                  ['Task ID', task.task_id],
                  ['From', task.from_name],
                  ['To', task.to_name],
                  ['Priority', task.priority],
                  ['Status', task.status],
                  ['Expires', task.expires_at],
                ].map(([label, val]) => (
                  <div key={label as string} className="flex justify-between gap-4">
                    <span className="text-[var(--fg-muted)] shrink-0">{label}</span>
                    <span
                      data-info-field={String(label).toLowerCase().replace(/\s+/g, '-')}
                      className="text-[var(--fg)] truncate max-w-[240px] text-right"
                      title={String(val || '')}
                    >
                      {String(val || '--')}
                    </span>
                  </div>
                ))}
              </div>
              <div
                className="mt-4 pt-3 border-t border-[var(--border)] flex items-center gap-2 text-sm text-[var(--fg)]"
                data-testid="task-detail-participants"
              >
                {task.from_name && <AliasAvatar alias={task.from_name} size={20} />}
                <span className="truncate">{task.from_name || '--'}</span>
                <span className="text-[var(--fg-dim)] shrink-0">→</span>
                {task.to_name && <AliasAvatar alias={task.to_name} size={20} />}
                <span className="truncate">{task.to_name || '--'}</span>
              </div>
              <div className="mt-2 text-[10px]">
                <span
                  className={priorityClass(task.priority)}
                  data-testid="task-detail-priority"
                >
                  Priority: {task.priority || 'normal'}
                </span>
              </div>
            </section>

            {/* Block 3: Content (parity #3) */}
            <section
              data-testid="task-detail-content"
              data-block="content"
              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-4"
            >
              <h2 className="text-sm font-semibold text-[var(--fg)] mb-2">Content</h2>
              <pre
                data-testid="task-detail-content-body"
                className="text-xs text-[var(--fg)] whitespace-pre-wrap break-words bg-[var(--bg)] rounded-lg px-3 py-2 border border-[var(--border)] max-h-64 overflow-y-auto font-sans"
              >
                {task.content || '--'}
              </pre>
            </section>

            {/* Block 4: Result (parity #4) */}
            {task.result && (
              <section
                data-testid="task-detail-result"
                data-block="result"
                className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-4"
              >
                <h2 className="text-sm font-semibold text-[var(--fg)] mb-2">Result</h2>
                <pre
                  data-testid="task-detail-result-body"
                  className="text-xs text-[var(--fg)] whitespace-pre-wrap break-words bg-[var(--bg)] rounded-lg px-3 py-2 border border-[var(--border)] max-h-64 overflow-y-auto font-sans"
                >
                  {task.result}
                </pre>
              </section>
            )}

            {/* Block 5: Events feed (parity #5) — 10s poll, always rendered
                even when empty so "no events" state is visible; a silently
                missing block would hide the difference between "feed
                gone" and "task has no events yet". */}
            <section
              data-testid="task-detail-events"
              data-block="events"
              data-events-count={events.length}
              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-4"
            >
              <h2 className="text-sm font-semibold text-[var(--fg)] mb-3">
                Events {events.length > 0 && <span className="text-[var(--fg-muted)]">({events.length})</span>}
              </h2>
              {events.length === 0 ? (
                <div className="text-xs text-[var(--fg-dim)] italic">No events yet.</div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {events.map((e, i) => (
                    <div
                      key={e.id ?? i}
                      data-testid="task-detail-event-row"
                      className="flex items-start gap-2 text-xs"
                    >
                      <span
                        aria-hidden
                        className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                          e.to_status === 'running'
                            ? 'bg-green-400'
                            : e.to_status === 'replied'
                              ? 'bg-[var(--accent)]'
                              : e.to_status === 'failed'
                                ? 'bg-red-400'
                                : 'bg-blue-400'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span data-testid="task-event-label" className="text-[var(--fg)] font-medium truncate">
                            {taskEventLabel(e)}
                          </span>
                          {e.from_status && (
                            <span className="text-[var(--fg-dim)] shrink-0">
                              {e.from_status} → {e.to_status}
                            </span>
                          )}
                          {e.actor && (
                            <span data-testid="task-event-actor" className="text-[var(--fg-muted)] truncate">
                              by {e.actor}
                            </span>
                          )}
                        </div>
                        {e.detail && (
                          <div data-testid="task-event-detail" className="mt-0.5 text-[11px] text-[var(--fg-muted)] break-words">
                            {e.detail}
                          </div>
                        )}
                        {isDeliveryStaleObservation(e) && (
                          <div data-testid="task-event-stale-context" className="mt-0.5 text-[10px] text-amber-500/80 break-words">
                            Informational delivery observation; tasks that do not require a reply may also appear here.
                          </div>
                        )}
                      </div>
                      <span className="text-[var(--fg-dim)] ml-auto shrink-0" title={e.created_at}>
                        {timeAgo(e.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {(task.status === 'failed' || task.status === 'expired') && (
              <div>
                <button
                  onClick={doRetry}
                  disabled={retrying}
                  data-testid="task-detail-retry"
                  className="text-xs text-orange-400 hover:text-orange-300 px-3 py-1.5 rounded-md border border-orange-500/30 hover:bg-orange-500/10 disabled:opacity-50 disabled:cursor-wait"
                >
                  {retrying ? 'Retrying…' : 'Retry task'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
