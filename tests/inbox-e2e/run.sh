#!/usr/bin/env bash
# 收件箱页的端到端验证（一次性 hub + 一次性 Dashboard dev server）。
#
# 为什么要有这个脚本：`/messages/inbox` 是**读路径**，仓库里的单元测试只证明纯函数
# 与代理契约，证明不了「浏览器真能读到 Hub 的 user_inbox」。这条链路三个环节都会
# 单独坏掉：代理不透传 scope、页面不带 scope、Hub 按鉴权身份过滤 —— 只有真起
# Hub + 真起 Dashboard 才能一次判完。
#
# 只动一次性资源：临时目录里的 hub、临时端口上的 dev server、临时注册的用户。
# 绝不连生产 hub，也不改任何生产配置。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH_ROOT="$(cd "$HERE/../.." && pwd)"
HUB_SRC="${ANET_E2E_HUB_SRC:-/vol1/1000/docker/nec8-docker/agent-network/server}"
[ -f "$HUB_SRC/bin/commhub.ts" ] || { echo "no commhub source at $HUB_SRC (set ANET_E2E_HUB_SRC)" >&2; exit 2; }

WORK="$(mktemp -d /tmp/anet-inbox-e2e.XXXXXX)"
HUB_PORT="${ANET_INBOX_HUB_PORT:-19961}"
DASH_PORT="${ANET_INBOX_DASH_PORT:-19962}"
HUB="http://127.0.0.1:$HUB_PORT"
DASH="http://127.0.0.1:$DASH_PORT"
trap 'kill ${HUB_PID:-0} ${DASH_PID:-0} 2>/dev/null || true; [ "${KEEP_WORK:-}" = "1" ] || rm -rf "$WORK"' EXIT

DM_TEXT="e2e question: which output directory should the render use?"
STEP() { echo "── $*"; }
FAIL() { echo "E2E FAILED: $*" >&2; exit 1; }

STEP "boot a throwaway hub"
COMMHUB_DB="$WORK/hub.db" bun run "$HUB_SRC/bin/commhub.ts" \
  --port "$HUB_PORT" --host 127.0.0.1 --db "$WORK/hub.db" --dev-open >"$WORK/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -sf "$HUB/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$HUB/health" >/dev/null 2>&1 || FAIL "hub did not come up (see $WORK/hub.log)"

STEP "seed: user + network + node + one node→human DM"
python3 - "$HUB" "$WORK/ids.json" "$DM_TEXT" <<'PY'
import json, sys, urllib.request
hub, ids_path, dm_text = sys.argv[1:4]

def call(path, tok=None, method="GET", body=None):
    h = {"Content-Type": "application/json"}
    if tok: h["Authorization"] = "Bearer " + tok
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(hub + path, method=method, headers=h, data=data)
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "body": e.read().decode()[:300]}

reg = call("/api/auth/register", method="POST", body={"username": "e2e-admin", "password": "e2e-password-123"})
utok = reg.get("token")
if not utok: sys.exit(f"register failed: {reg}")

net = call("/api/networks", utok, "POST", {"name": "e2e-project"})
netid = net.get("network_id") or (net.get("network") or {}).get("network_id")
if not netid: sys.exit(f"network create failed: {net}")

node = call("/api/auth/node-token", utok, "POST",
            {"network_id": netid, "node_name": "e2e-node", "node_id": "n_e2e_node01"})
ntok = node.get("token")
if not ntok: sys.exit(f"node token failed: {node}")

# 节点 → 人 的私信：MCP send_desktop_message（Dashboard 收件箱页读的就是这些行）
mcp = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": "send_desktop_message",
                             "arguments": {"to_username": "e2e-admin", "message": dm_text,
                                           "network_id": netid}}})
req = urllib.request.Request(hub + "/mcp", method="POST",
    headers={"Authorization": "Bearer " + ntok, "Content-Type": "application/json",
             "Accept": "application/json, text/event-stream"}, data=mcp.encode())
raw = urllib.request.urlopen(req).read().decode()
if "desktop_target" in raw: sys.exit(f"dm target failed: {raw[-300:]}")

# 一条 hub 代发的通知形状，确保 kind 不止一种时界面也不丢行
call("/api/tasks", utok, "POST", {"alias": "e2e-node", "task": "e2e task for the inbox e2e", "network_id": netid})
json.dump({"utok": utok, "network_id": netid, "node_token": ntok}, open(ids_path, "w"))
print("seeded: user=e2e-admin network=%s node=e2e-node" % netid)
PY
NET=$(python3 -c "import json;print(json.load(open('$WORK/ids.json'))['network_id'])")

STEP "start the dashboard dev server against the throwaway hub"
# 变量名以 app/lib/hub.ts 为准：`process.env.COMMHUB_URL`（不是 COMM_HUB_URL）。
# 名字写错的形状是「Dashboard 起来了，但连的是它自己默认的 9200」—— 那种情况下
# 这一屏读到的是另一个 Hub，测试通过也不能说明什么。
COMMHUB_URL="$HUB" npx next dev -p "$DASH_PORT" -H 127.0.0.1 >"$WORK/dash.log" 2>&1 &
DASH_PID=$!
# 就绪探针用公开页 `/login`：`/api/hub/*` 在没有任何会话时就是 401（这是
# requireDashboardAuth 的正确行为），拿它当就绪信号会把「鉴权门槛工作正常」
# 误判成「服务没起来」。
for _ in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$DASH/login")" = "200" ] && break; sleep 1; done
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$DASH/login")" != "200" ]; then KEEP_WORK=1; tail -20 "$WORK/dash.log" >&2; FAIL "dashboard dev server did not come up (log kept in $WORK/dash.log)"; fi

