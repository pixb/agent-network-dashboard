import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * 为什么钉这几处（和 proxy-allowlists.test.mjs 同一类测试）：
 *
 * 节点发给人的私信走 hub 的 `user_inbox` 表，只有 `GET /api/messages?scope=user`
 * 返回它；Messages 页读的是 `inbox` 表，里面**永远不会出现私信**。生产实测
 * （net_b91c0d535346，2026-11-04）：admin 的 user_inbox 42 行、acked 全 0
 * （25 task_expired / 9 task_orphan_suspected / 8 agent_message），而当时
 * 前端没有任何一处带 `scope=user` —— 界面上一行都没有。
 *
 * 这个文件不证明界面好看，只钉住四件会被后续重构悄悄拆掉的事：
 * 1) 代理透传 scope（不透传的话收件箱页永远拿到全量 inbox，私信消失）；
 * 2) 收件箱页确实读 scope=user，并按 user_inbox 的真实列名取字段；
 * 3) 收件箱入口在「这一页没有消息」时仍然可达（私信多的时候消息流常常正是空的）；
 * 4) 未读态（acked=0）被渲染，不是收下就丢。
 */

const ROUTE = readFileSync(new URL('../api/hub/messages/route.ts', import.meta.url), 'utf8');
const HOOKS = readFileSync(new URL('./hooks.ts', import.meta.url), 'utf8');
const INBOX_PAGE = readFileSync(new URL('../messages/inbox/page.tsx', import.meta.url), 'utf8');
const INBOX_LIB = readFileSync(new URL('./user-inbox.ts', import.meta.url), 'utf8');
const MESSAGES_PAGE = readFileSync(new URL('../messages/page.tsx', import.meta.url), 'utf8');

describe('hub 消息代理对收件箱参数的透传', () => {
  test('scope / kind / unacked_only 都在透传名单里', () => {
    // 判据是「收件箱页用到的每个参数都真的到了 Hub」，不是「代理代码存在」。
    expect(ROUTE).toMatch(/qs\.set\('scope'/);
    expect(ROUTE).toMatch(/qs\.set\('kind'/);
    expect(ROUTE).toMatch(/qs\.set\('unacked_only'/);
  });

  test('透传是条件式的：不传 scope 时不会替调用方决定读谁的收件箱', () => {
    // 代理一旦被允许写 scope 值（qs.set('scope','user')），Messages 页的
    // 全量时间线就会变成「只有我自己收件箱」的视图 —— 参数缺失时必须原样不传。
    expect(ROUTE).toMatch(/if\s*\(scope\)\s*qs\.set\('scope',\s*scope\)/);
  });
});

describe('收件箱页的数据来源', () => {
  test('hook 以 scope=user 请求', () => {
    expect(HOOKS).toMatch(/scope:\s*'user'/);
  });

  test('收件箱页用 user_inbox 的真实列名，不假设 inbox 的 from_alias/to_alias', () => {
    // Hub 的 user_inbox 没有 to_alias，发件来源列叫 from_session（分组在
    // app/lib/user-inbox.ts 里发生）。把分组改成读 from_alias 的那一瞬间，
    // 发件人会全部变成空白 —— 私信又看不见了。
    expect(INBOX_LIB).toMatch(/from_session/);
    expect(INBOX_PAGE).not.toMatch(/from_alias/);
    expect(INBOX_PAGE).toMatch(/message_id/);
  });

  test('未读态被渲染：acked 参与界面，不是收下就丢', () => {
    expect(INBOX_PAGE).toMatch(/isUnreadRow/);
    expect(INBOX_PAGE).toMatch(/countUnreadUserInbox/);
  });

  test('未知 kind 也进界面（kindTone/kindLabel 走全量行，不做白名单过滤）', () => {
    expect(INBOX_PAGE).toMatch(/kindLabel/);
    expect(INBOX_PAGE).toMatch(/kindTone/);
    expect(INBOX_PAGE).toMatch(/summarizeUserInbox/);
  });
});

describe('收件箱入口的可达性', () => {
  test('消息流页有指向 /messages/inbox 的入口', () => {
    expect(MESSAGES_PAGE).toMatch(/href="\/messages\/inbox"/);
  });

  test('入口在 `messages.length > 0` 的 chrome 门之外', () => {
    // 生产形状：admin 的 Messages 页 0 行（inbox 表里没有发给人的行），
    // 收件箱 42 行。入口若被 `{messages.length > 0 && (` 包住，
    // 最需要看到私信的人正好找不到它。
    const linkIndex = MESSAGES_PAGE.indexOf('href="/messages/inbox"');
    const gateIndex = MESSAGES_PAGE.indexOf('{messages.length > 0 && (');
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeLessThan(gateIndex);
  });
});
