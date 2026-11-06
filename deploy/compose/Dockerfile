# Dashboard 镜像：只装**已发布的 npm 包**，版本由 ARG 钉住。
#
# 三条硬约定（都踩过坑，别顺手改掉）：
#
# 1. 基础镜像必须与 lockfile 测试用的 Node 主版本一致。
#    本仓库 lockfile 用 node:24-slim 验证（见 AGENTS.md「Dockerfile 基础镜像
#    必须匹配 lockfile Node 版本」）。基础镜像与 lockfile 不一致时，
#    `npm ci` 的依赖树可以完全合规却仍然构建失败（#1272）。
#
# 2. 版本必须由 ARG 传入，不能写死在 RUN 里。
#    写死版本的镜像不记录「部署的是哪个版本」；换版本要改 Dockerfile，
#    而部署记录在 compose 的 build args 里 —— 两边会分叉。
#    生产实测：镜像/运行时目录名带版本（dashboard-runtime-v56），
#    `pm2 describe` 的 script path 是唯一的生效证明（见 deploy/dashboard/README.md）。
#
# 3. 安装用 --include=optional。
#    Next.js standalone 产物带平台相关的可选依赖；漏掉这个开关装出来的包
#    起不来（生产 install_dashboard 就是这么装的）。
ARG NODE_IMAGE=node:24-slim
FROM ${NODE_IMAGE}

# 发布源固定到 sleep2agi registry 作用域的公网包名。私有源地址不入库。
ARG PACKAGE=@sleep2agi/agent-network-dashboard
ARG VERSION=0.9.0-preview.56

ENV NEXT_TELEMETRY_DISABLED=1

# 装包，不构建源码：这条路径与生产一致（生产装的是发布包，不是仓库源码树）。
# 源码构建路径见仓库根的 `npm run build`，那条用于开发，不用于部署复现。
RUN npm install -g --include=optional "${PACKAGE}@${VERSION}" \
 && npm cache clean --force

# 包目录随版本走，固定到一个稳定路径，命令与 HEALTHCHECK 都能引用。
ARG PKG_DIR=/opt/dashboard
RUN PKG_REAL="$(node -e "console.log(require.resolve('${PACKAGE}/package.json'))" | sed 's#/package.json##')" \
 && ln -s "${PKG_REAL}" "${PKG_DIR}" \
 && node -e "console.log('dashboard package:', require('${PKG_DIR}/package.json').version)"

# 不以 root 跑常驻服务。
RUN useradd -r -u 10001 dashboard && chown -R dashboard:dashboard "${PKG_DIR}"
USER dashboard

# 监听地址：默认就是 127.0.0.1（bin/start.js: HOST || HOSTNAME || "127.0.0.1"）。
# 这里显式写死，是为了把契约写进镜像定义，不依赖默认值：
# 绑 0.0.0.0 等于把带会话的 UI 直接挂到局域网，绕过反代层的访问控制。
# 注意优先级是 HOST > HOSTNAME > 默认：要改监听地址用 HOST，
# 单改 HOSTNAME 会被容器里已存在的 HOST 变量压掉（bin/start.js 里就写了这一层）。
ENV HOSTNAME=127.0.0.1
ENV PORT=3001

EXPOSE 3001

# 就绪探针用 /login（公开页）。
# 不要用 /api/hub/health：无会话时它返回 401，`curl -f` 会把「活着」误判成「不健康」
# （2026-11-04 实测：/login=200、/api/hub/health=401）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 运行时环境变量（COMMHUB_URL 等）只在这里声明名字，值一律由 env_file 提供：
# 密钥不进镜像层、不进 git、不进命令行。
#
# 跑 bin/start.js（= 包声明的 bin），不跑 server.js：
# 本包没有 `files` 字段，发出去的就是 bin/start.js 这一入口，没有 standalone 的
# server.js。写 server.js 的镜像会在启动时「文件不存在」循环重启。
# bin/start.js 自身只转发信号给 SIGINT，不给 SIGTERM，所以 compose 侧配了
# `init: true` 接管 PID 1（`docker stop` 发的是 SIGTERM）。
CMD ["node", "/opt/dashboard/bin/start.js"]
