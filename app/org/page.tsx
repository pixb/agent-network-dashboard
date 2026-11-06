'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { EmptyState } from '../components/EmptyState';
import { useNetworkId } from '../lib/network-context';
import { NetworkRequiredNotice } from '../components/NetworkRequiredNotice';
import { buildOrgGroups, filterOrgPeople, type OrgGroup, type OrgDeptInput, type OrgMemberInput } from '../lib/org-tree';
import { buildAliasUserMap, buildUserDeptMap, collectDeptSubtree, taskInDept } from '../lib/dept-task-filter';

/**
 * Organization — #1635 / #1636（只读）。
 *
 * 数据有两条来源，和军团图完全一致：
 *   - `/api/hub/people`：人、部门名、名下 Agent（MCP requirements_people 的投影）；
 *   - `/api/hub/departments`：真实部门树（parent_id / leader / 成员落位）。
 * 老 Hub 没有第二条 → 404，页面回退成扁平分组并在顶部说明原因，
 * **不用空状态掩盖「这版 Hub 不支持」**。
 *
 * 分组逻辑在 app/lib/org-tree.ts（纯函数，org-tree.test.mjs 钉住），
 * 这里只负责画。没有编辑入口：部门与成员归属是人管的事，客户端才是编辑端。
 */

interface DirectoryAgent { node_id: string; alias: string }
interface DirectoryPerson {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  department: { id: string; name: string } | null;
  agents: DirectoryAgent[];
}
interface DirectoryResponse {
  ok: boolean;
  network_id: string;
  total: number;
  people: DirectoryPerson[];
  agents_without_owner?: DirectoryAgent[];
  has_more: boolean;
  next_offset: number | null;
}

const PAGE = 50;

