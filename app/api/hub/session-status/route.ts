import { requireDashboardAuth } from '@/app/lib/dashboard-auth';
import { hubFetch } from '@/app/lib/hub';

/**
 * 紧凑版会话状态：只回 `{ alias, status }`。
 *
 * 为什么需要：军团 2D / 3D 只需要「alias → 运行状态」来点亮图例，
 * 但它们拉的是 /api/hub/status —— 生产实测 **709 KB**（393 个 session 全量对象）。
 * 公网约 240 KB/s，光这一份就是 3 秒，军团页因此首屏很慢。
 * 这里在服务端投影出两个字段，回包体积降到约 1/30。
 *
 * 注意：只做投影，不做任何状态判定；判定仍在 /api/hub/overview（presence.ts）
 * 与页面原有的逻辑里，避免多一套「什么算在线」的定义。
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;

  const { searchParams } = new URL(req.url);
  const networkId = searchParams.get('network_id') || '';
  const includeFilter = networkId && networkId !== 'all';
  const qs = includeFilter ? `?network_id=${encodeURIComponent(networkId)}` : '';

  try {
    const res = await hubFetch(`/api/status${qs}`);
    if (!res.ok) {
      return Response.json(
        { ok: false, error: `CommHub /api/status ${res.status}` },
        { status: res.status === 404 ? 502 : res.status },
      );
    }
    const data = await res.json();
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return Response.json({
      ok: true,
      sessions: sessions
        .filter((s: { alias?: string }) => typeof s?.alias === 'string')
        .map((s: { alias: string; status?: string }) => ({ alias: s.alias, status: s.status ?? '' })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'hub request failed' },
      { status: 502 },
    );
  }
}
