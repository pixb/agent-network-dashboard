#!/usr/bin/env bash
# 部署定义的可重建性契约。
#
# 这条测试要防的是「只有某台机器上的人记得怎么部署」。
# 分支模型（2026-11-04 重新定义）：`pixb` 是我们自己的生产分支，只在本地部署，**不发 npm**；
# `main` 只作为上游同步分支，上游更新用 merge 进 pixb。于是部署身份 = **pixb 的源码提交**，
# 不是 npm 版本号。主路径 = 源码构建（Dockerfile.source）；装发布包那份（Dockerfile）保留，
# 因为现网当前跑的就是「固化安装 + 目录名当身份」那条（dash-start.sh 注释里写明）。
#
# 覆盖三组：镜像与版本钉法 / 端口与探针 / 环境变量名字对齐 + 泄密扫描 + 文件可解析。
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
DIR=deploy/compose
DF=$DIR/Dockerfile            # 现网形态：装发布包
DS=$DIR/Dockerfile.source     # 主路径：pixb 源码构建
CF=$DIR/compose.yaml
ENVT=$DIR/dashboard.env.template
chk() { if eval "$2"; then echo "  ok: $1"; else echo "  MISSING: $1" >&2; fail=1; fi; }
absent() { if ! eval "$2"; then echo "  ok: $1"; else echo "  FORBIDDEN: $1" >&2; fail=1; fi; }
for f in "$DF" "$DS" "$CF" "$ENVT" "$DIR/README.md"; do
  [ -f "$f" ] || { echo "缺文件: $f" >&2; fail=1; }
done
[ "$fail" = 0 ] || exit 1

echo "── 主路径：源码构建（不发 npm，部署身份 = pixb 提交）"
chk "基础镜像主版本 = lockfile 验证用的 Node 主版本（node:24，#1272）" \
  "grep -q 'ARG NODE_IMAGE=node:24' $DS"
chk "依赖按 lockfile 精确安装（npm ci，不解析出第二套依赖树）" \
  "grep -q 'npm ci' $DS"
chk "镜像内跑源码构建（npm run build），不是去 registry 取产物" \
  "grep -q 'npm run build' $DS"
chk "部署身份写进镜像 label（docker inspect 能回答「在跑的是哪份代码」）" \
  "grep -q 'SOURCE_REV' $DS && grep -q 'org.opencontainers.image.revision' $DS"

# 构建期两个实测教训，写成门，防止「能构建」退回「40 分钟 / 2.9GB」。
chk "npm ci 跳过 electron 二进制下载（electron 是 devDep，postinstall 下载会断流杀死构建）" \
  "grep -q 'ELECTRON_SKIP_BINARY_DOWNLOAD=1' deploy/compose/Dockerfile.source"
chk "构建后剪掉 dev 依赖（next 在 dependencies 里，next start 不需要 electron/capacitor/playwright）" \
  "grep -q 'npm prune --omit=dev' deploy/compose/Dockerfile.source"
chk "NPM_REGISTRY 是 ARG 且有默认值（换源不改判据）" \
  "grep -q 'ARG NPM_REGISTRY=https://registry.npmjs.org' deploy/compose/Dockerfile.source"
chk "npm 缓存跨构建复用（--mount=type=cache）" \
  "grep -q 'mount=type=cache' deploy/compose/Dockerfile.source"
# 探针端口不许写死：写死时改端口跑 = 服务正常而健康状态恒 unhealthy，依赖门会锁死下游。
for f in deploy/compose/Dockerfile.source deploy/compose/compose.yaml; do
  chk "$f 的探针从 process.env.PORT 取端口" "grep -q 'process.env.PORT' $f"
  chk "$f 的探针探 /login（公开 200；/api/* 无会话 401、/ 未登录 307）" "grep -q '/login' $f"
done
# 页面门：带子路由的页面必须在 matcher 里有 :path* 变体（proxy.ts 注释记录的 2026-07-31 规则）。
chk "matcher 含 /messages/:path*（新增子路由页时漏写会让无 cookie 访客拿到 200 页面壳）" \
  "grep -q "/messages/:path\\*" proxy.ts"
