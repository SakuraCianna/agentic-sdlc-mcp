# 项目对标评估：Microsoft Learn《Foundations of Agentic AI (GitHub)》

- 课程链接: https://learn.microsoft.com/zh-cn/training/modules/foundations-agentic-ai/
- 评估日期: 2026-07-06
- 评估对象: `agentic-sdlc-mcp`（本仓库）

## 1. 课程框架回顾

课程共 8 个单元，核心知识点集中在中间 5 个单元：

| 单元 | 核心概念 |
|---|---|
| 2. 定义 Agentic AI | Assistant（被动建议）vs Agent（目标驱动：可解释目标、决定中间步骤、使用工具、独立产出分支/提交/PR，并根据反馈迭代） |
| 3. Plan → Act → Evaluate 生命周期 | 这是一个**循环**，不是线性流程：Plan（结构化、可审查的计划）→ Act（限定在分支/PR 工作流内的操作）→ Evaluate（依据 CI 状态检查、审查意见、安全信号等**系统信号**判断，而非 agent 自身的信心）→ 未达标则回到 Plan 继续迭代 |
| 4. GitHub 作为记录系统 & 控制平面 | 记录系统：仓库/分支/提交/PR/Issue/工作流运行/审查历史。控制平面：Pull Request、Required reviews、Required status checks、CODEOWNERS、Rulesets/分支保护、Environments、GitHub Actions 的最小权限（GITHUB_TOKEN） |
| 5. 责任、风险、反模式、可追溯性 | 责任不随执行转移，人类始终对结果负责。4 大反模式：无计划执行、过度授权 agent、隐藏推理、对自动化的盲目信任。可信系统需要最低审核线索：明确目标、可审查计划、受限变更集、自动化证据、人类判断、明确结果 |
| 6. 参与者模型 | 用统一标准评审 agent 生成的 PR，不因"是 AI 写的"而过度怀疑，也不因"自动化产出"而过度信任：意图(intent)、范围(scope)、证据(evidence)、所有权(ownership/CODEOWNERS)、策略(policy/rulesets)、回退(fallback) |

## 2. 项目现状 → 课程概念映射

代码健康度快照（评估时）：`npm run typecheck` 0 错误；`npm run test` 13 个测试文件、105 个用例全部通过；CI/publish workflow 均已声明 `permissions: contents: read`（符合 unit4 的最小权限要求）。

| 课程概念 | 项目现有实现 | 覆盖程度 |
|---|---|---|
| Plan（可审查计划） | `plan_from_context`、`create_issue_set`、`prepare_work_item` | 完整 |
| Evaluate（系统信号而非自信） | `quality_gate_status`（CI 检查证据）、`security_triage`（代码扫描/Dependabot/密钥扫描）、`release_readiness_check` | 完整 |
| Accountability / 责任不转移 | 所有写操作 `dryRun` 默认 `true`；无 auto-merge、无 force-push、无删除分支能力 | 完整 |
| 可追溯性 | `agent_handoff_packet`；SDLC 标准要求 commit/PR 关联 issue | 完整 |
| 参与者模型（意图/范围/证据/策略） | `review_pr_against_standard` 覆盖 intent（描述完整性）、scope（文件分类）、evidence（测试覆盖）、policy（security-focused 密钥扫描） | 部分 |
| Act（分支/提交/PR 的实际执行） | 无对应工具 —— 项目只做 Plan 产出物（issue）的写入，不创建分支/提交/PR | **缺失** |
| GitHub 控制平面：CODEOWNERS | 无 | **缺失** |
| GitHub 控制平面：Rulesets / 分支保护 | 无 | **缺失** |
| GitHub 控制平面：Environments | 无 | 缺失（优先级较低，通常与部署审批相关，超出当前工具集范围） |
| 参与者模型：ownership 维度 | `review_pr_against_standard` 不检查 CODEOWNERS 命中与审阅请求 | **缺失** |
| Actions 最小权限（可审计） | 本项目自身 workflow 遵循最小权限，但没有工具能审计**目标仓库**的 workflow 权限声明 | **缺失** |

## 3. 差距识别（按优先级）

1. **仓库自身没有 CODEOWNERS 文件** —— 作为一个教 agent 遵循治理最佳实践的工具，自己没有示范这个模式。
2. **没有工具读取分支保护 / rulesets 配置** —— 课程 unit4 的核心控制平面表格（Required reviews、Required status checks、force-push/删除限制）目前只覆盖了"当前检查是否通过"（`quality_gate_status`），没有覆盖"这些检查是否被强制要求"。
3. **`review_pr_against_standard` 缺少 ownership 维度** —— 参与者模型的 6 个评审标准里，ownership（CODEOWNERS 命中与审阅路由）完全没有实现。
4. **没有 workflow 权限审计能力** —— unit4 强调的"最小权限 GITHUB_TOKEN"、unit5 的"过度授权 agent"反模式，目前只在本项目自身的 workflow 上做到了，没有工具能帮用户审计其他目标仓库的 workflow 文件。
5. **Act 阶段（创建分支/提交/开 PR）尚未实现** —— 范围和风险较大，需要额外斟酌（是否要让 MCP server 具备真正的仓库写代码能力），本轮暂不处理。

## 4. 路线图与执行状态

| # | 任务 | 状态 |
|---|---|---|
| 0 | 撰写本评估报告 | ✅ 已完成 |
| 1 | 新增 CODEOWNERS 文件 | 进行中 |
| 2 | 新增 `branch_protection_status` 工具（读取 required reviews / required status checks / force-push 限制等） | 待开始 |
| 3 | 增强 `review_pr_against_standard`，加入 CODEOWNERS-aware 的 ownership 检查 | 待开始 |
| 4 | 新增 `workflow_permissions_audit` 工具（扫描目标仓库 workflow 的 permissions 声明） | 待开始 |
| 5 | 评估是否新增受限的 "Act" 阶段工具（如 dryRun 优先的创建分支+起草 PR） | 暂缓，待用户进一步斟酌范围与风险 |

> 附注：评估过程中顺带发现，本仓库自身的 `main` 分支目前**没有配置任何分支保护规则**（`GET /repos/.../branches/main/protection` 返回 404 Branch not protected）。这意味着当前没有强制要求 PR 审查或状态检查才能合并到 main。是否要为本仓库启用分支保护，属于仓库设置层面的决定，需要用户自行在 GitHub 仓库设置中开启，本工具不会代为修改。
