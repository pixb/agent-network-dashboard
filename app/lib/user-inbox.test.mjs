import { describe, expect, test } from 'bun:test';
import {
  countUnreadUserInbox,
  groupUserInboxBySender,
  isUnreadRow,
  kindLabel,
  kindTone,
  parseUserInboxTime,
  sortUserInbox,
  summarizeUserInbox,
} from './user-inbox';

/**
 * Fixture is the **production shape** (net_b91c0d535346, 2026-11-04,
 * `GET /api/messages?scope=user`): 42 rows, every one acked=0 —
 * 25 task_expired / 9 task_orphan_suspected / 8 agent_message / 0 human_dm.
 * Timestamps are the hub's own strings: `YYYY-MM-DD HH:MM:SS` (UTC, no zone);
 * DM rows carry milliseconds.
 */
const row = (over) => ({
  message_id: 'dm_fixture',
  network_id: 'net_b91c0d535346',
  user_id: 'u_b1bd4ea4519c',
  from_session: '200-pix-auto-video-manual-doubao',
  sender_user_id: null,
  kind: 'agent_message',
  title: null,
  content: '033 段第三轮重做最终交付完成。',
  severity: 'info',
  acked: 0,
  created_at: '2026-11-04 04:38:19',
  ...over,
});

const PRODUCTION_LIKE = [
  row({ message_id: 'dm_1', created_at: '2026-11-04 04:38:19', kind: 'agent_message' }),
  row({ message_id: 'dm_2', created_at: '2026-11-04 06:06:03', kind: 'task_expired', from_session: '200-pix-auto-video-manual-doubao2', content: '5 个任务已过期' }),
  row({ message_id: 'dm_3', created_at: '2026-11-03 13:16:05', kind: 'task_orphan_suspected', from_session: '200-pix-auto-video-manual-doubao2', content: '再次确认：133 尚未重派' }),
  row({ message_id: 'dm_4', created_at: '2026-10-20 12:27:31.482', kind: 'human_dm', sender_user_id: 'u_b1bd4ea4519c', from_session: 'admin', content: '收到，方案如下：' }),
  row({ message_id: 'dm_5', created_at: '2026-11-04 06:01:44', kind: 'task_expired', acked: 1, content: '已读过的过期通知' }),
];

describe('kind label and tone', () => {
  test('every kind the hub writes today has a bilingual label', () => {
    // 判据是「hub 现在写的每一种 kind 都有标签」，不是「标签数量等于 N」。
    // 这条断言在 hub 新增 kind 时会红，从而逼着这里补标签 —— 而不是让新行
    // 在界面上显示成空白。
    for (const kind of ['human_dm', 'agent_message', 'task_expired', 'task_orphan_suspected']) {
      const label = kindLabel(kind);
      expect(label).toContain('·');
      expect(label).not.toBe('未知 · Unknown');
    }
  });

  test('an unknown kind is displayed, not dropped, and stays neutral', () => {
    expect(kindLabel('requirement_mention')).toBe('requirement_mention');
    expect(kindTone('requirement_mention')).toBe('neutral');
    expect(kindTone('')).toBe('neutral');
    expect(kindTone('task_expired')).toBe('notice');
    expect(kindTone('agent_message')).toBe('mail');
    expect(kindTone('human_dm')).toBe('dm');
  });
});

describe('hub timestamps', () => {
  test('the zone-less UTC string parses to the same instant as the ISO form', () => {
    expect(parseUserInboxTime('2026-11-04 04:38:19')).toBe(Date.parse('2026-11-04T04:38:19Z'));
  });

  test('millisecond DM rows sort after their second-level neighbours', () => {
    expect(parseUserInboxTime('2026-10-20 12:27:31.482')).toBeGreaterThan(Date.parse('2026-10-20T12:27:31Z'));
  });

  test('missing time is 0, not NaN — a NaN sort key poisons the whole order', () => {
    expect(parseUserInboxTime(null)).toBe(0);
    expect(parseUserInboxTime('nonsense')).toBe(0);
  });
});

describe('unread rule', () => {
  test('acked=0 is unread; acked=1 is read', () => {
    expect(isUnreadRow(row({ acked: 0 }))).toBe(true);
    expect(isUnreadRow(row({ acked: 1 }))).toBe(false);
  });

  test('a missing acked column counts as unread (fail-open on the hint, never on the read state)', () => {
    // 旧 hub 不返回 acked。把它当已读 = 一条从没被看过私信的未读提示永久消失；
    // 当未读 = 最多多提示一次。
    expect(isUnreadRow({ content: 'x' })).toBe(true);
    expect(countUnreadUserInbox([{ acked: 0 }, { acked: 1 }, {}])).toBe(2);
  });
});