chk "e2e 边界测试清单含 /messages/inbox（规则要求 matcher 与测试清单同时补）" \
  "grep -q '/messages/inbox' tests/e2e-proxy-auth-boundary.spec.ts"
chk "compose 传入 SOURCE_REV（换版本 = 换提交，记录在 compose 侧）" \
  "grep -q 'SOURCE_REV:' $CF"
chk "构建上下文 = 仓库根（../..），根目录 .dockerignore 才生效" \
  "grep -q 'context: ../..' $CF"
chk "构建期 npm 源是可换的 ARG（镜像源十分钟不出货时不用改 Dockerfile；实测一次 npm ci 跑了 40 分钟）" \
  "grep -q 'ARG NPM_REGISTRY=' $DS && grep -q 'NPM_REGISTRY:' $CF"
chk "npm 缓存跨构建复用（--mount=type=cache，同一棵树重复构建不重新乍载）" \
  "grep -q -- '--mount=type=cache' $DS"
chk "非 root 运行" "grep -q '^USER ' $DS"
chk "CMD 跑包声明的入口 bin/start.js" "grep -q 'bin/start.js' $DS"
chk "监听地址用 HOST（bin/start.js 优先级是 HOST > HOSTNAME > 默认）" \
  "grep -q 'ENV HOST=127.0.0.1' $DS"
absent "源码镜像不依赖 npm registry 的版本号参数（发版与部署已解耦）" \
  "grep -q 'ARG VERSION=' $DS"
# 本包 next.config.ts 是空配置（无 output:'standalone'），next start 需要 node_modules 在位。
chk "最终镜像拷完整工作树（依赖 + 产物），不单拷 .next" \
  "grep -q 'COPY --from=build /src ./' $DS"

echo "── 现网形态（装发布包）：作为权威描述保留，不删"
chk "版本由 ARG 传入（写死在 RUN 里的镜像不记录部署了哪个版本）" \
  "grep -q 'ARG VERSION=' $DF"
chk "安装带 --include=optional（standalone 产物的平台相关可选依赖）" \
  "grep -q -- '--include=optional' $DF"
chk "非 root 运行" "grep -q '^USER ' $DF"
chk "监听地址 127.0.0.1" "grep -q 'ENV HOSTNAME=127.0.0.1' $DF"
chk "CMD 跑 bin/start.js（本包无 standalone server.js）" "grep -q 'bin/start.js' $DF"

echo "── 端口契约：只监听 127.0.0.1"
chk "host 网络（Caddy :3000 / frpc :3100 都按 127.0.0.1:3001 反代）" \
  "grep -q 'network_mode: host' $CF"
absent "不用 ports: 映射（桥接网络会改变反代侧看到的源地址）" \
  "grep -qE '^ *ports:' $CF"
chk "init: true（bin/start.js 只转发 SIGINT，docker stop 发的是 SIGTERM）" \
  "grep -q 'init: true' $CF"
chk "stop_grace_period（给 next 进程留出退出时间）" "grep -q 'stop_grace_period' $CF"

echo "── 就绪探针：/login，不是 /api/hub/health"
# 只看真正的探针命令（带 fetch( 的那行），不看注释：
# 注释里提到 /api/hub/health 是「不要用」的说明，扫全文会把说明当成违规。
probe_lines() { grep -E 'fetch\(' "$1" || true; }
chk "探针打 /login（公开页，200 即就绪）" \
  "probe_lines $DS | grep -q '/login' && probe_lines $DF | grep -q '/login' && probe_lines $CF | grep -q '/login'"
absent "探针不打 /api/hub/health（无会话时 401，curl -f 判不健康 —— 2026-11-04 实测）" \
  "probe_lines $DS | grep -q '/api/hub/health'"

echo "── 环境变量：名字入库，值不入库"
# 反向对齐：代码里读的每个 env 名字，模板里必须出现。
# 这条防「模板与代码分叉」—— 新加一个 env 变量而模板没写，换机器的人只能靠读源码才知道。
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
chk "代码读取的每个运行时 env 变量都在模板里声明（缺:$missing）" "test -z '$missing'"

