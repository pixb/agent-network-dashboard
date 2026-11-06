/**
 * 我的收件箱（user_inbox）—— 纯函数层。
 *
 * 为什么需要这个页面：Dashboard 的 Messages 页读的是 hub 的 `inbox` 表
 * （`GET /api/messages?alias=<alias>`），而节点发给**人**的私信走
 * `send_desktop_message` 落 `user_inbox`，hub 只在 `GET /api/messages?scope=user`
 * 里返回它。**前端此前没有任何一处调用 scope=user**（2026-11-04 全仓 grep：
 * `scope=user` / `api/dm` / `human_dm` / `agent_message` 在 app/ 下 0 命中），
 * 所以「节点给 manager 发了私信」这件事在 Dashboard 上没有任何显示面。
 * 数据一直在 hub 里，缺的只是读它的那一屏。
 *
 * 生产实测（net_b91c0d535346，2026-11-04）：admin 的 user_inbox 42 行，
 * acked 全 0 —— 25 `task_expired` / 9 `task_orphan_suspected` / 8
 * `agent_message` / 0 `human_dm`。
 *
 * 这里不发明字段：行形状逐字来自 hub 的
 * `SELECT message_id, network_id, user_id, from_session, kind, title, content,
 *  severity, meta_json, sender_user_id, acked, created_at FROM user_inbox`
 * （commhub-server `server/src/human-dm.ts` / `server/src/server.ts` 的 scope=user 分支）。
 */

export interface UserInboxRow {
  message_id?: string | null;
  network_id?: string | null;
  user_id?: string | null;
  from_session?: string | null;
  sender_user_id?: string | null;
  kind?: string | null;
  title?: string | null;
  content?: string | null;
  severity?: string | null;
  meta_json?: string | null;
  acked?: number | null;
  created_at?: string | null;
}

/** kind → 双语标签 + 语义色。
 *  hub 侧现有 kind：`human_dm`（人发的人）、`agent_message`（Agent 发给人的私信）、
 *  `task_expired` / `task_orphan_suspected`（hub 代发的通知）。
 *  未知 kind 必须**显示出来**而不是丢掉：hub 加一种 kind 时，页面要能看见新行，
 *  不能把它渲染成空白（那是「Hub 发了、界面上没有」这类事故的形状）。 */
const KIND_LABELS: Record<string, { zh: string; en: string }> = {
  human_dm: { zh: '私信', en: 'DM' },
  agent_message: { zh: '节点来信', en: 'From node' },
  task_expired: { zh: '任务过期', en: 'Task expired' },
  task_orphan_suspected: { zh: '疑似孤儿任务', en: 'Orphan suspected' },
};

export function kindLabel(kind?: string | null): string {
  const k = (kind || '').trim();
  const known = KIND_LABELS[k];
  if (known) return `${known.zh} · ${known.en}`;
  return k || '未知 · Unknown';
}

/** 已知 kind 走语义色；未知 kind 走中性色（不能把未知 kind 涂成"过期"的红）。 */
export function kindTone(kind?: string | null): 'notice' | 'mail' | 'dm' | 'neutral' {
  const k = (kind || '').trim();
  if (k === 'task_expired' || k === 'task_orphan_suspected') return 'notice';
  if (k === 'agent_message') return 'mail';
  if (k === 'human_dm') return 'dm';
  return 'neutral';
}

/** hub 的 created_at 是 `YYYY-MM-DD HH:MM:SS`（UTC，无 Z），私信带毫秒。 */
export function parseUserInboxTime(value?: string | null): number {
  if (!value) return 0;
  const normalized = String(value).trim();
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : normalized.replace(' ', 'T') + 'Z';
  const ts = Date.parse(withZone);
  return Number.isFinite(ts) ? ts : 0;
}

/**  newest first. `message_id` 是主键，用于去重：hub 的私信重发按
 *  `(sender, client_request_id)` 定出同一个 message_id，两条同 id 的行是一件事。 */
export function sortUserInbox(rows: UserInboxRow[]): UserInboxRow[] {
  const byId = new Map<string, UserInboxRow>();
  const idless: UserInboxRow[] = [];
  for (const row of rows || []) {
    const id = typeof row?.message_id === 'string' && row.message_id ? row.message_id : null;
    if (!id) { idless.push(row); continue; }
    if (!byId.has(id)) byId.set(id, row);
  }
  return [...byId.values(), ...idless]
    .sort((a, b) => parseUserInboxTime(b.created_at) - parseUserInboxTime(a.created_at));
}

/** 按发件人分组，组内最新在前，组间按最新时间排序。
 *  `from_session` 对 Agent 发来的行是节点 alias，对人发的行是对方用户名。
 *  空 from_session 归到 'hub'（hub 代发的通知没有会话来源）。 */
export function groupUserInboxBySender(rows: UserInboxRow[]): Array<{
  sender: string;
  rows: UserInboxRow[];
  lastTime: number;
  unread: number;
}> {
  const groups = new Map<string, UserInboxRow[]>();
  for (const row of rows || []) {
    const sender = (row?.from_session || '').trim() || 'hub';
    const bucket = groups.get(sender);
    if (bucket) bucket.push(row); else groups.set(sender, [row]);
  }
  return [...groups.entries()]
    .map(([sender, bucket]) => {
      const sorted = sortUserInbox(bucket);
      return {
        sender,
        rows: sorted,
        lastTime: sorted.length ? parseUserInboxTime(sorted[0].created_at) : 0,
        unread: sorted.filter(isUnreadRow).length,
      };
    })
    .sort((a, b) => b.lastTime - a.lastTime);
}

/** 未读 = `acked === 0`。hub 用 SQLite 整数 0/1。
 *  `acked` 缺失（旧 hub 不返回该列）时**按未读算**：宁可多提示一次，
 *  也不能把"没读过"显示成"已读"。 */
export function isUnreadRow(row: UserInboxRow): boolean {
  return Number(row?.acked ?? 0) === 0;
}

export function countUnreadUserInbox(rows: UserInboxRow[]): number {
  return rows.filter(isUnreadRow).length;
}

/** kind 计数，用于页面顶部的摘要（"25 任务过期 / 9 疑似孤儿 / 8 节点来信"）。
 *  顺序按数量降序，未知 kind 也进表。 */
export function summarizeUserInbox(rows: UserInboxRow[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows || []) {
    const k = (row?.kind || '').trim() || 'unknown';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
}