function GroupSection({ group, depth, counts, focusName, expandAll, overrides, onToggle }: {
  group: OrgGroup; depth: number; counts: Map<string, number>; focusName?: string; expandAll?: boolean;
  overrides: Record<string, boolean>; onToggle: (id: string, next: boolean) => void;
}) {
  const focused = !!focusName && group.name === focusName;
  // 默认：≤8 人展开，更大的折叠；用户点过的记在页面级 overrides 里，
  // 搜索/清空之后展开状态还在。搜索时（expandAll）全展开。
  const isOpen = expandAll || (overrides[group.id] ?? group.totalPeople <= 8);
  // 有真实部门树时按 id 命中；老 Hub 回退成扁平分组（id 是合成的）时按部门名命中。
  const taskCount = counts.get(group.id.replace(/^dept:/, '')) ?? counts.get(group.name);
  return (
    <li>
      <div
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-[var(--border)] px-3 py-2 transition-colors sm:px-4 ${
          focused ? 'bg-[var(--accent)]/10' : ''
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        data-org-group={group.name}
        ref={el => { if (focused && el) el.scrollIntoView({ block: 'center' }); }}
      >
        <span className="text-[12px] font-medium text-[var(--fg)]">{group.name}</span>
        {group.leader && (
          <span className="rounded-full bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)]">
            负责人 {group.leader}
          </span>
        )}
        <button
          type="button"
          onClick={() => onToggle(group.id, !isOpen)}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? '收起' : '展开'} ${group.name} 的成员`}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
        >
          <span aria-hidden className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
          {group.totalPeople} 人 · {group.totalAgents} Agent
        </button>
        <Link
          href={`/legion?focus=${encodeURIComponent(group.name)}`}
          title="在军团图里看这个部门"
          aria-label={`在军团图里看 ${group.name}`}
          className="rounded-full bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          看军团
        </Link>
        {taskCount ? (
          <Link
            href={`/tasks?department=${encodeURIComponent(group.id.replace(/^dept:/, ''))}`}
            data-testid="org-dept-task-link"
            title="到任务页按这个部门筛选：数字是当前这批任务里的通讯录投影命中数，不是部门全量"
            className="rounded-full bg-[var(--accent)]/12 px-1.5 py-0.5 text-[11px] text-[var(--fg)] hover:bg-[var(--accent)]/25"
          >
            {taskCount} 条任务 →
          </Link>
        ) : null}
      </div>

      {isOpen && group.people.length > 0 && (
        <ul>
          {group.people.map(person => (
            <li
              key={person.user_id}
              className="px-3 py-2.5 sm:px-4"
              style={{ paddingLeft: `${12 + depth * 16 + 12}px` }}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm text-[var(--fg)]">{person.display_name || person.username}</span>
                <span className="text-[11px] text-[var(--fg-muted)]">@{person.username}</span>
                <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)]">
                  {person.role}
                </span>
                <span className="ml-auto text-[11px] text-[var(--fg-muted)]">{person.agents.length} 个 Agent</span>
              </div>
              {person.agents.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {person.agents.map(agent => (
                    <Link
                      key={agent.node_id}
                      href={`/nodes/${encodeURIComponent(agent.alias)}`}
                      className="rounded-md bg-[var(--bg)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
                    >
                      {agent.alias}
                    </Link>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {group.children.length > 0 && (
        <ul className="border-l border-[var(--border)]" style={{ marginLeft: `${20 + depth * 16}px` }}>
          {group.children.map(child => (
            <GroupSection key={child.id} group={child} depth={depth + 1} counts={counts} focusName={focusName} expandAll={expandAll} overrides={overrides} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  );
}

function OrgContent() {
  // #1636-P1 —— 通讯录/部门树都按当前网络读；切网要重取，
  // 否则会把上一个网络的人当成这个网络的（部门筛选会跟着错）。
  const { networkId, ready: networkReady } = useNetworkId();
  const router = useRouter();
  const searchParams = useSearchParams();
  const q = searchParams.get('q') || '';
  // 从军团图跳过来时定向到某个部门：/org?focus=<部门名>
  const focusName = searchParams.get('focus') || '';

  // 部门展开状态记在页面级：搜索/清空后不丢（组件级 state 会被建树重建冲掉）。
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  const toggleGroup = useCallback((id: string, next: boolean) => {
    setExpandOverrides(prev => ({ ...prev, [id]: next }));
  }, []);

  const [data, setData] = useState<DirectoryResponse | null>(null);
  const [org, setOrg] = useState<{ departments?: OrgDeptInput[]; members?: OrgMemberInput[] } | null>(null);
  const [orgChecked, setOrgChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [offset, setOffset] = useState(0);
  const [qInput, setQInput] = useState(q);

  const load = useCallback(async (nextOffset = 0, merge = false) => {
    // #1636-P1 —— 代际保护：同一个 load 会写 data / offset / loading / error / needsLogin 五个状态，
    // 旧响应（切网前的 A、或上一次搜索词）迟到时若直接落库，会把当前网络的列表**覆盖**成旧网络的人
    // （实测：挂起 A 的 people 响应 → 切到 B → 放行 A ⇒ Person B 消失、B 的徽标也消失，且 20s 轮询救不回来）。
    // 每次发起 +1，只有最新一代允许写状态；成功 / 401 / 错误 / 分页旧响应一视同仁。
    const gen = ++peopleGen.current;
    const isCurrent = () => peopleGen.current === gen;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (networkId) params.set('network_id', networkId);
      params.set('limit', String(PAGE));
      params.set('offset', String(nextOffset));
      const res = await fetch(`/api/hub/people?${params.toString()}`, { cache: 'no-store' });
      if (!isCurrent()) return;
      if (res.status === 401) { setNeedsLogin(true); setData(null); return; }
      const json = await res.json();
      if (!isCurrent()) return;
      if (!res.ok || !json.ok) { setError(json?.error || `hub_${res.status}`); return; }
      setNeedsLogin(false);
      setOffset(nextOffset);
      setData(prev => (merge && prev && nextOffset > 0
        ? { ...json, people: [...prev.people, ...json.people] }
        : json));
    } catch (e: unknown) {
      if (!isCurrent()) return;
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      // 旧代际不能把 loading 关掉（新请求还在飞）；否则会闪一下骨架
      if (isCurrent()) setLoading(false);
    }
  }, [q, networkId]);

  // 网络解析完成之前不发请求：否则首帧会发一次没有 scope 的请求（多网络账号会 400）。
  useEffect(() => { if (!networkReady || !networkId) return; load(0, false); }, [load, networkReady, networkId]);

  // 部门树单独拉：404 = 这版 Hub 没有这条路由（能力缺失），不是错误。
  useEffect(() => {
    if (!networkReady || !networkId) return;
    let alive = true;
    (async () => {
      try {
        const deptUrl = networkId
          ? `/api/hub/departments?network_id=${encodeURIComponent(networkId)}`
          : '/api/hub/departments';
        const res = await fetch(deptUrl, { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 404) { setOrg(null); setOrgChecked(true); return; }
        if (res.status === 401) { setNeedsLogin(true); setOrgChecked(true); return; }
        const json = await res.json().catch(() => null);
        if (!alive) return;
        setOrg(res.ok && json?.ok ? json : null);
      } catch {
        if (alive) setOrg(null);
      } finally {
        if (alive) setOrgChecked(true);
      }
    })();
    return () => { alive = false; };
  }, [networkId, networkReady]);

  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set('q', value); else next.delete('q');
    router.replace(next.toString() ? `/org?${next.toString()}` : '/org', { scroll: false });
  };

  const withoutOwner = data?.agents_without_owner ?? [];
  const people = data?.people ?? [];

  // 任务数徽标：只取一页任务（limit 100），和 /tasks 的部门筛选同口径 ——
  // 是「当前这批任务里的命中数」，不是部门全量，标题里写明。
  // 切网时用于丢弃旧网络的在途响应（每次换网 +1）。
  const tasksCountGen = useRef(0);
  // people 列表的代际号：切网 / 换搜索词会让旧响应作废（见 load 注释）。
  const peopleGen = useRef(0);
  const [tasksForCount, setTasksForCount] = useState<Array<{ from_name?: string; to_name?: string; from_alias?: string; to_alias?: string }>>([]);
  useEffect(() => {
    // #1636-P1（P1）—— 这页的任务数徽标也必须按当前网络读：
    //   ① 网络还没确定（解析中或为空）时**一个请求都不发**；
    //   ② 每次请求都带 network_id；
    //   ③ 切网重建轮询，并丢掉上一个网络的在途响应（generation 计数）。
    // 原来这里是 fetch('/api/hub/tasks?limit=100') + deps=[] + 20s 轮询，
    // 网络待定 / 无网络 / 已选 A 三种状态下都发**无 scope** 请求，会串网或 400。
    if (!networkReady || !networkId) { setTasksForCount([]); return; }
    const gen = ++tasksCountGen.current;
    const url = `/api/hub/tasks?limit=100&network_id=${encodeURIComponent(networkId)}`;
    const load = () => {
      void fetch(url, { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(json => {
          if (tasksCountGen.current !== gen) return;   // 旧网络的在途响应，丢弃
          if (json?.tasks) setTasksForCount(json.tasks);
        })
        .catch(() => { /* 任务读不到就不显示徽标，不影响组织树 */ });
    };
    setTasksForCount([]);          // 切网先清旧计数，避免用 A 的数字渲染 B 的部门
    load();
    const t = setInterval(load, 20000);
    return () => { clearInterval(t); };
  }, [networkReady, networkId]);

  const deptTaskCounts = useMemo(() => {
    const aliasUser = buildAliasUserMap(people);
    const userDept = buildUserDeptMap(people, org?.members ?? null);
    const counts = new Map<string, number>();
    for (const dept of org?.departments ?? []) {
      const subtree = collectDeptSubtree(org?.departments, dept.id);
      const n = tasksForCount.filter(t => taskInDept(t, aliasUser, userDept, subtree)).length;
      if (n > 0) counts.set(dept.id, n);
    }
    // 扁平回退：没有部门树时 group.id 是合成的，只能按部门名对上号。
    if (!org?.departments?.length) {
      const aliasDeptName = new Map<string, string>();
      for (const person of people) {
        const name = person.department?.name;
        if (!name) continue;
        for (const agent of person.agents ?? []) aliasDeptName.set(agent.alias, name);
      }
      const byName = new Map<string, number>();
      for (const t of tasksForCount) {
        const names = new Set([aliasDeptName.get(t.from_name ?? ''), aliasDeptName.get(t.from_alias ?? ''), aliasDeptName.get(t.to_name ?? ''), aliasDeptName.get(t.to_alias ?? '')]);
        names.delete(undefined);
        for (const name of names) if (name) byName.set(name, (byName.get(name) ?? 0) + 1);
      }
      return byName;
    }
    return counts;
  }, [people, org, tasksForCount]);
  const tree = useMemo(() => {
    // 搜索是找人的：按 姓名 / 用户名 / 名下 Agent 别名 过滤，再建树。
    const visible = filterOrgPeople(people, q);
    return buildOrgGroups(
      { people: visible, departments: org?.departments, members: org?.members },
      { hideEmpty: q.trim().length > 0 },
    );
  }, [people, org, q]);
  const deptCount = useMemo(() => {
    const count = (groups: OrgGroup[]): number =>
      groups.reduce((n, g) => n + 1 + count(g.children), 0);
    return count(tree.groups);
  }, [tree]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-[var(--fg)]">Organization</h1>
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              人、部门与他们名下的 Agent（只读）。
            </p>
            {orgChecked && org === null && (
              <p className="mt-1 text-[11px] text-[var(--fg-dim)]">
                当前 Hub 没有部门树接口，按通讯录的部门名分组（升级 Hub 后自动变为真实层级）。
              </p>
            )}
            {orgChecked && org !== null && (
              <p className="mt-1 text-[11px] text-[var(--fg-dim)]">
                部门树来自 Hub，共 {deptCount} 个部门、{tree.depth} 层。
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/legion"
              className="inline-flex min-h-11 items-center rounded-md px-2.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] sm:min-h-0 sm:py-1.5"
            >
              军团图
            </Link>
            <button
              type="button"
              onClick={() => load(offset, true)}
              className="inline-flex min-h-11 items-center rounded-md px-2.5 text-xs text-[var(--fg-muted)] transition-colors hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] sm:min-h-0 sm:py-1.5"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="rounded-lg bg-[var(--bg-secondary)] px-2.5 py-1.5">
            <input
              value={qInput}
              onChange={e => setQInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') setQuery(qInput); }}
              onBlur={() => { if (qInput !== q) setQuery(qInput); }}
              placeholder="人 / 部门 / Agent 别名"
              className="w-44 bg-transparent text-sm text-[var(--fg)] placeholder:text-[var(--fg-dim)] focus:outline-none sm:w-64"
            />
          </div>
          {q && (
            <button
              type="button"
              onClick={() => { setQInput(''); setQuery(''); }}
              className="rounded-md px-2.5 py-1.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              Clear
            </button>
          )}
          {data && <span className="text-[11px] text-[var(--fg-muted)]">{data.total} 人 · {deptCount} 个部门</span>}
        </div>

        {needsLogin && (
          <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            会话已过期，<Link href="/login" className="underline">重新登录</Link> 后再看组织架构。
          </div>
        )}
        {error && !needsLogin && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
            读取失败：{error}
            <button type="button" onClick={() => load(0, false)} className="ml-3 underline">重试</button>
          </div>
        )}

        {networkReady && !networkId ? (
          <NetworkRequiredNotice />
        ) : loading && !data ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-[var(--bg-secondary)]" />
            ))}
          </div>
        ) : people.length === 0 && !error && !needsLogin ? (
          <EmptyState
            variant="nodes"
            title={q ? '没有匹配的成员' : '通讯录是空的'}
            sub={q ? '换一个关键词试试。' : '成员加入网络后会自动出现在这里。'}
          />
        ) : (
          <>
            <ul className="overflow-hidden rounded-2xl bg-[var(--bg-secondary)]">
              {tree.groups.map(group => (
                <GroupSection key={group.id} group={group} depth={0} counts={deptTaskCounts} focusName={focusName} expandAll={!!q} overrides={expandOverrides} onToggle={toggleGroup} />
              ))}
            </ul>

            {data?.has_more && (
              <button
                type="button"
                disabled={loading}
                onClick={() => load(offset + PAGE, true)}
                className="mx-auto mt-4 block rounded-md px-4 py-2 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] disabled:opacity-50"
              >
                {loading ? '加载中…' : '加载更多'}
              </button>
            )}

            {offset === 0 && withoutOwner.length > 0 && (
              <div className="mt-6 rounded-2xl bg-[var(--bg-secondary)] p-4">
                <h2 className="mb-2 text-xs text-[var(--fg-muted)]">无 owner 的 Agent</h2>
                <div className="flex flex-wrap gap-1.5">
                  {withoutOwner.map(agent => (
                    <Link
                      key={agent.node_id}
                      href={`/nodes/${encodeURIComponent(agent.alias)}`}
                      className="rounded-md bg-[var(--bg)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
                    >
                      {agent.alias}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function OrgPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[var(--bg)]" />}>
      <OrgContent />
    </Suspense>
  );
}
