import { requireDashboardAuth } from '@/app/lib/dashboard-auth';
import { hubFetch } from '@/app/lib/hub';

/**
 * 登录设备（对齐客户端「账号 → 登录设备」）。
 *
 * Hub 侧合同（客户端 src/login-sessions-api.ts）：
 *   GET    /api/auth/sessions               列表
 *   DELETE /api/auth/sessions/:id           退出某一台
 *   POST   /api/auth/sessions/revoke-others 退出其他所有设备
 *
 * 这些接口只接受**用户 token**。用节点 token 登录 Dashboard 会得到
 * `user_token_required`——这不是故障，而是「这种登录取不到用户会话」，
 * 所以原样透传状态码与 code，由 UI 解释，而不是假装成功或吞成空列表。
 */
export async function GET() {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;
  try {
    const res = await hubFetch('/api/auth/sessions');
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e: unknown) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'hub unreachable' }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return Response.json({ ok: false, error: 'missing id' }, { status: 400 });
  try {
    const res = await hubFetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e: unknown) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'hub unreachable' }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;
  const action = new URL(req.url).searchParams.get('action') || '';
  if (action !== 'revoke-others') return Response.json({ ok: false, error: 'unsupported action' }, { status: 400 });
  try {
    const res = await hubFetch('/api/auth/sessions/revoke-others', { method: 'POST' });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e: unknown) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'hub unreachable' }, { status: 502 });
  }
}
