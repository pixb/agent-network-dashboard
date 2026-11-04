# Dashboard 部署：两条路径与一份可重建定义

## 分支模型决定了部署身份是什么

2026-11-04 重新定义（与 `agent-network` 仓库 AGENTS.md 的「分支规则」一致）：

- **`pixb` 是我们自己的生产分支**，只在本地部署；生产机器从 pixb 的源码构建。
- **`main` 只作为上游同步分支**，不写业务提交；上游更新用 **merge** 进 pixb。
- **不发 npm**。因此「部署的是哪一版」不能用 npm 版本号表达，只能用
  **pixb 的源码提交**表达。旧文档里「合 main → 发版 → 同步 VERSION → 重启」那条链路
  不再是日常路径；需要对外发布时（未来若有外部用户）才重新启用，且仍只从 main 发。

现网现状（2026-11-04 实测，**不是 pm2**）：dashboard 跑在 compose 容器里。

```
docker ps → anet-dashboard-1   镜像 anet-dashboard:compose   宿主 3200 -> 容器 3000
docker inspect → 项目 anet，config_files = agent-network/deploy/compose/compose.yaml
docker history → 镜像里烘的是 **npm 发布包 0.6.3-preview.56**（ARG DASH_VERSION），
                 烘进去的 ~/.anet/config.json 只写了 {"hub":"http://127.0.0.1:9200"}
```

历史路径是 pm2：pm2 指着 `~/.commhub/dashboard-runtime-vNN/`，里面是**从某个审核过的
源码提交构建出来的固化安装**（`dash-start.sh` 注释写明「目录名就是部署身份」，例如
「source/build commit 54150269，npm 版本停在 preview.54」）。两条路径有一个共同点：
**启动都不靠 npm registry 解包**，npm 版本号只是个标签。新模型把这件事说清楚：
**身份 = 源码提交**。

| 路径 | 定位 | 部署身份 | 权威副本 |
|---|---|---|---|
| compose 容器 `anet-dashboard-1` | **现网在跑的就是这条**（宿主 `:3200`） | 镜像（当前 = 烘进去的 preview.56，无提交 label） | `agent-network/deploy/compose/compose.yaml`（本轮补入 git） |
| compose + `Dockerfile.source`（本目录） | **主路径（pixb 源码构建）** | 镜像 label `org.opencontainers.image.revision` | 本目录 |
| pm2 + 固化安装 | 历史路径（vNN 目录名当身份） | 运行时目录名（对应某源码提交） | `agent-network` 仓库 `deploy/dashboard/` |
| compose + `Dockerfile` | 装发布包，= 现网镜像的可复现描述 | `build.args.VERSION` | 本目录 |

> 端口契约随路径而变：**pm2 路径**监听 `127.0.0.1:3001`（Caddy `:3000` / frpc `:3100` 反代）；
> **compose 路径**容器内 `HOST=0.0.0.0` + `PORT=3000`，对外由 `ports:` 决定（现网 `3200`）。
> 不要把两条契约混成一条：在 compose 里改 `HOST` 不会少暴露一点，在 pm2 里用 `ports:` 思路会直接断开反代。

## 端口契约（改之前先读这段）

```
浏览器 ──:3000──> Caddy ──┐
                          ├──> 127.0.0.1:3001  (dashboard，只监听 loopback)
外网用户 ──:3100──> frpc ─┘
```

- dashboard **只绑 127.0.0.1:3001**。绑 0.0.0.0 等于把带会话的 UI 直接挂到局域网，
  绕过反代层的访问控制。Dockerfile 里 `ENV HOSTNAME=127.0.0.1` 就是这条契约。
- 因此 compose 用 `network_mode: host`，**不用 `ports:` 映射**：桥接网络会把
  反代看到的源地址变成 docker bridge，排查时看不到真实客户端地址。
- 换端口要同时动三处：Caddy 上游、frpc 上游、`PORT`。只动一处表现是
  「容器健康、网页打不开」。

## 环境变量：名字进仓库，值不进仓库

名字与占位符在 `dashboard.env.template`，真实值写进 `dashboard.env`（不入库），
compose 通过 `env_file` 读。两个必须逐字符记住的点：

1. **`COMMHUB_URL`，不是 `COMM_HUB_URL`。** 前端读 `process.env.COMMHUB_URL`。
   写成后者不报错，dashboard 会静默连代码里的默认 hub —— 于是你看到的是
   「另一个 hub」的数据，而且怎么改都不对。
