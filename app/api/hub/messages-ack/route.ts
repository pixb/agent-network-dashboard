import { requireDashboardAuth, getV3UserToken } from '@/app/lib/dashboard-auth';
import { hubFetch } from '@/app/lib/hub';

/**
 * 收件箱标已读代理：`POST /api/hub/messages-ack` → Hub `POST /api/messages/ack`。
 *
 * 为什么必须有这一条：Dashboard 之前没有任何 ack 通路，于是
 * `user_inbox` 里的行**永远不会变成已读**。Hub 侧的分母是「全部未 ack 的行」，
 * 客户端只看得到最近一页 —— 生产 admin 的形状是 user_inbox 522 行 + inbox 5660 行
 * 清不掉（hub 代码里就是按这个事故加的 `{agent}` 形态）。
 * 收件箱页要能「把这个节点发来的都标已读」，只有一条路：调 Hub 的 agent 形态。
 *
 * 只透传四个字段，其余一律拒：Hub 的 ack 同时认 `message_id` / `message_ids` /
 * `agent`，多传一个键（比如 `user_id`）就会被 Hub 忽略或拒；更糟的是将来 Hub 新增
 * 一个语义不同的键，这里会静默放行。白名单 + 显式拒绝 = 加字段时测试先红。
 *
 * 收件人不由前端决定：Hub 从鉴权上下文取 userId，并且 `AND user_id = <ctx>` ——
 * 传别人的 message_id 匹配不到行，既改不到别人的状态，也不泄漏它是否存在。
 */

export const ACK_FIELDS = ['message_ids', 'message_id', 'agent', 'network_id'] as const;
const MAX_IDS = 500;

export async function POST(req: Request) {
  const authFailure = await requireDashboardAuth();
  if (authFailure) return authFailure;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ ok: false, error: 'invalid_request', detail: 'json object required' }, { status: 400 });
  }

  const extra = Object.keys(body).filter((k) => !(ACK_FIELDS as readonly string[]).includes(k));
  if (extra.length) {
    return Response.json(
      { ok: false, error: 'proxy_field_not_allowed', fields: extra, allowed: ACK_FIELDS },
      { status: 400 },
    );
  }

  const payload: Record<string, unknown> = {};
  let hasIds = false;

  if (Array.isArray(body.message_ids)) {
    const ids = body.message_ids.filter((x: unknown) => typeof x === 'string' && x.length > 0);
    if (ids.length > MAX_IDS) {
      return Response.json({ ok: false, error: 'too_many_ids', limit: MAX_IDS }, { status: 400 });
    }
    payload.message_ids = ids;
    hasIds = ids.length > 0;
  } else if (typeof body.message_id === 'string' && body.message_id) {
    payload.message_id = body.message_id;
    hasIds = true;
  }

  const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
  if (agent) payload.agent = agent;

  if (!hasIds && !agent) {
    return Response.json(
      { ok: false, error: 'ack_target_required', detail: 'message_id, message_ids, or agent is required' },
      { status: 400 },
    );
  }

  const networkId = typeof body.network_id === 'string' && body.network_id ? body.network_id : '';

  const userToken = await getV3UserToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userToken) headers['Authorization'] = `Bearer ${userToken}`;

  // utok 没有隐式网络（多网络账号必须点名），Hub 的 ack 也走同一个 scope 助手，
  // 所以 network_id 走 query 而不是 body。
  const path = `/api/messages/ack${networkId ? `?network_id=${encodeURIComponent(networkId)}` : ''}`;
  const res = await hubFetch(path, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({ ok: false, error: 'non_json_response' }));
  return Response.json(data, { status: res.status });
}