describe('sorting and dedup', () => {
  test('newest first, using the hub string ordering after parsing', () => {
    const ids = sortUserInbox(PRODUCTION_LIKE).map((r) => r.message_id);
    expect(ids[0]).toBe('dm_2'); // 06:06:03
    expect(ids[ids.length - 1]).toBe('dm_4'); // 2026-10-20
  });

  test('the same message_id from a DM resend is one row', () => {
    const twice = [row({ message_id: 'dm_x' }), row({ message_id: 'dm_x', content: '重发同一条气泡' })];
    expect(sortUserInbox(twice)).toHaveLength(1);
    // 第一条胜出：重发不能改写已渲染的正文形状。
    expect(sortUserInbox(twice)[0].content).toBe('033 段第三轮重做最终交付完成。');
  });

  test('rows without a message_id are never collapsed into each other', () => {
    expect(sortUserInbox([{ content: 'a' }, { content: 'b' }])).toHaveLength(2);
  });
});

describe('grouping by sender', () => {
  test('one group per from_session, newest group first, unread counted per group', () => {
    const groups = groupUserInboxBySender(PRODUCTION_LIKE);
    expect(groups.map((g) => g.sender)).toEqual([
      '200-pix-auto-video-manual-doubao2',
      '200-pix-auto-video-manual-doubao',
      'admin',
    ]);
    const doubao2 = groups.find((g) => g.sender === '200-pix-auto-video-manual-doubao2');
    expect(doubao2.rows.map((r) => r.kind)).toEqual(['task_expired', 'task_orphan_suspected']);
    expect(doubao2.unread).toBe(2); // 两条都没 acked
    // 唯一已 acked 的那条（dm_5）属于 doubao 组：未读是**按组**算的，
    // 一个组里读过不能让另一个组的私信变成已读。
    const doubao = groups.find((g) => g.sender === '200-pix-auto-video-manual-doubao');
    expect(doubao.rows.length).toBe(2);
    expect(doubao.unread).toBe(1);
  });

  test('a hub-sent notice without a session source groups under hub, not under an empty sender', () => {
    // from_session 为空是 hub 代发通知的真实形状。空字符串作为组名会在界面上
    // 渲染出一个没有名字的会话。
    const groups = groupUserInboxBySender([row({ from_session: null })]);
    expect(groups.map((g) => g.sender)).toEqual(['hub']);
  });

  test('an empty inbox groups into nothing — it is not an error', () => {
    expect(groupUserInboxBySender([])).toEqual([]);
    expect(groupUserInboxBySender(undefined)).toEqual([]);
  });
});

describe('summary chips', () => {
  test('counts by kind, most numerous first, unknown kinds included', () => {
    const summary = summarizeUserInbox([
      row({ kind: 'task_expired' }), row({ kind: 'task_expired' }), row({ kind: 'task_expired' }),
      row({ kind: 'agent_message' }), row({ kind: 'agent_message' }),
      row({ kind: 'task_orphan_suspected' }),
      row({ kind: 'brand_new_kind' }),
    ]);
    expect(summary).toEqual([
      { kind: 'task_expired', count: 3 },
      { kind: 'agent_message', count: 2 },
      { kind: 'task_orphan_suspected', count: 1 },
      { kind: 'brand_new_kind', count: 1 },
      { kind: 'human_dm', count: 0 },
    ].filter((r) => r.count > 0));
    expect(summary.map((s) => s.kind)).toContain('brand_new_kind');
  });

  test('the production shape summarises to the numbers the hub actually returned', () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row({ message_id: `e${i}`, kind: 'task_expired' })),
      ...Array.from({ length: 9 }, (_, i) => row({ message_id: `o${i}`, kind: 'task_orphan_suspected' })),
      ...Array.from({ length: 8 }, (_, i) => row({ message_id: `a${i}`, kind: 'agent_message' })),
    ];
    expect(summarizeUserInbox(rows)).toEqual([
      { kind: 'task_expired', count: 25 },
      { kind: 'task_orphan_suspected', count: 9 },
      { kind: 'agent_message', count: 8 },
    ]);
    expect(countUnreadUserInbox(rows)).toBe(42);
  });
});
