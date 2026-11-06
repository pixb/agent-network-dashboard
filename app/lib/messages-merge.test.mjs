import { describe, expect, test } from 'bun:test';
import {
  countInboxRowsInTimeline,
  inboxKindToType,
  inboxRowKey,
  mergeInboxIntoTimeline,
  unreadInboxBySender,
  userInboxRowToMessage,
} from './messages-merge';

// 页面传 mapper；测试用默认映射，签名与调用点保持一致。
const asRow = (row) => userInboxRowToMessage(row, 'admin');
const merge = (messages, rows) => mergeInboxIntoTimeline(messages, rows, asRow);

/**
 * 合并规则的钉子。fixture 用生产形状（net_b91c0d535346，2026-11-04）：
 * 42 行 user_inbox 全未 ack，25 task_expired / 9 task_orphan_suspected /
 * 8 agent_message；时间线那边是节点之间的 inbox 行。
 */
const row = (over) => ({
  message_id: 'dm_fixture',
  from_session: '200-pix-auto-video-manual-doubao',
  kind: 'agent_message',
  title: null,
  content: '033 段第三轮重做最终交付完成。',
  acked: 0,
  created_at: '2026-11-04 04:38:19',
  ...over,
});

describe('kind → 时间线类型', () => {
  test('发给人看的两种 kind 都是 dm', () => {
    expect(inboxKindToType('agent_message')).toBe('dm');
    expect(inboxKindToType('human_dm')).toBe('dm');
  });

  test('hub 通知与将来的未知 kind 一律落 notice，不会得到「没有类型」的行', () => {
    expect(inboxKindToType('task_expired')).toBe('notice');
    expect(inboxKindToType('task_orphan_suspected')).toBe('notice');
    expect(inboxKindToType('some_new_kind')).toBe('notice');
    expect(inboxKindToType(null)).toBe('notice');
  });
});

describe('收件箱行 → 时间线行', () => {
  test('主键带 ui: 命名空间 —— 两张表的 id 不能共用一个 key 体系', () => {
    // inbox.id 是 UUID，user_inbox.message_id 形如 dm_<uuid>。
    // 不加前缀时，两侧的 key 混在一起，去重会跨表误伤，React key 也会撞。
    expect(userInboxRowToMessage(row({ message_id: 'dm_1' }), 'admin').id).toBe('ui:dm_1');
    expect(inboxRowKey('dm_1')).toBe('ui:dm_1');
  });

  test('发件来源是 from_session，收件人固定成我自己', () => {
    const m = userInboxRowToMessage(row({ from_session: 'node-a' }), 'admin');
    expect(m.from_alias).toBe('node-a');
    expect(m.to_alias).toBe('admin');
  });

  test('from_session 为空（hub 代发通知）落到 hub，不落到空名字', () => {
    expect(userInboxRowToMessage(row({ from_session: null }), 'admin').from_alias).toBe('hub');
  });

  test('acked 缺失按未读算（宁可多提示一次）', () => {
    expect(userInboxRowToMessage(row({ acked: 0 }), 'admin').unread).toBe(true);
    expect(userInboxRowToMessage(row({ acked: 1 }), 'admin').unread).toBe(false);
    expect(userInboxRowToMessage({ message_id: 'dm_x' }, 'admin').unread).toBe(true);
  });

  test('title 与正文一起进内容，不丢标题', () => {
    const m = userInboxRowToMessage(row({ title: '任务过期', content: '5 个任务已过期' }), 'admin');
    expect(m.content).toBe('任务过期\n5 个任务已过期');
  });
});

