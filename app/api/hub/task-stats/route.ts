import { requireDashboardAuth } from '@/app/lib/dashboard-auth';
import { hubFetch } from '@/app/lib/hub';

/**
 * 任务状态计数（只回数字，不回任务本体）。
 *
 * 为什么需要：首页只要「每个状态有多少任务」，而 /api/stats 在部分环境不返回
 * tasks.by_status，于是首页退回拉 /api/hub/tasks?limit=500 —— 生产实测
 * **665,867 B**（公网 240 KB/s 约 2.8 秒），只为数出 5 个数字。
 *
 * 做法：服务端取任务列表并就地统计，浏览器只收几百字节。
 * 注意：只做计数，不缓存、不改判定口径（状态字符串原样作为 key）。
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;

  const { searchParams } = new URL(req.url);
  const networkId = searchParams.get('network_id') || '';
  const status = searchParams.get('status') || '';
  const sinceHours = Number(searchParams.get('sinceHours') || '0');
  const includeFilter = networkId && networkId !== 'all';
  const statusQs = status ? `&status=${encodeURIComponent(status)}` : '';
  const qs = `?limit=500${includeFilter ? `&network_id=${encodeURIComponent(networkId)}` : ''}${statusQs}`;

  try {
    const res = await hubFetch(`/api/tasks${qs}`);
    if (!res.ok) {
      return Response.json(
        { ok: false, error: `CommHub /api/tasks ${res.status}` },
        { status: res.status === 404 ? 502 : res.status },
      );
    }
    const data = await res.json();
    const tasks = Array.isArray(data.tasks) ? data.tasks : Array.isArray(data) ? data : [];
    const byStatus: Record<string, number> = {};
    const since = sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0;
    let recent = 0;
    for (const t of tasks) {
      const st = typeof t?.status === 'string' && t.status ? t.status : 'unknown';
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (since > 0) {
        const when = t?.completed_at || t?.created_at;
        const ts = when ? Date.parse(String(when)) : NaN;
        if (Number.isFinite(ts) && ts >= since) recent += 1;
      }
    }
    return Response.json({ ok: true, total: tasks.length, byStatus, recent }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'hub request failed' },
      { status: 502 },
    );
  }
}