STEP "login through the dashboard's own proxy (session cookie)"
LOGIN=$(curl -s -c "$WORK/cookies.txt" -X POST "$DASH/api/auth/v3" \
  -H 'Content-Type: application/json' \
  -d '{"action":"login","username":"e2e-admin","password":"e2e-password-123"}')
grep -q '"ok":true' <<<"$LOGIN" || grep -q 'anet_dashboard_session' "$WORK/cookies.txt" \
  || FAIL "dashboard login did not produce a session: $LOGIN"
COOKIE="$(grep -E 'anet_dashboard_session' "$WORK/cookies.txt" | awk '{print $6"="$7}' | tail -1)"
[ -n "$COOKIE" ] || FAIL "no session cookie in the jar"

STEP "1) the proxy answers scope=user with the DM row"
PROXY=$(curl -s -b "$WORK/cookies.txt" "$DASH/api/hub/messages?scope=user&network_id=$NET&limit=50")
grep -qF "$DM_TEXT" <<<"$PROXY" || FAIL "proxy did not return the DM: ${PROXY:0:300}"
python3 - "$PROXY" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
rows = d.get("messages") or []
assert rows, "proxy returned no rows"
assert all("user_id" in r for r in rows), "rows are not user_inbox shaped (no user_id)"
kinds = {r.get("kind") for r in rows}
assert "agent_message" in kinds, f"kind=agent_message missing: {kinds}"
print(f"   proxy rows={len(rows)} kinds={sorted(k for k in kinds if k)} unread={d.get('unread')}")
PY

STEP "2) the alias-scoped read (what the Messages page uses) does NOT contain the DM"
ALIAS=$(curl -s -b "$WORK/cookies.txt" "$DASH/api/hub/messages?alias=e2e-admin&network_id=$NET&limit=50")
grep -qF "$DM_TEXT" <<<"$ALIAS" && FAIL "the DM leaked into the alias-scoped read; the two surfaces are not separable"
echo "   confirmed: DM is invisible to the Messages page's read path"

STEP "3) /messages/inbox serves (200) and renders the inbox shell"
PAGE_CODE="$(curl -s -o "$WORK/inbox.html" -w '%{http_code}' -b "$WORK/cookies.txt" "$DASH/messages/inbox")"
[ "$PAGE_CODE" = "200" ] || FAIL "/messages/inbox returned $PAGE_CODE"
grep -qi 'My inbox' "$WORK/inbox.html" || grep -q '我的收件箱' "$WORK/inbox.html" \
  || FAIL "/messages/inbox did not render the inbox page (see $WORK/inbox.html)"
echo "   confirmed: /messages/inbox renders"

STEP "4) the Messages page links to it"
MSGS="$(curl -s -b "$WORK/cookies.txt" "$DASH/messages")"
grep -q '/messages/inbox' <<<"$MSGS" || FAIL "the Messages page has no link to /messages/inbox"
echo "   confirmed: entry link present"

STEP "5) 标已读：按发件人整批 ack，未读数随之下降"
# 这一步是「合并进时间线」的前置条件。hub 侧 ack 端点早就有（POST /api/messages/ack），
# 缺的一直是 dashboard 侧的代理与按钮：没有它，收件箱的未读徽标是**清不掉的红点**，
# 把这类行并进消息流就等于制造一个永远消不掉的提醒。
BEFORE=$(curl -s -b "$WORK/cookies.txt" "$DASH/api/hub/messages?scope=user&network_id=$NET&limit=50")
ACK=$(curl -s -b "$WORK/cookies.txt" -X POST "$DASH/api/hub/messages-ack" \
  -H 'Content-Type: application/json' -d '{"agent":"e2e-node"}')
grep -q '"ok":true' <<<"$ACK" || FAIL "ack proxy did not succeed: ${ACK:0:300}"
AFTER=$(curl -s -b "$WORK/cookies.txt" "$DASH/api/hub/messages?scope=user&network_id=$NET&limit=50")
python3 - "$BEFORE" "$AFTER" <<'PY'
import json, sys
before, after = (json.loads(x) for x in sys.argv[1:3])
def unread(d):
    v = d.get("unread")
    if isinstance(v, int): return v
    return sum(1 for r in (d.get("messages") or []) if not r.get("acked"))
b, a = unread(before), unread(after)
assert b > 0, f"nothing was unread before ack: {b}"
assert a < b, f"unread did not drop after ack: {b} -> {a}"
dm = [r for r in (after.get("messages") or []) if r.get("kind") == "agent_message"]
assert dm and all(r.get("acked") for r in dm), f"DM rows still unacked after ack: {[r.get('acked') for r in dm]}"
print(f"   unread {b} -> {a}; agent_message acked={sorted({bool(r.get('acked')) for r in dm})}")
PY

STEP "6) ack 代理不接受白名单之外的字段（不让前端拼出的任意字段直达 hub）"
BAD=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookies.txt" -X POST "$DASH/api/hub/messages-ack" \
  -H 'Content-Type: application/json' -d '{"user_id":"u_anyone"}')
[ "$BAD" = "400" ] || FAIL "unknown ack field returned $BAD, expected 400"
echo "   confirmed: non-whitelisted ack field rejected"

echo
echo "inbox e2e: PASS (6 checks)"
