# Dashboard ↔ 客户端设计 token 对照（含两处自我更正）

> 依据：客户端仓库 `agent-network-app` @ `e3dec7ef`（0.2.446）的
> `src/theme.ts`（`radius` 第 272 行、`type` 第 314 行）。这是权威来源，
> 不再依据任何节点的转述或 Dashboard 内部注释。

## 1. 客户端的圆角刻度（原文）

```
inline 2   — 一行文字里的标记（查找命中高亮）
mark   4   — 极小件：键帽、≤24 的悬停底、细把手
item   8   — 嵌在面或控件里面的一格：分段选中块、侧栏/导航项、代码块、表格、≤32 高的小图标按钮
control 12 — 输入框 / 按钮 / 分段控件 / 搜索框 / 菜单
thumb  12  — 聊天里的图片 / 视频缩略图
surface 16 — 卡片 / 弹窗 / 抽屉 / 底部面板 / 浮层
bubble 18  — 聊天气泡
pill  999  — chip / tag / badge / pill，以及所有圆
```

**客户端没有 6px。** 旧别名 `sm=8 / md=12 / lg=16` 也跟着新档走。

## 2. 我的两处更正（重要）

### 2.1 更正一：6px 不是「客户端也在用的按钮档位」

我在 `.341`/`.342` 里判断「`rounded-md`(6px) 是刻意的 standalone button 档位、不该迁移」，
依据是 Dashboard 内部 TopoGraph 的 R375/R376 注释。**那只证明 Dashboard 自己这么分过，
不证明它与客户端一致。** 客户端刻度里根本没有 6px：按钮/输入框/分段控件是 `control`(12)，
嵌在面里的格子与 ≤32px 图标按钮是 `item`(8)。

结论：Dashboard 全站 145 处带内边距的按钮用的是 **6px**，比客户端的 12px 更紧、也比 item 的 8px 更紧。
**这是一处真实的不对齐，不是「有意的档位」。**

### 2.2 更正二：10px 字号并非客户端禁用

客户端 token `type = { caption: 11, small: 12, body: 14, title: 16, heading: 20 }`，
但**实际代码里有 34 处 `fontSize: 10`**（日志行、chip 文字、附件图标标签等密集信息位）。
所以「10px 不在刻度 ⇒ 必须全部改成 11px」这个推论不成立；
客户端自己的做法是：**token 里不给 10px，但在密集信息位允许它**。

⇒ `docs/design-scale-migration-plan-20261104.md` 里的 F1（把需求域 51 处 10px 全改 11px）
应按上下文拆分，而不是整批迁移。

## 3. 现在能下的结论

| 项 | 结论 | 依据 |
|---|---|---|
| 浅色强调色 `#1b65db` | **与客户端完全一致**（客户端 light.accent 就是这个值） | `theme.ts:17` |
| 圆角 6px | **不对齐**（客户端无此档） | `theme.ts:272` |
| 字号 10px | **可作为密集档保留**，不该一刀切 | token + 34 处实际用法 |
| 字号 11px | 客户端的 `caption` | `theme.ts:314` |

## 4. 建议的下一步（各需一次批准）

### 4.1 圆角对齐（需要设计确认影响面）

| 类别 | Dashboard 现状 | 客户端对应 | 影响 |
|---|---|---|---|
| 按钮 / 输入框 / 分段控件 | 6px（145 处） | `control` 12px | 全部变圆，视觉变化明显 |
| 嵌在面里的格子、≤32 图标按钮 | 8px（已对齐 item） | `item` 8px | 无需改 |
| 卡片/弹窗/浮层 | 12~16px | `surface` 16px | 需逐处核对 |
| 极小件 | 2/4px | `inline` 2 / `mark` 4 | 已对齐 |

这一步不做「全站一次性」，按文件分批（先 3D 军团 → 节点类组件 → 需求域），每批出对比截图。

### 4.2 字号（F1 改为按上下文拆分）

- 密集信息位（日志、计数、徽标、时间戳）→ **保留 10px**（与客户端一致）
- 正文附近的说明文字（原本 10px 只是因为历史）→ 提到 `caption` 11px

先按「所在组件 + 语义」分类，再逐批判定；不按数量一刀切。

### 4.3 浅色强调色

`#1b65db` 与客户端 token 完全一致，分支 `design/light-accent-skyblue` 已备
（对比度 31/31、冒烟 45/45）。**仍需品牌方一句「做」，但证据已完整。**

## 5. 复现方式

```bash
git -C /home/vansin/agent-network-app log --oneline -1        # e3dec7ef
sed -n '272,290p;314p' /home/vansin/agent-network-app/src/theme.ts
grep -rn "fontSize: 10[,}]" /home/vansin/agent-network-app/src | wc -l   # 34
```
