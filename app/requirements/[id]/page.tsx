'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EmptyState } from '../../components/EmptyState';
import CommentMarkdown from '../../components/CommentMarkdown';
import { NetworkRequiredNotice } from '../../components/NetworkRequiredNotice';
import { useNetworkId } from '../../lib/network-context';
import { restoreFocusAfterUnmount } from '../../lib/focus-fallback';
import { peopleOptions, readRequirementPeople, type PersonOption } from '../../lib/requirement-people';
import { TagChip, useRequirementTags } from '../TagFilter';
import { editorTagSuggestions, tagColor } from '../../lib/tag-catalog';
import { priorityLabel, priorityTitle } from '../../lib/requirement-priority';
import { addChecklistItem, checklistPayload, moveChecklistItem, removeChecklistItem, validateChecklist, CHECKLIST_MAX_ITEMS, type ChecklistItem as EditableChecklistItem } from '../../lib/checklist-model';
import { addIssue, issueLabel, issuesFromHub, issuesWire, issueUrl, MAX_REQUIREMENT_ISSUES, type RequirementIssue } from '../../lib/requirement-issues';
import { planHealth, planHealthTone } from '../../lib/requirement-plan-health';

/**
 * One requirement — #1633 (read-only).
 *
 * Shows description, checklist, and the activity timeline. The write
 * surface (status/owner/tags/comments) is #1634 on purpose: the read
 * shape has to be right before anyone can edit against it.
 */

interface Person { kind: 'user' | 'node'; id: string; alias?: string }
interface ChecklistItem { id: string; text: string; done?: boolean }
interface Requirement {
  id: string; seq: number; name: string; column: string; priority: string;
  due?: string; start?: string; tags?: string[];
  owner?: Person | null; agent_owner?: Person | null; participants?: Person[];
  parent_id?: string | null;
  children?: { total: number; done: number };
  description?: string; checklist?: ChecklistItem[];
  createdAt?: string; updatedAt?: string;
  external_ref?: string | null; external_url?: string | null;
  issues?: Array<{ url: string; title?: string }> | null;
  archived?: boolean;
  project_id?: string | null;
}
interface EventRow {
  id: string; kind: string; field?: string | null;
  actor?: Person | null;
  at?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

const COLUMN_CHIP: Record<string, string> = {
  pool: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  doing: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  done: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  abandoned: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
};

const COLUMN_OPTIONS: { key: string; label: string }[] = [
  { key: 'pool', label: '需求池' },
  { key: 'doing', label: '进行中' },
  { key: 'done', label: '完成' },
  { key: 'abandoned', label: '放弃' },
];
const PRIORITY_OPTIONS = ['high', 'normal', 'low', 'lowest'] as const;

function personLabel(p?: Person | null) {
  if (!p) return '—';
  return p.alias || p.id;
}

/** 「3 天前」比 ISO 串更好扫；精确时间放 title。 */
function relativeTime(iso?: string | null) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 60_000) return { text: '刚刚', exact: iso };
  if (diff < 3_600_000) return { text: `${Math.round(diff / 60_000)} 分钟前`, exact: iso };
  if (diff < day) return { text: `${Math.round(diff / 3_600_000)} 小时前`, exact: iso };
  if (diff < 30 * day) return { text: `${Math.round(diff / day)} 天前`, exact: iso };
  return { text: iso.slice(0, 10), exact: iso };
}

function describeEvent(ev: EventRow) {
  if (ev.kind === 'comment') {
    const text = typeof ev.new?.text === 'string' ? ev.new.text : '';
    return { label: 'comment', body: text };
  }
  if (ev.kind === 'created') return { label: 'created', body: '' };
  if (ev.field) {
    const from = ev.old == null ? '—' : typeof ev.old === 'object' ? JSON.stringify(ev.old) : String(ev.old);
    const to = ev.new == null ? '—' : typeof ev.new === 'object' ? JSON.stringify(ev.new) : String(ev.new);
    return { label: ev.field, body: `${from.slice(0, 120)} → ${to.slice(0, 120)}` };
  }
  return { label: ev.kind, body: '' };
}

