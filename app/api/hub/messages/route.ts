import { requireDashboardAuth } from '@/app/lib/dashboard-auth';
import { hubFetch } from '@/app/lib/hub';

export async function GET(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;

  const { searchParams } = new URL(req.url);
  const limit = searchParams.get('limit') || '50';
  const networkId = searchParams.get('network_id') || '';
  // Show last 7 days by default (server defaults to 1 hour which is too short)
  const since = searchParams.get('since') || new Date(Date.now() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const qs = new URLSearchParams({ limit, since });
  if (networkId) qs.set('network_id', networkId);
  // 未读角标第二条取数：只看「发给当前用户」的那一窗。忙碌的网络上，
  // 全网 200 条窗口大多是 agent 之间的往来，用户自己的消息会被挤出去
  // （见 app/lib/chat-unread-feed.ts 的 mergeMessageFeeds）。这只是同一个
  // 网络内换一个过滤条件，不是 #1636-P1 里被撤掉的「为空就放宽作用域」。
  const alias = (searchParams.get('alias') || '').trim();
  if (alias) qs.set('alias', alias);
  try {
    const res = await hubFetch(`/api/messages?${qs.toString()}`);
    // #1636 —— 401 原样上抛
    if (res.status === 401) return Response.json({ error: 'login required' }, { status: 401 });
    // 上游失败不能包装成 200 {ok:false, messages:[]}：那会让页面把
    // 「Hub 读不到」显示成「没有消息」。状态码原样透传（5xx→502）。
    if (!res.ok) {
      return Response.json(
        { ok: false, error: `CommHub /api/messages ${res.status}` },
        { status: res.status === 404 ? 502 : res.status },
      );
    }
    const data = await res.json();
    // #1636-P1 —— 显式指定了 network_id 时，「空」就是答案。
    // 旧实现在这里撤掉 network_id 再查一次，把别的网络的命中以 `source: 'global'`
    // 返回给调用方；如果那次兜底是 401，还会被吞成「200 + 原空集合」。
    // 作用域不能因为「结果为空」被放宽 —— 要跨网络看，由调用方显式切换。
    // lite=1：未读角标只需要 id/from/to/时间戳（见 chat-unread-feed 的 UnreadFeedMessage），
    // 正文与其余字段都不读。生产实测 messages?limit=200 为 319,928 B，正文占了绝大部分。
    if (searchParams.get('lite') === '1' && Array.isArray(data.messages)) {
      data.messages = data.messages.map((m: Record<string, unknown>) => ({
        id: m.id ?? null,
        from_alias: m.from_alias ?? null,
        to_alias: m.to_alias ?? null,
        created_at: m.created_at ?? null,
      }));
    }
    return Response.json(data);
  } catch (e: unknown) {
    return Response.json({ ok: false, messages: [] }, { status: 502 });
  }
}