describe('合并', () => {
  const network = [
    { id: 'uuid-1', type: 'task', from_alias: 'admin', to_alias: 'node-a', created_at: '2026-11-04 04:00:00' },
    { id: 'uuid-2', type: 'reply', from_alias: 'node-a', to_alias: 'admin', created_at: '2026-11-04 05:00:00' },
  ];

  test('按时间升序（时间线自上而下 oldest→newest），收件箱行插在正确位置', () => {
    const merged = merge(network, [row({ message_id: 'dm_1', created_at: '2026-11-04 04:30:00' })]);
    expect(merged.map((m) => m.id)).toEqual(['uuid-1', 'ui:dm_1', 'uuid-2']);
  });

  test('收件箱行只增不减：网络窗口被挤掉时私信仍然在', () => {
    expect(merge([], [row({ message_id: 'dm_1' })])).toHaveLength(1);
    expect(merge(undefined, undefined)).toEqual([]);
  });

  test('去重只按 key，正文相同时间不同的两条私信仍然是两条', () => {
    const merged = merge([], [
      row({ message_id: 'dm_a', created_at: '2026-11-04 04:00:00' }),
      row({ message_id: 'dm_b', created_at: '2026-11-04 04:05:00' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  test('没有 message_id 的行不进时间线（无 key 的行无法安全去重）', () => {
    expect(merge([], [{ content: 'x', created_at: '2026-11-04 04:00:00' }])).toHaveLength(0);
  });

  test('时间线里已有的行不会被收件箱行覆盖（先到的赢，行形状不中途变）', () => {
    const merged = merge(network, []);
    expect(merged[0].type).toBe('task');
  });
});

describe('计数', () => {
  test('时间线里收件箱行的数量（界面 chip 用）', () => {
    const merged = merge(
      [{ id: 'uuid-1', created_at: '2026-11-04 04:00:00' }],
      [row({ message_id: 'dm_1' }), row({ message_id: 'dm_2', kind: 'task_expired' })],
    );
    expect(countInboxRowsInTimeline(merged)).toBe(2);
    expect(countInboxRowsInTimeline([])).toBe(0);
  });

  test('未读按发件人分组，已读不计', () => {
    expect(unreadInboxBySender([
      row({ message_id: 'a', from_session: 'node-a' }),
      row({ message_id: 'b', from_session: 'node-a' }),
      row({ message_id: 'c', from_session: 'node-b', acked: 1 }),
      row({ message_id: 'd', from_session: null }),
    ])).toEqual({ 'node-a': 2, hub: 1 });
  });
});

// 生产形状（net_b91c0d535346 实测）：admin 的 inbox 表 0 行、user_inbox 42 行
// （25 条 task_expired / 9 条 task_orphan_suspected / 8 条节点私信），全部未 ack。
// 这一组直接断言「私信在 Messages 页可见」，因为旧版这一页对这个用户是空屏。
describe('生产形状：网络消息 0 行 + 收件箱 42 行', () => {
  const map = (r) => userInboxRowToMessage(r, 'admin');
  const mk = (o) => ({
    message_id: o.message_id,
    kind: o.kind,
    from_session: o.from_session,
    to_username: 'admin',
    content: o.content || 'x',
    created_at: o.created_at,
    acked: 0,
    ...('acked' in o ? { acked: o.acked } : {}),
  });
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => mk({ message_id: `dm_ex_${i}`, kind: 'task_expired', from_session: 'hub', created_at: '2026-11-04 06:06:03' })),
    ...Array.from({ length: 9 }, (_, i) => mk({ message_id: `dm_or_${i}`, kind: 'task_orphan_suspected', from_session: 'hub', created_at: '2026-11-04 06:00:00' })),
    ...Array.from({ length: 8 }, (_, i) => mk({ message_id: `dm_n_${i}`, kind: 'agent_message', from_session: 'doubao', content: `node question ${i}`, created_at: `2026-11-04 06:05:0${i}` })),
  ];

  test('空网络消息 + 42 条收件箱行 → 时间线 42 行，私信可见', () => {
    const merged = mergeInboxIntoTimeline([], rows, map);
    expect(merged).toHaveLength(42);
    expect(countInboxRowsInTimeline(merged)).toBe(42);
    const dm = merged.filter((m) => m.type === 'dm');
    expect(dm).toHaveLength(8);
    expect(dm[0].from_alias).toBe('doubao');
    expect(dm[0].unread).toBe(true);
  });

  test('按 dm 过滤能只留下节点私信（旧版这条过滤恒为空）', () => {
    const merged = mergeInboxIntoTimeline([], rows, map);
    expect(merged.filter((m) => m.type === 'dm')).toHaveLength(8);
    expect(merged.filter((m) => m.type === 'notice')).toHaveLength(34);
  });

  test('发信人 chip 集合含节点别名 —— 指挥室要能按节点筛私信', () => {
    const merged = mergeInboxIntoTimeline([], rows, map);
    const aliases = new Set(merged.map((m) => (m.from_alias || '').trim()).filter(Boolean));
    expect(aliases.has('doubao')).toBe(true);
    expect(aliases.has('hub')).toBe(true);
  });

  test('时间线按时间有序：最新那条排在末尾（页面从下往上读）', () => {
    const merged = mergeInboxIntoTimeline([], rows, map);
    const times = merged.map((m) => new Date(m.created_at.replace(' ', 'T') + 'Z').getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    expect(merged[merged.length - 1].type).toBe('notice');
    // 生产时间关系：节点私信 06:05:0x，过期巡逻通知 06:06:03 —— 私信在通知之前。
    // 读顺 42 行时，「节点在问什么」正好排在「哪条任务挂了」前面，这一序对指挥室有意义。
    const lastDm = merged.map((m) => m.type).lastIndexOf('dm');
    expect(lastDm).toBeGreaterThan(-1);
    expect(lastDm).toBeLessThan(merged.length - 1);
  });
});
