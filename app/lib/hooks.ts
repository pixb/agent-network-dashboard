import { useEffect } from 'react';
import { hydrateHubAvatars } from './avatars';
import useSWR from 'swr';
import { Session, Health, AnetConfig } from '../components/types';
import { useNetworkId } from './network-context';
import type { UserInboxRow } from './user-inbox';

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
function withNetwork(url: string, networkId: string): string {
  if (!networkId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}network_id=${encodeURIComponent(networkId)}`;
}

export function useSessions() {
  const { networkId } = useNetworkId();
  const { data, error, isLoading, mutate } = useSWR<{ sessions: Session[]; _hint?: { global_count?: number; filtered_network?: string } }>(
    withNetwork('/api/hub/status', networkId),
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
  const { networkId } = useNetworkId();
  const { data, error, mutate } = useSWR<NodesResp>(
    withNetwork('/api/hub/nodes', networkId),
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

export function useTasks(params?: Record<string, string>) {
  const { networkId } = useNetworkId();
  const query = new URLSearchParams({ limit: '100', ...params }).toString();
  const { data, error, isLoading } = useSWR(
    withNetwork(`/api/hub/tasks?${query}`, networkId),
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
  const { networkId } = useNetworkId();
  const { data, error } = useSWR(withNetwork('/api/hub/stats', networkId), fetcher, SWR_OPTIONS);
  return { stats: data?.ok ? data : null, error };
}

export function useMessages(limit = 100) {
  const { networkId } = useNetworkId();
  // keepPreviousData: /messages grows `limit` when the user asks for older
  // history (#217 M5) — without it the key change would blank the list and
  // flash the skeleton while the bigger page is in flight.
  const { data, error, isLoading, mutate } = useSWR(
    withNetwork(`/api/hub/messages?limit=${limit}`, networkId),
    fetcher,
    { ...SWR_OPTIONS, keepPreviousData: true },
  );
  return { messages: data?.messages || [], error, isLoading, mutate };
}

/**
 * 我的收件箱（hub 的 `user_inbox`）：`GET /api/messages?scope=user`。
 *
 * 这读的不是上面 useMessages 读的 `inbox` 表。hub 把「Agent 发给人的私信」
 * （`send_desktop_message` → kind='agent_message'）和 hub 代发的通知
 * （task_expired / task_orphan_suspected）只放进 user_inbox，它们既不在
 * Messages 页的 inbox 里，也不算进聊天未读 ————私信在 Dashboard 上没有
 * 任何显示面（2026-11-04 全仓 grep：app/ 下 `scope=user` 0 命中）。
 * 读谁的收件箱由 hub 从 token 解出 userId，前端传不上去，也不需传。
 */
export function useUserInbox({ limit = 200, unackedOnly = false }: { limit?: number; unackedOnly?: boolean } = {}) {
  const { networkId } = useNetworkId();
  const query = new URLSearchParams({ limit: String(limit), scope: 'user' });
  if (unackedOnly) query.set('unacked_only', '1');
  const { data, error, isLoading, mutate } = useSWR<{ messages: UserInboxRow[] }>(
    withNetwork(`/api/hub/messages?${query.toString()}`, networkId),
    fetcher,
    SWR_OPTIONS,
  );
  return { rows: data?.messages || [], error, isLoading, mutate };
}
