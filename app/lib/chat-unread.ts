'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useNetworkId } from './network-context';
import { isMuted, useMuteVersion } from './chat-mute';
import { currentUserAlias, isUserRecipient, isUserSender, mergeMessageFeeds } from './chat-unread-feed';
import { useSSE } from './useSSE';

const STORAGE_PREFIX = 'anet_chat_read_v1:';
const UNREAD_EVENT = 'anet-chat-read-updated';

interface ChatMessage {
  from_alias?: string | null;
  to_alias?: string | null;
  created_at?: string | null;
}

/** Senders/recipients that mean "the dashboard user" in hub data. The chat
 *  panel uses the same set to decide which bubbles are "You". */
const USERISH = new Set(['', 'dashboard', 'admin', 'api', 'hub']);
const isUserish = (v?: string | null) => USERISH.has((v || '').trim().toLowerCase());

interface ReadMap {
  [alias: string]: string;
}

function storageKey(networkId: string) {
  return `${STORAGE_PREFIX}${networkId || 'global'}`;
}

function parseHubTime(value?: string | null): number {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const ts = Date.parse(withZone);
  return Number.isFinite(ts) ? ts : 0;
}

// Loop R8 (Vincent: 未读数字角标): last-read moved sessionStorage →
// localStorage so read state survives refresh/new tabs/restart (微信预期).
// One-time migration pulls any old session value forward.
const BASELINE_KEY = '__baseline';

function readStoredMap(networkId: string): ReadMap {
  if (typeof window === 'undefined') return {};
  try {
    let raw = window.localStorage.getItem(storageKey(networkId));
    if (!raw) {
      raw = window.sessionStorage.getItem(storageKey(networkId));
      if (raw) window.localStorage.setItem(storageKey(networkId), raw);
    }
    const parsed = raw ? JSON.parse(raw) : {};
    const map: ReadMap = parsed && typeof parsed === 'object' ? parsed : {};
    // R8 first-visit floor, written SYNCHRONOUSLY on first read: an async
    // (useEffect) baseline lost the race against the first SWR render and
    // let a badge storm flash — and stick, since nothing re-triggered the
    // count. Ensuring it here means no compute can ever see a missing
    // baseline. No event dispatch: every hook instance does the same
    // idempotent write.
    if (!map[BASELINE_KEY]) {
      map[BASELINE_KEY] = new Date().toISOString();
      window.localStorage.setItem(storageKey(networkId), JSON.stringify(map));
    }
    return map;
  } catch {
    return {};
  }
}

function writeStoredMap(networkId: string, next: ReadMap) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(networkId), JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: { networkId } }));
  } catch {}
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (res.status === 401) {
    window.location.assign('/login');
    throw new Error('unauthorized');
  }
  return res.json();
};

