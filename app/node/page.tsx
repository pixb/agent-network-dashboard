'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';
import { TaskChatPanel } from '../components/TaskChatPanel';
import { timeAgo } from '../components/utils';
import { NodeDetailHeader } from '../components/NodeDetailHeader';
import { useChatUnread, badgeLabel } from '../lib/chat-unread';

interface SessionDetail {
  resume_id: string;
  network_id?: string;
  alias: string;
  status: string;
  agent: string;
  server: string;
  hostname: string;
  task: string;
  output: string;
  progress: number;
  score: number;
  registered_at: string;
  updated_at: string;
  project_dir: string;
  tmux_name: string;
  ip: string;
  node_id: string;
  session_id: string;
  config_path: string;
  channels: string[];
  last_seen_at: string;
  model: string;
  version: string;
  external_schedules?: ExternalSchedulesSnapshot | null;
}

interface ExternalSchedule {
  id: string;
  name: string;
  kind: 'cron' | 'systemd' | 'tmux' | 'playwright' | 'custom';
  frequency: string;
  last_run_at: string | null;
  last_status: 'success' | 'failed' | 'running' | 'unknown';
  last_error: string | null;
  next_run_at: string | null;
  log_ref: string | null;
  enabled: boolean;
  editable?: boolean;
  revision?: number;
}

interface ExternalSchedulesSnapshot {
  observed_at: string;
  schedules: ExternalSchedule[];
  error?: 'invalid_manifest' | 'unsafe_manifest' | 'read_failed';
}

interface Message {
  id: string;
  content: string;
  from_session: string;
  priority: string;
  created_at: string;
  type: string;
}

