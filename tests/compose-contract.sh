#!/usr/bin/env bash
# 部署定义的可重建性契约。
#
# 这条测试要防的是「只有某台机器上的人记得怎么部署」。仓库里 deploy/ 有
# dash-start.sh（pm2 路径）已经好几年，但 compose 路径此前只存在于运行机上，
# 仓库里没有权威副本 —— 空机器复现不出来。这里把 compose 侧的关键约定钉住。
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
DF=deploy/compose/Dockerfile
CF=deploy/compose/compose.yaml
ENVT=deploy/compose/dashboard.env.template
chk() { if eval "$2"; then echo "  ok: $1"; else echo "  MISSING: $1" >&2; fail=1; fi; }
absent() { if ! eval "$2"; then echo "  ok: $1"; else echo "  FORBIDDEN: $1" >&2; fail=1; fi; }
[ -f "$DF" ] && [ -f "$CF" ] && [ -f "$ENVT" ] || { echo "deploy/compose 缺文件"; exit 1; }

echo "── 镜像：基础镜像与版本钉法"
chk "基础镜像主版本 = lockfile 验证用的 Node 主版本（node:24，#1272）" \
  "grep -q 'ARG NODE_IMAGE=node:24' $DF"
chk "版本由 ARG 传入（不是写死在 RUN 里）" \
  "grep -q 'ARG VERSION=' $DF"
chk "安装带 --include=optional（standalone 产物的平台相关可选依赖）" \
  "grep -q -- '--include=optional' $DF"
chk "compose 显式传 VERSION（部署版本记录在 compose 里，不在 Dockerfile 里）" \
  "grep -q 'VERSION:' $CF"
absent "Dockerfile 的 CMD 不写死版本号（写死后换版本会出现「CMD 跑旧包」）" \
  "grep -E 'CMD .*preview\\.[0-9]+' $DF"
chk "非 root 运行" \
  "grep -q '^USER ' $DF"

echo "── 端口契约：只监听 127.0.0.1"
chk "HOSTNAME=127.0.0.1（绑 0.0.0.0 等于把带会话的 UI 挂到局域网，绕过反代层）" \
  "grep -q 'ENV HOSTNAME=127.0.0.1' $DF"
chk "host 网络（Caddy :3000 / frpc :3100 都按 127.0.0.1:3001 反代）" \
  "grep -q 'network_mode: host' $CF"
absent "不用 ports: 映射（桥接网络会改变反代侧看到的源地址）" \
  "grep -qE '^ *ports:' $CF"

echo "── 就绪探针：/login，不是 /api/hub/health"
# 只看真正的探针命令（带 fetch( 的那行），不看注释：
# 注释里提到 /api/hub/health 是「不要用」的说明，扫全文会把说明当成违规。
probe_lines() { grep -E 'fetch\(' "$1" || true; }
chk "探针打 /login（公开页，200 即就绪）" \
  "probe_lines $DF | grep -q '/login' && probe_lines $CF | grep -q '/login'"
absent "探针不打 /api/hub/health（无会话时 401，curl -f 判不健康 —— 2026-11-04 实测）" \
  "probe_lines $DF | grep -q '/api/hub/health'"

echo "── 环境变量：名字入库，值不入库"
# 反向对齐：代码里读的每个 env 名字，模板里必须出现。
# 这条是防「模板与代码分叉」——新加一个 env 变量而模板没写，
# 换机器的人只能靠读源码才知道有这一项。
missing=""
for name in $(grep -rhoE "process\.env\.[A-Z0-9_]+" app --include='*.ts' --include='*.tsx' | sed 's/^process\.env\.//' | sort -u); do
  # 框架/内部哨兵，不该由部署方设置：
  #   NODE_ENV                    Next.js 自己设
  #   NEXT_PUBLIC_*               构建期常量，烧进 bundle，运行时设无效
  #   _DASHBOARD_TOKEN_WARN_SHOWN 进程内一次性告警哨兵
  case "$name" in
    NODE_ENV|_DASHBOARD_TOKEN_WARN_SHOWN) continue ;;
    NEXT_PUBLIC_*) continue ;;
  esac
  grep -q "^${name}=" "$ENVT" || missing="$missing $name"
done
chk "代码读取的每个运行时 env 变量都在模板里声明（缺:$missing）" \
  "test -z '$missing'"

chk "COMMHUB_URL 显式声明（逐字符敏感：COMM_HUB_URL 会静默连默认 hub）" \
  "grep -q '^COMMHUB_URL=' $ENVT"
absent "模板里不出现 COMM_HUB_URL 这个错名字" \
  "grep -q '^COMM_HUB_URL=' $ENVT"
