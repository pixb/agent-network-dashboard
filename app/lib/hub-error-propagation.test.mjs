import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 契约：读失败 ≠ 没有数据。
//
// 事故形状（2026-10-26）：`/api/hub/status` 是 SWR 的共享 key，Sidebar 注册的
// statusFetcher 在非 2xx 时返回 `{ sessions: [] }`。SWR 缓存按 key 去重，
// 于是 Sidebar 先解析出的「空」污染了整张页面：/nodes 显示「npx init 建第一个
// Agent」、/versions 显示「当前网络没有在线会话」、/messages 显示空态——全是
// 把「Hub 读不到」说成「本来就没有」。断言写在源码契约层，因为复现它需要
// 一个会返回 5xx 的 Hub（e2e 里很难稳定挡在缓存去重之前）。

const root = join(import.meta.dir, '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

describe('读失败必须冒泡，不能伪装成空数据', () => {
  test('共享 fetcher 对非 2xx 抛错（而不是 res.json() 当数据）', () => {
    const src = read('app/lib/hooks.ts');
    const fetcher = src.slice(src.indexOf('const fetcher'), src.indexOf('const SWR_OPTIONS'));
    expect(fetcher).toContain('if (!res.ok)');
    expect(fetcher).toMatch(/throw Object\.assign\(/);
  });

  test('Sidebar 的 statusFetcher 不再把非 2xx 吞成 { sessions: [] }', () => {
    const src = read('app/components/Sidebar.tsx');
    const start = src.indexOf('const statusFetcher');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 600);
    expect(body).toContain('if (!res.ok)');
    expect(body).not.toContain(': { sessions: [] }');
    // 同一 key 被多处注册；任何一处吞错都会重新污染缓存。
    const swallow = /'\/api\/hub\/status'[^)]*\)\s*\.then\(\s*r\s*=>\s*r\.ok\s*\?/;
    expect(swallow.test(src)).toBe(false);
  });

  test('代理层不再把上游 5xx 透传成 200', () => {
    for (const rel of ['app/api/hub/status/route.ts', 'app/api/hub/messages/route.ts']) {
      const src = read(rel);
      expect(src).toContain('if (!res.ok)');
      expect(src).toMatch(/status: res\.status/);
    }
    const tasks = read('app/api/hub/tasks/route.ts');
    // /api/tasks 失败后回退 /api/completions；两个都挂时必须 502，
    // 否则返回 { ok: true, tasks: [] } —— 用户看到的是「暂无任务」。
    expect(tasks).toContain('if (!compRes.ok)');
  });

  test('页面在 error 时不得渲染空态引导', () => {
    const nodes = read('app/nodes/NodesView.tsx');
    expect(nodes).toMatch(/loadError\s*&&\s*sessions\.length === 0/);
    const tasks = read('app/tasks/TasksView.tsx');
    expect(tasks).toMatch(/error\s*&&\s*tasks\.length === 0/);
    const versions = read('app/versions/page.tsx');
    expect(versions).toContain('failed');
    const messages = read('app/messages/page.tsx');
    // 守卫必须跟着**真正渲染的那条列表**走。/messages 现在把收件箱行并进时间线，
    // 渲染列表是 timeline；若继续写死 messages.length，「网络消息读失败 + 收件箱
    // 里有私信」会直接渲染 EmptyState —— 把读失败伪装成「这里很安静」，正是本测试要拦的事。
    expect(messages).toMatch(/error\s*&&\s*(messages|timeline)\.length === 0/);
  });
});

describe('其余代理路由：5xx 不再伪装成空列表', () => {
  test('/api/hub/tokens 失败不再返回 200 空 token 列表', () => {
    // 旧行为正好命中 /settings/tokens 注释里的坑：空列表会让用户重复建 token。
    const src = read('app/api/hub/tokens/route.ts');
    expect(src).not.toContain('ok: true, tokens: []');
    expect(src).toMatch(/status: res\.status === 404 \? 502 : res\.status/);
  });

  test('/api/hub/networks 与 /api/hub/task-events 的 404 显式标 unavailable', () => {
    for (const rel of ['app/api/hub/networks/route.ts', 'app/api/hub/task-events/route.ts']) {
      const src = read(rel);
      expect(src).toContain('res.status === 404');
      expect(src).toContain('unavailable: true');
      expect(src).toMatch(/status: res\.status/);
    }
  });

  test('/api/hub/nodes 两个上游都失败时报错，且 status 兜底只有一份映射', () => {
    const src = read('app/api/hub/nodes/route.ts');
    expect(src).toContain('function nodesFromSessions');
    expect(src.match(/nodesFromSessions\(/g).length).toBe(3); // 1 定义 + 2 调用
    expect(src).toContain('/api/status ${statusRes.status}');
    expect(src).toMatch(/\{ status: 502 \}/);
  });
});

describe('移动端空/错状态不能是整屏空白', () => {
  test('/nodes 在 sessions.length === 0 时也渲染主列（手机没有 manageView 入口）', () => {
    const src = read('app/nodes/NodesView.tsx');
    expect(src).toMatch(/sessions\.length === 0\)\)\s*&&\s*\(/);
  });
});