chk "COMMHUB_URL 显式声明（逐字符敏感：COMM_HUB_URL 会静默连默认 hub）" \
  "grep -q '^COMMHUB_URL=' $ENVT"
absent "模板里不出现 COMM_HUB_URL 这个错名字" \
  "grep -q '^COMM_HUB_URL=' $ENVT"
chk "DASHBOARD_PASSWORD 显式声明（只影响 dashboard 口令通路；网页登录走 /api/auth/v3 由 hub 校验。回落读 ~/.anet/config.json，容器里没有 → 该通路不可用）" \
  "grep -q '^DASHBOARD_PASSWORD=' $ENVT"

# 值形状扫描：模板只允许空值与带 REPLACE_ME 的占位符。
leaky=$(awk -F= '/^[A-Z][A-Z0-9_]*=/ { v=substr($0, index($0,"=")+1); if (v != "" && v !~ /REPLACE_ME/) print $1 }' "$ENVT")
chk "模板只含占位符/空值（泄漏字段:[$leaky]）" "test -z '$leaky'"
noncomment() { grep -vE '^[[:space:]]*#' "$@" || true; }
real_host=$(noncomment "$ENVT" "$CF" | grep -E '://[A-Za-z0-9.-]+:[0-9]+' | grep -vE 'REPLACE_ME|://(127\.0\.0\.1|localhost):' || true)
chk "模板与 compose 不含真实主机地址（命中:[$(echo "$real_host" | tr '\n' ' ')]）" "test -z '$real_host'"
leaky_cf=$(noncomment "$CF" "$ENVT" | grep -nE 'atok_|utok_' | grep -v REPLACE_ME || true)
chk "不含 token 值（命中:[$(echo "$leaky_cf" | tr '\n' ' ')]）" "test -z '$leaky_cf'"

echo "── compose 文件本身能被解析"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  tmp_env="$(mktemp)"; trap 'rm -f "$tmp_env"' EXIT
  if ANET_DASHBOARD_ENV_FILE="$tmp_env" docker compose -f "$CF" config >/dev/null 2>&1; then
    echo "  ok: docker compose config 解析通过"
  else
    echo "  FAIL: docker compose config 解析失败" >&2; fail=1
  fi
  # 自检：证明上面这条检查对「重复键」真的有牙，不是只证明文件能跑。
  # 实测 compose-go 会报 mapping key "restart" already defined at line 4。
  probe="$(mktemp -d)"
  printf 'services:\n  probe:\n    image: x\n    restart: always\n    restart: never\n' > "$probe/compose.yaml"
  if (cd "$probe" && docker compose config >/dev/null 2>&1); then
    echo "  FAIL: 故意写重键的样张被接受了 → 解析检查没有牙" >&2; fail=1
  else
    echo "  ok: 重复键会被解析层抓到（样张实测被拒）"
  fi
  rm -rf "$probe"
else
  if python3 -c "import yaml,sys; yaml.safe_load(open('$CF'))" 2>/dev/null; then
    echo "  ok: YAML 语法合法（本机无 docker，未做 compose 语义校验）"
  else
    echo "  FAIL: YAML 语法非法（且本机无 docker 可做完整校验）" >&2; fail=1
  fi
fi
echo "── 恢复文档回答六个问题里的关键几条"
chk "README 说清现网跑哪条、主路径是哪条" \
  "grep -qi 'pm2' $DIR/README.md && grep -qi 'pixb' $DIR/README.md"
chk "README 给出「真实生效」的证明方式（pm2 script path / docker inspect revision）" \
  "grep -qE 'pm2 describe|script path' $DIR/README.md && grep -q 'org.opencontainers.image.revision' $DIR/README.md"
chk "README 说明 dashboard 无状态、要备份的是 hub 侧数据" \
  "grep -qiE '无状态|stateless' $DIR/README.md"
chk "README 写明分支模型（pixb 生产 / main 只同步 / 不发 npm）" \
  "grep -qiE '不发 npm|不发.*npm' $DIR/README.md"

[ "$fail" = 0 ] && echo "compose 契约: PASS" || { echo "compose 契约: FAIL"; exit 1; }
