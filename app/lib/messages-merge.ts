import { parseUserInboxTime, type UserInboxRow } from './user-inbox';

/**
 * 把收件箱（user_inbox）的行并进消息时间线 —— 纯函数层。
 *
 * 为什么在前端合，而不是让 Hub 多写一行：Hub 的两张表**各有自己的已读语义**
 * （`inbox.acked` 由节点消费、`user_inbox.acked` 由人 ack）。一条私信在 Hub 里
 * 变成两行，就得到「一处已读、一处未读」的红点口径分叉 —— 那是最难查的一类事故。
 * 前端合只有一行真数据，读状态只有一个来源。
 */

/**
 * 时间线认得的最小行形状。字段全可选、值只用 `string`（不用 `null`）：
 * 各页自己的 `MessageItem` 的可选属性是 `string | undefined`，带 `null` 的形状
 * 赋不进去，合并结果就会在类型层散架（实测：4 处 TS2345）。
 */
export interface TimelineMessage {
  id: string;
  type?: string;
  from_alias?: string;
  to_alias?: string;
  content?: string;
  created_at?: string;
  /** 收件箱行的未读态（acked=0）。时间线原生行用它自己的 acked 语义，不混。 */
  unread?: boolean;
  /** 收件箱来源的原始 kind（界面标签用；未知 kind 原样带过去，不丢弃）。 */
  inbox_kind?: string;
}

/**
 * 🔴 两张表的主键不共用一个 key 体系：`inbox.id` 是 UUID，
 * `user_inbox.message_id` 形如 `dm_<uuid>` / `dm_<userId>_<clientRequestId>`。
 * 前缀集中在这一处，因为让每个页面自己拼会漂：一处漂了就得到跨表去重误伤
 * （两条真私信并成一条）与 React key 撞车。
 */
export const INBOX_ROW_KEY_PREFIX = 'ui:';

export function inboxRowKey(messageId: string): string {
  return `${INBOX_ROW_KEY_PREFIX}${messageId}`;
}

/** kind → 时间线类型。hub 加新 kind 时落到 `notice`，不会出现「没有类型的行」。 */
export function inboxKindToType(kind?: string | null): 'dm' | 'notice' {
  const k = (kind || '').trim();
  if (k === 'agent_message' || k === 'human_dm') return 'dm';
  return 'notice';
}

/**
 * 收件箱行 → 时间线行（默认映射）。
 * `from_alias` 是发件来源（节点别名 / 对方用户名），`to_alias` 固定成「我自己」：
 * 收件箱天然只有收件人 = 我的行（Hub 按鉴权身份取收件人，不接受 query 指定）。
 */
export function userInboxRowToMessage(row: UserInboxRow, me: string): TimelineMessage {
  const kind = (row?.kind || '').trim();
  return {
    id: inboxRowKey(row?.message_id || ''),
    type: inboxKindToType(kind),
    from_alias: (row?.from_session || '').trim() || 'hub',
    to_alias: me,
    content: row?.title ? `${row.title}\n${row.content || ''}`.trim() : (row?.content || ''),
    created_at: row?.created_at || undefined,
    unread: Number(row?.acked ?? 0) === 0,
    inbox_kind: kind || undefined,
  };
}

/**
 * 合并：按时间升序（时间线自上而下 oldest→newest），按 key 去重。
 *
 * 行形状由调用页决定（`toMessage`）：消息流页有 priority/attachments，聊天面板有
 * 另一套；强制一个统一形状会把两边都弄坏。**key 前缀与去重规则由本函数控制**，
 * 不让页面自己拼 —— 那正是会漂的部分。
 *
 * 只按 key 去重，**绝不按内容去重**：正文相同、时间不同的两条私信是两条私信。
 * 收件箱行只增不减（`mergeMessageFeeds` 的 fail-open 同一口径）。
 */
export function mergeInboxIntoTimeline<T extends TimelineMessage>(
  messages: T[],
  inboxRows: UserInboxRow[],
  toMessage: (row: UserInboxRow) => T,
): T[] {
  const byKey = new Map<string, T>();
  for (const m of messages || []) {
    const key = m?.id ? String(m.id) : `raw:${byKey.size}`;
    if (!byKey.has(key)) byKey.set(key, m);
  }
  for (const row of inboxRows || []) {
    if (!row?.message_id) continue;
    const key = inboxRowKey(row.message_id);
    if (!byKey.has(key)) byKey.set(key, toMessage(row));
  }
  return [...byKey.values()].sort(
    (a, b) => parseUserInboxTime(a.created_at) - parseUserInboxTime(b.created_at),
  );
}

/** 时间线里来自收件箱的行数（界面 chip「节点来信 N」用）。 */
export function countInboxRowsInTimeline(messages: TimelineMessage[]): number {
  return (messages || []).filter((m) => typeof m?.id === 'string' && m.id.startsWith(INBOX_ROW_KEY_PREFIX)).length;
}

/** 未读私信按发件人分组计数（「哪个节点在等你」的 chip 用）。 */
export function unreadInboxBySender(inboxRows: UserInboxRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of inboxRows || []) {
    if (Number(row?.acked ?? 0) !== 0) continue;
    const sender = (row?.from_session || '').trim() || 'hub';
    out[sender] = (out[sender] || 0) + 1;
  }
  return out;
}