function withNetwork(url: string, networkId: string): string {
  if (!networkId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}network_id=${encodeURIComponent(networkId)}`;
}

export function markChatRead(alias: string, networkId: string) {
  if (!alias) return;
  const current = readStoredMap(networkId);
  writeStoredMap(networkId, {
    ...current,
    [alias]: new Date().toISOString(),
  });
}

export function useChatUnread() {
  const { networkId, ready } = useNetworkId();
  // Messages are the ONLY count source: the hub mirrors every task reply as
  // a message to the originator (verified live: replied task + same-second
  // message, both present), so counting tasks too double-counted every
  // reply (E2E showed 4 where 2 was right).
  const { mutate } = useSWRConfig();
  const [me] = useState(() => (typeof window === 'undefined' ? null : currentUserAlias()));
  // 网络没解析完之前不发请求：`withNetwork(url, '')` 会返回**无作用域**的 URL，
  // 等于先打一枪全网的、等 networkId 到了再打一枪带作用域的（实测 /api/hub/messages
  // 在 4.1s 与 6.2s 各来一次）。null key 在 SWR 里表示「不发请求」。
  const wideKey = ready && networkId ? withNetwork('/api/hub/messages?limit=200', networkId) : null;
  // 第二条取数只看「发给当前用户」的那一窗：忙碌网络上，用户自己的消息会被
  // 全网 200 条窗口挤掉。两条**合并**而不是替换——合并只会多算，不会少算。
  const inboxKey = me && ready && networkId ? withNetwork(`/api/hub/messages?limit=200&alias=${encodeURIComponent(me)}`, networkId) : null;
  // SSE 先到先算：角标以前要等下一轮 5s 轮询；hub 本来就会推事件，
  // 有事件就立刻重取，轮询只做兜底（SSE 掉线时才回到 5s）。
  const sseEnabled = process.env.NEXT_PUBLIC_DISABLE_SSE !== '1';
  const { connected: sseConnected } = useSSE({
    url: '/api/hub/events',
    enabled: sseEnabled,
    onEvent: (event) => {
      if (!['new_task', 'new_message', 'new_reply', 'broadcast', 'chained_reply'].includes(event.type)) return;
      if (wideKey) void mutate(wideKey);
      if (inboxKey) void mutate(inboxKey);
    },
  });
  const refreshInterval = sseConnected ? 20000 : 5000;
  const { data: messagesData } = useSWR<{ messages?: ChatMessage[] }>(
    wideKey,
    fetcher,
    { refreshInterval, dedupingInterval: 3000 },
  );
  const { data: inboxData } = useSWR<{ messages?: ChatMessage[] }>(
    inboxKey,
    fetcher,
    { refreshInterval, dedupingInterval: 3000 },
  );
  const [readVersion, setReadVersion] = useState(0);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== storageKey(networkId)) return;
      setReadVersion((v) => (typeof v === 'number' ? v + 1 : 1));
    };
    const onUnreadUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ networkId?: string }>).detail;
      if (detail?.networkId !== undefined && detail.networkId !== networkId) return;
      setReadVersion((v) => (typeof v === 'number' ? v + 1 : 1));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(UNREAD_EVENT, onUnreadUpdate);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(UNREAD_EVENT, onUnreadUpdate);
    };
  }, [networkId, setReadVersion]);

  const readMap = useMemo(() => {
    void readVersion;
    return readStoredMap(networkId);
  }, [networkId, readVersion]);

  const unreadMap = useMemo(() => {
    // R8: count EVERY unread item per alias (Vincent: "有几条消息显示数字"),
    // not just a latest-activity boolean. A message from the alias counts;
    // a task's REPLY counts once when it lands after last-read. Self-sent
    // items never count (they're keyed by the counterpart alias).
    const counts = new Map<string, number>();
    // R28 (微信排序): recency tiebreak for Overview/Nodes — but ONLY for
    // conversations the user has actually OPENED (read-map entry). On this
    // fleet agents constantly report to 'admin'; counting those yanked
    // never-opened agents to the front on every report (measured: 2 cards
    // jumped 39→1 / 60→3 in one 6s window). WeChat's list holds YOUR
    // conversations — same rule here keeps the grid calm.
    const lastActivity = new Map<string, number>();
    const opened = new Set(Object.keys(readMap).filter((k) => k !== BASELINE_KEY));
    const baseline = parseHubTime(readMap[BASELINE_KEY]);
    const bump = (alias: string, at: number) => {
      if (opened.has(alias) && at > (lastActivity.get(alias) || 0)) lastActivity.set(alias, at);
      const readAt = Math.max(parseHubTime(readMap[alias]), baseline);
      if (at > readAt) counts.set(alias, (counts.get(alias) || 0) + 1);
    };
    // Scope: only the USER'S conversation — a badge on X means "X has
    // something FOR YOU". Fleet chatter (X's messages to other agents)
    // must NOT inflate it.
    //
    // 收件人判定必须同时认「登录用户名」：hub 把回复/消息直接写给 token 里的
    // username（例如 vansin），而 USERISH 只有那几个通用标签。只认 USERISH
    // 会让写给你本人的消息一条都不计数——角标永远不亮（#40）。
    const feed = mergeMessageFeeds(messagesData?.messages, inboxData?.messages) as ChatMessage[];
    for (const message of feed) {
      const alias = message.from_alias?.trim();
      if (!alias || isUserSender(alias, me)) continue;    // own sends never count
      if (!isUserRecipient(message.to_alias, me)) continue;  // must be addressed to the user
      const at = parseHubTime(message.created_at);
      if (at) bump(alias, at);
    }
    return { counts, lastActivity };
  }, [messagesData, inboxData, readMap, me]);

  const hasUnread = useCallback((alias?: string | null) => {
    if (!alias) return false;
    return (unreadMap.counts.get(alias) || 0) > 0;
  }, [unreadMap]);

  const unreadCount = useCallback((alias?: string | null) => {
    if (!alias) return 0;
    return unreadMap.counts.get(alias) || 0;
  }, [unreadMap]);

  const lastActivityAt = useCallback((alias?: string | null) => {
    if (!alias) return 0;
    return unreadMap.lastActivity.get(alias) || 0;
  }, [unreadMap]);

  // R34: muted conversations are excluded from the global count (WeChat
  // semantics); hasMutedUnread lets entry badges fall back to a dot.
  const muteVersion = useMuteVersion();
  const { totalUnread, hasMutedUnread } = useMemo(() => {
    void muteVersion;
    let t = 0;
    let mutedAny = false;
    for (const [alias, n] of unreadMap.counts) {
      if (isMuted(alias)) { if (n > 0) mutedAny = true; continue; }
      t += n;
    }
    return { totalUnread: t, hasMutedUnread: mutedAny };
  }, [unreadMap, muteVersion]);

  const clearUnread = useCallback((alias: string) => {
    markChatRead(alias, networkId);
  }, [networkId]);

  return { unreadMap, hasUnread, unreadCount, lastActivityAt, totalUnread, hasMutedUnread, clearUnread };
}

/** WeChat badge label: 1-99 as-is, above → "99+"; 0/negative → '' (hide). */
export function badgeLabel(n: number): string {
  if (n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}