2. **`DASHBOARD_PASSWORD` 只影响 dashboard 自己的口令通路，网页登录走的是 hub。**
   现在浏览器里用的登录走 `/api/auth/v3` → 由 **hub 的用户账号**校验，与这一项无关。
   这一项的取值顺序是 `DASHBOARD_PASSWORD` / `ANET_DASHBOARD_PASSWORD` → 读不到就
   回落到 `~/.anet/config.json` 里的 token（现网镜像里烘进去的那个文件只写了 hub 地址、
   没有 token）。所以容器里不设的准确后果是：**dashboard 口令通路不可用**（回落到空串），
   v3 登录不受影响。不设的代价是两类口令混在 hub 一侧，少一层隔离；代码里带
   `console.warn`，别看漏。

`tests/compose-contract.sh` 会反向扫代码里读取的每个 env 名字，模板里缺任何一项就红。

## 换版本 / 验证真实生效 / 回滚

主路径（pixb 源码构建）三步：

```bash
cd deploy/compose
git -C ../.. fetch && git -C ../.. checkout <pixb 提交>   # 或 git -C ../.. merge main（上游更新进来时）
ANET_DASHBOARD_SOURCE_REV=$(git -C ../.. rev-parse HEAD) docker compose build --build-arg SOURCE_REV=$ANET_DASHBOARD_SOURCE_REV
docker compose up -d
```

**「真实生效」只有一个证明方式：看常驻进程实际加载的是哪份代码。**

```bash
# compose 主路径（现网形状）：问镜像自己
docker inspect anet-dashboard:compose --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
# 期望 = 你检出的那个 pixb 提交；旧镜像没有这个 label（现网就是没有），
# 那就等于「无法从镜像回答在跑哪份代码」—— 这正是新路径要补的东西
docker inspect anet-dashboard-1 --format '{{.Image}}'   # 容器实际用的镜像 id
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/messages/inbox  # 新路由：307（要会话），不是 404

# pm2 路径（历史）
pm2 describe anet-dashboard | grep -E "script path|version"
# 期望 …/dashboard-runtime-vNN/node_modules/.bin/agent-network-dashboard
# 目录名里的 vNN 必须与部署记录里的提交对得上
```

只看「pm2 online」、只看「`/login` 返回 200」都不算数。2026-11-04 实测过一次：
`pm2 restart` 后进程 online、`:3001/login` = 200，但 `pm2 describe` 的 script path
还指着上一个版本的运行时目录 —— 新构建从未被加载。

**回滚** = 检出旧提交重建。源码在 git 里，旧提交永远构建得到；固化安装路径下
`RUNTIME_BIN` 指回旧目录即可。这是源码路径相对「装发布包」路径的实质优势：
不依赖 registry 上还留着哪个版本。

> 历史上出过的事：版本曾被钉到一个尚未发布到 npm 的号上，npx 每次 ETARGET 立即退出，
> pm2 无退避重启 34494 次整夜锤 registry（`dash-start.sh` 头部注释）。源码构建路径从根上
> 消除了这一类故障：启动与构建都不依赖 npm registry。

## 哪些状态不在这里

dashboard **无状态**：登录用户、token、任务、消息、网络成员全部在 hub 侧的 SQLite 里。
clone 这个仓库 + 重建镜像 **不会**恢复任何生产数据。要备份的是 hub 的数据库
（见 `agent-network` 仓库 hub 侧的备份说明），不是这里。

compose 路径不挂任何数据卷，正是为了让这一点显式：没有卷 = 没有隐藏状态。

## 启动

```bash
cd deploy/compose
cp dashboard.env.template dashboard.env   # 填真实值；不要提交
# 多 hub 场景必须显式设 COMMHUB_URL，否则连的是代码里的默认 hub
export ANET_DASHBOARD_SOURCE_REV=$(git -C ../.. rev-parse HEAD)   # 本次部署的 pixb 提交
docker compose build      # compose.yaml 会把 SOURCE_REV 传成镜像 label
docker compose up -d
docker compose ps         # health 应为 healthy
curl -fsS http://127.0.0.1:3001/login >/dev/null && echo ready
```

换到「装发布包」那条（= 现网形态）：把 `compose.yaml` 的 `dockerfile:` 改成
`deploy/compose/Dockerfile`，并在 `build.args` 里传 `VERSION`（该文件只认 VERSION/PACKAGE/NODE_IMAGE/PKG_DIR）。
两条路径不能同时抢 `127.0.0.1:3001`。

就绪判定用 `/login`（公开页）。**不要用 `/api/hub/health`**：无会话时它返回 401，
`curl -f` 会把「活着」判成「不健康」（2026-11-04 实测 `/login`=200、
`/api/hub/health`=401）。

## 契约测试

```bash
bash tests/compose-contract.sh
```

覆盖：基础镜像主版本、版本 ARG 钉法、`--include=optional`、非 root、
`HOSTNAME=127.0.0.1`、host 网络且无 `ports:`、探针用 `/login`、
env 名字与代码对齐、模板不含真实值。
