import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NOTIFY_STORAGE_KEY,
  notificationFor,
  readNotifyPreference,
  writeNotifyPreference,
  type NotifyContext,
} from '../../app/lib/desktop-notify.ts';

const ctx = (over: Partial<NotifyContext> = {}): NotifyContext => ({
  enabled: true,
  permission: 'granted',
  hidden: true,
  selfAlias: null,
  ...over,
});

test('默认关闭：enabled=false 时不提示', () => {
  assert.equal(notificationFor({ type: 'new_message', from_name: 'a', content: 'hi' }, ctx({ enabled: false })), null);
});

test('未授权 / 页面可见 时不提示', () => {
  const event = { type: 'new_message', from_name: 'a', content: 'hi' };
  assert.equal(notificationFor(event, ctx({ permission: 'default' })), null);
  assert.equal(notificationFor(event, ctx({ hidden: false })), null);
});

test('只对聊天相关事件提示', () => {
  assert.equal(notificationFor({ type: 'node.renamed', from_name: 'a', content: 'x' }, ctx()), null);
  assert.ok(notificationFor({ type: 'new_message', from_name: 'a', content: 'hi' }, ctx()));
});

test('自己发出的消息不提示', () => {
  const event = { type: 'new_task', from_name: 'me', to_name: 'agent', content: 'go' };
  assert.equal(notificationFor(event, ctx({ selfAlias: 'me' })), null);
  assert.ok(notificationFor(event, ctx({ selfAlias: 'someone-else' })));
});

test('文案：标题带往来方向，正文截断到 120 字以内，tag 用 task_id', () => {
  const long = 'x'.repeat(400);
  const msg = notificationFor({ type: 'new_message', from_name: '平台', to_name: 'agent-1', content: long, task_id: 't_9' }, ctx());
  assert.ok(msg);
  assert.match(msg!.title, /平台 → agent-1/);
  assert.ok(msg!.body.length <= 121);
  assert.equal(msg!.tag, 't_9');
});

test('没有正文时宁可不弹，也不弹空通知', () => {
  assert.equal(notificationFor({ type: 'new_message', from_name: 'a' }, ctx()), null);
});

test('偏好读写：默认关；写入后可读回；存储异常按关闭处理', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assert.equal(readNotifyPreference(storage), false);
  assert.equal(writeNotifyPreference(storage, true), true);
  assert.equal(store.get(NOTIFY_STORAGE_KEY), '1');
  assert.equal(readNotifyPreference(storage), true);
  assert.equal(readNotifyPreference(null), false);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readNotifyPreference(broken as never), false);
  assert.equal(writeNotifyPreference(broken as never, true), false);
});
