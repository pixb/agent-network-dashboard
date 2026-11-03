'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { EmptyState } from '../components/EmptyState';
import { createLoadGate, initialPagingState, requirementsPaging } from '../lib/requirements-paging';
import { ProjectFilter } from './ProjectFilter';
import { CreateRequirement } from './CreateRequirement';
import { TagChip, TagPicker, useRequirementTags } from './TagFilter';
import { ownerRefFor, useCurrentUserId } from '../lib/current-user';
import { TagManager } from './TagManager';
import { tagColor } from '../lib/tag-catalog';
import { parseSort, sortRequirements, SORT_KEYS } from '../lib/requirement-sort';
import { PRIORITY_KEYS, isPriorityKey, priorityLabel, priorityTitle } from '../lib/requirement-priority';
import { planHealth, planHealthRank, planHealthTone } from '../lib/requirement-plan-health';
import { buildTreeRows } from '../lib/requirement-tree';
import { NetworkRequiredNotice } from '../components/NetworkRequiredNotice';
import { useNetworkId } from '../lib/network-context';
import { restoreFocusAfterUnmount } from '../lib/focus-fallback';
import { ResponsibilityFilter, useRequirementPeople } from './ResponsibilityFilter';
import { peopleOptions, responsibilityPatch, validResponsibility } from '../lib/requirement-people';

/**
 * Requirements board — #1633 (read-only first slice).
 *
 * Why this page exists: the dashboard only ever showed dispatch tasks
 * (/tasks = who asked whom). The requirement board — 需求池 / 进行中 /
 * 完成, tags, owner vs agent owner, checklist progress — is what people
 * actually work from in the client. This is the read half; the write half
 * is #1634.
 */

interface RequirementPerson { kind: 'user' | 'node'; id: string; alias?: string }
interface Requirement {
  id: string;
  seq: number;
  name: string;
  column: 'pool' | 'doing' | 'done' | 'abandoned';
  priority: 'high' | 'normal' | 'low' | 'lowest';
  due?: string;
  start?: string;
  tags?: string[];
  owner?: RequirementPerson | null;
  agent_owner?: RequirementPerson | null;
  participants?: RequirementPerson[];
  project_id?: string | null;
  parent_id?: string | null;
  checklist_count?: { total: number; done: number };
  children?: { total: number; done: number };
  updatedAt?: string;
  has_description?: boolean;
  archived?: boolean;
}

const PRIORITIES = PRIORITY_KEYS;

const COLUMNS: { key: Requirement['column'] | ''; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'pool', label: '需求池' },
  { key: 'doing', label: '进行中' },
  { key: 'done', label: '完成' },
  { key: 'abandoned', label: '已放弃' },
];

const COLUMN_CHIP: Record<string, string> = {
  pool: 'bg-[var(--bg-elevated)] text-[var(--warning)]',
  doing: 'bg-[var(--bg-elevated)] text-[var(--info)]',
  done: 'bg-[var(--bg-elevated)] text-[var(--success)]',
  abandoned: 'bg-[var(--bg-elevated)] text-[var(--fg-muted)]',
};

function priorityClass(priority: string) {
  if (priority === 'high') return 'text-red-400';
  if (priority === 'low' || priority === 'lowest') return 'text-[var(--fg-muted)]';
  return 'text-gray-400';
}

function personLabel(p: RequirementPerson | null | undefined, names: Map<string, string>) {
  if (!p) return '—';
  return names.get(`${p.kind}:${p.id}`) || p.alias || p.id;
}

/** 相对时间：列表里「最近发生了什么」比绝对时间更好扫；title 保留精确值。 */
function relativeTime(iso?: string) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 0) return { text: '刚刚', exact: iso };
  if (diff < 3_600_000) return { text: `${Math.max(1, Math.round(diff / 60_000))} 分钟前`, exact: iso };
  if (diff < day) return { text: `${Math.round(diff / 3_600_000)} 小时前`, exact: iso };
  if (diff < 30 * day) return { text: `${Math.round(diff / day)} 天前`, exact: iso };
  return { text: iso.slice(0, 10), exact: iso };
}

function dueLabel(due?: string) {
  if (!due) return '—';
  const day = due.slice(0, 10);
  const overdue = day < new Date().toISOString().slice(0, 10);
  return overdue ? <span className="text-red-400">{day}</span> : <span className="text-gray-400">{day}</span>;
}


/** 时间线视图：按截止日期把需求排成一条横轴。
 *  为什么只画截止日：列表接口给的是 due（没有 start），画「起止条」等于编一个开始时间，
 *  用户会把它当成真实排期。所以这里是一个「到期时间线」：点在轴上、逾期变红、
 *  没有截止日的排在下面并单独说明。 */
