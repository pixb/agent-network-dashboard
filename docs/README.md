# 文档索引

设计稿、可靠性记录与安全门说明。截图在 `images/`。

## 设计与界面

- [design-task-chat.md](design-task-chat.md) —— 任务聊天面板设计方案：在 Dashboard 上像聊天一样给 Agent 派活、看回复。
- [mobile-app.md](mobile-app.md) —— Web / 桌面 / 移动三个薄壳如何共用同一套 Dashboard UI。

## 2026-11 迭代记录（最新在最前）

- [handoff-2026-11-04.md](handoff-2026-11-04.md) —— 一天 17 个版本（`.334`–`.350`）的因果、新增门禁的变异验证、待决策与未真机验证项。**接手先看这篇。**
- [client-embedding-readiness-20261104.md](client-embedding-readiness-20261104.md) —— Dashboard 放进客户端的包体与性能评估（2.35MB/gzip 0.76MB；3D 后台暂停；长会话内存；离线三条路径；可点性三态审计）。
- [client-token-alignment-20261104.md](client-token-alignment-20261104.md) —— 与客户端 `theme.ts` 的圆角/字号/配色对照，含两处自我更正与圆角决策选项 A/B/C。
- [design-scale-migration-plan-20261104.md](design-scale-migration-plan-20261104.md) —— 圆角与字号迁移的分批清单（先装门禁再迁移）。
- [font-10px-inventory-20261104.md](font-10px-inventory-20261104.md) —— 10px 字号的语义分类（密集 59 / 说明 13 / 其余 135），F1 已缩到 8 处。

## 可靠性与发布

- [chat-ha-preview.md](chat-ha-preview.md) —— 聊天预览改造：web、桌面与 CLI 内置 Dashboard 共用同一聊天面板与 `/api/hub/send` 路由，一处升级三端受益。

## 安全

- [oss-security-gates.md](oss-security-gates.md) —— 仓库的 OSS 安全门：凭据、不可移植路径、依赖、lint、生产构建与历史扫描各查什么。
- [军团 3D 可调参数与当前取值](legion-3d-tunables-20261105.md) — 「再震撼一点」的可执行拆解：每个常量当前值、往大往小的影响、改后必测项
