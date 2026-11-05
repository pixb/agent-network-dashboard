import { useEffect } from 'react';
import { hydrateHubAvatars } from './avatars';
import useSWR from 'swr';
import { Session, Health, AnetConfig } from '../components/types';
import { useNetworkId } from './network-context';

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (res.status === 401) {
    window.location.assign('/login');
    throw new Error('unauthorized');
  }
  // 非 2xx 不能当成数据：代理层失败时返回的是 {error} 而不是列表，
  // 旧行为会让页面把「读失败」渲染成「没有数据」。
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw Object.assign(
      new Error(detail?.error || detail?.message || `HTTP ${res.status}`),
      { status: res.status },
    );
  }
  return res.json();
};

const SWR_OPTIONS = { refreshInterval: 5000, dedupingInterval: 3000 };

/** Append network_id to URL if set */
// 未就绪时返回 null（SWR 的 null key 不发请求）。
// 为什么必须这样：`withNetwork(url, '')` 会**返回无作用域 URL 并发起请求**，
// 网络解析完再按 scoped URL 发一次 —— 首屏因此白打一轮（实测 /api/hub/messages
// 在 4.1s 与 6.2s 各来一次）。network-context 里早就写明了这个用法，只是这些
// 调用点没接 `ready`。
function scopedOrNull(url: string, networkId: string, ready: boolean): string | null {
  if (!ready || !networkId) return null;
  return withNetwork(url, networkId);
}

function withNetwork(url: string, networkId: string): string {
  if (!networkId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}network_id=${encodeURIComponent(networkId)}`;
}

export function useSessions() {
  const { networkId, ready } = useNetworkId();
  const { data, error, isLoading, mutate } = useSWR<{ sessions: Session[]; _hint?: { global_count?: number; filtered_network?: string } }>(
    scopedOrNull('/api/hub/status', networkId, ready),
    fetcher,
    SWR_OPTIONS,
  );
  return { sessions: data?.sessions || [], hint: data?._hint, error, isLoading, mutate };
}

// RFC-027 PR2 — alias → lifecycle_state map sourced from /api/nodes
// (commhub-server preview.12+). /api/status reads from `sessions` which
// doesn't carry lifecycle_state; /api/nodes does. Cheap secondary
// fetch, same SWR cadence as useSessions; merged client-side by alias.
// Absent alias → caller defaults to 'active'.
interface NodeAttrsSnapshot {
  display_name: string | null;
  team: string | null;
  tags: string[];
  attrs_revision: number;
}
interface NodesResp { nodes?: Array<{
  alias?: string;
  node_id?: string;
  lifecycle_state?: string | null;
  // #492 goal-item-3: node display attributes (hub PR #497). Legacy
  // rows read as null/[]/0 respectively — no guard needed by callers.
  display_name?: string | null;
  team?: string | null;
  tags?: string[];
  attrs_revision?: number;
  // avatar 接线单: cross-device custom avatar (hub #462 projection)
  avatar_url?: string | null;
}>; }
export function useNodeLifecycle() {
  const { networkId, ready } = useNetworkId();
  const { data, error, mutate } = useSWR<NodesResp>(
    scopedOrNull('/api/hub/nodes', networkId, ready),
    fetcher,
    SWR_OPTIONS,
  );
  // avatar 接线单: every consumer of this hook keeps the avatar layer-1
  // store fresh. Effect (not render): hydrate dispatches an event that
  // re-renders avatar consumers — doing that mid-render would warn.
  useEffect(() => { hydrateHubAvatars(data?.nodes); }, [data]);
  const lifecycleByAlias: Record<string, string> = {};
  const nodeIdByAlias: Record<string, string> = {};
  const attrsByAlias: Record<string, NodeAttrsSnapshot> = {};
  for (const n of data?.nodes ?? []) {
    if (n.alias && typeof n.lifecycle_state === 'string') lifecycleByAlias[n.alias] = n.lifecycle_state;
    if (n.alias && typeof n.node_id === 'string') nodeIdByAlias[n.alias] = n.node_id;
    if (n.alias) {
      attrsByAlias[n.alias] = {
        display_name: typeof n.display_name === 'string' ? n.display_name : null,
        team: typeof n.team === 'string' ? n.team : null,
        tags: Array.isArray(n.tags) ? n.tags : [],
        attrs_revision: typeof n.attrs_revision === 'number' ? n.attrs_revision : 0,
      };
    }
  }
  return { lifecycleByAlias, nodeIdByAlias, attrsByAlias, error, refreshNodes: mutate };
}
export type { NodeAttrsSnapshot };

export function useHealth() {
  const { data, error } = useSWR<Health>('/api/hub/health', fetcher, SWR_OPTIONS);
  return { health: data || null, error };
}

export function useAnetConfig() {
  const { data } = useSWR<AnetConfig>('/api/anet/config', fetcher, { refreshInterval: 30000 });
  return { config: data || null };
}

export function useTasks(params?: Record<string, string>, enabled = true) {
  const { networkId, ready } = useNetworkId();
  const query = new URLSearchParams({ limit: '100', ...params }).toString();
  // enabled=false → null key，SWR 不发请求。
  // 用途：首页只在 /api/stats 没有 by_status 时才需要任务列表兜底，
  // 而 tasks?limit=500 生产实测 665,867 B（约 666 KB）。
  const { data, error, isLoading } = useSWR(
    enabled ? scopedOrNull(`/api/hub/tasks?${query}`, networkId, ready) : null,
    fetcher,
    SWR_OPTIONS,
  );
  return {
    tasks: data?.tasks || [],
    count: data?.count ?? 0,
    source: data?.source,
    error,
    isLoading,
  };
}

export function useStats() {
  const { networkId, ready } = useNetworkId();
  const { data, error } = useSWR(scopedOrNull('/api/hub/stats', networkId, ready), fetcher, SWR_OPTIONS);
  return { stats: data?.ok ? data : null, error };
}

export function useMessages(limit = 100) {
  const { networkId, ready } = useNetworkId();
  // keepPreviousData: /messages grows `limit` when the user asks for older
  // history (#217 M5) — without it the key change would blank the list and
  // flash the skeleton while the bigger page is in flight.
  const { data, error, isLoading, mutate } = useSWR(
    scopedOrNull(`/api/hub/messages?limit=${limit}`, networkId, ready),
    fetcher,
    { ...SWR_OPTIONS, keepPreviousData: true },
  );
  return { messages: data?.messages || [], error, isLoading, mutate };
}
