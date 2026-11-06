'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { legionFetcher, deptFetcher, legionReadError, type PeopleResponse, type DepartmentsResponse, scopedUrl } from '../../lib/legion-data';
import { buildPlazaDirectory, loadLegionDirectory, type PlazaAgent, type PlazaDepartment } from '../../lib/legion-directory';
import { useNetworkId } from '../../lib/network-context';
import { NetworkRequiredNotice } from '../../components/NetworkRequiredNotice';
import { AliasAvatar } from '../../components/AliasAvatar';
import { useAvatarsVersion } from '../../lib/avatars';
import type { Session, Health } from '../../components/types';
import { LegionChat } from '../LegionChat';
import { PlazaScene } from './PlazaScene';
import { PlazaPerspective } from './PlazaPerspective';
import { plazaAgentSnapshots, type PlazaNodeMetadata as NodeMetadata } from './plaza-perspective-metadata';

const control = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 text-xs hover:bg-[var(--hover-tint)] focus-visible:outline-2 focus-visible:outline-[var(--accent-text)]';

/** Agent's canonical node ID selects metadata. An old duplicate alias cannot win. */
function NodeAttributes({ agent, department, nodes, sessions, health, metadataError, onChat }: {
  agent: PlazaAgent; department: string; nodes: NodeMetadata[]; sessions: Session[]; health?: Health;
  metadataError?: Error; onChat: (alias: string) => void;
}) {
  const node = nodes.find(n => n.node_id === agent.node_id);
  const session = sessions.find(s => s.node_id === agent.node_id);
  const networkId = node?.network_id ?? session?.network_id;
  const presence = health?.sse_sessions;
  const reachable = presence && networkId ? !!presence[`${networkId}:${agent.alias}`] : null;
  const rows = [
    ['节点 ID', agent.node_id], ['部门', department], ['负责人', agent.owner ?? '无负责人'],
    ['连接', reachable == null ? '未知（未取得网络连接状态）' : reachable ? '在线' : '离线'],
    ['任务状态', session?.status ?? '未上报'], ['生命周期', node?.lifecycle_state ?? agent.lifecycle_state ?? '未上报'],
    ['模型', node?.model ?? session?.model ?? '未上报'], ['运行时', node?.runtime ?? session?.runtime ?? session?.agent ?? '未上报'],
    ['主机', node?.hostname ?? session?.server ?? node?.server ?? '未上报'],
    ['工作目录', session?.project_dir ?? node?.project_dir ?? '未上报'], ['会话 ID', session?.session_id ?? '未上报'],
    ['可管理', node?.lifecycle_controllable == null ? '未知' : node.lifecycle_controllable ? '服务端允许生命周期控制' : '当前不可控制'],
    ['当前任务', session?.task || '未上报'], ['更新时间', agent.updated_at || '未上报'],
  ];
  return <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3" data-testid="plaza-node-attributes" data-node-id={agent.node_id}>
    <h3 className="break-words text-sm font-semibold">{agent.alias || agent.node_id}</h3>
    {metadataError && <p role="alert" className="mt-2 text-xs text-[var(--warning)]">属性读取失败，显示最近一次成功读取的数据（如有）。</p>}
    <dl className="mt-3 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-2 text-xs">
      {rows.map(([name, value]) => <div key={name} className="contents"><dt className="text-[var(--fg-muted)]">{name}</dt><dd className="min-w-0 break-words [overflow-wrap:anywhere]">{value}</dd></div>)}
    </dl>
    <button type="button" disabled={!agent.alias} onClick={() => onChat(agent.alias)} className={`${control} mt-3 w-full bg-[var(--bg-elevated)] text-[var(--accent-text)] disabled:opacity-50`} data-testid="plaza-chat">开始对话</button>
  </section>;
}

