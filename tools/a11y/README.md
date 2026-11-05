# tools/a11y — 可复用的无障碍审计

2026-11-05 在 Dashboard 上做了一整天审计后抽出来的工具。**结论先写**：这三个脚本抓到的真问题是
"用肉眼和看代码都发现不了"的那类，所以值得别的线直接用。

## 为什么不能只查 DOM 属性

| 坑 | 后果 | 本工具的做法 |
|---|---|---|
| Chromium 新版把颜色算成 `color(srgb …)` / `lab(…)` | 正则解析把 0–1 当成 0–255，对比度结论全错（实测误判 6 处） | 用 canvas 把 CSS 颜色画出来读真实像素 |
| `::before` 被用来扩大热区（如关闭按钮 20×44 + `inset-x:[-8px]` → 36×64） | 只量 border-box 会把达标控件报成缺陷 | 把伪元素偏移算进"有效热区" |
| Chrome 会用 `placeholder` 兜底生成可访问名 | 只看 `aria-label` 会把"其实能读"的控件报成缺陷（实测 4 个里只有 1 个真无名） | 读 CDP `Accessibility.getFullAXTree` |
| SVG `<g role=button>` 的 `innerText` 为空 | 误报"按钮无名" | 同上，走无障碍树 |

## 三个脚本

```bash
# 1) 对比度（WCAG AA：正文 4.5:1、大字 3:1）
node tools/a11y/contrast.mjs --base https://your.dashboard --config <node config.json> \
     --routes /,/nodes,/requirements --themes light,cyber --samples 3

# 2) 触控目标（默认 24×24 最低线，可 --width 390 --min 24）
node tools/a11y/tap-targets.mjs --base http://127.0.0.1:3000 --password '<dashboard password>' --routes /,/nodes

# 3) 可访问名（表单控件与按钮在无障碍树里是否为空）
node tools/a11y/accessible-names.mjs --base http://127.0.0.1:3000 --config <node config.json> --routes /,/settings
```

- `--config` 读节点 `config.json` 里的 `ntok_`/`utok_`，拼成只读会话 `v3:<token>`；
- `--password` 用口令算 `sha256("anet-dashboard:"+password)`，与 Dashboard 的 cookie 约定一致；
- 有发现时退出码为 1，可直接接 CI 或 cron。

## 实测战绩（2026-11-05）

| 工具 | 抓到的问题 |
|---|---|
| contrast | 暗色 `离线` **2.19:1**、`节点 2` 3.83:1、需求空态 3.90:1 → 修复后 5.2–7.4:1 |
| tap-targets | 搜索框有效热区仅 160×20（外框 38px 但点空白不聚焦）→ 修成整框可点 |
| accessible-names | 优先级下拉在无障碍树里名字为空（其余 3 个靠 placeholder 兜底，属误报） |

## 为什么用 `--samples N`

线上页面内容随时序变化（消息、状态、会话预览都会刷新），**单次采样会漏报也会误报**：
同一条目在一次运行里是 4.09:1，下一次同页面可能已经不渲染。`--samples N` 会对每个路由重复采样 N 次并取**并集**，
结果才可复现。本地夹具（数据固定）用默认 1 次即可。

报告里会带出命中元素的 `className` 片段，便于直接定位到源码里的类名，不用再逐个探测。

## 已知限制

- 只能测 DOM 渲染的文字；3D 画布内绘制的文字测不到（需要另做像素对比）；
- 触控目标按"有效热区"估算伪元素扩展，只覆盖 `::before/::after` 且要求 `content` 非 `none`；
- 对比度按页面当前主题计算，切换主题要分别跑（`--themes` 支持多值）；
- 线上真实数据必须 `--samples 3` 以上，否则结论不可复现（见上节）。

## 待复现（2026-11-05 记录）

在线上真实数据上，`contrast` 两次都报出浅色主题 `"已推送" 1.95:1 (11px)`，但手工探测未能稳定定位到该元素
（内容随时序变化）。复现命令：

```bash
node tools/a11y/contrast.mjs --base https://dm.vansin.top --config <node config.json> --routes /nodes --themes light --wait 3000
```

定位到组件后再决定修法，不凭猜测改样式。
