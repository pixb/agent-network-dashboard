import { requireDashboardAuth } from '@/app/lib/dashboard-auth';
import { hubFetch } from '@/app/lib/hub';
import { normalizeSessions } from '@/app/lib/session-normalize';
import { presenceStatus, isOnline, type SseSessionsMap } from '@/app/lib/presence';

/**
 * 首屏聚合端点：只回「在线数 / 总数 / presence 状态」这一小组数字。
 *
 * 为什么需要：侧栏只需要两个数字，但 /api/hub/status 会返回全部 session 对象
 * （生产实测 **709 KB**，393 个节点）。公网链路约 240 KB/s，光这一份就要 3 秒，
 * 首屏因此被拖到 6–7 秒。
 *
 * 做法：在**服务端**并行取 status + health（server→hub 是本地回环，几十毫秒），
 * 用 presence 的同一套判定算出数字，浏览器只收几百字节。
 * 判定逻辑必须是同一份（presence.ts），否则侧栏、统计卡、拓扑会各说各话。
 */
export const dynamic = 'force-dynamic';

type HubHealth = {
  ok?: boolean;
  sse_sessions?: SseSessionsMap;
  sse_connections?: number;
} & Record<string, unknown>;

export async function GET(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;

  const { searchParams } = new URL(req.url);
  const networkId = searchParams.get('network_id') || '';
  const includeFilter = networkId && networkId !== 'all';
  const qs = includeFilter ? `?network_id=${encodeURIComponent(networkId)}` : '';

  try {
    // 并行：两个请求互不依赖，串行会对公网首屏各付一次往返（本机无感、公网很痛）。
    const [statusRes, healthRes] = await Promise.all([
      hubFetch(`/api/status${qs}`),
      hubFetch('/health'),
    ]);

    if (!statusRes.ok) {
      return Response.json(
        { ok: false, error: `CommHub /api/status ${statusRes.status}` },
        { status: statusRes.status === 404 ? 502 : statusRes.status },
      );
    }

    const statusData = await statusRes.json();
    const sessions = Array.isArray(statusData.sessions)
      ? normalizeSessions(statusData.sessions)
      : [];
    const health = healthRes.ok ? (await healthRes.json()) as HubHealth : null;
    const sseSessions = health?.sse_sessions;

    const online = sessions.filter((s: { alias?: string; network_id?: string }) =>
      s.alias ? isOnline({ alias: s.alias, network_id: s.network_id }, sseSessions) : false,
    ).length;

    return Response.json({
      ok: true,
      total: sessions.length,
      online,
      presence: presenceStatus(sseSessions, health ?? undefined),
      // 只在「有 SSE 统计」时给出，避免前端拿 0 当真实在线数
      known: Boolean(sseSessions),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'hub request failed' },
      { status: 502 },
    );
  }
}
