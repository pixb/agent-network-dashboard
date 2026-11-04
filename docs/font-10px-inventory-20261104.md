# 字号 10px 分类清单（只分类，不改代码）

> 依据：`app/**/*.tsx` 静态扫描（207 处）。分类为启发式，**不是最终裁决**。
> 关键前提：客户端 `theme.ts` 的 token 没有 10px，但实码有 34 处 `fontSize: 10`
> （日志、chip、图标标签），所以「全部提到 11px」不成立。

## 汇总

| 类别 | 处数 | 建议 |
|---|---:|---|
| 密集信息（tabular-nums / mono / 大写小标签 / 计数） | 59 | 保留 10px |
| 说明性文字（句子里有解释） | 13 | 候选 → 11px |
| 其余（时间戳 / 状态词 / ID） | 135 | 逐条看，默认保留 |
| 合计 | 207 | |

## 说明性文字候选（13 处，逐条确认后再改）

| 文件:行 | 摘要 |
|---|---|
| `app/components/NodeSettingsPanel.tsx:186` | <p className="mt-1.5 text-[10px] text-[var(--fg-dim)]">置顶=列表最前；静音=未读只显红点、不计入全局数字（均存本浏览器） |
| `app/components/NodeSettingsPanel.tsx:277` | <span className="text-[10px] text-emerald-400" data-testid="avatar-save-ok">已保存，全设备同步</s |
| `app/components/NodeSettingsPanel.tsx:279` | <span className="text-[10px] text-[var(--fg-dim)]">保存后跨设备同步（经 hub）</span> |
| `app/components/NodeSettingsPanel.tsx:865` | <p className="mt-1 text-[10px] text-[var(--warning)]/80">无法读取该节点的配置快照（Hub 不可达或节点离线），暂不能保 |
| `app/components/NodeSettingsPanel.tsx:868` | <p className="mt-1 text-[10px] text-[var(--fg-dim)]">该节点未在 W1 supervisor 下运行，重启类改动可能不生效。 |
| `app/components/TaskChatPanel.tsx:1925` | <div className="mt-1 text-[10px] text-amber-400" role="status">{t('最多同时附带 6 个附件', 'Up to |
| `app/legion/page.tsx:1136` | <p className="px-2 py-1 text-[10px] text-[var(--fg-dim)]">成员超过 60，只列部门与核心；找成员请用搜索或直接点图。< |
| `app/legion/page.tsx:1431` | <button type="button" onClick={reset} aria-label="重置视图" className="rounded px-2 py-1 tex |
| `app/skillhub/page.tsx:135` | <span className={`rounded-full bg-[var(--hover-tint)] px-2 py-0.5 text-[10px] ${skill.st |
| `app/requirements/TagManager.tsx:212` | <span className="text-[10px] text-[var(--fg-muted)]">父标签（顶级 = 根）</span> |
| `app/requirements/page.tsx:1151` | <span className="text-[10px] text-[var(--fg-dim)]">未完成且截止已过</span> |
| `app/requirements/[id]/page.tsx:1189` | <p className="mt-1 text-[10px] text-gray-600">最多 5 层、不能成环（Hub 校验）；改父级不改卡片其它字段。</p> |
| `app/requirements/[id]/page.tsx:1230` | <p className="mt-1 text-[10px] text-gray-600">同一网络、最多 5 层、不能成环（由 Hub 校验）。</p> |

## 下一批的做法（F1 修订版）

1. 只对上面这 13 条逐条判断：是否属于「说明性文字」——是则 `10px → 11px`（`caption`）；
2. 其余 195 处保留 10px，并在代码注释里写明「密集档，与客户端一致」；
3. 每批改动仍走 320/390/1440 截图 + 需求矩阵套件。

## 为什么不全改

- 客户端自己也用 10px 处理密集信息（34 处），一刀切会让 Dashboard 比客户端更松；
- 纯数字/时间戳提升到 11px 只增加行高，可读性收益接近于零。
