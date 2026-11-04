# Dashboard 部署：两条路径与一份可重建定义

## 现网走的是 pm2，不是 compose

先说清楚，避免读到这个目录就以为容器是现网形态：

| 路径 | 状态 | 权威副本 |
|---|---|---|
| **pm2** | **现网在跑的就是这条** | `agent-network` 仓库 `deploy/dashboard/`：`dash-start.sh` + `ecosystem.config.cjs` |
| **compose（本目录）** | 空机器复现用的权威定义，尚未接管现网 | 本目录 `compose.yaml` + `Dockerfile` + `dashboard.env.template` |

两条路径并存时以 pm2 为准。要把 compose 接管现网，需要显式评审：停 pm2 应用、
让 Caddy/frpc 的上游端口保持 `127.0.0.1:3001` 不变，然后按下节启动。

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
2. **`DASHBOARD_PASSWORD` 在容器里是必设项。** 取值顺序是
   `DASHBOARD_PASSWORD` / `ANET_DASHBOARD_PASSWORD` → 读不到就回落到
   `~/.config/anet/cli.json` 里的 hub token。容器里没有那个文件，回落得到空串，
   `verifyDashboardPassword` 恒为 false：**谁都登不进去**，而 `/login` 照常返回 200、
   就绪探针照常通过。回落本身也是安全隐患（网页口令 == hub token）。

`tests/compose-contract.sh` 会反向扫代码里读取的每个 env 名字，模板里缺任何一项就红。

## 换版本 / 验证真实生效 / 回滚

发布链（顺序不能颠倒，AGENTS.md：对外 npm 产物只从 `main` 发布）：

```bash
# 1) 合入 main（pixb 上的改动对 :3000 没有任何影响，直到这一步完成）
# 2) 发布 npm
# 3) 更新部署记录里的版本号
#    pm2 路径：deploy/dashboard/dash-start.sh 的 VERSION 与 RUNTIME_BIN
#    compose 路径：本目录 compose.yaml 的 build.args.VERSION
# 4) 重启
```

**「真实生效」只有一个证明方式：看常驻进程实际加载的是哪个包。**

```bash
# pm2 路径
pm2 describe anet-dashboard | grep -E "script path|version"
# 期望看到 …/dashboard-runtime-vNN/node_modules/.bin/agent-network-dashboard
# 目录名里的 vNN 必须与版本号一致（运行时目录按版本隔离，v55 与 v56 并存）

# compose 路径
docker inspect anet-dashboard --format '{{json .Config.Image}}'
docker logs anet-dashboard 2>&1 | grep -i "dashboard package"   # 构建期打印的包版本
```

只看「pm2 online」、只看「`/login` 返回 200」都不算数。2026-11-04 实测过一次：
`pm2 restart` 后进程 online、`:3001/login` = 200，但 `pm2 describe` 的 script path
还指着上一个版本的运行时目录 —— 新构建从未被加载。

**回滚** = 把版本号改回旧值重建。发布包不可变，旧版本永远装得到
（这一条是 compose 路径相对 pm2 路径的实质优势：`RUNTIME_BIN` 指回旧目录即可）。

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
docker compose build          # 版本来自 compose.yaml 的 build.args.VERSION
docker compose up -d
docker compose ps             # health 应为 healthy
curl -fsS http://127.0.0.1:3001/login >/dev/null && echo ready
```

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