function Roster({ platform, networkId, onChat }: { platform: PlazaDepartment; networkId: string; onChat: (alias: string) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const agents = platform.agents.filter(a => `${a.alias} ${a.node_id} ${a.owner ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const pageCount = Math.max(1, Math.ceil(agents.length / 24));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = agents.slice(currentPage * 24, (currentPage + 1) * 24);
  const picked = platform.agents.find(a => a.node_id === selected);
  // One scoped snapshot per resource, never a request per node. SWR shares it across departments.
  const nodes = useSWR<{ ok: boolean; nodes: NodeMetadata[] }>(scopedUrl('/api/hub/nodes', networkId), legionFetcher, { refreshInterval: 15000, shouldRetryOnError: false });
  const status = useSWR<{ ok: boolean; sessions: Session[] }>(scopedUrl('/api/hub/status', networkId), legionFetcher, { refreshInterval: 15000, shouldRetryOnError: false });
  const health = useSWR<Health>(scopedUrl('/api/hub/health', networkId), legionFetcher, { refreshInterval: 15000, shouldRetryOnError: false });
  const metadataError = legionReadError(nodes.error, status.error, health.error);
  const scopedNodes = (nodes.data?.nodes ?? []).filter(n => !n.network_id || n.network_id === networkId);
  const scopedSessions = (status.data?.sessions ?? []).filter(s => !s.network_id || s.network_id === networkId);
  return <>
    {platform.unknown && <p className="text-xs text-[var(--warning)]">该部门未出现在当前可见部门树中，已保留节点归属。</p>}
    <p className="text-xs text-[var(--fg-muted)]">{platform.people.length} 名成员 · {platform.agents.length} 个 Agent</p>
    {platform.people.length > 0 && <p className="text-xs text-[var(--fg-muted)] break-words">成员：{platform.people.map(p => p.display_name || p.username).join('、')}</p>}
    <label className="block text-xs text-[var(--fg-muted)]">查找节点
      <input value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} placeholder="别名、节点 ID、负责人" className="mt-1 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--fg)]" />
    </label>
    {metadataError && <p role="alert" className="text-xs text-[var(--warning)]">{metadataError.status === 401 ? '会话过期，请重新登录。' : `节点属性读取失败：${metadataError.message}`}
      <button className={`${control} ml-1 underline`} onClick={() => { void nodes.mutate(); void status.mutate(); void health.mutate(); }}>重试属性</button></p>}
    {(nodes.isLoading || status.isLoading) && <p role="status" className="text-xs text-[var(--fg-muted)]">正在读取节点属性…</p>}
    {picked && <NodeAttributes agent={picked} department={platform.name} nodes={scopedNodes} sessions={scopedSessions} health={health.data} metadataError={metadataError} onChat={onChat} />}
    <div className="grid gap-1" aria-label={`${platform.name}节点`} data-testid="plaza-roster">
      {shown.map(a => {
        const node = scopedNodes.find(n => n.node_id === a.node_id), session = scopedSessions.find(s => s.node_id === a.node_id);
        return <button key={a.node_id} type="button" onClick={() => setSelected(a.node_id)} aria-pressed={selected === a.node_id}
          className={`flex min-h-14 min-w-0 items-center gap-2 rounded-lg border p-2 text-left ${selected === a.node_id ? 'border-[var(--accent-text)] bg-[var(--bg-elevated)]' : 'border-transparent hover:bg-[var(--hover-tint)]'}`} data-testid="plaza-agent" data-node-id={a.node_id}>
          <AliasAvatar alias={a.alias} size={30} />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{a.alias || a.node_id}</span>
            <span className="block truncate text-[11px] text-[var(--fg-muted)]">{node?.model ?? session?.model ?? '模型未上报'} · {node?.runtime ?? session?.runtime ?? '运行时未上报'}</span></span>
          <span className="shrink-0 text-[11px] text-[var(--fg-muted)]">{session?.status ?? '未上报'}</span>
        </button>;
      })}
    </div>
    {!agents.length && <p className="py-5 text-sm text-[var(--fg-muted)]">{query ? '没有匹配的节点' : '该部门暂无 Agent'}</p>}
    {pageCount > 1 && <nav className="flex items-center justify-between text-xs" aria-label="节点分页">
      <button type="button" className={control} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <span>{currentPage + 1} / {pageCount} · 共 {agents.length} 个</span>
      <button type="button" className={control} disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </nav>}
  </>;
}

export default function LegionPlazaPage() {
  const { networkId, ready: networkReady } = useNetworkId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [sceneMode, setSceneMode] = useState<'2d' | '3d'>('3d');
  const [selection, setSelection] = useState<{ network: string; id: string } | null>(null);
  const [chat, setChat] = useState<{ network: string; alias: string } | null>(null);
  const [viewNetwork, setViewNetwork] = useState(networkId);
  if (viewNetwork !== networkId) {
    setViewNetwork(networkId);
    setSelection(null);
    setChat(null);
  }
  const people = useSWR<PeopleResponse>(networkReady && networkId ? scopedUrl('/api/hub/people?limit=100&offset=0', networkId) : null, loadLegionDirectory, { refreshInterval: 30000, shouldRetryOnError: false });
  const hierarchy = useSWR<DepartmentsResponse | null>(networkReady && networkId ? scopedUrl('/api/hub/departments', networkId) : null, deptFetcher, { refreshInterval: 60000, shouldRetryOnError: false });
  // Shared SWR keys with the roster: one scoped snapshot, not one read per namecard.
  const nodes = useSWR<{ ok: boolean; nodes: NodeMetadata[] }>(networkReady && networkId ? scopedUrl('/api/hub/nodes', networkId) : null, legionFetcher, { refreshInterval: 15000, shouldRetryOnError: false });
  const status = useSWR<{ ok: boolean; sessions: Session[] }>(networkReady && networkId ? scopedUrl('/api/hub/status', networkId) : null, legionFetcher, { refreshInterval: 15000, shouldRetryOnError: false });
  const snapshots = useMemo(() => plazaAgentSnapshots(nodes.data?.nodes ?? [], status.data?.sessions ?? [], networkId), [nodes.data, status.data, networkId]);
  const snapshotError = legionReadError(nodes.error, status.error);
  useAvatarsVersion();
  const directory = useMemo(() => buildPlazaDirectory(people.data, hierarchy.data), [people.data, hierarchy.data]);
  const { platforms } = directory;
  const selectedId = selection?.network === networkId ? selection.id : null;
  const platform = platforms.find(p => p.id === selectedId) ?? platforms.find(p => p.agents.length > 0) ?? platforms[0];
  const loading = !networkReady || people.isLoading || hierarchy.isLoading;
  const readError = legionReadError(people.error, hierarchy.error);
  const fatal = readError?.status === 401 ? 'login' : networkReady && !networkId ? 'no-network' : readError ? 'error' : null;
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = async () => {
    setFullscreenError('');
    try {
      if (document.fullscreenElement === rootRef.current) await document.exitFullscreen();
      else if (rootRef.current?.requestFullscreen) await rootRef.current.requestFullscreen();
      else setFullscreenError('当前浏览器不支持全屏');
    } catch { setFullscreenError('浏览器未允许全屏，请检查权限后重试'); }
  };
  return <div ref={rootRef} tabIndex={-1} data-legion-stage="plaza" data-testid="legion-plaza-stage"
    className={`relative min-w-0 bg-[var(--bg)] p-3 text-[var(--fg)] outline-none sm:p-5 ${fullscreen ? 'h-dvh overflow-auto' : 'min-h-screen'}`}>
    <div className="mx-auto max-w-[1720px]">
      <header className={`mb-4 flex flex-wrap items-center justify-between gap-3 ${fullscreen ? '' : 'lg:pr-10'}`}>
        <div><h1 className="text-xl font-semibold">军团 · 平台视角</h1>
          <p className="mt-1 text-xs text-[var(--fg-muted)]" data-testid="plaza-counts">{loading ? '正在读取完整编制…' : `${platforms.length} 个展台 · ${directory.people} 名成员 · ${directory.agents} 个 Agent`}</p>
          <p className="mt-1 text-[11px] text-[var(--fg-muted)]">Agent 独立编制 · 点击展台查看节点属性</p></div>
        <nav className="flex flex-wrap items-center gap-1" aria-label="军团视图">
          <div role="group" aria-label="平台维度" className="flex rounded-lg border border-[var(--border)] p-0.5">
            <button type="button" onClick={() => setSceneMode('2d')} aria-pressed={sceneMode === '2d'} className={`${control} ${sceneMode === '2d' ? 'bg-[var(--bg-elevated)] text-[var(--accent-text)]' : ''}`} data-testid="plaza-mode-2d">2D 平台</button>
            <button type="button" onClick={() => setSceneMode('3d')} aria-pressed={sceneMode === '3d'} className={`${control} ${sceneMode === '3d' ? 'bg-[var(--bg-elevated)] text-[var(--accent-text)]' : ''}`} data-testid="plaza-mode-3d">3D 平台</button>
          </div>
          <Link href="/legion/3d" className={control}>3D 拓扑</Link><Link href="/legion" className={control}>2D 同心环</Link>
          <button type="button" className={`${control} bg-[var(--bg-elevated)]`} onClick={() => void toggleFullscreen()} aria-pressed={fullscreen} data-testid="plaza-fullscreen">{fullscreen ? '退出全屏' : '全屏'}</button>
        </nav>
      </header>
      {fullscreenError && <p role="alert" className="mb-3 text-sm text-[var(--warning)]">{fullscreenError}</p>}
      {fatal === 'no-network' && <NetworkRequiredNotice />}
      {fatal === 'login' && <p role="alert">会话已过期，<Link className="underline" href="/login">重新登录</Link> 后再看军团。</p>}
      {fatal === 'error' && <p role="alert" className="text-sm text-[var(--danger)]">读取军团编制失败：{readError?.message}<button className={control} onClick={() => { void people.mutate(); void hierarchy.mutate(); }}>重试</button></p>}
      {!fatal && loading && <p role="status" className="py-12 text-center text-sm text-[var(--fg-muted)]">正在读取完整编制…</p>}
      {!fatal && !loading && <>
        {directory.legacy && <p className="mb-3 text-xs text-[var(--warning)]">当前 Hub 未提供 Agent 独立部门能力，暂按负责人部门展示。</p>}
        {directory.rawAgents > directory.agents && <p className="mb-3 text-xs text-[var(--fg-muted)]">同名节点保留最近更新记录：{directory.rawAgents} 条记录 → {directory.agents} 个 Agent</p>}
        {sceneMode === '3d' && snapshotError && <p role="alert" className="mb-3 text-xs text-[var(--warning)]">{snapshotError.status === 401 ? '会话已过期，请重新登录后更新节点状态。' : '节点状态与属性读取失败；卡片仅显示最近快照（如有），不表示实时状态。'}<button type="button" className={control} onClick={() => { void nodes.mutate(); void status.mutate(); }}>重试节点状态</button></p>}
        {sceneMode === '3d' && !snapshotError && (nodes.isLoading || status.isLoading) && <p role="status" className="mb-3 text-xs text-[var(--fg-muted)]">正在读取节点状态与属性…</p>}
        {!platforms.length ? <p className="py-12 text-center text-sm text-[var(--fg-muted)]">当前网络暂无部门、成员或 Agent</p> : <div className={`grid min-w-0 items-start gap-4 ${sceneMode === '3d' ? '2xl:grid-cols-[minmax(0,1fr)_320px]' : 'xl:grid-cols-[minmax(0,1fr)_360px]'}`}>
          {sceneMode === '3d' ? <PlazaPerspective key={networkId} platforms={platforms} selected={platform?.id ?? null} snapshots={snapshots} onSelect={id => setSelection({ network: networkId, id })} />
            : <PlazaScene platforms={platforms} selected={platform?.id ?? null} onSelect={id => setSelection({ network: networkId, id })} />}
          <section className="min-w-0 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 xl:max-h-[65dvh] xl:overflow-auto" aria-label="部门节点与属性">
            <label className="block text-xs text-[var(--fg-muted)]">部门展台
              <select value={platform?.id ?? ''} onChange={e => setSelection({ network: networkId, id: e.target.value })} data-testid="plaza-department-select"
                className="mt-1 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-sm text-[var(--fg)]">
                {platforms.map(p => <option key={p.id} value={p.id}>{p.name} · {p.agents.length} Agent</option>)}
              </select>
            </label>
            {platform && <Roster key={`${networkId}:${platform.id}`} platform={platform} networkId={networkId} onChat={alias => setChat({ network: networkId, alias })} />}
          </section>
        </div>}
      </>}
    </div>
    {chat?.network === networkId && networkReady && !fatal && <LegionChat key={`${networkId}:${chat.alias}`} alias={chat.alias} networkId={networkId} onClose={() => setChat(null)} />}
  </div>;
}
