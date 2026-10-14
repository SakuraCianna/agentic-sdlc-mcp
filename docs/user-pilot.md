# 小规模用户试点方案

状态：**计划，尚未执行**。本文件不代表已经招募用户、取得仓库授权、完成真实客户端连接、发布候选包或证明用户收益。当前 1.11.0 候选版的代码、fixture、SDK、打包验证与未来用户观察必须分开记录；本次文档工作不联系外部用户。

## 要回答的问题

试点观察只读 PR 评估是否能让审阅者更快找到阻塞项与证据缺口，并减少手工重写上下文。特别检查：`ready_for_review` 是否被误读为可自动合并，`needs_evidence` 是否可行动，权限不足是否被误读为仓库没有控制，以及 checkbox/CI 绿灯是否被误当作业务验收。

## 授权仓库清单

开始前由有权授权的人在受控本地记录中明确仓库与读取范围。授权仅覆盖选定仓库、PR/ref 和采集时间段，不包含写入、外部联系、生产配置变更或扩大 token 权限。没有授权的仓库不进入样本。撤销后立即停止其采集，按约定删除或归还本地资料。

以下是**空模板**，不是已授权仓库列表：

| 字段 | 记录要求 |
|---|---|
| `repository_alias` | 本地分配的无语义代号，例如 `R01`；对外只使用代号 |
| `repository_coordinates` | 精确 owner/repo；仅保存在访问受控的本地授权账本 |
| `authorized_by_role` | 授权者的仓库管理角色；联系方式和真实姓名不进入汇总 |
| `permitted_prs_or_refs` | 显式 PR 清单或有界筛选条件、允许的 ref |
| `allowed_operations` | 只读 metadata/checks/reviews/policy，以及明确同意的可选安全来源 |
| `credential_scope` | token 类型、仓库范围与权限名称；永不记录 token 值 |
| `consent_recorded_at` / `expires_at` | 授权时间与到期时间；默认不无限延长 |
| `withdrawal_and_retention` | 撤销入口、原始文件保留时限、访问者和删除责任人 |
| `artifact_location` | 受控本地目录；不上传公共 CI、Issue、PR 或第三方分析服务 |

## 样本与执行

探索样本为 **3–5 个已授权仓库、合计 20–30 个 PR**，不按仓库数乘成更大样本。优先覆盖文档变更、一般功能、依赖/配置变更，以及有明确安全或策略要求的 PR；保留无策略、权限受限、pending/failed checks 和更新 head/base 的案例。公开与私有仓库均需明确授权。

这属于便利抽样；同一仓库、维护者、客户端或技术栈的 PR 可能高度相关，不能据此推断总体正确率、企业兼容性、收益显著性或未来模型表现。若未覆盖某客户端，就保留“未验证”，不外推。

1. 固定候选包/commit、Node、客户端和策略版本。先运行离线 `doctor`，授权后再运行只读在线探测。MCP 使用 `envonly`、`SDLC_READ_ONLY=true` 和审查工具名单；不启用自动批准。
2. 审阅者先按原有流程记录找到阻塞项与缺证据的用时及需要的手工整理次数，再阅读候选报告；标注先看报告可能带来的学习效应。可在后续 PR 交替顺序，但不将这种小样本比较包装成随机对照实验。
3. 对每个 PR 执行一次 advisory `assess-pr`。需要追踪变化时保存不同文件名并运行 `diff`，不覆盖旧文件。只有经明确同意才导入验收文本和 mapping；保留未验证状态。
4. 人工核对结论与 GitHub 实际来源，记录真阻塞、误报、遗漏、不可行动缺口、耗时和下一步。工具不发评论、不批准、不合并、不部署。
5. 报告仅输出匿名聚合；原始 packet 可能含仓库坐标、URL、SHA 和业务摘要，不因名为“证据”就自动适合公开。按授权账本保留并清理。

