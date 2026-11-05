import { requireDashboardAuth } from '@/app/lib/dashboard-auth';
import { hubFetch } from '@/app/lib/hub';

/**
 * 拓扑「流动连线」用的轻量数据：只回 from/to/时间戳/截断后的内容。
 *
 * 为什么需要：首页拓扑每 5 秒拉 messages?limit=50 + tasks?limit=100
 * （生产实测合计约 430 KB，公网 240 KB/s 下每次轮询约 1.8 秒），
 * 而 buildFlowLinks 只用到：
 *   messages: from_alias / to_alias / content / created_at
 *   tasks:    from_* / to_* / content / created_at|delivered_at|started_at|completed_at
 * content 只作为连线标签的首个样本，截断即可。
 *
 * 做法：服务端并行取两份并投影，浏览器每次轮询只收十几 KB。
 */
export const dynamic = 'force-dynamic';

const CONTENT_MAX = 60;

const cut = (v: unknown): string => {
  const s = typeof v === 'string' ? v : '';
  return s.length > CONTENT_MAX ? `${s.slice(0, CONTENT_MAX)}…` : s;
};

export async function GET(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;

  const { searchParams } = new URL(req.url);
  const networkId = searchParams.get('network_id') || '';
  const msgLimit = Number(searchParams.get('messages') || '50');
  const taskLimit = Number(searchParams.get('tasks') || '100');
  const qs = networkId && networkId !== 'all' ? `&network_id=${encodeURIComponent(networkId)}` : '';

  try {
    const [msgRes, taskRes] = await Promise.all([
      hubFetch(`/api/messages?limit=${msgLimit}${qs}`),
      hubFetch(`/api/tasks?limit=${taskLimit}${qs}`),
    ]);
    if (!msgRes.ok || !taskRes.ok) {
      return Response.json(
        { ok: false, error: `CommHub ${msgRes.status}/${taskRes.status}` },
        { status: 502 },
      );
    }
    const [msgData, taskData] = await Promise.all([msgRes.json(), taskRes.json()]);
    const messages = Array.isArray(msgData.messages) ? msgData.messages : [];
    const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : Array.isArray(taskData) ? taskData : [];

    return Response.json({
      ok: true,
      messages: messages.map((m: Record<string, unknown>) => ({
        from_alias: m.from_alias ?? null,
        to_alias: m.to_alias ?? null,
        content: cut(m.content),
        created_at: m.created_at ?? null,
      })),
      tasks: tasks.map((t: Record<string, unknown>) => ({
        from_alias: t.from_alias ?? null,
        from_name: t.from_name ?? null,
        to_alias: t.to_alias ?? null,
        to_name: t.to_name ?? null,
        content: cut(t.content),
        created_at: t.created_at ?? null,
        delivered_at: t.delivered_at ?? null,
        started_at: t.started_at ?? null,
        completed_at: t.completed_at ?? null,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'hub request failed' },
      { status: 502 },
    );
  }
}