chk "DASHBOARD_PASSWORD 显式声明且标为必设（容器内无 ~/.config/anet/cli.json，
     缺它则登录口令回落成空串，谁都登不进去，而 /login 照常 200）" \
  "grep -q '^DASHBOARD_PASSWORD=' $ENVT"

# 值形状扫描：模板只允许空值与带 REPLACE_ME 的占位符。
# 允许占位符里带结构（如 http://REPLACE_ME:9200）：变量名与格式本身是有用信息，
# 只要地址不是真实主机就不算泄密。
leaky=$(awk -F= '/^[A-Z][A-Z0-9_]*=/ { v=substr($0, index($0,"=")+1); if (v != "" && v !~ /REPLACE_ME/) print $1 }' "$ENVT")
chk "模板只含占位符/空值（泄漏字段:[$leaky]）" "test -z '$leaky'"
# 占位符之外的真实地址：模板与 compose 都不得出现非 REPLACE_ME 的 hub 地址。
# 排除项：注释行（# 开头）与 loopback 地址。探针里写死 127.0.0.1:3001 是端口契约，
# 注释里提 atok_ 是「不要写真实值」的说明 —— 扫到它们不是泄密，是把检查做成噪音。
noncomment() { grep -vE '^[[:space:]]*#' "$@" || true; }
real_host=$(noncomment "$ENVT" "$CF" | grep -E '://[A-Za-z0-9.-]+:[0-9]+' | grep -vE 'REPLACE_ME|://(127\.0\.0\.1|localhost):' || true)
chk "模板与 compose 不含真实主机地址（命中:[$(echo "$real_host" | tr '\n' ' ')]）" "test -z '$real_host'"
leaky_cf=$(noncomment "$CF" "$ENVT" | grep -nE 'atok_|utok_' | grep -v REPLACE_ME || true)
chk "不含 token 值（命中:[$(echo "$leaky_cf" | tr '\n' ' ')]）" "test -z '$leaky_cf'"

echo "── compose 文件本身能被解析"
# 只靠肉眼读 YAML 不算：一个缩进错到部署时才发现，而部署时机往往是故障现场。
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  # env 变量引用在文件不存在时会让 config 报错，所以指一个空文件去查结构。
  tmp_env="$(mktemp)"; trap 'rm -f "$tmp_env"' EXIT
  if ANET_DASHBOARD_ENV_FILE="$tmp_env" docker compose -f "$CF" config >/dev/null 2>&1; then
    echo "  ok: docker compose config 解析通过"
  else
    echo "  FAIL: docker compose config 解析失败" >&2; fail=1
  fi
else
  # 没有 docker 时退回到 YAML 语法层，不让这条检查静默跳过。
  if python3 -c "import yaml,sys; yaml.safe_load(open('$CF'))" 2>/dev/null; then
    echo "  ok: YAML 语法合法（本机无 docker，未做 compose 语义校验）"
  else
    echo "  FAIL: YAML 语法非法（且本机无 docker 可做完整校验）" >&2; fail=1
  fi
fi
chk "init: true（bin/start.js 不转发 SIGTERM，docker stop 发的是 SIGTERM）" \
  "grep -q 'init: true' $CF"
chk "CMD 跑包声明的入口 bin/start.js（本包无 standalone server.js）" \
  "grep -q 'bin/start.js' $DF"
# 本文件只服务一个 service，所同一缩进下的键必须唯一；出现重复就是
# 「后一个默默盖掉前一个」（我写这份文件时就不小心写重了一个 restart）。
dupkeys=$(grep -nE '^[[:space:]]+[A-Za-z_][A-Za-z0-9_-]*:' "$CF" | sed -E 's/^[0-9]+://' | sed -E 's/^([[:space:]]+)([A-Za-z_][A-Za-z0-9_-]*):.*/\1|\2/' | sort | uniq -d)
chk "compose 里没有重复的键（命中:[$(echo "$dupkeys" | tr '\n' ' ')]）" "test -z '$dupkeys'"

echo "── 恢复文档回答六个问题里的关键几条"
chk "README 说清 pm2（现网）与 compose（重建）哪条在跑" \
  "grep -qi 'pm2' deploy/compose/README.md"
chk "README 给出「真实生效」的证明方式（pm2 script path / 镜像版本）" \
  "grep -qE 'pm2 describe|script path' deploy/compose/README.md"
chk "README 说明 dashboard 无状态、要备份的是 hub 侧数据" \
  "grep -qiE '无状态|stateless' deploy/compose/README.md"

[ "$fail" = 0 ] && echo "compose 契约: PASS" || { echo "compose 契约: FAIL"; exit 1; }