function TmuxViewer({ tmuxName }: { tmuxName: string }) {
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fetchTmux = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/hub/tmux?name=${encodeURIComponent(tmuxName)}`);
      const data = await res.json();
      setOutput(data.output || data.error || 'No output');
    } catch { setOutput('Failed to fetch'); }
    setLoading(false);
  };

  return (
    <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-300">Terminal ({tmuxName})</h2>
        <div className="flex gap-2">
          <button onClick={fetchTmux} disabled={loading}
            className="text-xs text-[var(--accent-text)] hover:opacity-80 disabled:text-[var(--fg-dim)]">
            {loading ? 'Loading...' : 'Capture'}
          </button>
          {output && (
            <button onClick={() => setExpanded(!expanded)} className="text-xs text-gray-500 hover:text-gray-300">
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </div>
      </div>
      {output && (
        <pre className={`text-[11px] text-green-300 bg-[var(--code-bg)] rounded-lg px-3 py-2 overflow-x-auto whitespace-pre font-mono ${expanded ? 'max-h-96' : 'max-h-32'} overflow-y-auto`}>
          {output}
        </pre>
      )}
      {!output && <p className="text-xs text-gray-600">Click Capture to view terminal output</p>}
    </div>
  );
}

function ExternalSchedulesCard({ snapshot, nodeId, onQueued }: {
  snapshot: ExternalSchedulesSnapshot | null | undefined;
  nodeId?: string;
  onQueued?: () => void;
}) {
  const [editing, setEditing] = useState<ExternalSchedule | null>(null);
  const [cron, setCron] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [editNotice, setEditNotice] = useState('');
  if (snapshot === undefined || snapshot === null) return null;
  const reportedAgo = timeAgo(snapshot.observed_at);
  const age = /^(\d+)([smhd]) ago$/.exec(reportedAgo);
  const stale = reportedAgo === '--' || Boolean(age && (age[2] === 'h' || age[2] === 'd' || (age[2] === 'm' && Number(age[1]) >= 2)));
  const openEdit = (schedule: ExternalSchedule) => {
    setEditing(schedule);
    setCron(schedule.frequency);
    setEnabled(schedule.enabled);
    setEditError('');
    setEditNotice('');
  };
  const submitEdit = async () => {
    if (!editing || !nodeId || !Number.isSafeInteger(editing.revision)) return;
    setSaving(true);
    setEditError('');
    setEditNotice('');
    try {
      const res = await fetch(`/api/hub/nodes/${encodeURIComponent(nodeId)}/external-schedule-edits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule_id: editing.id,
          base_revision: editing.revision,
          patch: { cron: cron.trim(), enabled },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEditing(null);
      setEditNotice('Edit queued for this node. Waiting for its authenticated apply acknowledgement.');
      onQueued?.();
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : 'edit_failed';
      setEditError(code === 'revision_conflict' ? 'Schedule changed since this report. Refresh and try again.' : code);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="bg-[var(--bg-secondary)] rounded-xl p-4" data-testid="external-schedules-card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-300">External schedules</h2>
        <span className={`text-[10px] ${stale ? 'text-amber-400' : 'text-gray-600'}`} title={snapshot.observed_at}>
          {stale ? 'stale report' : 'reported'} {reportedAgo}
        </span>
      </div>
      {snapshot.error && (
        <div className="mb-3 rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          Node could not read a safe external-schedules manifest ({snapshot.error}).
        </div>
      )}
      {snapshot.schedules.length === 0 && !snapshot.error ? (
        <p className="text-xs text-gray-600">No external schedules reported by this node.</p>
      ) : (
        <div className="space-y-2">
          {snapshot.schedules.map((schedule) => (
            <div key={schedule.id} className="rounded-lg bg-[var(--col-inset)] px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-300" title={schedule.name}>{schedule.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                  schedule.last_status === 'failed' ? 'bg-red-950/50 text-red-300' :
                  schedule.last_status === 'running' ? 'bg-blue-950/50 text-blue-300' :
                  schedule.last_status === 'success' ? 'bg-emerald-950/50 text-emerald-300' :
                  'bg-gray-800 text-gray-400'
                }`}>{schedule.last_status}</span>
                {!schedule.enabled && <span className="text-[10px] text-gray-600">disabled</span>}
                {schedule.editable === true && Number.isSafeInteger(schedule.revision) && nodeId && (
                  <button
                    type="button"
                    disabled={stale}
                    onClick={() => openEdit(schedule)}
                    className="rounded border border-[var(--accent)]/40 px-2 py-0.5 text-[10px] text-[var(--accent-text)] disabled:cursor-not-allowed disabled:opacity-40"
                    title={stale ? 'Wait for a fresh node report before editing' : 'Edit timing and enabled state'}
                  >Edit</button>
                )}
              </div>
              <div className="mt-1 text-[10px] text-gray-500">
                {schedule.kind} · {schedule.frequency}
                {schedule.next_run_at ? ` · next ${timeAgo(schedule.next_run_at)}` : ''}
              </div>
              {schedule.last_error && <div className="mt-1 text-[10px] text-red-300 break-words">{schedule.last_error}</div>}
              {schedule.log_ref && <div className="mt-1 text-[10px] text-gray-600">log: {schedule.log_ref}</div>}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <div className="mt-3 rounded-lg border border-cyan-900/60 bg-cyan-950/10 p-3" data-testid="external-schedule-editor">
          <div className="text-xs font-medium text-gray-300">Edit {editing.name}</div>
          <p className="mt-1 text-[10px] text-gray-500">Only five-field cron timing and enabled state can change. The command is immutable.</p>
          <label className="mt-3 block text-[10px] text-gray-500">Five-field cron
            <input value={cron} onChange={(event) => setCron(event.target.value)} maxLength={120}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--col-inset)] px-2 py-1.5 font-mono text-xs text-gray-200" />
          </label>
          <label className="mt-2 flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className="rounded px-3 py-1 text-xs text-gray-400">Cancel</button>
            <button type="button" disabled={saving || cron.trim().length < 5} onClick={submitEdit}
              className="rounded bg-cyan-700 px-3 py-1 text-xs text-white disabled:opacity-40">{saving ? 'Queueing…' : 'Queue edit'}</button>
          </div>
        </div>
      )}
      {editError && <p className="mt-2 text-xs text-red-300" role="alert">{editError}</p>}
      {editNotice && <p className="mt-2 text-xs text-emerald-300" role="status">{editNotice}</p>}
      <p className="mt-3 text-[10px] text-gray-600">Reported by the node; Agent Network does not execute or verify these schedules.</p>
    </div>
  );
}

function NodeDetailContent() {
  const searchParams = useSearchParams();
  const alias = searchParams.get('alias') || '';
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [inbox, setInbox] = useState<Message[]>([]);
  const [sse, setSse] = useState(0);
  const [error, setError] = useState('');
  const [sendMsg, setSendMsg] = useState('');
  const [sending, setSending] = useState(false);

  const fetchData = useCallback(async () => {
    if (!alias) return;
    try {
      const res = await fetch(`/api/hub/session?alias=${encodeURIComponent(alias)}`);
      const data = await res.json();
      if (data.session) setSession(data.session);
      if (data.inbox) setInbox(data.inbox);
      setSse(data.sse || 0);
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    }
  }, [alias]);

  useEffect(() => {
    // Initial fetch kick-off + poll; state lands async after the fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const [sendError, setSendError] = useState('');

  const sendTask = async () => {
    if (!sendMsg.trim() || !alias) return;
    setSending(true);
    setSendError('');
    try {
      const res = await fetch('/api/hub/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias, task: sendMsg,
          // P0 network_id fix: scope to the node's own network.
          ...(session?.network_id ? { network_id: session.network_id } : {}),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSendMsg('');
        setTimeout(fetchData, 2000);
      } else {
        setSendError(data.error || 'Send failed');
      }
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : 'Send failed');
    }
    setSending(false);
  };

  if (!alias) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)] p-6 flex items-center justify-center">
        <p className="text-[var(--fg-muted)]">No alias specified. <Link href="/" className="text-[var(--accent-text)] hover:underline">Back to dashboard</Link></p>
      </div>
    );
  }

  const headerSession = session?.alias === alias ? session : null;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)] p-4 sm:p-6">
      <NodeDetailHeader key={alias} alias={alias} session={headerSession} sse={headerSession ? sse : 0} />

      {error && (
        <div className="bg-red-900/20 border border-red-800/40 text-red-300 px-4 py-2 rounded-lg mb-6 text-sm">{error}</div>
      )}

      {/* Full-width tabbed layout */}
      <NodeFullPanel alias={alias} session={session} sse={sse} sendMsg={sendMsg} setSendMsg={setSendMsg} sending={sending} sendTask={sendTask} sendError={sendError} />
    </div>
  );
}

function NodeFullPanel({ alias, session, sse, sendMsg, setSendMsg, sending, sendTask, sendError }: {
  alias: string; session: SessionDetail | null; sse: number; sendMsg: string; setSendMsg: (v: string) => void; sending: boolean; sendTask: () => void; sendError: string;
}) {
  const [tab, setTab] = useState<'chat' | 'events' | 'info'>('chat');
  const { hasUnread, unreadCount } = useChatUnread();
  // 面板高度按「视口底部还剩多少」实测，而不是写死 calc(100vh - 140px)：
  // 页头在 390 宽会换行变高，写死的减法算不准，输入区的语音按钮会被切在
  // 折线下方 11px。外壳（AppShell）根是 min-h、HealthBanner 在流内，文档
  // 本来就比视口高，所以只量 rect.top（视口坐标），滚动时重测——
  // 与 NodesView 的 #Stage D 同一套做法。
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    // 必须用「文档坐标」而不是视口坐标：外壳的文档本来就比视口高（横幅 + 底部留白），
    // 若按 rect.top 算高度，每次滚动都会把面板撑高、文档再变高，形成自激增长
    // （实测 981→1077→1173，滚动多少次涨多少次）。
    const apply = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(240, window.innerHeight - top)}px`;
    };
    apply();
    window.addEventListener('resize', apply);
    const ro = new ResizeObserver(apply);
    ro.observe(document.body);
    return () => {
      window.removeEventListener('resize', apply);
      ro.disconnect();
    };
  }, []);
  const [events, setEvents] = useState<Array<{ id: number; event_type: string; from_status: string; to_status: string; detail: string; created_at: string }>>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const chatUnread = hasUnread(alias);

  useEffect(() => {
    if (tab === 'events' && !eventsLoaded) {
      fetch('/api/hub/task-events?limit=50').then(r => r.json()).then(d => {
        setEvents(d.events || []);
        setEventsLoaded(true);
      }).catch(() => setEventsLoaded(true));
    }
  }, [tab, eventsLoaded]);

  return (
    <div ref={panelRef} data-testid="node-chat-panel" className="bg-[var(--bg-secondary)] rounded-xl overflow-hidden h-[calc(100dvh-9rem)] flex flex-col">
      {/* Tab bar — round 40: emoji icons (💬 📋 📊) replaced with stroke
          SVG to drop the "AI generated" tell. */}
      <div className="flex border-b border-[var(--col-line)] bg-[var(--bg)] shrink-0">
        {([
          { id: 'chat',   label: 'Chat',   icon: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' },
          { id: 'events', label: 'Events', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8' },
          { id: 'info',   label: 'Info',   icon: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 8h.01 M11 12h1v4h1' },
        ] as const).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id ? 'border-[var(--accent)] text-[var(--accent-text)]' : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]'
            }`}>
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={t.icon} />
            </svg>
            <span className="relative inline-flex items-center gap-2">
              {t.label}
              {t.id === 'chat' && chatUnread && tab !== 'chat' && (
                // 数字而不是光点：不切到 Chat 也知道积了几条。
                <span
                  data-testid="node-chat-unread"
                  className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-[18px] text-white tabular-nums"
                  aria-label={`${unreadCount(alias)} 条未读消息`}
                >
                  {badgeLabel(unreadCount(alias))}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'chat' && (
          <TaskChatPanel alias={alias} onClose={() => {}} inline autoFocus={false} />
        )}

        {tab === 'events' && (
          <EventsTimeline events={events} loading={!eventsLoaded} />
        )}

        {tab === 'info' && (
          <div className="p-4 overflow-y-auto h-full space-y-4 max-w-2xl">
            <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-3">Node Info</h2>
            <div className="space-y-2 text-xs">
              {[
                { label: 'Node ID', value: session?.node_id, alwaysShow: true },
                { label: 'Session ID', value: session?.session_id, alwaysShow: true },
                { label: 'Resume ID', value: session?.resume_id, alwaysShow: true },
                { label: 'Alias', value: session?.alias, alwaysShow: true },
                { label: 'Agent', value: session?.agent, alwaysShow: true },
                { label: 'Model', value: session?.model, alwaysShow: true },
                { label: 'Version', value: session?.version },
                { label: 'Server', value: session?.server, alwaysShow: true },
                { label: 'Hostname', value: session?.hostname, alwaysShow: true },
                { label: 'IP', value: session?.ip, alwaysShow: true },
                { label: 'Project', value: session?.project_dir },
                { label: 'Config', value: session?.config_path, alwaysShow: true },
                { label: 'Channels', value: session?.channels?.length ? (Array.isArray(session.channels) ? session.channels.join(', ') : session.channels) : null, alwaysShow: true },
                { label: 'Tmux', value: session?.tmux_name },
                { label: 'SSE', value: sse > 0 ? `Connected (${sse})` : 'Disconnected', alwaysShow: true },
                { label: 'Progress', value: session?.progress ? `${session.progress}%` : null },
                { label: 'Score', value: session?.score },
                { label: 'Last Seen', value: session?.last_seen_at, alwaysShow: true },
                { label: 'Registered', value: session?.registered_at, alwaysShow: true },
                { label: 'Updated', value: session?.updated_at, alwaysShow: true },
              ].map(({ label, value, alwaysShow }) => (value || alwaysShow) ? (
                <div key={label} className="flex justify-between gap-3">
                  <span className="text-gray-500 shrink-0">{label}</span>
                  <span className="text-gray-300 truncate max-w-[200px]" title={value ? String(value) : '--'}>
                    {value ? String(value) : '--'}
                  </span>
                </div>
              ) : null)}
            </div>
          </div>

          {/* Current Task */}
          {session?.task && (
            <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-2">Current Task</h2>
              <p className="text-xs text-gray-400 whitespace-pre-wrap">{session.task}</p>
            </div>
          )}

          {/* Output */}
          {session?.output && (
            <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-2">Last Output</h2>
              <p className="text-xs text-gray-400 whitespace-pre-wrap max-h-48 overflow-y-auto">{session.output}</p>
            </div>
          )}

          <ExternalSchedulesCard snapshot={session?.external_schedules} nodeId={session?.node_id} />

          {/* Send Task */}
          <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">Send Task</h2>
            <div className="flex gap-2">
              <input
                type="text"
                value={sendMsg}
                onChange={e => setSendMsg(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendTask()}
                placeholder={`Send task to ${alias}...`}
                className="flex-1 bg-[var(--col-inset)] border border-[var(--border)] rounded px-3 py-2 text-base sm:text-xs text-[var(--fg)] placeholder-[var(--fg-dim)] focus:border-cyan-500/40 focus:outline-none"
              />
              <button
                onClick={sendTask}
                disabled={sending || !sendMsg.trim()}
                className="inline-flex min-h-[44px] items-center justify-center px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-xs rounded transition-colors"
              >
                {sending ? '...' : 'Send'}
              </button>
            </div>
            {sendError && <div className="mt-2 text-xs text-red-400">{sendError}</div>}
          </div>

          {/* Tmux Terminal */}
          {session?.tmux_name && (
            <TmuxViewer tmuxName={session.tmux_name} />
          )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Round 59: emoji icons replaced with stroke SVG paths to drop the
 *  "AI generated" tell. Each path is sized to fit inside the 18px
 *  colored event dot. */
const EVENT_COLORS: Record<string, { dot: string; line: string; path: string }> = {
  delivered: { dot: 'bg-blue-400',   line: 'bg-blue-500/30',   path: 'M12 5v14 M5 12l7 7 7-7' },                   // down arrow
  acked:     { dot: 'bg-yellow-400', line: 'bg-yellow-500/30', path: 'M20 6 9 17l-5-5' },                          // check
  running:   { dot: 'bg-green-400',  line: 'bg-green-500/30',  path: 'M13 2L4 14h6l-1 8 10-12h-6l1-8z' },         // bolt
  replied:   { dot: 'bg-purple-400', line: 'bg-purple-500/30', path: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }, // chat bubble
  failed:    { dot: 'bg-red-400',    line: 'bg-red-500/30',    path: 'M18 6 6 18 M6 6l12 12' },                    // X
  created:   { dot: 'bg-gray-400',   line: 'bg-gray-500/30',   path: 'M12 5v14 M5 12h14' },                       // plus
};

function EventsTimeline({ events, loading }: { events: Array<{ id: number; event_type: string; from_status: string; to_status: string; detail: string; created_at: string; task_id?: string }>; loading: boolean }) {
  if (loading) return <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" /></div>;
  if (events.length === 0) return <div className="text-center py-12 text-gray-600 text-xs">No task events yet</div>;

  // Group by task_id
  const groups = new Map<string, typeof events>();
  events.forEach(e => {
    const key = (e as { task_id?: string }).task_id || `ungrouped-${e.id}`;
    const group = groups.get(key) || [];
    group.push(e);
    groups.set(key, group);
  });

  return (
    <div className="p-4 overflow-y-auto h-full space-y-4">
      {[...groups.entries()].map(([taskId, taskEvents]) => (
        <div key={taskId} className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="text-[10px] text-gray-600 mb-3 truncate">Task: {taskId.slice(0, 20)}...</div>
          <div className="relative pl-6">
            {/* Vertical line */}
            <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-[var(--col-line)]" />

            {taskEvents.map((e, i) => {
              const cfg = EVENT_COLORS[e.to_status] || EVENT_COLORS.created;
              return (
                <div key={e.id} className="relative pb-4 last:pb-0">
                  {/* Dot on line — round 59: emoji icons replaced with
                      a 10px stroke SVG path matching event type. */}
                  <div className={`absolute -left-6 top-0.5 w-[18px] h-[18px] rounded-full ${cfg.dot} flex items-center justify-center z-10 border-2 border-[var(--bg-secondary)]`}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0e0e10" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d={cfg.path} />
                    </svg>
                  </div>
                  {/* Content */}
                  <div className="ml-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium ${e.to_status === 'failed' ? 'text-[var(--danger)]' : e.to_status === 'replied' ? 'text-[var(--accent-text)]' : 'text-[var(--fg)]'}`}>
                        {e.event_type}
                      </span>
                      {e.from_status && (
                        <span className="text-[10px] text-gray-600">{e.from_status} → {e.to_status}</span>
                      )}
                      <span className="text-[10px] text-gray-600 ml-auto">{timeAgo(e.created_at)}</span>
                    </div>
                    {e.detail && (
                      <div className="text-[11px] text-gray-500 mt-0.5 truncate">{e.detail.slice(0, 50)}{e.detail.length > 50 ? '...' : ''}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function NodePage() {
  return (
    <Suspense fallback={
      // #209 R36: same pattern R30 fixed on /tasks — bare "Loading..."
      // string used p-6 (no mobile padding tighten) + no left indent,
      // so the fixed top-3 left-3 mobile hamburger covered the "Loa".
      // Match the loaded layout: p-4 sm:p-6 + lg:ml-0 ml-10 mobile
      // indent on the text. Loading state now visually maps to the
      // populated /node detail page.
      <div className="min-h-screen bg-[#0b0b0d] text-gray-100 p-4 sm:p-6">
        <div className="lg:ml-0 ml-10 text-gray-500 text-sm">Loading…</div>
      </div>
    }>
      <NodeDetailContent />
    </Suspense>
  );
}
