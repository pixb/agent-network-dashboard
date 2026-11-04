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
const ACK_ROUTE = readFileSync(new URL('../api/hub/messages-ack/route.ts', import.meta.url), 'utf8');
const MERGE_LIB = readFileSync(new URL('./messages-merge.ts', import.meta.url), 'utf8');

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

  test('入口在「有消息才显示 chrome」的门之外', () => {
    // 生产形状：admin 的 Messages 页 0 行（inbox 表里没有发给人的行），
    // 收件箱 42 行。入口若被那个门包住，最需要看到私信的人正好找不到它。
    // 门本身现在看的是合并后的 `timeline.length`（私信也算内容），
    // 所以这里钉的是「入口在门之前」这个顺位，不是门里的变量名。
    const linkIndex = MESSAGES_PAGE.indexOf('href="/messages/inbox"');
    const gateIndex = MESSAGES_PAGE.search(/\{(messages|timeline)\.length > 0 && \(/);
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeLessThan(gateIndex);
  });
});

describe('标已读代理（user_inbox 的 ack 通路）', () => {
  test('代理存在，且转发的就是 Hub 的 /api/messages/ack', () => {
    // 没有这条通路，收件箱里的行永远不会变成已读：Hub 的未读分母是「全部未 ack
    // 的行」，而客户端只看得到最近一页（生产 admin：user_inbox 522 行）。
    expect(ACK_ROUTE).toMatch(/\/api\/messages\/ack/);
  });

  test('只透传白名单里的四个字段，其余显式拒', () => {
    // 静默放行一个 Hub 不认识（或将来语义不同）的键，就是下一次红点的形状。
    expect(ACK_ROUTE).toMatch(/ACK_FIELDS\s*=\s*\['message_ids', 'message_id', 'agent', 'network_id'\]/);
    expect(ACK_ROUTE).toMatch(/proxy_field_not_allowed/);
    // agent 形态必须在：逐条点清不完 522 行。
    expect(ACK_ROUTE).toMatch(/\bagent\b/);
  });

  test('network_id 走 query（utok 没有隐式网络），不塞进 body', () => {
    expect(ACK_ROUTE).toMatch(/network_id=\$\{encodeURIComponent\(networkId\)\}/);
  });

  test('收件箱页真的调它', () => {
    // 只钉两件事：调了这个代理，标完重取了一次。不钉代码顺序 ——
    // 顺序断言会把「先 mutate 后 fetch」这种同样正确的写法判成失败。
    expect(INBOX_PAGE).toMatch(/\/api\/hub\/messages-ack/);
    expect(INBOX_PAGE).toMatch(/mutate\(\)/);
    // agent 形态（按发件人整批标已读），不是逐条。
    expect(INBOX_PAGE).toMatch(/agent:\s*sender/);
  });
});

describe('私信并入消息时间线（一个地方看）', () => {
  test('消息流页读收件箱并合并', () => {
    expect(MESSAGES_PAGE).toMatch(/mergeInboxIntoTimeline/);
    expect(MESSAGES_PAGE).toMatch(/useUserInbox/);
  });

  test('合并后的行有类型颜色（dm / notice），不会落到 unknown 灰', () => {
    expect(MESSAGES_PAGE).toMatch(/dm:\s*'bg-/);
    expect(MESSAGES_PAGE).toMatch(/notice:\s*'bg-/);
  });

  test('合并用 ui: 命名空间 —— 两张表的主键不共用一个 key 体系', () => {
    // 钉的是「前缀存在且只有一处」，不是某个具体写法：前缀集中在 lib 里，
    // 页面自己拼的版本会漂（一处漂了就得到跨表去重误伤 + React key 撞车）。
    expect(MERGE_LIB).toMatch(/INBOX_ROW_KEY_PREFIX\s*=\s*'ui:'/);
    expect(MERGE_LIB).toMatch(/inboxRowKey\(row\.message_id\)/);
    // 去重只按 key：按内容去重会把两条真私信并成一条。
    expect(MERGE_LIB).not.toMatch(/dedupByContent/);
  });

  test('chrome 的门看合并后的时间线，不看网络消息数', () => {
    // 生产形状：网络消息 0 行、私信 42 行。门只看 messages.length 时，
    // 筛选器/类型选项在唯一有内容的那一页上是隐藏的。
    expect(MESSAGES_PAGE).toMatch(/\{timeline\.length > 0 && \(/);
  });
});


// 页面级契约要读整个 .tsx，用仓库根相对路径；上面那些代理契约读的是同目录文件。
const page = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('Messages 页把收件箱行并进时间线，且页面守卫跟着合并后的列表', () => {
  const src = page('app/messages/page.tsx');
  // 合并调用 + 两条 feed 都要有：只读 scope=user 不读网络消息，或只读网络消息
  // 不合并，都等于「私信不可见」，只是换了个失败方式。
  expect(src).toContain('mergeInboxIntoTimeline');
  expect(src).toContain('useUserInbox');
  expect(src).toContain('useMessages');
  // 合并行必须能被单独筛出来：没有这两个 option，用户只能在混合流里肉眼找。
  expect(src).toContain('value="dm"');
  expect(src).toContain('value="notice"');
  // 页面 chrome / 搜索 / 空态守卫一律用合并后的列表。用 messages.length 的话，
  // 「网络消息 0 行 + 收件箱 42 行」这个真实生产形状下搜索框会整块消失，
  // 而 42 条私信正在渲染。
  expect(src).toContain('timeline.length');
  expect(src).toContain('enabled: timeline.length > 0');
  // 读失败要冒泡到合并后的列表上，不能因为收件箱读到了就不报。
  expect(src).toContain('error && timeline.length > 0');
});

test('收件箱页只有一张配色表，且它来自 lib', () => {
  const src = page('app/messages/inbox/page.tsx');
  // 页面里再写一张 kind→class 表是漂移源：lib 加一种 kind，页面那张表不会跟着变，
  // 于是新 kind 的 chip 静默失去配色（本次开发里真的写重过一次，靠 build 才抓到）。
  expect(src).not.toMatch(/TONE_CLASS|const TONE\b/);
  const uses = (src.match(/kindTone\(/g) || []).length;
  expect(uses).toBeGreaterThanOrEqual(2); // 汇总 chip + 每行 chip
  // 命名色板不走主题 token：新页面必须从 0 开始（color-ratchet 基线只降不升）。
  expect(src).not.toMatch(/\b(?:bg|text|border)-(?:green|amber|red|blue|yellow|purple|pink|slate|gray)-\d+\//);
});