function TimelineView({ rows }: { rows: Requirement[] }) {
  const dated = rows.filter(row => row.due).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const undated = rows.filter(row => !row.due);
  const today = new Date().toISOString().slice(0, 10);
  const day = (value: string) => Math.floor(new Date(`${value.slice(0, 10)}T00:00:00Z`).getTime() / 86400000);
  const days = dated.map(row => day(String(row.due)));
  const low = days.length ? Math.min(...days, day(today)) : day(today);
  const high = days.length ? Math.max(...days, day(today)) : day(today) + 1;
  const span = Math.max(1, high - low);
  const at = (value: string) => ((day(value) - low) / span) * 100;
  // 4 个刻度：第 5 个会贴在卡片右边缘，和右上角的「逾期 N 条」挤在一起（实拍）。
  const ticks = Array.from({ length: 4 }, (_, i) => {
    const ms = (low + (span * i) / 3) * 86400000;
    return { left: (i / 3) * 100, label: new Date(ms).toISOString().slice(5, 10) };
  });
  return (
    <div data-testid="requirements-timeline" className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
      {dated.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-[var(--fg-muted)]" data-testid="timeline-empty">
          已加载的需求里都没有截止日期，先给需求补一个 due 再看时间线。
        </p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-3 pr-1 text-[10px] text-[var(--fg-dim)]">
            <span className="whitespace-nowrap">{dated.length} 条带截止日期的需求</span>
            <span className="whitespace-nowrap">逾期 {dated.filter(row => String(row.due).slice(0, 10) < today && row.column !== 'done').length} 条</span>
          </div>
          <div className="relative ml-[38%] h-4 border-b border-[var(--border)]">
            {ticks.map((tick, index) => (
              <span
                key={tick.left}
                className="absolute whitespace-nowrap text-[10px] text-[var(--fg-dim)]"
                style={{
                  // 贴边刻度改用 right 定位：left:100% 时绝对定位元素可用宽度为 0，文字会被折行
                  // 成「11-」/「20」，正好压到右上角的「逾期 N 条」上（实拍）。
                  ...(index === 0 ? { left: 0 } : index === ticks.length - 1 ? { right: 0 } : { left: `${tick.left}%`, transform: 'translateX(-50%)' }),
                  bottom: 2,
                }}
              >
                {tick.label}
              </span>
            ))}
          </div>
          <div className="relative">
            <span
              data-testid="timeline-today"
              aria-label={`今天 ${today}`}
              className="pointer-events-none absolute bottom-0 top-0 ml-[38%] w-px bg-[var(--hl)]/40"
              style={{ left: 0 }}
            />
            {dated.map(row => {
              const overdue = String(row.due).slice(0, 10) < today && row.column !== 'done';
              const startDay = row.start ? String(row.start).slice(0, 10) : null;
              const hasBar = !!startDay && startDay <= String(row.due).slice(0, 10);
              const barLeft = hasBar ? Math.max(2, Math.min(96, at(startDay as string))) : 0;
              const barRight = hasBar ? Math.max(2, Math.min(96, at(String(row.due)))) : 0;
              // 首尾都留 2%：贴边的点在圆角容器里会被切掉一半。
              const left = Math.max(2, Math.min(96, at(String(row.due))));
              // 行高至少 44px，标题链接撑满行高：手机上原来只有 16px 高的文字可点。
              return (
                // 整行都是链接：手机上用户会直接点条形/圆点，原来那 66% 的图表区域点了没反应。
                <Link key={row.id} href={`/requirements/${row.id}`} className="flex min-h-12 items-center gap-2 border-b border-[var(--border)]/60 text-gray-300 last:border-0 hover:bg-[var(--hover-tint)]" data-testid="timeline-row" data-column={row.column} title={row.name}>
                  <span className="flex w-[34%] shrink-0 items-center truncate text-xs">
                    <span className="mr-1 tabular-nums text-[10px] text-[var(--fg-dim)]">#{row.seq}</span>
                    {row.name}
                  </span>
                  <div className="relative h-5 flex-1">
                    {hasBar && (
                      <span
                        data-testid="timeline-bar"
                        data-from={startDay}
                        title={`${startDay} → ${String(row.due).slice(0, 10)}`}
                        className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full ${overdue ? 'bg-[var(--danger)]/35' : row.column === 'done' ? 'bg-[var(--fg-dim)]/35' : 'bg-[var(--accent)]/30'}`}
                        style={{ left: `${barLeft}%`, width: `${Math.max(0.6, barRight - barLeft)}%` }}
                      />
                    )}
                    <span
                      data-testid="timeline-dot"
                      data-overdue={overdue ? 'true' : undefined}
                      title={`${row.name} · 截止 ${String(row.due).slice(0, 10)}`}
                      className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${overdue ? 'bg-[var(--danger)]' : row.column === 'done' ? 'bg-[var(--fg-dim)]' : 'bg-[var(--accent)]'}`}
                      style={{ left: `${left}%` }}
                    />
                    <span
                      className={`absolute top-1/2 -translate-y-1/2 text-[10px] ${overdue ? 'text-[var(--danger)]' : 'text-[var(--fg-dim)]'}`}
                      style={left > 88 ? { right: `${100 - left}%`, marginRight: 8 } : { left: `${left}%`, marginLeft: 8 }}
                    >
                      {String(row.due).slice(5, 10)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
      {undated.length > 0 && (
        <p data-testid="timeline-undated" className="mt-2 text-[10px] text-[var(--fg-dim)]">
          另有 {undated.length} 条没有截止日期，未画在轴上。
        </p>
      )}
    </div>
  );
}


/** 汇总条：已加载需求的分布（状态 / 负责人 / 逾期）。
 *  和 APP 的「仪表盘」对齐的是"一眼看出这堆卡长什么样"，但这里只统计**已加载**的
 *  页（Hub 列表没有聚合接口），所以面板上必须写清分母，不能让人当成全网总量。 */
function SummaryPanel({ rows, labelFor, projects, onPickOwner, onPickProject }: {
  rows: Requirement[];
  labelFor: (person?: RequirementPerson | null) => string;
  projects: Array<{ id: string; name: string }>;
  onPickOwner: (person: RequirementPerson) => void;
  onPickProject: (projectId: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const statuses = [
    { key: 'pool' as const, label: '需求池', tone: 'bg-[var(--fg-dim)]' },
    { key: 'doing' as const, label: '进行中', tone: 'bg-[var(--accent)]' },
    { key: 'done' as const, label: '完成', tone: 'bg-[var(--ok,var(--accent))]' },
    { key: 'abandoned' as const, label: '已放弃', tone: 'bg-[var(--danger)]' },
  ];
  const counts = statuses.map(status => ({ ...status, value: rows.filter(row => row.column === status.key).length }));
  const overdue = rows.filter(row => row.due && String(row.due).slice(0, 10) < today && row.column !== 'done').length;
  const undated = rows.filter(row => !row.due).length;
  const byOwner = new Map<string, { label: string; total: number; done: number }>();
  for (const row of rows) {
    const key = row.owner ? `${row.owner.kind}:${row.owner.id}` : 'none';
    const entry = byOwner.get(key) ?? { label: row.owner ? labelFor(row.owner) : '未分配', total: 0, done: 0 };
    entry.total += 1;
    if (row.column === 'done') entry.done += 1;
    byOwner.set(key, entry);
  }
  const owners = [...byOwner.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  const widest = Math.max(1, ...owners.map(([, entry]) => entry.total));
  const projectNames = new Map(projects.map(project => [project.id, project.name]));
  const byProject = new Map<string, { label: string; total: number; done: number }>();
  for (const row of rows) {
    const key = row.project_id || 'none';
    const label = row.project_id ? (projectNames.get(row.project_id) ?? row.project_id) : '无项目';
    const entry = byProject.get(key) ?? { label, total: 0, done: 0 };
    entry.total += 1;
    if (row.column === 'done') entry.done += 1;
    byProject.set(key, entry);
  }
  const projectRows = [...byProject.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  const projectWidest = Math.max(1, ...projectRows.map(([, entry]) => entry.total));
  return (
    <section data-testid="requirements-summary" className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
      <div className="flex flex-wrap items-center gap-4">
        {counts.map(item => (
          <div key={item.key} data-testid={`summary-status-${item.key}`} data-count={item.value} className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <span className={`h-2 w-2 rounded-full ${item.tone}`} />
            {item.label}
            <span className="tabular-nums text-[var(--fg)]">{item.value}</span>
          </div>
        ))}
        <div data-testid="summary-overdue" data-count={overdue} className={`flex items-center gap-1.5 text-[11px] ${overdue ? 'text-[var(--danger)]' : 'text-[var(--fg-muted)]'}`}>
          逾期 <span className="tabular-nums">{overdue}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
          无截止日 <span className="tabular-nums">{undated}</span>
        </div>
      </div>
      <div data-testid="summary-owners" className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 2xl:grid-cols-3">
        {owners.map(([key, entry]) => (
          <button
            key={key}
            type="button"
            data-testid={`summary-owner-${key}`}
            disabled={key === 'none'}
            title={key === 'none' ? '没有负责人的需求不在这一行筛选' : `只看 ${entry.label}`}
            onClick={() => {
              const row = rows.find(item => (item.owner ? `${item.owner.kind}:${item.owner.id}` : 'none') === key);
              if (row?.owner) onPickOwner(row.owner);
            }}
            className="flex min-w-0 items-center gap-2 rounded text-left text-[11px] text-[var(--fg-muted)] transition-colors enabled:hover:bg-[var(--hover-tint)] enabled:hover:text-[var(--fg)] disabled:cursor-default"
          >
            <span className="w-20 shrink-0 truncate" title={entry.label}>{entry.label}</span>
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
              <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]/70" style={{ width: `${(entry.total / widest) * 100}%` }} />
            </span>
            <span className="w-9 shrink-0 text-right tabular-nums text-[var(--fg-dim)]">{entry.done}/{entry.total}</span>
          </button>
        ))}
      </div>
      {projectRows.length > 0 && (
        <div data-testid="summary-projects" className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 border-t border-[var(--border)]/60 pt-3 sm:grid-cols-2 2xl:grid-cols-3">
          {projectRows.map(([key, entry]) => (
            <button
              key={key}
              type="button"
              data-testid={`summary-project-${key}`}
              disabled={key === 'none'}
              title={key === 'none' ? '无项目的需求不在这一行筛选' : `只看项目 ${entry.label}`}
              onClick={() => onPickProject(key)}
              className="flex min-w-0 items-center gap-2 rounded text-left text-[11px] text-[var(--fg-muted)] transition-colors enabled:hover:bg-[var(--hover-tint)] enabled:hover:text-[var(--fg)] disabled:cursor-default"
            >
              <span className="w-20 shrink-0 truncate" title={entry.label}>{entry.label}</span>
              <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--info)]/60" style={{ width: `${(entry.total / projectWidest) * 100}%` }} />
              </span>
              <span className="w-9 shrink-0 text-right tabular-nums text-[var(--fg-dim)]">{entry.done}/{entry.total}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] text-[var(--fg-dim)]" data-testid="summary-scope">基于已加载的 {rows.length} 条（不是全网总量）；左侧数值是完成/总数。</p>
    </section>
  );
}

function RequirementsContent({ networkId }: { networkId: string }) {
  const searchParams = useSearchParams();

  const status = searchParams.get('status') || '';
  const tag = searchParams.get('tag') || '';
  const q = searchParams.get('q') || '';
  const project = searchParams.get('project_id') || '';
  const owner = searchParams.get('owner') || '';
  const agent = searchParams.get('agent_owner') || '';
  const includeArchived = searchParams.get('include_archived') !== '0';
  const searching = q.trim().length > 0;
  const board = searchParams.get('view') === 'board';
  const timeline = searchParams.get('view') === 'timeline';
  const summaryOpen = searchParams.get('summary') === '1';
  const treeMode = searchParams.get('tree') === '1';
  const [collapsedTree, setCollapsedTree] = useState<Set<string>>(new Set());
  const sortSpec = parseSort(searchParams);
  const overdue = searchParams.get('overdue') === '1';
  const meId = useCurrentUserId();
  // 「我负责」只认服务端签发的 user_id，认不出来就不显示这个胶囊。
  const mineOwner = meId ? ownerRefFor(meId) : null;
  const mine = !!mineOwner && owner === mineOwner && !agent;
  // 「我参与」是本地过滤：Hub 列表没有参与人查询参数，APP 也是过滤已加载项。
  const participant = searchParams.get('participant') || '';
  const participating = !!meId && participant === ownerRefFor(meId);
  // 优先级也只在已加载结果上筛（Hub 列表没有 priority 查询参数）。
  const priorityParam = searchParams.get('priority') || '';
  const priorities = useMemo(() => {
    if (!priorityParam) return null;
    const picked = priorityParam.split(',').filter(isPriorityKey);
    return picked.length ? new Set(picked) : null;
  }, [priorityParam]);

  // #1636: 替换态与追加态分开，追加时已加载的行不能进骨架屏。
  const [state, dispatch] = useReducer(
    requirementsPaging<Requirement>,
    undefined,
    initialPagingState<Requirement>,
  );
  const { rows, loading, loadingMore, error, needsLogin, cursor, hasMore } = state;
  // #1636 回归：追加只在完全空闲时放行；替换抢占旧请求并用代际号丢弃迟到回包。
  const gate = useRef(createLoadGate());
  const [tagInput, setTagInput] = useState(tag);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [qInput, setQInput] = useState(q);
  const [archiveSupported, setArchiveSupported] = useState<boolean | null>(null);
  const archiveSupport = useRef<boolean | null>(null);
  const pendingUrls = useRef(new Set<string>());
  const [projectSupported, setProjectSupported] = useState<boolean | null>(null);
  const [projectRefresh, setProjectRefresh] = useState(0);
  const [projectCatalog, setProjectCatalog] = useState<Array<{ id: string; name: string }>>([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState('');
  const [moveNotice, setMoveNotice] = useState('');
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  // 看板「按紧迫度」只是本地视图顺序，不影响 Hub 的 sort/dir，也不改任何数据。
  const [urgencySort, setUrgencySort] = useState(false);
  useEffect(() => {
    setUrgencySort(window.localStorage.getItem('requirements-urgency-sort') === '1');
  }, []);
  const toggleUrgencySort = () => {
    setUrgencySort(value => {
      const next = !value;
      window.localStorage.setItem('requirements-urgency-sort', next ? '1' : '0');
      return next;
    });
  };
  const [createNotice, setCreateNotice] = useState('');
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  const [showAbandoned, setShowAbandoned] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  // 手机上筛选区有 4 个控件 + 搜索，默认全展开会把内容推到折叠线以下；
  // 宽屏照旧全展开，手机上收进「筛选」。
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // 深链带着项目/责任归属/标签/归档参数进来时，这些筛选必须**自动展开**：
  // 否则手机上你看得见结果，却看不见「为什么只剩这几条」，也没法就地取消。
  // 注意不含 includeArchived：它默认就是开（include_archived !== '0'），
  // 算进来会让「自动展开」永远成立，收起就失效了。
  const extraFiltersActive = Boolean(project || owner || agent || tag);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // 批量操作期间按钮被 disabled，焦点会掉到 body。这里不按「原元素」恢复
  // （批量栏里的控件在刷新后会重建，元素引用失效），而是把焦点收回批量栏这个
  // 稳定锚点，用户能立刻继续下一次操作。
  const bulkBarRef = useRef<HTMLDivElement | null>(null);
  const prevBulkBusy = useRef(false);
  useEffect(() => {
    if (prevBulkBusy.current && !bulkBusy) restoreFocusAfterUnmount(() => bulkBarRef.current);
    prevBulkBusy.current = bulkBusy;
  }, [bulkBusy]);
  // 批量失败时把原因汇总：只报「第一条原因」会让人以为其余失败也是同一原因。
  const summarizeFailures = (failures: { error: string }[]) => {
    const byReason = new Map<string, number>();
    for (const item of failures) byReason.set(item.error, (byReason.get(item.error) ?? 0) + 1);
    return [...byReason.entries()].map(([reason, n]) => (n > 1 ? `${reason}（${n} 项）` : reason)).join('；');
  };

  const [bulkMessage, setBulkMessage] = useState('');
  const [bulkDue, setBulkDue] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const [bulkParticipant, setBulkParticipant] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [responsibilitySupported, setResponsibilitySupported] = useState<boolean | null>(null);
  const { catalog: peopleCatalog, retry: retryPeople } = useRequirementPeople(projectRefresh, networkId);
  const { catalog: tagCatalog, refresh: refreshTagCatalog } = useRequirementTags(networkId);
  const [tagOpsSupported, setTagOpsSupported] = useState(false);
  const [tagTreeSupported, setTagTreeSupported] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const personOptions = useMemo(() => peopleCatalog.status === 'ready' ? peopleOptions(peopleCatalog.people) : [], [peopleCatalog]);
  const personNames = useMemo(() => new Map(personOptions.map(p => [p.value, p.label])), [personOptions]);

  // Our actions update drafts immediately. Their later React renders must not
  // overwrite typing made since submission. External URL navigation still syncs.
  useEffect(() => {
    const pending = pendingUrls.current;
    const url = searchParams.toString();
    if (pending.has(url)) {
      for (const entry of pending) {
        pending.delete(entry);
        if (entry === url) break;
      }
      return;
    }
    pending.clear();
    setQInput(q);
    setTagInput(tag);
  }, [searchParams, q, tag]);

  useEffect(() => {
    const restore = () => {
      // Back/Forward is external even if it matches an unobserved local write.
      pendingUrls.current.clear();
      const params = new URLSearchParams(window.location.search);
      setQInput(params.get('q') || '');
      setTagInput(params.get('tag') || '');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  // 「/」聚焦搜索：和大多数列表页一致；在输入框/下拉里打字时不抢键。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 看板：焦点在卡片上时，↑/↓（或 j/k）在同一列内上下移动；Enter 由链接自身处理。
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'j' || event.key === 'k') {
        const card = (document.activeElement as HTMLElement | null)?.closest?.('[data-board-card]');
        if (card) {
          const columnKey = card.getAttribute('data-column');
          const cards = Array.from(document.querySelectorAll<HTMLElement>(`[data-board-card][data-column="${columnKey}"]`));
          const from = cards.indexOf(card as HTMLElement);
          if (from >= 0) {
            const forward = event.key === 'ArrowDown' || event.key === 'j';
            const next = Math.max(0, Math.min(cards.length - 1, from + (forward ? 1 : -1)));
            if (next !== from) {
              event.preventDefault();
              event.stopImmediatePropagation();
              cards[next].querySelector<HTMLElement>('a[href^="/requirements/"]')?.focus();
              return;
            }
          }
        }
      }
      // 列表行漫游：焦点在行上时 j/k 与 ↑/↓ 等价（roving index，见上面的 effect）。
      if (event.key === 'j' || event.key === 'k' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const active = document.activeElement as HTMLElement | null;
        const onRow = !!active?.closest?.('a[data-req-row]');
        if (!onRow && rowIndex === null) return;
        const rows = reqRows();
        if (!rows.length) return;
        const fromDom = active ? rows.indexOf(active as HTMLAnchorElement) : -1;
        const base = fromDom >= 0 ? fromDom : (rowIndex ?? -1);
        const delta = (event.key === 'j' || event.key === 'ArrowDown') ? 1 : -1;
        const next = Math.max(0, Math.min(rows.length - 1, base + delta));
        event.preventDefault();
        event.stopImmediatePropagation();
        rowFocusPending.current = true;
        setRowIndex(next);
        return;
      }
      // w：切换「本周内」本地筛选（和工具栏那枚统计同一个动作，只是不用鼠标）。
      if (event.key === 'w' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const el = event.target as HTMLElement | null;
        const elTag = el?.tagName;
        if (elTag === 'INPUT' || elTag === 'TEXTAREA' || elTag === 'SELECT' || el?.isContentEditable) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // 这个监听器只在挂载时注册一次，闭包里的 weekOnly 是旧值——按一次 w 之后就再也关不掉，
        // 所以从当前 URL 现读状态，而不是相信注册时的快照。
        const weekOn = new URLSearchParams(window.location.search).get('week') === '1';
        setParam({ week: weekOn ? '' : '1' });
        return;
      }
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('anet-requirements-board-collapsed');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) setCollapsedColumns(new Set(parsed.filter(key => typeof key === 'string')));
    } catch { /* ignore malformed preferences */ }
  }, []);

  const toggleBulkMode = () => {
    setBulkMode(value => {
      if (value) { setSelectedIds(new Set()); setBulkMessage(''); setBulkError(''); }
      return !value;
    });
  };

  const toggleColumn = useCallback((key: string) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem('anet-requirements-board-collapsed', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const setParam = useCallback((patch: Record<string, string>) => {
    setSelectedIds(new Set());
    // This page fetches on the client. Next's native history integration makes
    // the real URL authoritative immediately, without a cancellable RSC trip.
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const qs = next.toString();
    if ('q' in patch) setQInput(patch.q);
    if ('tag' in patch) setTagInput(patch.tag);
    pendingUrls.current.delete(qs);
    pendingUrls.current.add(qs);
    window.history.replaceState(null, '', qs ? `/requirements?${qs}` : '/requirements');
  }, []);

  // 空态文案与「清空筛选」按钮共用这一份推导：以前是同一串布尔值抄了三遍，
  // 加一个筛选维度就得改三处，而且「清空筛选」只在结果为空时够得着——
  // 同时开着项目+标签+责任归属时，用户只能一个个点掉。
  const activeFilterLabels = [
    status && '状态',
    tag && '标签',
    q && '搜索',
    project && '项目',
    (owner || agent) && '责任归属',
    overdue && '已逾期',
    participating && '我参与',
    priorities && '优先级',
  ].filter(Boolean) as string[];
  const hasActiveFilters = activeFilterLabels.length > 0;

  // 「加载更多」的可达性：① 追加完要有状态播报（读屏用户否则完全不知道又来了几条）；
  // ② 走到最后一页时那个按钮会消失，键盘焦点不能掉到 body。
  const [loadNotice, setLoadNotice] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);
  const prevLoadingMore = useRef(false);
  useEffect(() => {
    if (prevLoadingMore.current && !loadingMore) {
      setLoadNotice(`已加载 ${rows.length} 条${hasMore ? '，还有更多' : '，已到末尾'}`);
      // 加载时按钮是先置灰的（disabled 会让焦点掉到 body），所以：
      // 还有下一页就把焦点还给按钮；到底了（按钮已被卸载）就收回到列表容器。
      restoreFocusAfterUnmount(() => (hasMore ? loadMoreRef.current : listRef.current));
    }
    prevLoadingMore.current = loadingMore;
  }, [loadingMore, rows.length, hasMore]);

  // 列表行的键盘漫游：`j`/`k` 或 ↑/↓ 逐条走，roving index + 渲染后聚焦
  // （直接 focus(next) 会在列表重排时被替换掉——见 nodes 页那次的教训）。
  const [rowIndex, setRowIndex] = useState<number | null>(null);
  const rowFocusPending = useRef(false);
  const reqRows = () => [...document.querySelectorAll<HTMLAnchorElement>('a[data-req-row]')]
    .filter(el => el.getClientRects().length > 0);
  useEffect(() => {
    if (!rowFocusPending.current || rowIndex === null) return;
    rowFocusPending.current = false;
    const raf = requestAnimationFrame(() => {
      const rows = reqRows();
      const el = rows[Math.min(rowIndex, Math.max(0, rows.length - 1))];
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [rowIndex, rows.length]);

  // 详情页的「上一条/下一条」要沿用这里的筛选：把最近一次的查询串存下来
  // （只存筛选，不含视图开关），离开列表后详情页据此取同一份列表。
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      for (const key of ['view', 'summary', 'tree']) params.delete(key);
      window.sessionStorage.setItem('anet_req_list_query', params.toString());
    } catch {}
  }, [searchParams]);

  const clearFilters = () => {
    setPeopleQuery('');
    // 「清空筛选」按完，这个按钮自己就消失了；不接管焦点的话会掉回 body，
    // 键盘用户得从头 Tab 一遍。统一走已有的焦点兜底，落到搜索框上（下一步最可能操作的地方）。
    restoreFocusAfterUnmount(() => searchInputRef.current);
    setParam({ status: '', tag: '', q: '', project_id: '', owner: '', agent_owner: '', overdue: '', participant: '', priority: '' });
  };


  const load = useCallback(async (opts: { cursor?: string | null; append?: boolean; silent?: boolean } = {}) => {
    const nextCursor = opts.cursor ?? null;
    let phase: 'append' | 'replace' = opts.append === true ? 'append' : 'replace';
    // 闸门在 dispatch 之前：被拒绝的追加不进入加载态，也不发请求。
    const gen = gate.current.begin(phase);
    if (gen === null) return;
    // 静默刷新（看板移动后的对账）不出骨架屏，也不在失败时清空已加载行。
    if (!opts.silent) dispatch({ type: 'start', phase });
    try {
      if (!validResponsibility(owner, agent)) throw new Error('URL 中的负责人或 Agent 角色格式无效，请清空责任归属');
      const params = new URLSearchParams({ network_id: networkId });
      if (status) params.set('status', status);
      if (tag) params.set('tag', tag);
      if (q) params.set('q', q);
      if (project) params.set('project_id', project);
      if (owner) params.set('owner', owner);
      if (agent) params.set('agent_owner', agent);
      if (overdue) params.set('overdue', '1');
      const wantsArchives = searching && includeArchived;
      if (wantsArchives && archiveSupport.current === true) params.set('include_archived', '1');
      params.set('limit', '200');
      if (nextCursor) params.set('cursor', nextCursor);
      let res = await fetch(`/api/hub/requirements?${params.toString()}`, { cache: 'no-store' });
      // 已被更新的一次加载取代（换筛选/重复刷新）：这个回包整份作废。
      if (!gate.current.isCurrent(gen)) return;
      if (res.status === 401) { dispatch({ type: 'unauthorized', phase }); return; }
      let data = await res.json();
      if (!gate.current.isCurrent(gen)) return;
      if (!res.ok || !data.ok) {
        if (opts.silent) return;
        dispatch({ type: 'failed', phase, error: data?.error || `hub_${res.status}` });
        return;
      }
      const checkProjects = (caps: unknown) => {
        const supported = Array.isArray(caps) && caps.includes('projects');
        setProjectSupported(supported);
        // A legacy Hub may ignore unknown filters. Never label all rows as a
        // successful project-filtered result, including a direct URL visit.
        if (project && !supported) throw new Error('当前 Hub 未提供项目筛选能力，请清空项目筛选后重试');
        const roles = Array.isArray(caps) && caps.includes('agent_owner');
        setResponsibilitySupported(roles);
        setTagOpsSupported(Array.isArray(caps) && caps.includes('tag_ops'));
        setTagTreeSupported(Array.isArray(caps) && caps.includes('tag_tree'));
        if ((owner || agent) && !roles) throw new Error('当前 Hub 未提供双角色筛选能力，请清空责任归属后重试');
      };
      checkProjects(data.capabilities);
      const supportsArchives = (caps: unknown) => Array.isArray(caps) && caps.includes('archived') && caps.includes('search');
      const supported = supportsArchives(data.capabilities);
      archiveSupport.current = supported;
      setArchiveSupported(supported);
      // Learn capability from a normal read before sending the archive option.
      // Negotiate inside this generation so the preliminary page is never shown
      // as an archive-inclusive result, and late responses cannot change the UI.
      if (params.has('include_archived') !== (wantsArchives && supported)) {
        if (wantsArchives && supported) params.set('include_archived', '1');
        else params.delete('include_archived');
        // A changed capability also changes the query: never reuse its cursor.
        params.delete('cursor');
        phase = 'replace';
        dispatch({ type: 'start', phase });
        res = await fetch(`/api/hub/requirements?${params.toString()}`, { cache: 'no-store' });
        if (!gate.current.isCurrent(gen)) return;
        if (res.status === 401) { dispatch({ type: 'unauthorized', phase }); return; }
        data = await res.json();
        if (!gate.current.isCurrent(gen)) return;
        if (!res.ok || !data.ok) {
          if (!opts.silent) dispatch({ type: 'failed', phase, error: data?.error || `hub_${res.status}` });
          return;
        }
        checkProjects(data.capabilities);
        const confirmed = supportsArchives(data.capabilities);
        archiveSupport.current = confirmed;
        setArchiveSupported(confirmed);
        if (confirmed !== supported) throw new Error('搜索能力已变化，请重试');
      }
      const incoming = (data.requirements || []) as Requirement[];
      const nextCursorValue = typeof data.next_cursor === 'string' ? data.next_cursor : null;
      dispatch({
        type: 'loaded',
        phase,
        incoming,
        nextCursor: nextCursorValue,
        hasMore: data.has_more === true && nextCursorValue !== null,
      });
    } catch (e: unknown) {
      if (!gate.current.isCurrent(gen)) return;
      if (opts.silent) return;
      dispatch({ type: 'failed', phase, error: e instanceof Error ? e.message : 'fetch failed' });
    } finally {
      gate.current.settle(gen);
    }
  }, [networkId, status, tag, q, project, owner, agent, overdue, searching, includeArchived]);

  useEffect(() => {
    void load();
    const currentGate = gate.current;
    // Unmounting on a network change also invalidates a pending archive
    // negotiation, so it cannot issue a follow-up read for the old network.
    return () => { currentGate.begin('replace'); };
  }, [load]);

  const columnOf = useCallback((row: Requirement) => columnOverrides[row.id] ?? row.column, [columnOverrides]);

  const moveCard = useCallback(async (row: Requirement, column: Requirement['column']) => {
    const from = columnOverrides[row.id] ?? row.column;
    if (column === from) return;
    setMovingId(row.id);
    setMoveError('');
    setMoveNotice('');
    setColumnOverrides(prev => ({ ...prev, [row.id]: column }));
    const revert = () => setColumnOverrides(prev => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    try {
      const res = await fetch(`/api/hub/requirements/${encodeURIComponent(row.id)}?network_id=${encodeURIComponent(networkId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        revert();
        setMoveError(`移动失败：${data?.error || `hub_${res.status}`}`);
        return;
      }
      revert();
      setMoveNotice(`已移到 ${COLUMNS.find(item => item.key === column)?.label ?? column}`);
      // 静默对账：不闪骨架屏，也不掩盖后续读取失败。
      await load({ silent: true });
    } catch {
      revert();
      setMoveError('移动失败：网络错误');
    } finally {
      setMovingId(null);
    }
  }, [columnOverrides, load, networkId]);

  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map(row => row.id));
      const next = new Set([...prev].filter(id => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** 批量打/去标签：每张卡的 tags 不同，必须按卡计算目标数组再逐张写。
   *  超过 Hub 的 10 个上限时只跳过那一张，并在提示里说明，不静默截断。 */
  /** 批量参与者：把一个人/Agent 加进每张卡（已存在则跳过），或从每张卡移出。
   *  参与者是整表替换语义，所以按卡算好目标数组再写，不能直接发送增量。 */
  const bulkParticipantChange = async (mode: 'add' | 'remove', ref: string) => {
    const ids = [...selectedIds];
    if (!ref || !ids.length || bulkBusy) return;
    const [kind, ...rest] = ref.split(':');
    const target = { kind, id: rest.join(':') };
    if (!target.id) return;
    setBulkBusy(true);
    setBulkMessage('');
    setBulkError('');
    const failures: Array<{ id: string; error: string }> = [];
    let changed = 0;
    for (const id of ids) {
      const row = rows.find(item => item.id === id);
      const current = row?.participants || [];
      const exists = current.some(item => item.kind === target.kind && item.id === target.id);
      if (mode === 'add' && exists) { changed += 1; continue; }
      if (mode === 'remove' && !exists) { changed += 1; continue; }
      const next = mode === 'add'
        ? [...current, target]
        : current.filter(item => !(item.kind === target.kind && item.id === target.id));
      try {
        const res = await fetch(`/api/hub/requirements/${encodeURIComponent(id)}?network_id=${encodeURIComponent(networkId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participants: next }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) failures.push({ id, error: data?.message || data?.error || `hub_${res.status}` });
        else changed += 1;
      } catch {
        failures.push({ id, error: '网络错误' });
      }
    }
    if (failures.length) {
      setBulkError(`成功 ${changed} 项，失败 ${failures.length} 项：${summarizeFailures(failures)}`);
      setSelectedIds(new Set(failures.map(item => item.id)));
    } else {
      setBulkMessage(mode === 'add' ? `已把 ${changed} 项加入参与者` : `已从 ${changed} 项移出参与者`);
      setSelectedIds(new Set());
    }
    if (changed) await load({ silent: true });
    setBulkBusy(false);
  };

  const bulkTagChange = async (mode: 'add' | 'remove') => {
    const tag = bulkTag.trim();
    const ids = [...selectedIds];
    if (!tag || !ids.length || bulkBusy) return;
    setBulkBusy(true);
    setBulkMessage('');
    setBulkError('');
    const failures: Array<{ id: string; error: string }> = [];
    let changed = 0;
    for (const id of ids) {
      const row = rows.find(item => item.id === id);
      const current = row?.tags || [];
      const next = mode === 'add'
        ? (current.includes(tag) ? current : [...current, tag])
        : current.filter(item => item !== tag);
      if (next.length > 10) { failures.push({ id, error: `「${tag}」超出每条 10 个标签的上限` }); continue; }
      if (next.length === current.length) { changed += 1; continue; }
      try {
        const res = await fetch(`/api/hub/requirements/${encodeURIComponent(id)}?network_id=${encodeURIComponent(networkId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: next }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) failures.push({ id, error: data?.message || data?.error || `hub_${res.status}` });
        else changed += 1;
      } catch {
        failures.push({ id, error: '网络错误' });
      }
    }
    if (failures.length) {
      setBulkError(`成功 ${changed} 项，失败 ${failures.length} 项：${summarizeFailures(failures)}`);
      setSelectedIds(new Set(failures.map(item => item.id)));
    } else {
      setBulkMessage(mode === 'add' ? `已给 ${changed} 项加上「${tag}」` : `已从 ${changed} 项移除「${tag}」`);
      setSelectedIds(new Set());
    }
    if (changed) await load({ silent: true });
    setBulkBusy(false);
  };

  const bulkPatch = async (fields: Record<string, unknown>) => {
    const ids = [...selectedIds];
    if (!ids.length || bulkBusy) return;
    setBulkBusy(true);
    setBulkMessage('');
    setBulkError('');
    const results = await Promise.all(ids.map(async id => {
      try {
        const res = await fetch(`/api/hub/requirements/${encodeURIComponent(id)}?network_id=${encodeURIComponent(networkId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        });
        const data = await res.json().catch(() => ({}));
        return { id, error: res.ok && data.ok !== false ? null : (data?.message || data?.error || `hub_${res.status}`) };
      } catch {
        return { id, error: '网络错误' };
      }
    }));
    const failures = results.filter(result => result.error);
    if (failures.length) {
      setBulkError(`成功 ${ids.length - failures.length} 项，失败 ${failures.length} 项：${summarizeFailures(failures)}`);
      setSelectedIds(new Set(failures.map(item => item.id)));
    } else {
      setBulkMessage(`已更新 ${ids.length} 项`);
      setSelectedIds(new Set());
    }
    if (failures.length < ids.length) await load({ silent: true });
    setBulkBusy(false);
  };

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.column] = (out[r.column] || 0) + 1;
    return out;
  }, [rows]);

  // 「我参与」在已加载结果上过滤；其它筛选仍交给 Hub。参与人只认 user 角色，
  // 与 APP 的 personKey 语义一致。
  const weekOnly = searchParams.get('week') === '1';
  // 返回锚点：进详情前记下是哪一行；回来时把焦点放回那一行（浏览器会顺带把它带进视口），
  // 长列表里不至于每次都从顶部重新找。只记一行，不存滚动像素——窗口高度一变像素就没有意义。
  const rememberRowAnchor = useCallback((rowId: string) => {
    try {
      sessionStorage.setItem('requirements-return-anchor', JSON.stringify({ rowId, query: searchParams.toString() }));
    } catch { /* 隐私模式下写不了就放弃恢复，不影响导航 */ }
  }, [searchParams]);

  useEffect(() => {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem('requirements-return-anchor'); } catch { return; }
    if (!raw) return;
    let marker: { rowId?: string; query?: string } = {};
    try { marker = JSON.parse(raw); } catch { return; }
    if (!marker.rowId || marker.query !== searchParams.toString()) return;
    const rowId = marker.rowId;
    // 行是异步加载的，等它出现再接管焦点；最多等 2 秒，拿不到就算了。
    let tries = 0;
    let timer = 0 as unknown as ReturnType<typeof setTimeout>;
    const attempt = () => {
      const el = document.querySelector<HTMLElement>(`a[data-req-row][href^="/requirements/${rowId}?"], a[data-req-row][href="/requirements/${rowId}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: 'center' });
        try { sessionStorage.removeItem('requirements-return-anchor'); } catch { /* 忽略 */ }
        return;
      }
      tries += 1;
      if (tries < 20) timer = setTimeout(attempt, 100);
    };
    attempt();
    return () => clearTimeout(timer);
    // 只在首次挂载时尝试一次：之后用户自己滚动/切换筛选不该被拽回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点进详情再返回时，列表的筛选/搜索/看板状态不能丢——把当前查询串塞进 from。
  const rowHref = useCallback((rowId: string) => {
    const query = searchParams.toString();
    return query ? `/requirements/${rowId}?from=${encodeURIComponent(query)}` : `/requirements/${rowId}`;
  }, [searchParams]);
  const participatingRows = useMemo(
    () => rows.filter(row => {
      if (participating && meId && !(row.participants || []).some(person => person.kind === 'user' && person.id === meId)) return false;
      if (priorities && !priorities.has(row.priority)) return false;
      if (weekOnly) {
        const plan = planHealth(row.start, row.due, new Date(), row.column === 'done' || row.column === 'abandoned');
        if (!plan?.thisWeek) return false;
      }
      return true;
    }),
    [rows, participating, meId, priorities, weekOnly],
  );
  const orderedRows = useMemo(
    () => sortRequirements(participatingRows, sortSpec),
    // sortSpec is derived from searchParams each render; depend on its values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [participatingRows, sortSpec.key, sortSpec.dir],
  );

  // 已加载范围内的紧迫统计：只数当前这批结果，不冒充全库总量（面板里已有同样口径的提示）。
  const loadedUrgency = useMemo(() => {
    let overdue = 0;
    let thisWeek = 0;
    for (const row of rows) {
      const plan = planHealth(row.start, row.due, new Date(), row.column === 'done' || row.column === 'abandoned');
      if (!plan) continue;
      if (plan.kind === 'overdue') overdue += 1;
      else if (plan.thisWeek) thisWeek += 1;
    }
    return { overdue, thisWeek };
  }, [rows]);

  // 「按紧迫度」：列表和看板共用同一份排序结果，避免两个视图各排各的。
  // 只影响显示顺序——不参与 sortRequirements 的服务器排序，也不写任何数据。
  const rankOfRow = (row: Requirement) =>
    planHealthRank(planHealth(row.start, row.due, new Date(), row.column === 'done' || row.column === 'abandoned'));
  const viewRows = useMemo(
    () => (urgencySort && !treeMode ? [...orderedRows].sort((a, b) => rankOfRow(a) - rankOfRow(b)) : orderedRows),
    // rankOfRow 是纯函数式闭包，依赖只看这三项即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [urgencySort, treeMode, orderedRows],
  );

  // 树状视图：只在列表里生效，按 parent_id 在已加载行上分组；父不在本页的行仍当根。
  const treeRows = useMemo(
    () => (treeMode ? buildTreeRows(orderedRows, collapsedTree) : null),
    [treeMode, orderedRows, collapsedTree],
  );

  return (
    <div data-requirements-root className="min-h-screen bg-[var(--bg)] text-gray-200">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-white">Requirements</h1>
            {/* 手机首屏寸土寸金：副标题与说明优先让位给第一条需求（实测第一条被推到 741px）。 */}
            <p className="mt-1 hidden text-xs text-[var(--fg-muted)] sm:block">
              只读视图。派单在 <Link href="/tasks" className="text-[var(--hl)] hover:underline">Tasks</Link>。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-[var(--fg-muted)]">
              <span className="hidden sm:inline">排序</span>
              <select
                aria-label="排序"
                value={sortSpec.key}
                onChange={event => setParam({ sort: event.target.value, dir: event.target.value ? sortSpec.dir : '' })}
                title="排序只作用于已加载结果，不会改变 Hub 的全量顺序"
                className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-[11px] text-[var(--fg)]"
              >
                <option value="">默认</option>
                {SORT_KEYS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <button
              type="button"
              aria-label="切换排序方向"
              disabled={!sortSpec.key}
              onClick={() => setParam({ sort: sortSpec.key, dir: sortSpec.dir === 'asc' ? 'desc' : 'asc' })}
              className="rounded border border-[var(--border)] px-1.5 py-1 text-[11px] text-[var(--fg-muted)] disabled:opacity-40"
            >
              {sortSpec.dir === 'asc' ? '↑' : '↓'}
            </button>
            {/* 放在共用工具栏里：列表和看板都要能用（树状/时间线有各自顺序，不掺和）。 */}
            {!treeMode && !timeline && (
              <button
                type="button"
                data-testid="requirements-urgency-sort"
                aria-pressed={urgencySort}
                title="只调整已加载条目的显示顺序（超期 → 今天 → 3 天内 → 其余），不改服务器排序，也不写任何数据"
                onClick={toggleUrgencySort}
                className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${urgencySort ? 'bg-[var(--bg-elevated)] text-[var(--danger)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200'}`}
              >
                按紧迫度
              </button>
            )}
            <CreateRequirement
              networkId={networkId}
              onCreated={seq => {
                setCreateNotice(seq ? `已创建需求 #${seq}` : '已创建需求');
                void load();
              }}
            />
            <div role="group" aria-label="视图切换" className="flex flex-wrap items-center gap-0.5 rounded-md border border-[var(--border)] p-0.5">
              {[{ key: '', label: '列表', test: 'list' }, { key: 'board', label: '看板', test: 'board' }, { key: 'timeline', label: '时间线', test: 'timeline' }].map(option => {
                const active = timeline ? option.key === 'timeline' : (option.key === 'board') === board;
                return (
                  <button
                    key={option.test}
                    type="button"
                    aria-pressed={active}
                    data-testid={`requirements-view-${option.test}`}
                    onClick={() => setParam({ view: option.key })}
                    className={`whitespace-nowrap rounded px-2.5 py-1 text-xs transition-colors ${active ? 'bg-[var(--bg-elevated)] text-gray-100' : 'text-[var(--fg-muted)] hover:text-gray-200'}`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              aria-pressed={summaryOpen}
              aria-expanded={summaryOpen}
              data-testid="requirements-summary-toggle"
              title="统计已加载结果的分布（不是全网总量）"
              onClick={() => setParam({ summary: summaryOpen ? '' : '1' })}
              className={`whitespace-nowrap rounded-md border px-2 py-1 text-xs transition-colors ${summaryOpen ? 'border-[var(--accent)] text-[var(--accent-text)]' : 'border-[var(--border)] text-[var(--fg-muted)] hover:text-gray-200'}`}
            >
              汇总
            </button>
            <button
              type="button"
              aria-pressed={treeMode}
              data-testid="requirements-view-tree"
              title="按 parent_id 在已加载结果里分层显示"
              onClick={() => setParam({ tree: treeMode ? '' : '1', q: qInput, tag: tagInput })}
              className={`whitespace-nowrap rounded-md border px-2 py-1 text-xs transition-colors ${treeMode ? 'border-[var(--accent)] text-[var(--accent-text)]' : 'border-[var(--border)] text-[var(--fg-muted)] hover:text-gray-200'}`}
            >
              树状
            </button>
          <button
            type="button"
            onClick={() => { setProjectRefresh(n => n + 1); void load(); }}
            className="hidden rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] transition-colors hover:bg-[var(--hover-tint)] hover:text-gray-200 sm:block"
          >
            Refresh
          </button>
          </div>
        </div>

        {/* Status tabs */}
        <div className="mb-4 flex flex-wrap items-center gap-1.5" aria-label="状态筛选，数量为当前已加载结果">
          {COLUMNS.map(col => {
            const count = col.key ? counts[col.key] || 0 : rows.length;
            const active = status === col.key;
            return (
              <button
                key={col.key || 'all'}
                type="button"
                onClick={() => setParam({ status: col.key })}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  active
                    ? 'bg-[var(--bg-elevated)] text-gray-100'
                    : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200'
                }`}
              >
                {col.label}
                <span className="ml-1.5 text-[10px] tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>

        <div className={`mb-4 flex-wrap items-center gap-1.5 sm:flex ${mobileFiltersOpen || extraFiltersActive ? 'flex' : 'hidden'}`}>
          <button
            type="button"
            aria-pressed={overdue}
            data-testid="requirements-overdue-toggle"
            onClick={() => setParam({ overdue: overdue ? '' : '1', q: qInput, tag: tagInput })}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${overdue ? 'bg-[var(--bg-elevated)] text-[var(--danger)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200'}`}
          >
            已逾期
          </button>
          <span className="text-[10px] text-[var(--fg-dim)]">未完成且截止已过</span>
          {(loadedUrgency.overdue > 0 || loadedUrgency.thisWeek > 0) && (
            <span
              data-testid="requirements-loaded-urgency"
              data-overdue={loadedUrgency.overdue}
              data-this-week={loadedUrgency.thisWeek}
              title="只统计当前已加载的结果，不是全网总量"
              className="ml-1 inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] tabular-nums text-[var(--fg-muted)]"
            >
              <span className="text-[var(--fg-dim)]">已加载中</span>
              {loadedUrgency.overdue > 0 && <span className="text-[var(--danger)]">超期 {loadedUrgency.overdue}</span>}
              {loadedUrgency.overdue > 0 && loadedUrgency.thisWeek > 0 && <span className="text-[var(--fg-dim)]">·</span>}
              {loadedUrgency.thisWeek > 0 && (
                <button
                  type="button"
                  data-testid="requirements-week-toggle"
                  aria-pressed={weekOnly}
                  title="只看这批已加载结果里本周内到期的（本地筛选，不重新请求）"
                  onClick={() => setParam({ week: weekOnly ? '' : '1' })}
                  className={`rounded px-1 transition-colors ${weekOnly ? 'bg-[var(--bg-elevated)] text-[var(--warning)]' : 'text-[var(--warning)] hover:bg-[var(--hover-tint)]'}`}
                >
                  本周内 {loadedUrgency.thisWeek}
                </button>
              )}
            </span>
          )}
          {mineOwner && (
            <button
              type="button"
              aria-pressed={mine}
              data-testid="requirements-mine-toggle"
              title="只筛负责人是我的需求（不含我参与的）"
              onClick={() => setParam(mine ? { owner: '', agent_owner: '' } : { owner: mineOwner, agent_owner: '' })}
              className={`ml-2 rounded-md px-3 py-1.5 text-xs transition-colors ${mine ? 'bg-[var(--bg-elevated)] text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200'}`}
            >
              我负责
            </button>
          )}
          {mineOwner && (
            <button
              type="button"
              aria-pressed={participating}
              data-testid="requirements-participating-toggle"
              title="在已加载的结果里筛参与人是我；Hub 列表没有参与人查询参数"
              onClick={() => setParam({ participant: participating ? '' : mineOwner, q: qInput, tag: tagInput })}
              className={`rounded-md px-3 py-1.5 text-xs transition-colors ${participating ? 'bg-[var(--bg-elevated)] text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200'}`}
            >
              我参与
            </button>
          )}
          {participating && (
            <span className="text-[10px] text-[var(--fg-dim)]" data-testid="requirements-participating-hint">
              只筛已加载的 {rows.length} 条
            </span>
          )}
          <span className="ml-2 flex items-center gap-1" data-testid="requirements-priority-chips">
            <span className="text-[10px] text-[var(--fg-dim)]">优先级</span>
            {PRIORITIES.map(value => {
              const on = priorities?.has(value) ?? false;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  data-testid={`requirements-priority-${value}`}
                  title={`在已加载结果里筛 ${priorityLabel(value)}（${value}）；Hub 列表没有优先级查询参数`}
                  onClick={() => {
                    const next = new Set(priorities ?? []);
                    if (next.has(value)) next.delete(value); else next.add(value);
                    setParam({ priority: [...next].join(','), q: qInput, tag: tagInput });
                  }}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${on ? 'bg-[var(--bg-elevated)] text-[var(--accent-text)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200'}`}
                >
                  {priorityLabel(value)}
                </button>
              );
            })}
          </span>
          {priorities && (
            <span className="text-[10px] text-[var(--fg-dim)]" data-testid="requirements-priority-hint">
              只筛已加载的 {rows.length} 条
            </span>
          )}
          {weekOnly && (
            <span className="text-[10px] text-[var(--fg-dim)]" data-testid="requirements-week-hint">
              只筛已加载的 {rows.length} 条中的本周内
            </span>
          )}
          {hasActiveFilters && (
            <button
              type="button"
              data-testid="requirements-clear-filters"
              onClick={clearFilters}
              title={`清空这些筛选：${activeFilterLabels.join('、')}`}
              className="ml-auto rounded-md px-2.5 py-1.5 text-xs text-[var(--fg-muted)] underline decoration-dotted underline-offset-2 hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              清空筛选
              <span className="ml-1 tabular-nums text-[var(--fg-dim)]" data-testid="requirements-active-filter-count">{activeFilterLabels.length}</span>
            </button>
          )}
        </div>

        {summaryOpen && (
          <SummaryPanel
            rows={orderedRows}
            projects={projectCatalog}
            labelFor={person => (person ? personNames.get(`${person.kind}:${person.id}`) || person.alias || person.id : '未分配')}
            onPickOwner={person => setParam({ ...responsibilityPatch(`${person.kind}:${person.id}`), q: qInput, tag: tagInput })}
            onPickProject={id => setParam({ project_id: id, q: qInput, tag: tagInput })}
          />
        )}

        <div className="mb-2 flex items-center gap-1.5 sm:hidden">
          <button
            type="button"
            data-testid="requirements-mobile-filters"
            aria-expanded={mobileFiltersOpen}
            onClick={() => setMobileFiltersOpen(v => !v)}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]"
          >
            {mobileFiltersOpen ? '收起筛选' : `筛选${activeFilterLabels.length ? `（${activeFilterLabels.length}）` : ''}`}
          </button>
          {/* 手机上 Refresh 为省首屏被隐藏了，但手动刷新不能没有：这里补一个等效入口。 */}
          <button
            type="button"
            data-testid="requirements-mobile-refresh"
            aria-label="刷新需求列表"
            onClick={() => { setProjectRefresh(n => n + 1); void load(); }}
            className="min-h-9 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)]"
          >
            刷新
          </button>
        </div>
        <div className={mobileFiltersOpen || extraFiltersActive ? 'contents' : 'hidden sm:contents'} data-testid="requirements-mobile-filter-panel">
        <ProjectFilter
          networkId={networkId}
          value={project}
          supported={projectSupported}
          refreshKey={projectRefresh}
          onCatalog={setProjectCatalog}
          onChange={value => setParam({ project_id: value, q: qInput, tag: tagInput })}
        />

        <ResponsibilityFilter owner={owner} agent={agent} supported={responsibilitySupported}
          query={peopleQuery} onQueryChange={setPeopleQuery}
          catalog={peopleCatalog} options={personOptions} onRetry={retryPeople}
          onChange={value => setParam({ ...responsibilityPatch(value), q: qInput, tag: tagInput })} />
        </div>

        {/* Text filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 focus-within:border-[var(--border-hover)]">
            <input
              ref={searchInputRef}
              title="按 / 聚焦搜索"
              value={qInput}
              onChange={e => setQInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { setParam({ q: qInput }); return; }
                // Esc：有内容先清空并撤掉 URL 里的 q；已经空了就离开输入框。
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (qInput) { setQInput(''); setParam({ q: '' }); }
                  else e.currentTarget.blur();
                }
              }}
              onBlur={() => { if (qInput !== q) setParam({ q: qInput }); }}
              placeholder="搜索标题 / 人 / 标签"
              aria-label="搜索需求"
              className="w-40 bg-transparent text-sm text-white placeholder-gray-700 focus:outline-none sm:w-56"
            />
            {/* 这个搜索要回车（或失焦）才生效，且服务端筛选；不提示的话用户会以为「输入了没反应」。
                提示常驻占位、只切可见性：它一旦按条件插入/移除，输入框区域就会伸缩，
                点击紧邻的「清空筛选」时那一下会被挤空（实测：失焦写入草稿的同一帧里点击落空）。 */}
            <span
              data-testid="requirements-search-pending"
              aria-hidden={!(qInput && qInput !== q)}
              className={`text-[10px] text-[var(--fg-dim)] ${qInput && qInput !== q ? 'visible' : 'invisible'}`}
            >回车搜索</span>
            {qInput && (
              <button
                type="button"
                data-testid="requirements-search-clear"
                aria-label="清空搜索"
                onClick={() => { setQInput(''); setParam({ q: '', tag: tagInput }); searchInputRef.current?.focus(); }}
                className="rounded px-1 text-xs text-[var(--fg-dim)] hover:text-[var(--fg)]"
              >
                ✕
              </button>
            )}
          </div>
          <div className={mobileFiltersOpen || extraFiltersActive ? 'contents' : 'hidden sm:contents'}>
          <TagPicker
            draft={tagInput}
            applied={tag}
            catalog={tagCatalog}
            onDraftChange={setTagInput}
            onApply={next => setParam({ tag: next, q: qInput })}
          />
          </div>
          {/* 「管理标签」是操作而不是筛选条件，不能跟着筛选一起收起。 */}
          {tagCatalog?.canManage && tagOpsSupported && (
            <button
              type="button"
              data-testid="requirements-manage-tags"
              onClick={() => setTagManagerOpen(true)}
              className="rounded-md px-2 py-1.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)]"
            >
              管理标签
            </button>
          )}
          {archiveSupported === true && (
            <label className={`flex min-h-11 items-center gap-2 rounded-md px-2.5 text-xs sm:min-h-9 ${searching ? 'cursor-pointer text-[var(--fg)]' : 'text-[var(--fg-muted)]'}`}>
              <input
                type="checkbox"
                checked={includeArchived}
                disabled={!searching}
                onChange={e => setParam({ q: qInput, tag: tagInput, include_archived: e.target.checked ? '1' : '0' })}
                aria-describedby="archive-search-hint"
                className="h-4 w-4 accent-[var(--hl)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--hl)]"
              />
              包含已归档
            </label>
          )}
          {(status || tag || q || project || owner || agent || overdue || participating || priorities) && (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-md px-2.5 py-1.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* 「还没搜索」这句在手机上是纯占位：留着会把第一条需求再往下推一行。
            错误/未登录/搜索中一律保留——那些是必须看见的状态。 */}
        <p id="archive-search-hint" role="status" className={`mb-4 text-xs text-[var(--fg-muted)] ${!searching && !error && !needsLogin ? 'hidden sm:block' : ''}`}>
          {needsLogin
            ? '登录后可继续读取需求。'
            : error
              ? '本次读取未完成，请重试。'
              : archiveSupported === false
            ? '当前 Hub 未提供归档搜索能力，仅显示普通需求。'
            : !searching
              ? '输入搜索词后可查找已归档需求。'
              : loading
                ? '正在读取搜索结果…'
                : archiveSupported === true && includeArchived
                  ? '搜索包含已归档需求，归档项单独标记。'
                  : '搜索仅包含未归档需求。'}
          {!loading && !error && !needsLogin && ` 已加载 ${rows.length} 条${hasMore ? '，可继续加载。' : '。'}`}
        </p>

        {rows.length > 0 && orderedRows.length === 0 && (participating || priorities) && !loading && !error && (
          <p role="status" data-testid="requirements-local-empty" className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--fg-muted)]">
            已加载的 {rows.length} 条里没有匹配本地区筛选（我参与 / 优先级）的需求
            {hasMore ? '；还有更多未加载。' : '。'}
            {hasMore && (
              <button type="button" onClick={() => load({ cursor, append: true })} className="ml-2 underline hover:text-[var(--fg)]">
                继续加载
              </button>
            )}
          </p>
        )}

        {createNotice && (
          <p role="status" data-testid="requirements-create-notice" className="mb-4 text-xs text-[var(--fg-muted)]">
            {createNotice}
            <button type="button" onClick={() => setCreateNotice('')} className="ml-2 underline">知道了</button>
          </p>
        )}

        {needsLogin && (
          <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            会话已过期，<Link href="/login" className="underline">重新登录</Link> 后再看需求。
          </div>
        )}
        {error && !needsLogin && (
          // role="alert"：失败是突发事件，读屏器应当主动播报，而不是等用户 Tab 到才听见。
          <div role="alert" data-testid="requirements-error"
            className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
            读取失败：{error}
            <button
              type="button"
              onClick={() => (rows.length > 0 && hasMore ? load({ cursor, append: true }) : load())}
              className="ml-3 underline"
            >重试</button>
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]" />
            ))}
          </div>
        ) : rows.length === 0 && !needsLogin && !error ? (
          // 空态只代表“这个筛选真的没有数据”。未登录或读失败时 rows 也会是空的，
          // 那时说「需求池是空的」就是把鉴权/故障说成没数据，用户会以为需求丢了。
          <EmptyState
            variant="generic"
            title={hasActiveFilters ? '没有符合筛选的需求' : '需求池是空的'}
            sub={hasActiveFilters ? '清掉筛选再试，或换一个项目、责任归属或标签。' : '客户端建一条需求后，这里就会出现。'}
            cta={hasActiveFilters ? { label: '清空筛选', onClick: clearFilters } : undefined}
          />
        ) : timeline ? (
          <TimelineView rows={rows} />
        ) : board ? (
          <>
            {(moveError || moveNotice) && (
              <p
                role={moveError ? 'alert' : 'status'}
                data-testid="requirements-move-status"
                className={`mb-2 text-xs ${moveError ? 'text-red-400' : 'text-[var(--fg-muted)]'}`}
              >
                {moveError || moveNotice}
              </p>
            )}
          <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              data-testid="requirements-bulk-toggle"
              aria-pressed={bulkMode}
              onClick={toggleBulkMode}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${bulkMode ? 'bg-[var(--bg-elevated)] text-[var(--fg)]' : 'text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200'}`}
            >
              {bulkMode ? '退出批量' : '批量'}
            </button>
            {status !== 'abandoned' && (
              <button
                type="button"
                data-testid="requirements-abandoned-toggle"
                aria-label={showAbandoned ? '收起已放弃列' : '展开已放弃列'}
                aria-pressed={showAbandoned}
                onClick={() => setShowAbandoned(value => !value)}
                className="rounded-md px-2.5 py-1 text-[11px] text-[var(--fg-muted)] transition-colors hover:bg-[var(--hover-tint)] hover:text-gray-200"
              >
                {showAbandoned ? '收起已放弃' : `已放弃 ${counts.abandoned || 0}`}
              </button>
            )}
          </div>
          {bulkMode && (
            <div ref={bulkBarRef} tabIndex={-1} className="mb-2 flex flex-nowrap items-center gap-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs outline-none sm:flex-wrap sm:overflow-visible" data-testid="requirements-bulk-bar">
              <span className="shrink-0 whitespace-nowrap text-[var(--fg-muted)]">已选 {selectedIds.size} 项</span>
              <select
                aria-label="批量移动到状态"
                value=""
                disabled={bulkBusy || selectedIds.size === 0}
                onChange={event => { if (event.target.value) void bulkPatch({ column: event.target.value }); }}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-[var(--fg)] disabled:opacity-50"
              >
                <option value="">移到…</option>
                {COLUMNS.filter(item => item.key).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
              <select
                aria-label="批量设置优先级"
                value=""
                disabled={bulkBusy || selectedIds.size === 0}
                onChange={event => { if (event.target.value) void bulkPatch({ priority: event.target.value }); }}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-[var(--fg)] disabled:opacity-50"
              >
                <option value="">优先级…</option>
                {(['high', 'normal', 'low', 'lowest'] as const).map(value => <option key={value} value={value}>{value}</option>)}
              </select>
              <select
                aria-label="批量设置负责人"
                data-testid="requirements-bulk-owner"
                value=""
                disabled={bulkBusy || selectedIds.size === 0 || personOptions.length === 0}
                title={personOptions.length === 0 ? '人员目录未就绪' : '按人与 Agent 两种角色批量指派'}
                onChange={event => {
                  const value = event.target.value;
                  if (!value) return;
                  // 批量写的是 {kind,id} 或 null（代理按此校验）；筛选用的 'user:x' / 'none'
                  // 字符串不能直接当写入值，之前直接把字符串发过去会被 400 拒掉。
                  if (value === 'none') { void bulkPatch({ owner: null, agent_owner: null }); return; }
                  const [kind, ...rest] = value.split(':');
                  const person = { kind, id: rest.join(':') };
                  void bulkPatch(kind === 'node' ? { owner: null, agent_owner: person } : { owner: person, agent_owner: null });
                }}
                className="shrink-0 max-w-[12rem] rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-[var(--fg)] disabled:opacity-50"
              >
                <option value="">负责人…</option>
                <option value="none">清空负责人</option>
                {(['user', 'node'] as const).map(kind => (
                  <optgroup key={kind} label={kind === 'user' ? '人' : 'Agent'}>
                    {personOptions.filter(option => option.value.startsWith(`${kind}:`)).map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <select
                aria-label="批量设置项目"
                data-testid="requirements-bulk-project"
                value=""
                disabled={bulkBusy || selectedIds.size === 0 || projectCatalog.length === 0}
                title={projectCatalog.length === 0 ? '项目目录未就绪' : '把选中的卡移到同一个项目；「无项目」= 明确不属于任何项目'}
                onChange={event => { if (event.target.value) void bulkPatch({ project_id: event.target.value === 'none' ? null : event.target.value }); }}
                className="shrink-0 max-w-[12rem] rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-[var(--fg)] disabled:opacity-50"
              >
                <option value="">项目…</option>
                <option value="none">无项目</option>
                {projectCatalog.map(project => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <select
                aria-label="批量参与者"
                data-testid="requirements-bulk-participant"
                value=""
                disabled={bulkBusy || selectedIds.size === 0 || personOptions.length === 0}
                title={personOptions.length === 0 ? '人员目录未就绪' : '选一个人或 Agent 加进参与者的同时，可按右侧按钮移出'}
                onChange={event => { if (event.target.value) { setBulkParticipant(event.target.value); void bulkParticipantChange('add', event.target.value); } }}
                className="shrink-0 max-w-[11rem] rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-[var(--fg)] disabled:opacity-50"
              >
                <option value="">参与者…</option>
                {(['user', 'node'] as const).map(kind => (
                  <optgroup key={kind} label={kind === 'user' ? '人' : 'Agent'}>
                    {personOptions.filter(option => option.value.startsWith(`${kind}:`)).map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                data-testid="requirements-bulk-participant-remove"
                disabled={bulkBusy || selectedIds.size === 0 || !bulkParticipant}
                title="把上面选中的人/Agent 从每张卡的参与者里移出"
                onClick={() => { if (bulkParticipant) void bulkParticipantChange('remove', bulkParticipant); }}
                className="rounded border border-[var(--border)] px-1.5 py-1 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-50"
              >
                移出参与者
              </button>
              <label className="flex items-center gap-1 text-[11px] text-[var(--fg-muted)]">
                标签
                <input
                  aria-label="批量标签"
                  data-testid="requirements-bulk-tag"
                  value={bulkTag}
                  maxLength={40}
                  disabled={bulkBusy || selectedIds.size === 0}
                  onChange={event => setBulkTag(event.target.value)}
                  placeholder="标签名"
                  className="w-24 shrink-0 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-[var(--fg)] disabled:opacity-50"
                />
                <button
                  type="button"
                  data-testid="requirements-bulk-tag-add"
                  disabled={bulkBusy || selectedIds.size === 0 || !bulkTag.trim()}
                  onClick={() => { void bulkTagChange('add'); }}
                  className="rounded border border-[var(--border)] px-1.5 py-1 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-50"
                >
                  加上
                </button>
                <button
                  type="button"
                  data-testid="requirements-bulk-tag-remove"
                  disabled={bulkBusy || selectedIds.size === 0 || !bulkTag.trim()}
                  onClick={() => { void bulkTagChange('remove'); }}
                  className="rounded border border-[var(--border)] px-1.5 py-1 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-50"
                >
                  去掉
                </button>
              </label>
              <label className="flex items-center gap-1 text-[11px] text-[var(--fg-muted)]">
                截止
                <input
                  type="date"
                  aria-label="批量设置截止日期"
                  data-testid="requirements-bulk-due"
                  value={bulkDue}
                  disabled={bulkBusy || selectedIds.size === 0}
                  onChange={event => setBulkDue(event.target.value)}
                  className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs text-[var(--fg)] disabled:opacity-50"
                />
                <button
                  type="button"
                  data-testid="requirements-bulk-due-apply"
                  disabled={bulkBusy || selectedIds.size === 0 || !bulkDue}
                  onClick={() => { void bulkPatch({ due: bulkDue }); }}
                  className="rounded border border-[var(--border)] px-1.5 py-1 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-50"
                >
                  应用
                </button>
                <button
                  type="button"
                  data-testid="requirements-bulk-due-clear"
                  title="把选中项的截止日期清空"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={() => { void bulkPatch({ due: null }); }}
                  className="text-[11px] text-[var(--fg-muted)] underline disabled:opacity-50"
                >
                  清空日期
                </button>
              </label>
              <button type="button" onClick={() => setSelectedIds(new Set())} disabled={bulkBusy || selectedIds.size === 0} className="text-[11px] text-[var(--fg-muted)] underline disabled:opacity-50">清空选择</button>
              {bulkBusy && <span className="text-[11px] text-[var(--fg-muted)]">批量写入中…</span>}
              {bulkMessage && <span role="status" className="text-[11px] text-[var(--fg-muted)]">{bulkMessage}</span>}
              {bulkError && <span role="alert" className="text-[11px] text-[var(--danger)]">{bulkError}</span>}
            </div>
          )}
          {/* snap 必须加在「真正滚动的容器」上：之前加在内层 flex 上，容器 scroll-snap-type 是 none，
              手机上滑到一半会停在两列之间。 */}
          <div className="-mx-1 min-w-0 snap-x snap-mandatory overflow-x-auto pb-1" data-testid="requirements-board">
            <div className="flex gap-3 px-1">
              {COLUMNS.filter(col => col.key)
                .filter(col => (!status || col.key === status) && (col.key !== 'abandoned' || showAbandoned || status === 'abandoned'))
                .map(col => {
                const items = viewRows.filter(row => columnOf(row) === col.key);
                const isCollapsed = collapsedColumns.has(col.key);
                // 列头超期计数：看板一眼看不出「这一列里有几条已经晚了」，
                // 数一下并给出可点的入口（点了就是已有的「已逾期」筛选，可再点取消）。
                const overdueCount = items.filter(row => planHealth(row.start, row.due, new Date(), row.column === 'done' || row.column === 'abandoned')?.kind === 'overdue').length;
                return (
                  <section
                    key={col.key}
                    aria-label={`${col.label}列`}
                    data-testid={`requirements-column-${col.key}`}
                    className={`snap-start shrink-0 rounded-xl border bg-[var(--bg-secondary)]/60 transition-colors ${isCollapsed ? 'w-12' : 'w-72 sm:w-[19rem] lg:w-[calc((100%-1.5rem)/3)] lg:max-w-[19rem]'} ${dragOverColumn === col.key ? 'border-[var(--hl)] bg-[var(--hover-tint)]' : 'border-[var(--border)]'}`}
                    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverColumn(col.key); }}
                    onDragLeave={event => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDragOverColumn(null); }}
                    onDrop={event => {
                      event.preventDefault();
                      setDragOverColumn(null);
                      const id = event.dataTransfer.getData('text/plain');
                      const row = rows.find(item => item.id === id);
                      if (row) void moveCard(row, col.key as Requirement['column']);
                    }}
                  >
                    {isCollapsed ? (
                      <button
                        type="button"
                        onClick={() => toggleColumn(col.key)}
                        aria-label={`${col.label} 展开`}
                        data-testid={`requirements-column-expand-${col.key}`}
                        className="flex h-44 w-full flex-col items-center justify-between gap-2 rounded px-1 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hl)] focus-visible:outline-offset-1"
                      >
                        <span className={`rounded px-1 py-0.5 text-[11px] tabular-nums ${COLUMN_CHIP[col.key]}`}>{items.length}</span>
                        <span className="text-[11px] text-[var(--fg-muted)]" style={{ writingMode: 'vertical-rl' }}>{col.label}</span>
                      </button>
                    ) : (
                    <>
                    <header className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${COLUMN_CHIP[col.key]}`}>{col.label}</span>
                      <span className="flex items-center gap-2">
                        {overdueCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setParam({ overdue: overdue ? '' : '1', q: qInput, tag: tagInput })}
                            title={`这一列有 ${overdueCount} 条已超期（点了只看超期，再点取消）`}
                            data-testid={`requirements-column-overdue-${col.key}`}
                            data-overdue-count={overdueCount}
                            aria-pressed={overdue}
                            className="rounded bg-[var(--danger)]/12 px-1 py-0.5 text-[10px] tabular-nums text-[var(--danger)] hover:bg-[var(--danger)]/20"
                          >
                            超期 {overdueCount}
                          </button>
                        )}
                        <span className="text-[10px] tabular-nums text-[var(--fg-muted)]">{items.length}</span>
                        <button
                          type="button"
                          onClick={() => toggleColumn(col.key)}
                          aria-label={`${col.label} 折叠`}
                          data-testid={`requirements-column-collapse-${col.key}`}
                          className="rounded px-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hl)] focus-visible:outline-offset-1"
                        >−</button>
                      </span>
                    </header>
                    <div className="space-y-2 px-2 pb-3">
                      {items.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-6 text-center text-[11px] text-[var(--fg-muted)]">
                          这一列没有需求
                        </p>
                      ) : items.map(row => {
                        const chk = row.checklist_count;
                        const kids = row.children;
                        return (
                          <div
                            key={row.id}
                            data-board-card
                            data-column={col.key}
                            data-urgency-rank={urgencySort ? rankOfRow(row) : undefined}
                            className={`rounded-lg border border-[var(--border)] bg-[var(--bg)] transition-opacity ${movingId === row.id ? 'opacity-60' : ''}`}
                          >
                            <Link
                              href={rowHref(row.id)}
                              onClick={() => rememberRowAnchor(row.id)}
                              draggable
                              onDragStart={event => {
                                event.dataTransfer.setData('text/plain', row.id);
                                event.dataTransfer.effectAllowed = 'move';
                              }}
                              onDragEnd={() => setDragOverColumn(null)}
                              className="block rounded-t-lg px-3 pb-1 pt-2.5 hover:bg-[var(--hover-tint)]"
                            >
                              <span className="flex items-center justify-between gap-2 text-[10px] text-[var(--fg-muted)]">
                                <span className="tabular-nums">#{row.seq}</span>
                                <span className="flex items-center gap-2">
                                  <span className={priorityClass(row.priority)} title={priorityTitle(row.priority)}>{priorityLabel(row.priority)}</span>
                                  {row.due && <span>{dueLabel(row.due)}</span>}
                                </span>
                              </span>
                              <span className="mt-1 block text-sm text-gray-100">
                                <span className="line-clamp-2" title={row.name}>{row.name}</span>
                              </span>
                              {row.archived === true && (
                                <span className="mt-1 inline-flex rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] leading-4 text-[var(--fg-muted)]">已归档</span>
                              )}
                              {(() => {
                                // 和列表行共用同一份 planHealth：同一批需求在两种视图里
                                // 必须说同一句话，断言会比对两边的 data-plan-kind。
                                const plan = planHealth(row.start, row.due, new Date(), row.column === 'done' || row.column === 'abandoned');
                                if (!plan) return null;
                                const tone = planHealthTone(plan);
                                return (
                                  <span data-testid={`requirements-card-plan-${row.id}`} data-plan-kind={plan.kind} data-this-week={plan.thisWeek ? 'true' : 'false'}
                                    className={`mt-1 inline-flex rounded px-1.5 py-0.5 text-[10px] tabular-nums ${tone}`}>
                                    {plan.label}
                                  </span>
                                );
                              })()}
                              {(row.tags || []).length > 0 && (
                                <span className="mt-2 flex flex-wrap gap-1">
                                  {(row.tags || []).slice(0, 3).map(name => (
                                    <TagChip key={name} name={name} color={tagColor(tagCatalog, name)} className="text-[10px] text-gray-400" />
                                  ))}
                                </span>
                              )}
                              <span
                                data-responsibility
                                className="mt-2 block text-[11px] leading-4 text-[var(--fg-muted)]"
                                title={`负责人：${personLabel(row.owner, personNames)}；负责 Agent：${personLabel(row.agent_owner, personNames)}`}
                              >
                                <span className="block truncate">人 · {personLabel(row.owner, personNames)}</span>
                                <span className="block truncate">Agent · {personLabel(row.agent_owner, personNames)}</span>
                              </span>
                              {(chk || kids) && (
                                <span className="mt-1 flex gap-3 text-[10px] tabular-nums text-[var(--fg-muted)]">
                                  {chk && chk.total > 0 && <span>✓ {chk.done}/{chk.total}</span>}
                                  {kids && kids.total > 0 && <span>↳ {kids.done}/{kids.total}</span>}
                                </span>
                              )}
                            </Link>
                            <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
                              {bulkMode && (
                                <label className="mr-auto flex items-center gap-1 text-[10px] text-[var(--fg-muted)]">
                                  <input
                                    type="checkbox"
                                    aria-label={`选择 #${row.seq} ${row.name}`}
                                    checked={selectedIds.has(row.id)}
                                    disabled={bulkBusy}
                                    onChange={() => toggleSelected(row.id)}
                                    className="h-3.5 w-3.5 accent-[var(--hl)]"
                                  />
                                  选择
                                </label>
                              )}
                              <select
                                aria-label={`移动到状态 ${row.seq}`}
                                value={columnOf(row)}
                                disabled={movingId === row.id}
                                onChange={event => void moveCard(row, event.target.value as Requirement['column'])}
                                title="移动到其它状态（键盘/触屏可用）"
                                className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[10px] text-[var(--fg-muted)] disabled:opacity-50"
                              >
                                {COLUMNS.filter(item => item.key).map(item => (
                                  <option key={item.key} value={item.key}>{item.label}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
          </>
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl bg-[var(--bg-secondary)]">
            {(treeRows ?? viewRows.map(row => ({ row, depth: 0, hasChildren: false }))).map(({ row, depth, hasChildren }) => {
              const chk = row.checklist_count;
              const kids = row.children;
              // 行的紧迫度：超期/今天到期整行给一条左侧竖条，扫一眼就知道该先看哪条
              // （标签只是小字，整列扫的时候容易被忽略）。
              const plan = planHealth(row.start, row.due, new Date(), row.column === 'done' || row.column === 'abandoned');
              const urgency = plan?.kind === 'overdue'
                ? 'border-l-2 border-l-[var(--danger)]'
                : plan?.kind === 'dueToday'
                  ? 'border-l-2 border-l-[var(--warning)]'
                  : 'border-l-2 border-l-transparent';
              return (
                <li key={row.id} data-depth={treeMode ? depth : undefined} data-urgency={plan?.kind ?? 'none'}
                  data-urgency-rank={urgencySort ? rankOfRow(row) : undefined}
                  className={`${urgency} hover:bg-[var(--bg-secondary)]/60`}>
                  {treeMode && (
                    <span className="inline-flex w-5 justify-center align-middle" style={{ marginLeft: 8 + depth * 16 }}>
                      {hasChildren ? (
                        <button
                          type="button"
                          aria-label={collapsedTree.has(row.id) ? `展开子需求 ${row.seq}` : `收起子需求 ${row.seq}`}
                          data-testid={`requirements-tree-toggle-${row.id}`}
                          onClick={() => setCollapsedTree(prev => {
                            const next = new Set(prev);
                            if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                            return next;
                          })}
                          className="text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
                        >
                          {collapsedTree.has(row.id) ? '▸' : '▾'}
                        </button>
                      ) : (
                        <span aria-hidden className="text-[11px] text-transparent">·</span>
                      )}
                    </span>
                  )}
                  <Link href={rowHref(row.id)} data-req-row onClick={() => rememberRowAnchor(row.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:px-4" style={treeMode ? { paddingLeft: 8 + depth * 16 } : undefined}>
                    <span className="w-12 shrink-0 text-[11px] tabular-nums text-[var(--fg-muted)]">#{row.seq}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${COLUMN_CHIP[row.column] || COLUMN_CHIP.abandoned}`}>
                      {row.column}
                    </span>
                    <span className="min-w-0 flex-1 basis-32 text-sm text-gray-100 sm:basis-0">
                      <span className="block truncate" title={row.name}>{row.name}</span>
                      {row.archived === true && (
                        <span className="mt-1 inline-flex rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] leading-4 text-[var(--fg-muted)]">已归档</span>
                      )}
                    </span>
                    {(row.tags || []).slice(0, 3).map(name => (
                      <TagChip key={name} name={name} color={tagColor(tagCatalog, name)} className="hidden shrink-0 text-[10px] text-gray-400 sm:inline-flex" />
                    ))}
                    <span className={`shrink-0 text-[11px] ${priorityClass(row.priority)}`} title={priorityTitle(row.priority)}>{priorityLabel(row.priority)}</span>
                    <span data-responsibility className="hidden w-36 shrink-0 text-[11px] leading-4 text-[var(--fg-muted)] sm:block"
                      title={`负责人：${personLabel(row.owner, personNames)}；负责 Agent：${personLabel(row.agent_owner, personNames)}`}>
                      <span className="block truncate">人 · {personLabel(row.owner, personNames)}</span>
                      <span className="block truncate">Agent · {personLabel(row.agent_owner, personNames)}</span>
                    </span>
                    <span className="w-20 shrink-0 text-right text-[11px]">{dueLabel(row.due)}</span>
                    {(() => {
                      // 计划健康度：「剩余 2 天」和「剩余 30 天」在列表里必须一眼可分，
                      // 现有筛选只有「已逾期」这一个二元开关。
                      if (!plan) return null;
                      const tone = planHealthTone(plan);
                      return (
                        <span data-testid={`requirements-plan-${row.id}`} data-plan-kind={plan.kind} data-this-week={plan.thisWeek ? 'true' : 'false'}
                          title={`开始：${row.start || '—'}；截止：${row.due || '—'}`}
                          className={`hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums sm:inline-flex ${tone}`}>
                          {plan.label}
                        </span>
                      );
                    })()}
                    {(() => {
                      const updated = relativeTime(row.updatedAt);
                      return updated ? (
                        <span data-role="updated" className="hidden w-16 shrink-0 text-right text-[10px] text-[var(--fg-dim)] lg:inline" title={`更新于 ${updated.exact.replace('T', ' ').slice(0, 16)}`}>
                          {updated.text}
                        </span>
                      ) : null;
                    })()}
                    {chk && chk.total > 0 && (
                      <span className="hidden shrink-0 text-[10px] tabular-nums text-[var(--fg-muted)] sm:inline">
                        ✓ {chk.done}/{chk.total}
                      </span>
                    )}
                    {kids && kids.total > 0 && (
                      <span className="hidden shrink-0 text-[10px] tabular-nums text-[var(--fg-muted)] md:inline">
                        ↳ {kids.done}/{kids.total}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {/* 播报区：只在追加完成后说话，不打扰日常浏览。 */}
        <p role="status" aria-live="polite" data-testid="requirements-load-notice" className="sr-only">{loadNotice}</p>
        <div ref={listRef} tabIndex={-1} data-testid="requirements-list-end" className="outline-none" />
        {hasMore && !loading && (
          <button
            type="button"
            data-testid="requirements-load-more"
            ref={loadMoreRef}
            disabled={loadingMore}
            onClick={() => load({ cursor, append: true })}
            className="mx-auto mt-4 block rounded-md px-4 py-2 text-xs text-[var(--fg-muted)] hover:bg-[var(--hover-tint)] hover:text-gray-200 disabled:opacity-50"
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
        {tagManagerOpen && tagCatalog?.canManage && (
          <TagManager
            catalog={tagCatalog}
            networkId={networkId}
            treeSupported={tagTreeSupported}
            onClose={() => setTagManagerOpen(false)}
            onApplied={() => { refreshTagCatalog(); void load({ silent: true }); }}
          />
        )}
      </div>
    </div>
  );
}

export default function RequirementsPage() {
  const { networkId, ready } = useNetworkId();
  if (!ready) return <div role="status" className="px-6 py-8 text-sm text-[var(--fg-muted)]">正在确认当前网络…</div>;
  if (!networkId) return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <NetworkRequiredNotice />
    </div>
  );
  return (
    <Suspense fallback={<div className="min-h-screen bg-[var(--bg)]" />}>
      {/* A new network owns new rows, cursors, capabilities and catalog reads. */}
      <RequirementsContent key={networkId} networkId={networkId} />
    </Suspense>
  );
}