CLI 默认 advisory，即使结论阻塞也可能退出 0；需要观察判定字段。试点不把 `--enforce` 设为仓库 required check。若之后考虑执行门禁，应单独评审失败样本和仓库权限，再取得对应变更授权。

## 匿名汇总字段

共享表只保存完成判断所需的低基数数据；代号与仓库坐标的映射不进入共享表。

| 字段 | 值或单位 |
|---|---|
| `sample_id`, `repository_alias` | 无语义随机/顺序代号；不是仓库 URL 或 PR number |
| `candidate_version`, `candidate_commit` | 被验证产品版本与公开源码 commit；不是目标私有仓库 commit |
| `client_family`, `client_version`, `node_major` | 客户端名称/版本及 Node 主版本 |
| `change_category`, `policy_present`, `permission_class` | 预定义枚举；权限按完整/部分/未知分组 |
| `decision`, `gate_conclusion`, `review_conclusion` | 工具返回的状态枚举 |
| `source_gap_categories` | 权限/超时/限流/截断/换头/策略不可读等固定类别 |
| `baseline_minutes`, `assisted_minutes` | 人工观察的时间；缺失值保留缺失 |
| `manual_rewrites_before`, `manual_rewrites_after` | 人工重写上下文的次数 |
| `confirmed_blockers`, `false_blockers`, `missed_blockers` | 人工复核计数，附匿名分类，不附原文 |
| `actionable_gap_count`, `unactionable_gap_count` | 按是否能确定责任人/下一步复核的计数 |
| `github_requests`, `duration_ms`, `retry_count` | 采集预算与耗时；不按私有仓库路径细分 |
| `acceptance_status_counts` | missing/needs_human/unverified/verified/not_applicable 计数 |
| `reviewer_outcome` | continue/fix_first/stop；理由使用匿名问题类别 |

不收集 token、Cookie、邮箱、姓名、Issue/PR 正文、检查日志、私有源码、文件路径、目标仓库 URL、私有 commit SHA，或可以还原这些内容的自由文本。跨仓库汇总避免稀有类别组合识别个人；需要解释个案时先在本地处理，另行确认可分享范围。

## 停止、修复和继续判据

任何一次未授权 GitHub 写入、秘密/私有正文进入共享输出、跨仓库取错证据、旧 head 被当作当前证明、未知/失败证据被静默提升为通过，都立即停止受影响路径。保全最少的本地复现资料，撤销或限制凭据，修复并补回归，再由仓库负责人决定是否恢复；不以样本未收满为理由继续。

发现重复不可行动缺口、同类明显误报、客户端无法识别实际运行版本，或审阅者把 ready/绿色 CI 当作自动批准时，先暂停扩样并修正文案或行为。若两次相同采集都因同一权限/超时问题失败，停止自动重试，交给负责人处理。

满 20–30 个 PR 后仅当严重边界事件为零、已知真实阻塞没有被静默标成 ready、至少 80% 已记录证据缺口经人工认定有明确下一步，且至少两个仓库的审阅者认为报告值得继续使用时，考虑扩大下一轮。耗时/重写次数报告中位数、范围、缺失数与样本构成，不承诺统计显著收益；没有改善时优先修复流程，不因完成代码就宣布产品验证成功。

## 结果状态模板

| 维度 | 当前状态 | 未来应附证据 |
|---|---|---|
| 代码实现 | 1.11.0 候选源码集成中 | 具体 commit 与行为回归 |
| 本机验证 | 以交付记录实际命令为准 | 命令、环境、结果及限制 |
| 远端 CI | 本方案未验证本候选的远端运行 | 精确 commit 的 run URL 与 required checks |
| 公开分发 | 本方案未声明已发布 | Release、npm/Registry 精确版本与包内容核验 |
| 客户端连接 | 配方仅核验官方文档 | 实际客户端/版本、discovery 与只读调用结果 |
| 用户收益 | 尚未采样 | 匿名汇总、失败样本、人工判定与样本限制 |