function RequirementDetailContent({ networkId }: { networkId: string }) {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const searchParams = useSearchParams();
  // 从列表点进来时带上了来路筛选：返回和上一条/下一条都回到同一个筛选视图，
  // 而不是把用户丢回一个干净的列表、让他重新筛一遍。
  const listBack = searchParams.get('from') || '';
  const withBack = (path: string) => (listBack ? `${path}?from=${encodeURIComponent(listBack)}` : path);
  const backHref = listBack ? `/requirements?${listBack}` : '/requirements';
  // 锚点跟着你实际停留的那条走：连续按上一条/下一条之后再返回，
  // 焦点要落在「最后看的那条」，而不是最初点开的那条。
  useEffect(() => {
    if (!listBack || !id) return;
    try {
      sessionStorage.setItem('requirements-return-anchor', JSON.stringify({ rowId: id, query: listBack }));
    } catch { /* 隐私模式下写不了就放弃恢复 */ }
  }, [id, listBack]);
  const [req, setReq] = useState<Requirement | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  // #1634 — write surface. Every mutation goes through Hub's own rules; we
  // only show its error code back to the user instead of failing silently.
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [personChoices, setPersonChoices] = useState<PersonOption[] | null>(null);
  const [peopleError, setPeopleError] = useState('');
  const [peopleAttempt, setPeopleAttempt] = useState(0);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [editingTags, setEditingTags] = useState(false);
  const [tagsDraft, setTagsDraft] = useState('');
  const [editingChecklist, setEditingChecklist] = useState(false);
  const [checklistDraft, setChecklistDraft] = useState<EditableChecklistItem[]>([]);
  const [newItemText, setNewItemText] = useState('');
  const [checklistError, setChecklistError] = useState('');
  const [childRows, setChildRows] = useState<Array<{ id: string; seq: number; name: string; column: string; priority: string }>>([]);
  const [childError, setChildError] = useState('');
  const [childDraft, setChildDraft] = useState('');
  const [childPriority, setChildPriority] = useState('normal');
  const [childBusy, setChildBusy] = useState(false);
  const [ancestors, setAncestors] = useState<Array<{ id: string; seq: number; name: string }>>([]);
  const [copied, setCopied] = useState(false);
  // issues 的可写副本：Hub 给的数据读不懂时保持 null，只读展示，不提供编辑。
  const [issues, setIssues] = useState<RequirementIssue[] | null>([]);
  const [issueDraft, setIssueDraft] = useState('');
  const [issueError, setIssueError] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string; archived?: boolean }> | null>(null);
  const [projectError, setProjectError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [parentQuery, setParentQuery] = useState('');
  const [parentResults, setParentResults] = useState<Array<{ id: string; seq: number; name: string; column: string; priority: string }>>([]);
  const [parentBusy, setParentBusy] = useState(false);
  const [parentError, setParentError] = useState('');
  const [editError, setEditError] = useState('');

  const retryRouter = useRouter();
  // 上一条 / 下一条：用列表页最近一次的筛选条件取同一份列表，在当前条目
  // 前后各取一个。为什么不用「seq ± 1」：筛选后 seq 不连续，跨过筛选条件
  // 会把人带到一条本来看不到的需求上。
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const [navIds, setNavIds] = useState<{ prev: string | null; next: string | null }>({ prev: null, next: null });
  const [navScope, setNavScope] = useState<{ prev: string; next: string } | null>(null);
  useEffect(() => {
    if (!id || !networkId) return;
    let cancelled = false;
    (async () => {
      let stored = '';
      try { stored = window.sessionStorage.getItem('anet_req_list_query') || ''; } catch {}
      const params = new URLSearchParams(stored);
      params.set('network_id', networkId);
      params.set('limit', '200');
      const res = await fetch(`/api/hub/requirements?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const rows = (data.requirements || []) as Array<{ id?: string; seq?: number; name?: string }>;
      const idx = rows.findIndex(r => r.id === id);
      if (cancelled || idx < 0) return;
      const pick = (r?: { id?: string; seq?: number; name?: string }) => (r && r.id ? `${r.seq ? `#${r.seq} ` : ''}${(r.name || '').slice(0, 24)}` : '');
      setNavIds({ prev: rows[idx - 1]?.id ?? null, next: rows[idx + 1]?.id ?? null });
      setNavScope({ prev: pick(rows[idx - 1]), next: pick(rows[idx + 1]) });
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [id, networkId, reloadKey]);

  // j / → 下一条，k / ← 上一条。焦点在输入框、或开着对话框时不抢键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return;
      // c：跳到评论框。评论是这个页面最常写的输入，鼠标点一次、回车发送都顺手，
      // 只有「找到输入框」还得用鼠标。
      if (e.key === 'c' || e.key === 'C') {
        if (!e.shiftKey) { e.preventDefault(); commentRef.current?.focus(); return; }
      }
      const forward = e.key === 'j' || e.key === 'ArrowRight';
      const backward = e.key === 'k' || e.key === 'ArrowLeft';
      if (!forward && !backward) return;
      const target = forward ? navIds.next : navIds.prev;
      if (!target) return;
      e.preventDefault();
      retryRouter.push(`/requirements/${encodeURIComponent(target)}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navIds, retryRouter]);

  const reload = () => setReloadKey(k => k + 1);
  // Every read and write names the selected network: a user token can belong to
  // several networks and Hub then refuses to guess.
  const scope = `network_id=${encodeURIComponent(networkId)}`;
  const { catalog: tagCatalog } = useRequirementTags(networkId);

  useEffect(() => {
    let alive = true;
    setPeopleError('');
    (async () => {
      try {
        const res = await fetch(`/api/hub/requirements/people?${scope}`, { cache: 'no-store' });
        if (!res.ok) {
          if (alive) setPeopleError(res.status === 401 ? '人员目录登录已过期' : `人员目录读取失败（${res.status}）`);
          return;
        }
        const choices = peopleOptions(readRequirementPeople(await res.json()));
        if (alive) setPersonChoices(choices);
      } catch {
        if (alive) setPeopleError('人员目录读取失败，请重试');
      }
    })();
    return () => { alive = false; };
  }, [scope, peopleAttempt]);

  async function sendPatch(fields: Record<string, unknown>): Promise<boolean> {
    if (!id || busy) return false;
    setBusy(true); setActionError('');
    try {
      const res = await fetch(`/api/hub/requirements/${encodeURIComponent(id)}?${scope}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) { setActionError(data?.message || data?.error || `hub_${res.status}`); return false; }
      reload();
      return true;
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'patch failed');
      return false;
    } finally { setBusy(false); }
  }

  async function toggleItem(itemId: string, done: boolean) {
    if (!id || busy) return;
    setBusy(true); setActionError('');
    try {
      const res = await fetch(`/api/hub/requirements/${encodeURIComponent(id)}/checklist/${encodeURIComponent(itemId)}?${scope}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) { setActionError(data?.error || `hub_${res.status}`); return; }
      reload();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'checklist failed');
    } finally { setBusy(false); }
  }

  async function changeParticipants(next: Person[]) {
    await sendPatch({ participants: next });
  }

  // 「更早的评论」的可达性：追加后播报条数；拉到末尾按钮消失时把焦点收回动态列表。
  const [eventsNotice, setEventsNotice] = useState('');
  const eventsEndRef = useRef<HTMLDivElement | null>(null);
  // 归档/恢复会切换按钮与横幅（一侧卸载、另一侧出现）：手机/键盘用户点完
  // 不该把焦点丢在 body 上。归档 → 焦点给横幅，恢复 → 焦点给「归档」按钮。
  const archivedBannerRef = useRef<HTMLParagraphElement | null>(null);
  const archiveButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasArchived = useRef<boolean | null>(null);
  useEffect(() => {
    const archived = req?.archived === true;
    if (wasArchived.current !== null && wasArchived.current !== archived) {
      restoreFocusAfterUnmount(() => (archived ? archivedBannerRef.current : archiveButtonRef.current));
    }
    wasArchived.current = archived;
  }, [req?.archived]);

  async function loadOlderEvents() {
    if (!id || olderBusy || !eventCursor) return;
    setOlderBusy(true);
    setActionError('');
    try {
      const res = await fetch(`/api/hub/requirements/events?requirement_id=${encodeURIComponent(id)}&limit=50&cursor=${encodeURIComponent(eventCursor)}&${scope}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) { setActionError(data?.message || data?.error || `hub_${res.status}`); return; }
      const older = (data.events || []) as EventRow[];
      setEvents(prev => {
        const seen = new Set(prev.map(item => item.id));
        return [...prev, ...older.filter(item => !seen.has(item.id))];
      });
      const nextCursor = typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
      setEventCursor(nextCursor);
      setEventsNotice(`又加载 ${older.length} 条动态${nextCursor ? '' : '，已到最早'}`);
      // 按钮刚被卸载：焦点别掉到 body（判定与需求列表共用一处实现）。
      if (!nextCursor) restoreFocusAfterUnmount(() => eventsEndRef.current);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'events failed');
    } finally { setOlderBusy(false); }
  }

  async function saveName() {
    const next = nameDraft.trim();
    if (!next) { setNameError('名称不能为空'); return; }
    if (next.length > 80) { setNameError('名称不能超过 80 个字符'); return; }
    if (next === req?.name) { setRenaming(false); return; }
    const ok = await sendPatch({ name: next });
    if (ok) { setRenaming(false); setNameError(''); }
    else setNameError('保存失败，见上方提示');
  }

  async function saveIssues(next: RequirementIssue[]) {
    const ok = await sendPatch({ issues: issuesWire(next) });
    if (ok) setIssues(next);
    return ok;
  }

  function addIssueRow() {
    if (issues === null) return;
    const result = addIssue(issues, issueDraft);
    if (!result.ok) { setIssueError(result.error); return; }
    setIssueError('');
    void saveIssues(result.issues).then(ok => { if (ok) setIssueDraft(''); });
  }

  function removeIssueRow(label: string) {
    if (issues === null) return;
    setIssueError('');
    void saveIssues(issues.filter(item => issueLabel(item) !== label));
  }

  function startChecklistEdit() {
    setChecklistDraft((req?.checklist || []).map(item => ({ id: item.id, text: item.text, done: item.done === true })));
    setNewItemText('');
    setChecklistError('');
    setEditingChecklist(true);
  }

  function addChecklistRow() {
    const next = addChecklistItem(checklistDraft, newItemText);
    if (!next) {
      setChecklistError(checklistDraft.length >= CHECKLIST_MAX_ITEMS ? `检查项最多 ${CHECKLIST_MAX_ITEMS} 个` : '检查项不能为空，且不超过 500 字');
      return;
    }
    setChecklistDraft(next);
    setNewItemText('');
    setChecklistError('');
  }

  async function saveChecklist() {
    const invalid = validateChecklist(checklistDraft);
    if (invalid) { setChecklistError(invalid); return; }
    if (await sendPatch({ checklist: checklistPayload(checklistDraft) })) setEditingChecklist(false);
  }

  async function saveDescription() {
    setEditError('');
    if (descriptionDraft.length > 20_000) { setEditError('描述不能超过 20000 个字符'); return; }
    if (await sendPatch({ description: descriptionDraft })) setEditingDescription(false);
  }

  function parseTags(draft: string): string[] | null {
    const tags = [...new Set(draft.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))];
    if (tags.length > 10) { setEditError('最多 10 个标签'); return null; }
    if (tags.some(tag => tag.length > 20)) { setEditError('单个标签不能超过 20 个字符'); return null; }
    return tags;
  }

  async function saveTags() {
    setEditError('');
    const tags = parseTags(tagsDraft);
    if (!tags) return;
    if (await sendPatch({ tags })) setEditingTags(false);
  }

  async function submitComment() {
    if (!id || busy || !comment.trim()) return;
    setBusy(true); setActionError('');
    try {
      const res = await fetch(`/api/hub/requirements/${encodeURIComponent(id)}/comments?${scope}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: comment.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) { setActionError(data?.error || `hub_${res.status}`); return; }
      setComment('');
      reload();
      // 连续写第二条时不用再点一次：等一帧让 React 更新完 value 再聚焦。
      requestAnimationFrame(() => commentRef.current?.focus());
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'comment failed');
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const [detailRes, eventsRes] = await Promise.all([
          fetch(`/api/hub/requirements/${encodeURIComponent(id)}?${scope}`, { cache: 'no-store' }),
          fetch(`/api/hub/requirements/events?requirement_id=${encodeURIComponent(id)}&limit=50&${scope}`, { cache: 'no-store' }),
        ]);
        if (detailRes.status === 401) { if (alive) { setNeedsLogin(true); } return; }
        const detail = await detailRes.json();
        if (!detailRes.ok || !detail.ok) { if (alive) setError(detail?.error || `hub_${detailRes.status}`); return; }
        const eventsJson = eventsRes.ok ? await eventsRes.json() : { events: [] };
        if (!alive) return;
        setReq(detail.requirement as Requirement);
        // 读不懂就置 null：宁可显示「不支持」也不给一个会清空原始数据的编辑器。
        setIssues(issuesFromHub((detail.requirement as Requirement).issues) ?? null);
        setEvents((eventsJson.events || []) as EventRow[]);
        setEventCursor(typeof eventsJson.next_cursor === 'string' && eventsJson.next_cursor ? eventsJson.next_cursor : null);
      } catch (e: unknown) {
        if (alive) setError(e instanceof Error ? e.message : 'fetch failed');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id, scope, reloadKey]);

  // 项目目录：只用于「项目」下拉；读不到时不影响其它编辑，只是这一项不可选。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/hub/requirements/projects?network_id=${encodeURIComponent(networkId || '')}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok || data.ok === false) { setProjectError(`项目目录读取失败（${res.status}）`); return; }
        setProjects(Array.isArray(data.projects) ? data.projects : []);
      } catch {
        if (alive) setProjectError('项目目录读取失败');
      }
    })();
    return () => { alive = false; };
  }, [networkId]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/hub/requirements?${scope}&parent_id=${encodeURIComponent(id)}&view=summary&limit=100`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok || data.ok === false) {
          setChildRows([]);
          setChildError(data?.message || data?.error || `hub_${res.status}`);
          return;
        }
        setChildError('');
        setChildRows((data.requirements || []) as Array<{ id: string; seq: number; name: string; column: string; priority: string }>);
      } catch {
        if (alive) { setChildRows([]); setChildError('子需求读取失败，请重试'); }
      }
    })();
    return () => { alive = false; };
  }, [id, scope, reloadKey]);

  // 上级链（最多 3 层）：只用已有详情接口逐级读，成环/失败就停，绝不假装有上级。
  useEffect(() => {
    const parentId = (req as { parent_id?: string | null } | null)?.parent_id;
    if (!parentId) { setAncestors([]); return; }
    let alive = true;
    (async () => {
      const chain: Array<{ id: string; seq: number; name: string }> = [];
      const seen = new Set<string>([id || '']);
      let cursor: string | null = parentId;
      for (let depth = 0; depth < 3 && cursor && !seen.has(cursor); depth++) {
        seen.add(cursor);
        try {
          const res = await fetch(`/api/hub/requirements/${encodeURIComponent(cursor)}?${scope}`, { cache: 'no-store' });
          if (!res.ok) break;
          const data = await res.json();
          if (!data?.ok || !data.requirement) break;
          const row = data.requirement as { id: string; seq: number; name: string; parent_id?: string | null };
          chain.push({ id: row.id, seq: row.seq, name: row.name });
          cursor = row.parent_id ?? null;
        } catch {
          break;
        }
      }
      if (alive) setAncestors(chain);
    })();
    return () => { alive = false; };
  }, [id, scope, reloadKey, req]);

  async function searchParents() {
    const q = parentQuery.trim();
    if (!q) { setParentError('先输入关键词再搜索'); return; }
    setParentBusy(true);
    setParentError('');
    try {
      const res = await fetch(`/api/hub/requirements?${scope}&q=${encodeURIComponent(q)}&view=summary&limit=20`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) { setParentError(data?.message || data?.error || `hub_${res.status}`); return; }
      // 自己不能当自己的上级：其余交给 Hub 的层级/成环校验。
      setParentResults(((data.requirements || []) as Array<{ id: string; seq: number; name: string; column: string; priority: string }>)
        .filter(row => row.id !== id));
    } catch {
      setParentError('搜索失败，请重试');
    } finally {
      setParentBusy(false);
    }
  }

  async function moveUnder(parentId: string | null) {
    if (parentBusy) return;
    setParentBusy(true);
    setParentError('');
    try {
      if (await sendPatch({ parent_id: parentId })) {
        setParentPickerOpen(false);
        setParentResults([]);
        setParentQuery('');
        reload();
      }
    } finally {
      setParentBusy(false);
    }
  }

  async function createChild() {
    if (!id || childBusy) return;
    const name = childDraft.trim();
    if (!name) { setChildError('子需求需要一个标题'); return; }
    setChildBusy(true);
    setChildError('');
    try {
      const res = await fetch(`/api/hub/requirements?${scope}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, priority: childPriority, parent_id: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        setChildError(data?.message || data?.error || `hub_${res.status}`);
        return;
      }
      setChildDraft('');
      reload();
    } catch {
      setChildError('网络异常，子需求未创建');
    } finally {
      setChildBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] p-6 text-gray-500">
        <div className="mx-auto max-w-4xl space-y-3">
          <div className="h-6 w-2/3 animate-pulse rounded bg-[var(--bg-elevated)]" />
          <div className="h-40 animate-pulse rounded bg-[var(--bg-secondary)]" />
        </div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="min-h-screen bg-[var(--bg)] p-6">
        <div className="mx-auto max-w-4xl rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          会话已过期，<Link href="/login" className="underline">重新登录</Link>。
        </div>
      </div>
    );
  }

  if (error || !req) {
    return (
      <div className="min-h-screen bg-[var(--bg)] p-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
            {error ? `读取失败：${error}` : '这条需求不存在或不可见。'}
          </div>
          <Link href={backHref} className="text-sm text-blue-400 hover:underline" data-testid="requirement-back">← 返回需求列表</Link>
        </div>
      </div>
    );
  }

  const checklist = req.checklist || [];
  const personValue = (person?: Person | null) => (person ? `${person.kind}:${person.id}` : '');
  const optionLabel = (value: string) => personChoices?.find(choice => choice.value === value)?.label ?? value;
  const ownerValue = personValue(req.owner);
  const agentValue = personValue(req.agent_owner);
  const directoryReady = personChoices !== null;

  return (
    <div data-detail-root className="min-h-screen bg-[var(--bg)] text-gray-200">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="mb-4">
          <Link href={backHref} className="text-xs text-gray-500 hover:text-gray-300" data-testid="requirement-back">← 需求列表</Link>
        </div>

        <header className="mb-5">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            <span className="tabular-nums">#{req.seq}</span>
            <span className={`rounded border px-1.5 py-0.5 ${COLUMN_CHIP[req.column] || COLUMN_CHIP.abandoned}`}>{req.column}</span>
            <span title={priorityTitle(req.priority)}>{priorityLabel(req.priority)}</span>
            {req.start && <span>start {String(req.start).slice(0, 10)}</span>}
            {req.due && <span>due {String(req.due).slice(0, 10)}</span>}
            {/* 详情页也说同一句话：列表/看板有「还剩几天」，点进来不该反而没了。 */}
            {(() => {
              const plan = planHealth(req.start, req.due, new Date(), req.column === 'done' || req.column === 'abandoned');
              if (!plan) return null;
              return (
                <span data-testid="requirement-plan-health" data-plan-kind={plan.kind} data-this-week={plan.thisWeek ? 'true' : 'false'}
                  className={`rounded px-1.5 py-0.5 tabular-nums ${planHealthTone(plan)}`}>
                  {plan.label}
                </span>
              );
            })()}
            {(req.tags || []).map(name => (
              <TagChip key={name} name={name} color={tagColor(tagCatalog, name)} className="text-gray-400" />
            ))}
          </div>
          {ancestors.length > 0 && (
            <p className="mb-1 flex flex-wrap items-center gap-1 text-[11px] text-gray-500" data-testid="requirement-ancestors">
              上级：
              {ancestors.slice().reverse().map(ancestor => (
                <Link key={ancestor.id} href={`/requirements/${ancestor.id}`} className="underline hover:text-gray-300">
                  #{ancestor.seq} {ancestor.name}
                </Link>
              ))}
            </p>
          )}
          {/* 窄屏必须允许换行：标题块带 min-w-0 会被压到 0 宽，里面的「重命名」
              溢出后直接压在「归档」上（320px 实拍是「重命名档」）。 */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            {renaming ? (
              <div className="min-w-0 flex-1">
                <input
                  aria-label="名称"
                  data-testid="requirement-name-input"
                  value={nameDraft}
                  autoFocus
                  maxLength={120}
                  onChange={event => { setNameDraft(event.target.value); setNameError(''); }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); void saveName(); }
                    if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); setNameError(''); }
                  }}
                  className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-lg font-semibold text-white focus:border-[var(--border-hover)] focus:outline-none"
                />
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  <button type="button" data-testid="requirement-name-save" disabled={busy} onClick={() => void saveName()} className="rounded bg-[var(--hl)] px-2 py-0.5 text-[var(--bg)] disabled:opacity-60">保存</button>
                  <button type="button" data-testid="requirement-name-cancel" onClick={() => { setRenaming(false); setNameError(''); }} className="text-gray-400 underline hover:text-gray-200">取消</button>
                  {nameError && <span role="alert" data-testid="requirement-name-error" className="text-[var(--danger)]">{nameError}</span>}
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-lg font-semibold text-white" title={req.name}>{req.name}</h1>
                <button
                  type="button"
                  data-testid="requirement-rename"
                  disabled={busy}
                  title="重命名（Hub 校验 1–80 字）"
                  onClick={() => { setNameDraft(req.name); setNameError(''); setRenaming(true); }}
                  className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] disabled:opacity-60"
                >
                  重命名
                </button>
              </div>
            )}
            {!req.archived && (
              <button
                type="button"
                data-testid="requirement-archive"
                ref={archiveButtonRef}
                disabled={busy}
                title="归档后列表默认不显示，可在「包含已归档」里找到"
                onClick={() => void sendPatch({ archived: true })}
                className="inline-flex min-w-11 shrink-0 items-center justify-center rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] disabled:opacity-60"
              >
                归档
              </button>
            )}
            <button
              type="button"
              data-testid="requirement-prev"
              disabled={!navIds.prev}
              onClick={() => { if (navIds.prev) retryRouter.push(withBack(`/requirements/${encodeURIComponent(navIds.prev)}`)); }}
              title={navIds.prev ? `上一条（按列表当前筛选）${navScope?.prev ? `：${navScope.prev}` : ''} · k / ←` : '按列表当前筛选没有上一条'}
              className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] disabled:opacity-40"
            >
              ← 上一条
            </button>
            <button
              type="button"
              data-testid="requirement-next"
              disabled={!navIds.next}
              onClick={() => { if (navIds.next) retryRouter.push(withBack(`/requirements/${encodeURIComponent(navIds.next)}`)); }}
              title={navIds.next ? `下一条（按列表当前筛选）${navScope?.next ? `：${navScope.next}` : ''} · j / →` : '按列表当前筛选没有下一条'}
              className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] disabled:opacity-40"
            >
              下一条 →
            </button>
            <button
              type="button"
              data-testid="requirement-copy-link"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                } catch {
                  setCopied(false);
                }
              }}
              className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              {copied ? '已复制' : '复制链接'}
            </button>
          </div>
          {req.archived && (
            <p ref={archivedBannerRef} tabIndex={-1} data-testid="requirement-archived-banner" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-300">
              这条需求已归档，列表默认不显示它。
              <button
                type="button"
                data-testid="requirement-restore"
                disabled={busy}
                onClick={() => void sendPatch({ archived: false })}
                className="rounded border border-amber-400/30 px-2 py-0.5 text-amber-200 hover:bg-amber-400/10 disabled:opacity-60"
              >
                恢复到列表
              </button>
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-gray-500">
            <span>负责人 {req.owner ? optionLabel(ownerValue) : '—'}</span>
            <span>负责 Agent {req.agent_owner ? optionLabel(agentValue) : '—'}</span>
            {(() => {
              const created = relativeTime(req.createdAt);
              const updated = relativeTime(req.updatedAt);
              return (
                <>
                  {created && <span data-testid="requirement-created" title={created.exact}>创建于 {created.text}</span>}
                  {updated && <span data-testid="requirement-updated" title={updated.exact}>更新于 {updated.text}</span>}
                </>
              );
            })()}
            <span data-testid="requirement-project-label">项目 {req.project_id ? (projects?.find(item => item.id === req.project_id)?.name ?? req.project_id) : '—'}</span>
            {req.children && req.children.total > 0 && <span>子卡 {req.children.done}/{req.children.total}</span>}
            {req.external_url && (
              <a href={req.external_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                {req.external_ref || 'external'}
              </a>
            )}
          </div>
        </header>

        {/* #1634 — write surface. Hub keeps the rules (owner must be human,
            node tokens may not delete); this bar only sends whitelisted fields. */}
        <section className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5">
          <span className="text-[10px] uppercase tracking-wide text-gray-600">Status</span>
          {COLUMN_OPTIONS.map(opt => (
            <button
              key={opt.key}
              type="button"
              disabled={busy || req.column === opt.key}
              onClick={() => sendPatch({ column: opt.key })}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${
                req.column === opt.key
                  ? (COLUMN_CHIP[opt.key] || COLUMN_CHIP.abandoned)
                  : 'border-transparent text-gray-500 hover:bg-[var(--bg-elevated)] hover:text-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-[var(--border)]" />
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-600">
            Priority
            <select
              value={req.priority}
              disabled={busy}
              onChange={e => sendPatch({ priority: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs normal-case text-gray-200"
            >
              {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{priorityLabel(p)} · {p}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-600">
            项目
            <select
              aria-label="项目"
              data-testid="requirement-project"
              value={req.project_id || ''}
              disabled={busy || projects === null}
              onChange={event => sendPatch({ project_id: event.target.value || null })}
              title={projectError || '移到另一个项目；选「无项目」= 明确不属于任何项目'}
              className="max-w-[12rem] rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs normal-case text-gray-200 disabled:opacity-60"
            >
              <option value="">无项目</option>
              {(projects || []).map(project => (
                <option key={project.id} value={project.id}>{project.name}{project.archived ? '（已归档）' : ''}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-600">
            Start
            <input
              type="date"
              aria-label="开始日期"
              data-testid="requirement-start"
              value={req.start ? String(req.start).slice(0, 10) : ''}
              disabled={busy}
              onChange={e => sendPatch({ start: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs normal-case text-gray-200"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-600">
            Due
            <input
              type="date"
              aria-label="截止日期"
              data-testid="requirement-due"
              value={req.due ? String(req.due).slice(0, 10) : ''}
              disabled={busy}
              onChange={e => sendPatch({ due: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs normal-case text-gray-200"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-600">
            负责人
            <select
              aria-label="负责人（人）"
              value={ownerValue}
              disabled={busy || !directoryReady}
              title={peopleError || (directoryReady ? '只列人；同名以 ID 区分' : '正在读取人员目录…')}
              onChange={e => {
                const value = e.target.value;
                if (value && !value.startsWith('user:')) return;
                sendPatch({ owner: value ? { kind: 'user', id: value.slice('user:'.length) } : null });
              }}
              className="max-w-[12rem] rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs normal-case text-gray-200 disabled:opacity-60"
            >
              <option value="">未分配</option>
              {personChoices?.filter(choice => choice.kind === 'user').map(choice => (
                <option key={choice.value} value={choice.value} title={choice.label}>{choice.label}</option>
              ))}
              {ownerValue && !personChoices?.some(choice => choice.value === ownerValue) && (
                <option value={ownerValue} disabled>{optionLabel(ownerValue)}（不可用）</option>
              )}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-600">
            负责 Agent
            <select
              aria-label="负责 Agent"
              value={agentValue}
              disabled={busy || !directoryReady}
              title={peopleError || (directoryReady ? '只列 Agent；同名以 ID 区分' : '正在读取人员目录…')}
              onChange={e => {
                const value = e.target.value;
                if (value && !value.startsWith('node:')) return;
                sendPatch({ agent_owner: value ? { kind: 'node', id: value.slice('node:'.length) } : null });
              }}
              className="max-w-[12rem] rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs normal-case text-gray-200 disabled:opacity-60"
            >
              <option value="">未分配</option>
              {personChoices?.filter(choice => choice.kind === 'node').map(choice => (
                <option key={choice.value} value={choice.value} title={choice.label}>{choice.label}</option>
              ))}
              {agentValue && !personChoices?.some(choice => choice.value === agentValue) && (
                <option value={agentValue} disabled>{optionLabel(agentValue)}（不可用）</option>
              )}
            </select>
          </label>
          {peopleError && (
            <span role="status" className="text-[11px] text-amber-300">
              {peopleError}
              <button type="button" onClick={() => setPeopleAttempt(n => n + 1)} className="ml-2 underline">重试人员目录</button>
            </span>
          )}
          <span className="mx-1 h-4 w-px bg-[var(--border)]" />
          {editingTags ? (
            <span className="flex items-center gap-1">
              <input
                aria-label="标签"
                value={tagsDraft}
                onChange={event => setTagsDraft(event.target.value)}
                placeholder="逗号分隔"
                className="w-44 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs text-gray-200"
              />
              <button type="button" data-testid="requirement-save-tags" disabled={busy} onClick={() => void saveTags()} className="rounded bg-[var(--hl)] px-2 py-0.5 text-[10px] text-[var(--bg)] disabled:opacity-60">保存</button>
              <button type="button" onClick={() => { setEditingTags(false); setEditError(''); }} className="text-[10px] text-gray-500 underline">取消</button>
              {editorTagSuggestions(tagCatalog, tagsDraft).length > 0 && (
                <span className="ml-1 flex flex-wrap items-center gap-1" data-testid="requirement-tag-suggestions">
                  {editorTagSuggestions(tagCatalog, tagsDraft).map(suggestion => (
                    <button
                      key={suggestion.name}
                      type="button"
                      onClick={() => setTagsDraft(prev => (prev.trim() ? `${prev.trim().replace(/[,，]$/, '')}, ${suggestion.name}` : suggestion.name))}
                      className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
                      data-testid={`requirement-tag-suggestion-${suggestion.name}`}
                    >
                      {suggestion.color && <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: suggestion.color }} />}
                      {suggestion.name}
                    </button>
                  ))}
                </span>
              )}
            </span>
          ) : (
            <button type="button" data-testid="requirement-edit-tags" onClick={() => { setTagsDraft((req.tags || []).join(', ')); setEditError(''); setEditingTags(true); }} className="text-[11px] text-gray-500 underline hover:text-gray-300">编辑标签</button>
          )}
          {editError && !editingDescription && <span role="alert" className="text-[11px] text-[var(--danger)]">{editError}</span>}
          {busy && <span className="text-[11px] text-gray-500">saving…</span>}
          {actionError && <span className="text-[11px] text-red-400">{actionError}</span>}
        </section>

        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <h2 className="mb-2 text-xs uppercase tracking-wide text-gray-500">参与者 {req.participants && req.participants.length > 0 && <span className="ml-1 text-gray-600">{req.participants.length}</span>}</h2>
          <div className="flex flex-wrap items-center gap-2" data-testid="requirement-participants">
            {(req.participants || []).length === 0 ? (
              <p className="text-sm text-gray-600">暂无参与者</p>
            ) : (req.participants || []).map(person => {
              const value = `${person.kind}:${person.id}`;
              const known = personChoices?.some(choice => choice.value === value);
              const label = optionLabel(value);
              return (
                <span key={value} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-xs text-gray-200">
                  <span className="max-w-[12rem] truncate" title={`${person.kind} · ${person.id}`}>{label}{known ? '' : '（不可用）'}</span>
                  <button
                    type="button"
                    aria-label={`移除参与者 ${label}`}
                    disabled={busy}
                    onClick={() => void changeParticipants((req.participants || []).filter(item => !(item.kind === person.kind && item.id === person.id)))}
                    className="rounded px-1 text-[var(--fg-muted)] hover:text-[var(--danger)] disabled:opacity-50"
                  >✕</button>
                </span>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
              添加参与者
              <select
                aria-label="添加参与者"
                value=""
                disabled={busy || personChoices === null}
                onChange={event => {
                  const person = personChoices?.find(choice => choice.value === event.target.value);
                  if (!person) return;
                  const ref = person.value.split(':');
                  void changeParticipants([...(req.participants || []), { kind: ref[0] as Person['kind'], id: ref.slice(1).join(':') }]);
                }}
                className="max-w-[14rem] rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs normal-case text-gray-200 disabled:opacity-60"
              >
                <option value="">选择人 / Agent</option>
                {(['user', 'node'] as const).map(kind => (
                  <optgroup key={kind} label={kind === 'user' ? '人' : 'Agent'}>
                    {personChoices?.filter(choice => choice.kind === kind && !(req.participants || []).some(item => item.kind === kind && item.id === choice.value.split(':').slice(1).join(':'))).map(choice => (
                      <option key={choice.value} value={choice.value}>{choice.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {peopleError && <span role="status" className="text-[11px] text-[var(--warning)]">{peopleError}</span>}
          </div>
        </section>

        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-xs uppercase tracking-wide text-gray-500">Description</h2>
            {!editingDescription ? (
              <button type="button" data-testid="requirement-edit-description" onClick={() => { setDescriptionDraft(req.description || ''); setEditError(''); setEditingDescription(true); }} className="text-[11px] text-gray-400 underline hover:text-gray-200">编辑描述</button>
            ) : (
              <span className="flex items-center gap-2 text-[11px]">
                <button type="button" data-testid="requirement-save-description" disabled={busy} onClick={() => void saveDescription()} className="rounded bg-[var(--hl)] px-2 py-0.5 text-[var(--bg)] disabled:opacity-60">保存</button>
                <button type="button" onClick={() => { setEditingDescription(false); setEditError(''); }} className="text-gray-400 underline hover:text-gray-200">取消</button>
              </span>
            )}
          </div>
          {editingDescription ? (
            <div>
              <textarea
                aria-label="描述"
                value={descriptionDraft}
                onChange={event => setDescriptionDraft(event.target.value)}
                rows={8}
                className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 font-mono text-xs text-gray-200 focus:border-[var(--border-hover)] focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-[var(--fg-dim)]">{descriptionDraft.length}/20000 · 支持 Markdown</p>
              {editError && <p role="alert" className="mt-1 text-[11px] text-[var(--danger)]">{editError}</p>}
            </div>
          ) : req.description ? (
            <div className="prose prose-invert max-w-none prose-sm prose-pre:bg-[var(--bg)] prose-pre:border prose-pre:border-[var(--border)]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{req.description}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-gray-600">（没有描述）</p>
          )}
        </section>

        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <h2 className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
            Checklist {checklist.length > 0 && <span className="ml-1 text-gray-600">{checklist.filter(c => c.done).length}/{checklist.length}</span>}
            {!editingChecklist && (
              <button type="button" data-testid="requirement-edit-checklist" onClick={startChecklistEdit} className="ml-auto text-[11px] normal-case text-gray-500 underline hover:text-gray-300">编辑清单</button>
            )}
          </h2>
          {editingChecklist ? (
            <div>
              {checklistDraft.length === 0 ? (
                <p className="text-sm text-gray-600">（还没有检查项，先添加一条）</p>
              ) : (
                <ul className="space-y-1.5">
                  {checklistDraft.map((item, index) => (
                    <li key={item.id} className="flex items-center gap-2 text-sm" data-testid={`checklist-row-${index}`}>
                      <span className="min-w-0 flex-1 break-words text-gray-200">{item.text}</span>
                      <button type="button" aria-label={`上移 ${item.text}`} disabled={index === 0} onClick={() => setChecklistDraft(draft => [...moveChecklistItem(draft, index, index - 1)])} className="px-1 text-gray-500 disabled:opacity-30">↑</button>
                      <button type="button" aria-label={`下移 ${item.text}`} disabled={index === checklistDraft.length - 1} onClick={() => setChecklistDraft(draft => [...moveChecklistItem(draft, index, index + 1)])} className="px-1 text-gray-500 disabled:opacity-30">↓</button>
                      <button type="button" aria-label={`删除 ${item.text}`} onClick={() => setChecklistDraft(draft => removeChecklistItem(draft, item.id))} className="px-1 text-[11px] text-[var(--danger)]">删除</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex items-center gap-2">
                <input
                  aria-label="新检查项"
                  value={newItemText}
                  onChange={event => setNewItemText(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addChecklistRow(); } }}
                  placeholder="加一条检查项，回车添加"
                  className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--fg)]"
                />
                <button type="button" data-testid="requirement-add-checklist" onClick={addChecklistRow} className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)]">添加</button>
              </div>
              {checklistError && <p role="alert" data-testid="checklist-error" className="mt-1 text-[11px] text-[var(--danger)]">{checklistError}</p>}
              <div className="mt-2 flex items-center gap-2">
                <button type="button" data-testid="requirement-save-checklist" disabled={busy} onClick={() => void saveChecklist()} className="rounded bg-[var(--hl)] px-2 py-0.5 text-[10px] text-[var(--bg)] disabled:opacity-60">保存</button>
                <button type="button" onClick={() => { setEditingChecklist(false); setChecklistError(''); }} className="text-[10px] text-gray-500 underline">取消</button>
              </div>
            </div>
          ) : checklist.length === 0 ? (
            <p className="text-sm text-gray-600">（没有检查项）</p>
          ) : (
            <ul className="space-y-1.5">
              {checklist.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => toggleItem(item.id, !item.done)}
                    className="flex items-start gap-2 text-left text-sm hover:opacity-80 disabled:opacity-60"
                  >
                    <span aria-hidden className={item.done ? 'text-emerald-400' : 'text-gray-600'}>{item.done ? '✓' : '○'}</span>
                    <span className={item.done ? 'text-gray-500 line-through' : 'text-gray-200'}>{item.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4" data-testid="requirement-issues">
          <h2 className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
            关联 Issue
            {issues && issues.length > 0 && <span className="text-gray-600">{issues.length}/{MAX_REQUIREMENT_ISSUES}</span>}
          </h2>
          {issues === null ? (
            <p className="text-xs text-gray-500" data-testid="requirement-issues-unsupported">Hub 返回的 issue 列表读不懂，为避免覆盖原始数据，这里不提供编辑。</p>
          ) : (
            <>
              {issues.length === 0 ? (
                <p className="text-xs text-gray-500">还没有关联 GitHub issue。可以贴完整链接或 <code>owner/repo#123</code>。</p>
              ) : (
                <ul className="mb-2 space-y-1">
                  {issues.map(issue => (
                    <li key={issueLabel(issue)} data-testid="requirement-issue-row" className="flex items-center gap-2 text-xs">
                      <a href={issueUrl(issue)} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                        {issueLabel(issue)}
                      </a>
                      {issue.title && <span className="truncate text-gray-400">{issue.title}</span>}
                      <button
                        type="button"
                        data-testid={`requirement-issue-remove-${issueLabel(issue)}`}
                        disabled={busy}
                        onClick={() => removeIssueRow(issueLabel(issue))}
                        className="ml-auto shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-gray-200 disabled:opacity-60"
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  data-testid="requirement-issue-input"
                  aria-label="关联 issue"
                  value={issueDraft}
                  placeholder="https://github.com/owner/repo/issues/123 或 owner/repo#123"
                  onChange={event => { setIssueDraft(event.target.value); setIssueError(''); }}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addIssueRow(); } }}
                  className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-gray-200 focus:border-[var(--border-hover)] focus:outline-none"
                />
                <button
                  type="button"
                  data-testid="requirement-issue-add"
                  disabled={busy || !issueDraft.trim()}
                  onClick={addIssueRow}
                  className="rounded bg-[var(--hl)] px-2 py-1 text-xs text-[var(--bg)] disabled:opacity-60"
                >
                  添加
                </button>
              </div>
              {issueError && <p role="alert" data-testid="requirement-issue-error" className="mt-1 text-[11px] text-[var(--danger)]">{issueError}</p>}
            </>
          )}
        </section>

        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4" data-testid="requirement-children">
          <h2 className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
            子需求{childRows.length > 0 && <span className="ml-1 text-gray-600">{childRows.length}</span>}
            <button
              type="button"
              data-testid="requirement-move-parent"
              onClick={() => { setParentPickerOpen(v => !v); setParentError(''); }}
              className="ml-auto text-[11px] normal-case text-gray-500 underline hover:text-gray-300"
            >
              改父级
            </button>
          </h2>
          {parentPickerOpen && (
            <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5" data-testid="requirement-parent-picker">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  aria-label="搜索新上级"
                  value={parentQuery}
                  onChange={event => setParentQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void searchParents(); } }}
                  placeholder="搜索新上级（标题）"
                  className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--fg)]"
                />
                <button type="button" onClick={() => void searchParents()} disabled={parentBusy} className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)] disabled:opacity-60">搜索</button>
                <button type="button" data-testid="requirement-move-root" onClick={() => void moveUnder(null)} disabled={parentBusy} className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)] disabled:opacity-60">升为顶级</button>
              </div>
              {parentError && <p role="alert" className="mt-1 text-[11px] text-[var(--danger)]">{parentError}</p>}
              {parentResults.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-auto rounded border border-[var(--border)]" data-testid="requirement-parent-results">
                  {parentResults.map(row => (
                    <li key={row.id}>
                      <button
                        type="button"
                        data-testid={`requirement-parent-option-${row.id}`}
                        onClick={() => void moveUnder(row.id)}
                        disabled={parentBusy}
                        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
                      >
                        <span className="tabular-nums text-[10px] text-gray-500">#{row.seq}</span>
                        <span className="rounded bg-[var(--bg-elevated)] px-1 text-[10px]">{row.column}</span>
                        <span className="min-w-0 flex-1 truncate">{row.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[11px] text-gray-600">最多 5 层、不能成环（Hub 校验）；改父级不改卡片其它字段。</p>
            </div>
          )}
          {childError && <p role="alert" className="mb-2 text-[11px] text-[var(--danger)]">{childError}</p>}
          {childRows.length === 0 ? (
            <p className="text-sm text-gray-600">（还没有子需求）</p>
          ) : (
            <ul className="space-y-1.5">
              {childRows.map(row => (
                <li key={row.id}>
                  <Link href={`/requirements/${row.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] px-2 py-1.5 text-sm hover:bg-[var(--hover-tint)]">
                    <span className="tabular-nums text-[11px] text-gray-500">#{row.seq}</span>
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-gray-400">{row.column}</span>
                    <span className="text-[11px] text-gray-400" title={priorityTitle(row.priority)}>{priorityLabel(row.priority)}</span>
                    <span className="min-w-0 flex-1 truncate text-gray-200">{row.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              aria-label="子需求标题"
              value={childDraft}
              onChange={event => setChildDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createChild(); } }}
              placeholder="子需求标题"
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--fg)]"
            />
            <select
              aria-label="子需求优先级"
              value={childPriority}
              onChange={event => setChildPriority(event.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-xs text-[var(--fg)]"
            >
              {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{priorityLabel(p)}</option>)}
            </select>
            <button type="button" data-testid="requirement-create-child" disabled={childBusy} onClick={() => void createChild()} className="rounded bg-[var(--hl)] px-2 py-1 text-[11px] text-[var(--bg)] disabled:opacity-60">
              {childBusy ? '创建中…' : '新建子需求'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-gray-600">同一网络、最多 5 层、不能成环（由 Hub 校验）。</p>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <h2 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Activity</h2>
          {events.length === 0 ? (
            <EmptyState variant="generic" compact title="还没有动态" sub="状态变更和评论会出现在这里。" />
          ) : (
            <ul className="space-y-2">
              {events.map(ev => {
                const d = describeEvent(ev);
                return (
                  <li key={ev.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                      <span className="text-gray-300">{personLabel(ev.actor)}</span>
                      <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5">{d.label}</span>
                      {ev.at && <span>{String(ev.at).replace('T', ' ').slice(0, 16)}</span>}
                    </div>
                    {d.body && (d.label === 'comment'
                      ? <CommentMarkdown text={d.body} />
                      : <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-300">{d.body}</p>)}
                  </li>
                );
              })}
            </ul>
          )}
          <p role="status" aria-live="polite" data-testid="requirement-events-notice" className="sr-only">{eventsNotice}</p>
          <div ref={eventsEndRef} tabIndex={-1} className="outline-none" />
          {eventCursor && (
            <button
              type="button"
              data-testid="requirement-load-older-events"
              disabled={olderBusy}
              onClick={() => void loadOlderEvents()}
              className="mt-2 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200 disabled:opacity-60"
            >
              {olderBusy ? '读取中…' : '更早的评论'}
            </button>
          )}

          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <textarea
              ref={commentRef}
              aria-keyshortcuts="c"
              title="按 c 聚焦这里；Ctrl/⌘+Enter 发送"
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={2}
              placeholder="写一条进展或评论…（Ctrl/⌘+Enter 发送）"
              className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-sm text-gray-200 placeholder-gray-700 focus:border-blue-500/40 focus:outline-none"
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitComment(); }}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !comment.trim()}
                onClick={submitComment}
                className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-300 disabled:opacity-50"
              >
                Add comment
              </button>
              {actionError && <span className="text-[11px] text-red-400">{actionError}</span>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function RequirementDetailPage() {
  const { networkId, ready } = useNetworkId();
  if (!ready) return <div role="status" className="min-h-screen bg-[var(--bg)] p-6 text-sm text-gray-500">正在确认当前网络…</div>;
  if (!networkId) return (
    <div className="min-h-screen bg-[var(--bg)] p-6">
      <div className="mx-auto max-w-4xl"><NetworkRequiredNotice /></div>
    </div>
  );
  // A network switch must not leave another network's description or timeline
  // on screen: remount resets every piece of local state.
  return <RequirementDetailContent key={networkId} networkId={networkId} />;
}
