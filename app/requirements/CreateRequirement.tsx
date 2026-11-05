'use client';

import { useEffect, useRef, useState } from 'react';
import { projectOptions, type RequirementProject } from '../lib/requirement-projects';

const PRIORITIES = [
  { key: 'normal', label: '普通' },
  { key: 'high', label: '高' },
  { key: 'low', label: '低' },
  { key: 'lowest', label: '极低' },
] as const;
const COLUMNS = [
  { key: 'pool', label: '需求池' },
  { key: 'doing', label: '进行中' },
  { key: 'done', label: '完成' },
] as const;

/**
 * Create one requirement from the board/list. Hub remains the authority for
 * name length, enums, project membership and permissions; this dialog only
 * shapes the request and names the network explicitly.
 */
export function CreateRequirement({ networkId, onCreated }: {
  networkId: string;
  onCreated: (seq?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [priority, setPriority] = useState<string>('normal');
  const [column, setColumn] = useState<string>('pool');
  const [project, setProject] = useState('');
  const [tags, setTags] = useState('');
  const [due, setDue] = useState('');
  const [description, setDescription] = useState('');
  const [projects, setProjects] = useState<RequirementProject[] | null>(null);
  const [projectError, setProjectError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  useEffect(() => {
    if (!open || projects !== null) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/hub/requirements/projects?network_id=${encodeURIComponent(networkId)}`, { cache: 'no-store' });
        if (!res.ok) { if (alive) setProjectError(`项目目录读取失败（${res.status}），可先不选项目`); return; }
        const data = await res.json();
        if (alive) setProjects(Array.isArray(data.projects) ? data.projects : []);
      } catch {
        if (alive) setProjectError('项目目录读取失败，可先不选项目');
      }
    })();
    return () => { alive = false; };
  }, [open, projects, networkId]);

  const reset = () => {
    setName(''); setPriority('normal'); setColumn('pool'); setProject('');
    setTags(''); setDue(''); setDescription(''); setError('');
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setError('名称不能为空'); nameRef.current?.focus(); return; }
    if (trimmed.length > 80) { setError('名称不能超过 80 个字符'); return; }
    setBusy(true); setError('');
    try {
      const tagList = tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean).slice(0, 10);
      const res = await fetch(`/api/hub/requirements?network_id=${encodeURIComponent(networkId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed, priority, column,
          ...(project ? { project_id: project } : {}),
          ...(tagList.length ? { tags: tagList } : {}),
          ...(due ? { due } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        setError(data?.message || data?.error || `创建失败（${res.status}）`);
        return;
      }
      setOpen(false);
      reset();
      onCreated(data?.requirement?.seq);
    } catch {
      setError('创建失败：网络错误，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid="requirements-create-open"
        onClick={() => { setOpen(true); setError(''); }}
        className="rounded-md bg-[var(--hl)] px-2.5 py-1.5 text-xs font-medium text-[var(--bg)] transition-opacity hover:opacity-90"
      >
        新建需求
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--bg)]/70 p-4 sm:items-center" onClick={() => { if (!busy) setOpen(false); }}>
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="新建需求"
            data-testid="requirements-create-dialog"
            onClick={event => event.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--fg)] shadow-xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">新建需求</h2>
              <button type="button" aria-label="关闭新建需求" onClick={() => { if (!busy) setOpen(false); }} className="rounded px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]">✕</button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--fg-muted)]">名称</span>
                <input
                  ref={nameRef}
                  value={name}
                  maxLength={80}
                  onChange={event => setName(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(); }}
                  aria-label="名称"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--fg)] focus:border-[var(--border-hover)] focus:outline-none"
                />
                <span className="mt-1 block text-[10px] text-[var(--fg-dim)]">{name.length}/80 · Hub 仍会校验</span>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--fg-muted)]">优先级</span>
                  <select aria-label="优先级" value={priority} onChange={event => setPriority(event.target.value)}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--fg)]">
                    {PRIORITIES.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--fg-muted)]">状态</span>
                  <select aria-label="状态" value={column} onChange={event => setColumn(event.target.value)}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--fg)]">
                    {COLUMNS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--fg-muted)]">项目</span>
                <select aria-label="项目" value={project} onChange={event => setProject(event.target.value)}
                  disabled={projects === null}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--fg)] disabled:opacity-60">
                  <option value="">不选项目</option>
                  {projects && projectOptions(projects).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                {projectError && <span role="status" className="mt-1 block text-[10px] text-[var(--warning)]">{projectError}</span>}
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--fg-muted)]">标签（逗号分隔，最多 10 个）</span>
                <input value={tags} onChange={event => setTags(event.target.value)} aria-label="标签"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--fg)]" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--fg-muted)]">截止日期（可选）</span>
                <input type="date" value={due} onChange={event => setDue(event.target.value)} aria-label="截止日期"
                  data-testid="requirements-create-due"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--fg)]" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--fg-muted)]">描述（可选）</span>
                <textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} aria-label="描述"
                  className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--fg)]" />
              </label>
              {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button type="button" onClick={() => { if (!busy) setOpen(false); }} className="rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]">取消</button>
                <button type="button" onClick={() => void submit()} disabled={busy} data-testid="requirements-create-submit"
                  className="rounded-md bg-[var(--hl)] px-3 py-1.5 text-xs font-medium text-[var(--bg)] disabled:opacity-60">
                  {busy ? '创建中…' : '创建'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
