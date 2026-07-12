# Agentic SDLC MCP Roadmap

## 定位

`agentic-sdlc-mcp` 不应该只是 GitHub API 的 MCP 包装层，而应该发展成 AI coding agent 的 SDLC 治理层和安全控制平面。

这里的 AI coding agent 是通用概念，包含各类命令行 coding agent、IDE agent、MCP 客户端和后续出现的同类工具。项目不为某个客户端做专用能力，而是提供一套客户端无关的 MCP 工具，让任何 agent 都能按同样的工程约束工作。

它的核心价值是帮助 AI coding agent 在真实仓库中遵循可审查、可追溯、可验证的工程流程：

- 开工前读取足够的仓库上下文
- 根据任务类型生成合适的 SDLC 计划
- 默认以 `dryRun` 预览所有写操作
- 用 GitHub 系统信号验证 PR 与发布风险
- 输出可复用的 evidence packet，方便人类审查和交接

一句话定位：

> agentic-sdlc-mcp helps AI coding agents work like accountable engineering teammates: plan with context, create traceable work, verify PR quality, and produce auditable SDLC evidence.

## 产品原则

1. **客户端无关**
   MCP server 只关心标准工具输入输出，不假设调用方是某一个具体软件。文档和测试场景应该写成 "AI coding agent 应该如何使用"，而不是 "某客户端应该如何使用"。

2. **上下文优先**
   Agent 在计划或执行前必须先了解仓库，而不是只凭用户一句话开始操作。

3. **安全默认值**
   所有写入类能力默认 `dryRun: true`。真实写入必须显式请求，并且必须保留人类审查入口。

4. **证据驱动**
   MCP 不应该只告诉 agent "可以继续"，而要返回可审查的依据：CI、PR 状态、分支保护、权限、测试、风险和缺口。

5. **任务类型自适应**
   文档、功能、Bug 修复、重构、安全、发布和基础设施任务不应该共用同一套模板。

6. **不替代人类控制权**
   项目不应提供 auto-merge、force-push、删除保护规则等高风险能力。MCP 的职责是整理上下文、生成计划、创建可审查产物和验证门禁。

## 版本路线

### v1.4: 通用 Agent 可用性与上下文增强

目标：让任何 AI coding agent 都能快速验证 MCP 是否可用，并让 `repo_context` 返回足够有用的开工上下文。

> **状态：已在 v1.4.0 完成。** 以下两点验收标准全部达成，但实现时对本节最初给出的示例设计做了三处调整，记录在此以备后续版本参考：
>
> 1. **输出结构：扁平而非嵌套。** 本节 `repo_context` 建议的示例 JSON 是 `repo`/`runtime`/`scripts`/`testing`/`governance` 分组的嵌套结构。实际实现选择在现有扁平 `structuredContent`（`fullName`/`defaultBranch` 等已在顶层）基础上新增顶层字段（`packageManager`/`techStack`/`scripts`/`workflows`/`governance`/`agentInstructions`），因为包已发布到 npm（v1.3.1），真实 agent 可能已经依赖现有字段路径——嵌套重构属于 breaking change，收益不足以抵消迁移成本。
> 2. **`governance` 不重复探测分支保护。** 本节建议 `governance.branchProtectionKnown`，但项目已有专门的 `branch_protection_status` 工具，而 `getBranchProtection` 这个 API 常需要 admin 权限、容易 403。`repo_context.governance` 目前只报告 `codeownersFound`，分支保护判断留给专用工具，避免重复调用且默认请求更容易失败。
> 3. **包管理器识别用混合策略。** 优先读 `package.json` 的 `packageManager` 字段（0 次额外调用）；缺失时才探测 `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lockb`（最多 4 次额外调用，命中即停）。多数仓库不会声明 `packageManager` 字段，纯字段读取会让大多数仓库返回 `unknown`，实用性有限。
> 4. **agent 规则文件探测范围收窄为最小集。** 只探测 `AGENTS.md`（跨工具开放约定）与 `CLAUDE.md`（本节示例 JSON 自己用的文件名）。未纳入 `.cursorrules`、`.windsurfrules` 等具体客户端专属文件名——项目定位是"客户端无关"，在代码里硬编码一堆厂商专属文件名与这个定位存在张力。

#### 1. 新增通用 AI Coding Agent 冒烟测试文档 ✅ 已完成（v1.4.0）

当前文档不应该围绕某个客户端命名。应该新增一份通用冒烟测试指南，说明任何支持 MCP 的 AI coding agent 如何验证本 server 是否配置成功、是否能读取目标仓库、是否能安全预览写操作。

建议文档内容：

- MCP server 的最小配置项
- `GITHUB_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO` 的作用和安全注意事项
- 不传 `owner` / `repo` 时如何回退到环境变量
- 只读工具的验证路径，例如 `repo_context`
- 写入工具的 dry-run 验证路径，例如 `create_issue_set`
- 常见失败：token 缺失、repo 坐标缺失、权限不足、MCP 客户端未加载 server
- Windows PowerShell 示例，以及 JSON 配置示例

验收标准：

- 不出现某个客户端专属流程作为唯一入口
- 示例不包含真实 token、cookie、私钥或私有证书
- 用户可以在 5 分钟内完成一次只读调用和一次 dry-run 写入预览
- 文档明确说明 dry-run 不会真实创建 issue

示例提示词 1：

```text
使用 agentic-sdlc-mcp 读取当前默认仓库的 repo_context。不要修改任何文件，也不要创建 issue。
```

期望 agent 操作：

- 调用 `repo_context`
- 不传 `owner` / `repo` 时使用 `GITHUB_OWNER` 和 `GITHUB_REPO`
- 不调用任何写入工具

期望返回：

- 仓库 full name
- 默认分支
- 主要语言
- open issues / open PRs 数量
- README 是否可读取
- 如果配置缺失，返回清晰的环境变量修复建议

示例提示词 2：

```text
用 agentic-sdlc-mcp dryRun 创建 3 个测试 issue 预览，不要真实创建。
```

期望 agent 操作：

- 调用 `create_issue_set`
- 显式传入 `dryRun: true`
- 汇报 `issues: []` 或等价的未创建结果

期望返回：

- `dryRun: true`
- 预览 issue 标题、标签、body 摘要
- 明确说明没有调用真实创建 issue 的 GitHub 写入路径

示例提示词 3：

```text
检查 agentic-sdlc-mcp 当前连接的 GitHub 仓库是否能用于后续 SDLC 流程。
```

期望 agent 操作：

- 先调用 `repo_context`
- 如用户要求计划，再调用 `plan_from_context`
- 不应该直接创建 issue、开 PR 或尝试修改仓库

期望返回：

- 当前连接仓库是否清楚
- MCP 工具是否可用
- 下一步建议，例如读取更深上下文、生成计划或 dry-run issue set

#### 2. 增强 `repo_context` ✅ 已完成（v1.4.0，实现细节见本节顶部状态说明）

当前 `repo_context` 已能读取仓库基础信息，但对 agent 开工来说仍偏薄。下一步应把它升级为 "repository briefing packet"，让 agent 在动手前知道项目如何启动、如何测试、有哪些治理约束。

建议新增或强化的信息：

- README 摘要
- `package.json` 摘要，包括 scripts、dependencies、devDependencies
- 技术栈识别，例如 TypeScript、Vite、Next.js、Vitest、Express
- 包管理器识别，例如 npm、pnpm、yarn
- 常用检查命令，例如 build、typecheck、test、smoke
- `.github/workflows` 摘要
- CODEOWNERS 摘要
- AGENTS.md 或其他 agent 规则文件摘要
- 最近 open issues 和 open PRs
- 默认分支、最近 push、仓库 topics、主要语言

建议输入参数：

- `includeReadme`
- `includePackageJson`
- `includeWorkflows`
- `includeAgentInstructions`
- `includeGovernance`
- `includeOpenIssues`
- `includeOpenPRs`
- `maxReadmeChars`
- `maxInstructionChars`

结构化输出建议：

```json
{
  "repo": {
    "fullName": "owner/repo",
    "defaultBranch": "main",
    "language": "TypeScript"
  },
  "runtime": {
    "packageManager": "npm",
    "nodeVersion": ">=24"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "testing": {
    "framework": "vitest",
    "smokeCommand": "npm run smoke"
  },
  "governance": {
    "codeownersFound": true,
    "branchProtectionKnown": false
  },
  "agentInstructions": [
    {
      "path": "AGENTS.md",
      "summary": "Windows PowerShell commands only; dryRun defaults preserved"
    }
  ]
}
```

验收标准：

- 默认输出仍保持精简，不让上下文失控
- 通过参数打开更深层上下文
- structuredContent 中包含 README/package/scripts 等关键字段，而不只出现在 markdown 文本中
- README 缺失、package.json 缺失、规则文件缺失时返回 degraded context，而不是直接失败
- 单元测试覆盖缺失文件、可选字段关闭、内容截断、JSON 解析失败

示例提示词 1：

```text
读取这个仓库的上下文，重点告诉我它怎么安装、怎么测试、怎么构建，以及 agent 开发时必须遵守哪些规则。
```

期望 agent 操作：

- 调用 `repo_context`
- 打开 `includePackageJson`
- 打开 `includeAgentInstructions`
- 打开 `includeGovernance`

期望返回：

- npm scripts 摘要
- 测试框架
- 构建命令
- AGENTS.md 或同类规则摘要
- 如果缺少某类文件，标注 unknown 或 not found

示例提示词 2：

```text
开始修复一个 bug 前，请先用 MCP 判断这个仓库的技术栈、测试命令和最近打开的 PR。
```

期望 agent 操作：

- 调用 `repo_context`，包含 package.json 和 open PRs
- 不直接修改代码

期望返回：

- 技术栈：例如 TypeScript + Vitest + MCP SDK
- 建议验证命令：例如 `npm run typecheck`、`npm run test`
- 最近 PR 列表或空列表

示例提示词 3：

```text
你是接手这个仓库的新 AI coding agent，先生成一个开工前 briefing，不要做计划。
```

期望 agent 操作：

- 只调用 `repo_context`
- 不调用 `plan_from_context`
- 不创建 issue

期望返回：

- 仓库职责
- 入口文件
- 关键命令
- 风险提醒
- 下一步可选动作

#### 3. 增强 `plan_from_context` 的任务类型识别 ✅ 已完成（v1.4.0）

当前计划模板对所有任务基本一致，容易让 docs-only 任务也出现不合适的测试或实现步骤。下一步应增加 `workType`，并把推断依据暴露给调用方。

建议支持的 `workType`：

- `docs`
- `feature`
- `bugfix`
- `refactor`
- `security`
- `release`
- `infra`

输入设计：

- 用户可显式传入 `workType`
- 未传入时根据 `goal`、`acceptanceCriteria` 和仓库上下文做保守推断
- 推断结果需要在输出中说明，避免隐藏判断
- 如果置信度较低，返回 `needsClarification: true` 和建议问题

不同任务类型的计划差异：

- `docs`：强调读现有文档、补示例、检查术语一致性、运行 markdown/diff 检查
- `feature`：强调设计、实现、单元测试、集成测试、PR summary
- `bugfix`：强调复现、最小修复、回归测试、原因说明
- `refactor`：强调行为不变、测试先行、分批提交、避免公共 API 破坏
- `security`：强调威胁、权限、密钥、依赖、输入校验
- `release`：强调版本、changelog、tag、CI、rollback
- `infra`：强调 workflow、权限、环境变量、最小权限和回滚

验收标准：

- docs-only 任务不会默认生成代码单元测试任务
- bugfix 任务必须包含复现和回归测试
- security 任务包含威胁、权限、密钥和依赖检查
- release 任务包含 changelog、版本、tag、CI、回滚计划
- structuredContent 包含 `workType`、`confidence`、`reasoning`、`needsClarification`

示例提示词 1：

```text
为这个仓库规划一个任务：补充 MCP 配置和 dryRun 使用文档。验收标准：包含环境变量说明、repo_context 示例、create_issue_set dryRun 示例。
```

期望 agent 操作：

- 调用 `plan_from_context`
- 推断 `workType: "docs"`

期望返回：

- Plan 阶段：阅读 README、现有 docs、工具 schema
- Create 阶段：新增或更新文档
- Test 阶段：检查示例、运行 `git diff --check`
- Review 阶段：确认没有 token、没有过时命令
- 不应要求新增单元测试，除非文档生成逻辑也变更

示例提示词 2：

```text
规划一个 bugfix：quality_gate_status 在没有 checks 的 PR 上不应该直接显示 passing，而应该提示 no evidence。
```

期望 agent 操作：

- 调用 `plan_from_context`
- 推断 `workType: "bugfix"`

期望返回：

- 复现步骤
- 单元测试建议：无 checks、失败 checks、pending checks
- 实现风险
- 回归验证命令

示例提示词 3：

```text
规划一个 security 任务：审计 workflow permissions，发现过宽权限时给出 findings。
```

期望 agent 操作：

- 调用 `plan_from_context`
- 推断或显式使用 `workType: "security"`

期望返回：

- 权限模型说明
- 高风险文件路径
- 测试样例：只读权限、写权限、缺失 permissions
- 安全审查 gate

### v1.5: Plan 与 Issue 创建闭环

目标：让 `plan_from_context` 的输出可以直接进入 `create_issue_set`，减少 agent 手动改写计划的摩擦，并让人类能在 dry-run 预览里判断是否允许真实创建。

> **状态：已在 v1.5.0 完成。** `plan_from_context` 现在输出 3-5 个结构化 `issueDrafts`，只采用目标仓库中已存在的标签，并可直接作为 `create_issue_set.issues` 输入。`create_issue_set` 的 dry-run 返回目标仓库、标题、标签、body 摘要与 warning；live 批次则保留部分成功结果并报告安全化失败原因。

#### 1. 输出 `issueDrafts` ✅ 已完成（v1.5.0）

`plan_from_context` 除了返回 `suggestedIssues` 标题列表，还应返回可直接传给 `create_issue_set` 的结构化 issue 草稿。

建议结构：

```json
{
  "title": "[Docs] Add generic MCP smoke test guide",
  "body": "### Background\n...\n### Acceptance Criteria\n- [ ] ...",
  "labels": ["docs", "agentic-sdlc"],
  "phase": "plan",
  "acceptanceCriteria": ["..."],
  "riskLevel": "low"
}
```

设计细节：

- `title` 使用简洁、可执行的动词短语
- `body` 使用项目现有 issue template 结构
- `labels` 只生成仓库中常见或保守标签，不臆造复杂分类
- `phase` 对应 SDLC 阶段
- `riskLevel` 用于后续 release/readiness 或 review 工具排序
- `sourcePlanId` 或 `goal` 可用于追踪 issue 来自哪次计划

验收标准：

- `issueDrafts` 可直接作为 `create_issue_set.issues` 入参
- 计划输出同时保留人类可读 markdown 和 structuredContent
- dry-run 可完整预览即将创建的 issue
- 单元测试覆盖 docs、feature、bugfix、security 至少四类任务

示例提示词 1：

```text
用 agentic-sdlc-mcp 为“增强 repo_context 输出 package scripts”生成计划，并把可创建的 issue 草稿也返回出来。不要真实创建 issue。
```

期望 agent 操作：

- 调用 `plan_from_context`
- 从 structuredContent 读取 `issueDrafts`
- 不调用 live 写入

期望返回：

- SDLC plan
- 3 到 5 个 issue 草稿
- 每个 issue 包含 title、body、labels、phase、acceptanceCriteria

示例提示词 2：

```text
把刚才的计划转换成 dryRun issue 预览，确认不会真实创建。
```

期望 agent 操作：

- 调用 `create_issue_set`
- 使用 `plan_from_context` 产出的 `issueDrafts`
- 显式传入 `dryRun: true`

期望返回：

- `dryRun: true`
- `count`
- 每个 issue 的标题、标签和 body 摘要
- `createdIssues` 为空或等价字段为空

示例提示词 3：

```text
为一个 security 任务生成 issue 草稿：扫描 workflow permissions，过宽权限要给出 warning。
```

期望 agent 操作：

- 调用 `plan_from_context`，workType 为 security

期望返回：

- 至少包含 Plan、Create、Test、Secure 相关 issue 草稿
- security issue 的 body 中包含权限风险和测试场景

#### 2. 改善 `create_issue_set` 预览体验 ✅ 已完成（v1.5.0）

此前 dry-run 只返回 `previewTitles`，安全性很好，但对人类审查还不够完整。v1.5.0 已将 dry-run 扩展为提交前确认页面。

建议增强：

- 返回每个 issue 的标题、标签、body 摘要
- 标出真实写入前需要确认的仓库坐标
- 对空 labels、超长 title、缺失 body 给出 warning
- 明确 `dryRun: true` 没有调用 GitHub 写接口
- 对 `dryRun: false` 返回创建后的 issue number、url、labels
- 在 markdown 文本中高亮 "Preview only"

验收标准：

- dry-run 可作为人类确认页面使用
- live 分支测试继续验证 Octokit create issue 参数
- 默认值仍为 `dryRun: true`
- `dryRun: false` 必须由调用方显式传入
- 输入为空数组时返回清晰错误

示例提示词 1：

```text
预览创建这些 issue：一个文档任务、一个测试任务、一个安全审查任务。只允许 dryRun。
```

期望 agent 操作：

- 调用 `create_issue_set`
- `dryRun: true`

期望返回：

- issue preview table
- warnings，例如缺少 label 或 body 太短
- 明确 "No GitHub issues were created"

示例提示词 2：

```text
检查这组 issue 草稿是否适合真实创建，但先不要创建。
```

期望 agent 操作：

- 调用 `create_issue_set` dry-run
- 总结 preview 中的风险

期望返回：

- 哪些 issue title 清晰
- 哪些 body 或 acceptance criteria 不足
- 下一步建议：补充后再让用户确认 `dryRun: false`

示例提示词 3：

```text
我确认可以真实创建这些 issue。请用 agentic-sdlc-mcp 创建。
```

期望 agent 操作：

- 只有在用户明确确认后才传 `dryRun: false`
- 创建后汇报 issue number 和 url

期望返回：

- `dryRun: false`
- created issue 列表
- 每个 issue 的 GitHub URL
- 如果某个创建失败，返回部分成功和失败原因

### v1.6: 真实合并门禁

目标：把 `quality_gate_status` 从 "检查 CI 状态" 升级为 "PR 是否可进入人工合并决策"。

> **状态：已在 v1.6.0 完成。** `quality_gate_status` 已聚合 check runs、commit statuses、reviews、CODEOWNERS、branch protection/rulesets、阻塞标签与关联 Issues，并输出六种可解释结论；`review_pr_against_standard` 已升级为 work-type-aware 结构化 reviewer；`release_readiness_check` 已对齐统一 CI 证据语义。所有决策工具仍只读，不会批准、合并 PR 或修改仓库策略。
>
> **相对初稿的已确认取舍：**
>
> - 共享 `pull-request-evidence` 层代替各工具重复抓取 GitHub 信号，并用 `unverifiedSignals`/`errors` 表达 degraded evidence。
> - `review_pr_against_standard.workType` 为可选显式覆盖；省略时返回保守推断、置信度与理由。
> - `quality_gate_status` 保留兼容的 ref 模式；ref 模式只判断 CI，不虚构 PR review/policy 缺口。
> - v1.6 的 `blockingLabels` 使用可覆盖的内置默认值，仓库级配置留到 v1.7 `.agentic-sdlc.yml`。
> - 发布就绪度同步修复：零信号、全 skipped/neutral、pending、unknown 均不可发布，只有至少一个明确 passing 且无失败、等待或证据缺口的 CI 才可 ready。
> - 密钥检测采用“成熟 Gitleaks CI 证据为主、内置启发式为辅”的分层方案；可信证据绑定具体 Actions job、run、head SHA 和唯一的 base workflow job，同名/重名 status/job、未知 App、不完整证据或扫描策略自修改均不能证明 clean scan。
> - 补充启发式在所有 review standard 下运行，按 diff hunk/statement 有界扫描并聚合输出；覆盖 credential 字段和认证头 API sink 的动态拼接/格式化、多语言模板插值与 builder、join、解码、多行和有界的补丁内字段别名，以 `DynamicSecretConstruction` 表达风险，但不替代跨文件数据流分析、CodeQL/SAST 或人工审查。

#### 1. 扩展 PR 门禁信号

真实 PR 门禁不只看 check runs。一个 PR 可能 CI 全绿，但仍然缺少 required review、缺少 CODEOWNERS 审阅、处于 draft 状态，或者目标分支没有任何保护策略。工具应该把这些信号拆开说明。

建议聚合：

- check runs / commit statuses
- PR draft 状态
- mergeable / merge state
- required status checks
- required reviews
- review decision
- CODEOWNERS 命中情况
- branch protection / rulesets
- 是否存在阻塞 label
- 是否有关联 issue

输出结论建议：

- `passing`：系统证据完整，没有阻塞项
- `failing`：存在失败 checks 或明确失败信号
- `pending`：checks 或 mergeability 仍在计算
- `needs_review`：CI 通过但缺少 required review
- `policy_gap`：仓库缺少保护策略或工具权限不足导致无法确认
- `no_evidence`：没有 checks，也没有其他可验证信号

结构化输出建议：

```json
{
  "conclusion": "needs_review",
  "evidence": {
    "checks": { "passing": 2, "failing": 0, "pending": 0 },
    "reviews": { "approved": 0, "required": 1 },
    "branchProtection": "protected"
  },
  "blockers": ["Required review is missing"],
  "warnings": ["No linked issue found"],
  "nextActions": ["Request review from CODEOWNER"]
}
```

验收标准：

- CI 全绿但缺少 required review 时，不应返回单纯 passing
- 没有任何 checks 时，不应把 0 个失败误判为 passing
- 分支保护缺失时给出 policy warning，而不是当作 PR 本身失败
- structuredContent 中区分 `evidence`、`blockers`、`warnings`、`nextActions`
- 权限不足时返回 degraded mode，说明缺哪些权限

示例提示词 1：

```text
检查 PR #10 是否真的可以进入人工合并决策，不要只看 CI。
```

期望 agent 操作：

- 调用增强后的 `quality_gate_status`
- 必要时结合 `branch_protection_status`

期望返回：

- CI 状态
- review 状态
- draft / mergeable 状态
- branch protection 状态
- 结论：passing、needs_review、policy_gap 等

示例提示词 2：

```text
PR #12 的 CI 是绿的，但请确认它有没有缺 required review 或 CODEOWNERS 审查。
```

期望 agent 操作：

- 查询 PR checks
- 查询 reviews 和 requested reviewers
- 检查 CODEOWNERS 命中

期望返回：

- 如果缺 reviewer，结论为 `needs_review`
- 给出需要谁审查或哪些路径触发 ownership

示例提示词 3：

```text
检查 main 分支的 PR 门禁策略是否足够，不要修改仓库设置。
```

期望 agent 操作：

- 调用 `branch_protection_status`
- 不调用任何修改分支保护的 API

期望返回：

- classic branch protection 状态
- rulesets 状态
- required checks / reviews 是否存在
- 风险和下一步人工设置建议

#### 2. 强化 `review_pr_against_standard`

`review_pr_against_standard` 应从简单 diff 检查升级为更接近 reviewer 的结构化判断。它不需要替代人类 reviewer，但应该指出 agent 生成 PR 中常见的缺口。

建议审查维度：

- intent：PR 描述是否说明目的
- scope：文件变更是否和目标一致
- evidence：测试、构建、文档是否匹配变更
- ownership：CODEOWNERS 是否覆盖关键路径
- policy：是否违反仓库治理要求
- fallback：是否有回滚或降级说明
- security：是否触碰 token、env、auth、workflow 权限、依赖锁文件

不同任务的期望：

- docs-only PR：不要求代码单元测试，但要求文档验证方式
- feature PR：要求测试或明确说明为什么无需测试
- bugfix PR：要求回归测试或复现说明
- security PR：要求更严格风险说明和安全验证
- workflow PR：要求权限最小化、触发条件说明和回滚说明

验收标准：

- 对 docs-only PR 不要求代码测试，但要求文档验证方式
- 对 workflow、auth、release 配置变更提高风险等级
- 密钥扫描继续保持保守，避免 keyword mention 造成噪音
- findings 按 severity 排序，并包含文件路径、原因、建议动作

示例提示词 1：

```text
用 security-focused 标准审查 PR #15，重点看有没有 secret、workflow 权限过宽、.env 风险。
```

期望 agent 操作：

- 调用 `review_pr_against_standard`
- `standard: "security-focused"`

期望返回：

- findings 列表
- release risk
- 是否发现 secret-like patch
- 是否触碰 `.env`、workflow、lockfile、dist

示例提示词 2：

```text
审查这个 docs-only PR，不要因为它没有单元测试就直接判失败。
```

期望 agent 操作：

- 调用 `review_pr_against_standard`
- 识别 docs-only scope

期望返回：

- 文档验证缺口
- 示例是否可执行
- 是否包含敏感配置
- 如果没有代码变更，不把缺单元测试作为 blocker

示例提示词 3：

```text
PR #18 修改了 .github/workflows，请检查它是否符合最小权限原则。
```

期望 agent 操作：

- 调用 `review_pr_against_standard`
- 可结合 `workflow_permissions_audit`

期望返回：

- workflow permissions 变化
- 高风险权限 warning
- 建议改成 `contents: read` 或更窄权限

### v1.7: 仓库级策略配置

目标：允许每个仓库定义自己的 SDLC 规则，而不是完全依赖 MCP 内置默认值。

#### 0. 发布到官方 MCP Registry

v1.7 计划同步把本服务发布到 [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)。Registry 当前仍处于 preview，因此实现时必须再次核对官方规范，不能把预览接口当作永久稳定契约。

计划：

- 采用 registry 名称 `io.github.sakuracianna/agentic-sdlc-mcp`。
- 在仓库增加 `server.json`，并通过官方 `mcp-publisher` 校验和发布。
- npm 包增加 `mcpName`，其值必须与 `server.json`/Registry 名称完全一致。
- 保持发布顺序：先确认 npm 对应版本可用，再向 MCP Registry 发布元数据，避免 Registry 指向不存在的包版本。
- GitHub Actions 使用 OIDC（`id-token: write`）向 Registry 认证，不保存长期 Registry secret；npm 仍沿用现有 Trusted Publishing。
- 发布后通过 Registry API 查询并验证名称、版本、package 和 transport 元数据可发现。

验收标准：

- `server.json` 通过官方 schema/CLI 校验，名称与 npm `mcpName` 完全一致。
- workflow 使用最小 `contents: read` 与 `id-token: write` 权限，action/工具版本固定且无长期 Registry token。
- npm 包先发布成功，Registry 发布后 API 能查询到 v1.7 对应版本。
- README 说明 Registry 仍为 preview，并保留 npx 直接安装方式作为兼容入口。
- 发布前再次核对官方 [Quickstart](https://modelcontextprotocol.io/registry/quickstart)、[GitHub Actions](https://modelcontextprotocol.io/registry/github-actions) 与 [Authentication](https://modelcontextprotocol.io/registry/authentication) 文档。

#### 1. 支持 `.agentic-sdlc.yml`

不同仓库的风险边界不同。库项目、Web 应用、基础设施仓库、内部工具仓库对 tests、review、release 和 protected paths 的要求都不同。`.agentic-sdlc.yml` 应提供仓库级策略入口。

建议配置项：

```yaml
defaultWorkType: feature
requiredChecks:
  - test
  - typecheck
protectedPaths:
  - ".github/**"
  - "src/config.ts"
labels:
  releaseBlocking:
    - release-blocker
    - security
review:
  requireIssueLink: true
  requireCodeOwnersForProtectedPaths: true
release:
  requireChangelog: true
  requireRollbackPlan: true
```

设计细节：

- 配置缺失时使用安全默认值
- 配置解析失败时返回清晰错误，不静默忽略
- 工具输出中说明哪些判断来自仓库策略，哪些来自 MCP 默认策略
- 配置不能启用高风险能力，例如 auto-merge、force-push、删除分支
- 配置字段需要有 Zod schema 和单元测试

验收标准：

- `repo_context` 能报告策略文件是否存在
- `quality_gate_status` 能读取 required checks 和 protected paths
- `review_pr_against_standard` 能根据 protected paths 提升风险
- `release_readiness_check` 能根据 release 配置检查 changelog 和 rollback
- 非法 YAML、未知字段、类型错误都有清晰反馈

示例提示词 1：

```text
读取这个仓库的 .agentic-sdlc.yml，并告诉我有哪些策略会影响 PR 审查。
```

期望 agent 操作：

- 调用 `repo_context` 或未来策略读取能力
- 不修改配置

期望返回：

- required checks
- protected paths
- release blocking labels
- review requirements
- 配置缺失时说明使用默认策略

示例提示词 2：

```text
PR #20 修改了 src/config.ts，请根据仓库策略判断是否需要提高风险等级。
```

期望 agent 操作：

- 读取 `.agentic-sdlc.yml`
- 调用 `review_pr_against_standard`

期望返回：

- 命中 protected path
- 需要 CODEOWNERS 或人工安全审查
- 结论可能为 `needs_review` 或存在高风险 warning

示例提示词 3：

```text
检查 release readiness，要求遵守仓库自己的发布策略。
```

期望 agent 操作：

- 调用 `release_readiness_check`
- 加载 `.agentic-sdlc.yml`

期望返回：

- changelog 是否满足要求
- rollback plan 是否存在
- blocking labels 是否存在
- CI 和安全信号是否满足发布策略

#### 2. 策略驱动的计划与门禁

仓库策略不应该只被读取，还应该影响计划、issue 草稿、PR 审查和发布判断。

让以下工具读取策略：

- `plan_from_context`
- `create_issue_set`
- `quality_gate_status`
- `review_pr_against_standard`
- `release_readiness_check`
- `agent_handoff_packet`

策略影响示例：

- 如果 `requiredChecks` 包含 `typecheck`，计划和 gate 都应该把 typecheck 作为必跑项
- 如果 `protectedPaths` 命中 `.github/**`，review 应提高风险等级
- 如果 `requireIssueLink: true`，PR 缺 issue link 应成为 warning 或 blocker
- 如果 `requireRollbackPlan: true`，release readiness 缺 rollback 应失败

验收标准：

- 仓库策略可以改变 required checks 和 protected paths
- 不能通过配置开启 auto-merge、force-push 或删除分支能力
- 测试覆盖默认策略、合法配置、非法配置
- 每个受策略影响的工具都在输出中显示 `policySources`

示例提示词 1：

```text
为一个 workflow 修改任务生成计划，必须遵守仓库策略里的 protectedPaths。
```

期望 agent 操作：

- 调用 `plan_from_context`
- 加载策略

期望返回：

- 计划中包含 workflow 权限审查
- 计划中包含 CODEOWNERS 或人工审查 gate
- suggested issues 或 issueDrafts 带上 security/governance 标签

示例提示词 2：

```text
检查 PR #21，它没有关联 issue。仓库策略要求 PR 必须关联 issue。
```

期望 agent 操作：

- 调用 `quality_gate_status` 或 `review_pr_against_standard`
- 应用策略

期望返回：

- warning 或 blocker：missing linked issue
- 下一步：补 PR 描述或关联 issue

示例提示词 3：

```text
创建 release readiness 报告，按仓库策略判断是否能发布。
```

期望 agent 操作：

- 调用 `release_readiness_check`
- 应用 release 策略

期望返回：

- 通过项
- 阻塞项
- 缺失证据
- 人工 release approval 建议

### v2.0: Evidence Packet 与审计闭环

目标：形成项目的核心差异化能力：把 AI agent 的工作过程整理成可审查、可归档、可交接的证据包。

#### 1. 新增 `sdlc_evidence_packet`

AI coding agent 的关键风险不是不会写代码，而是人类很难快速判断它做了什么、为什么这么做、有没有证据、还有哪些风险。`sdlc_evidence_packet` 应把一次工作流中的关键系统信号汇总成审计材料。

建议汇总的信息：

- repository briefing
- SDLC plan
- issue set
- active work item
- PR summary
- quality gate status
- PR review findings
- branch protection / rulesets
- workflow permissions audit
- security triage
- release readiness
- handoff packet

输出形式：

- 人类可读 markdown
- structuredContent，方便 agent 继续消费
- 可粘贴到 PR comment、release note、handoff 或审计记录

结构化输出建议：

```json
{
  "subject": {
    "repo": "owner/repo",
    "pullNumber": 42
  },
  "verifiedEvidence": [
    "CI checks passed",
    "No high security alerts found"
  ],
  "missingEvidence": [
    "No linked issue found"
  ],
  "warnings": [
    "Branch protection could not be verified"
  ],
  "recommendedNextActions": [
    "Request human review before merge"
  ]
}
```

验收标准：

- 支持按 PR、issue 或 release ref 生成证据包
- 清楚区分 verified evidence、warnings、missing evidence
- 不输出 token、cookie、私钥等敏感信息
- 对 GitHub API 权限不足的部分给出 degraded mode，而不是整体失败
- markdown 和 structuredContent 信息一致

示例提示词 1：

```text
为 PR #30 生成一份 SDLC evidence packet，方便我贴到 PR 评论里。
```

期望 agent 操作：

- 调用 `sdlc_evidence_packet`
- 可能内部聚合 PR summary、quality gate、review findings

期望返回：

- PR 基本信息
- 已验证证据
- 缺失证据
- 风险
- 下一步人工动作

示例提示词 2：

```text
为 issue #12 当前工作生成交接证据包，下一个 agent 要能继续做。
```

期望 agent 操作：

- 调用 `sdlc_evidence_packet` 或 `agent_handoff_packet`
- 汇总 issue、计划、已完成和未完成项

期望返回：

- 当前状态
- 已完成动作
- 未完成动作
- 推荐下一次工具调用
- 风险和阻塞项

示例提示词 3：

```text
发布前生成 evidence packet，告诉我哪些证据已经 verified，哪些还缺。
```

期望 agent 操作：

- 调用 `release_readiness_check`
- 调用或生成 `sdlc_evidence_packet`

期望返回：

- CI 和安全信号
- changelog / rollback 状态
- blocking issue / label
- 是否需要人工 release approval

#### 2. 增强 `agent_handoff_packet`

让 handoff 不只是模板，而是真正的 agent continuation packet。下一个 agent 应该能根据它知道目标、边界、已完成内容、剩余任务、失败检查和风险。

建议新增字段：

- 当前目标和非目标
- 已完成动作
- 未完成动作
- 最近失败的检查
- 下一步推荐工具调用
- 风险和阻塞项
- 不应执行的高风险动作
- 相关 issue / PR / commit / branch
- 最近 decisions 和 rationale

验收标准：

- 新 agent 可以直接根据 handoff packet 接续工作
- 包含足够上下文，但不复制过长 diff 或日志
- 对缺失信息明确标注 unknown
- 不包含 token、cookie、私钥等敏感信息
- 对未验证信息标注 unverified

示例提示词 1：

```text
我要结束这轮工作，请生成 handoff packet，让下一个 AI coding agent 接着处理 PR #32。
```

期望 agent 操作：

- 调用 `agent_handoff_packet`
- 包含 PR、当前状态、下一步

期望返回：

- 可复制给下一个 agent 的 prompt
- 当前 PR 状态
- 最近 checks
- 剩余任务
- 风险

示例提示词 2：

```text
根据 issue #18 生成交接包，但不要假设还没有验证过的事情已经通过。
```

期望 agent 操作：

- 调用 `agent_handoff_packet`
- 把 unknown / unverified 分开写

期望返回：

- verified work
- unverified assumptions
- missing checks
- next actions

示例提示词 3：

```text
我想让另一个 agent 继续做 release readiness，请生成最小但完整的上下文。
```

期望 agent 操作：

- 调用 `agent_handoff_packet`
- 结合 release readiness 状态

期望返回：

- release target
- 已检查项
- 未检查项
- rollback/changelog 状态
- 人工审批提醒

## 非目标

以下能力不作为近期路线重点：

- 自动合并 PR
- 强制 push
- 删除分支或删除保护规则
- 绕过 required reviews
- 在 MCP server 内执行任意仓库代码修改
- 保存或输出用户密钥、token、cookie、私有证书
- 为单一 AI coding 客户端做专用流程或专属测试矩阵

如果未来需要更主动的执行能力，也应保持最小权限、dry-run 优先、人类确认和完整审计记录。

## 建议优先级

| 优先级 | 方向 | 原因 | 状态 |
|---|---|---|---|
| P0 | 通用 Agent 冒烟测试文档 | 让任何 MCP 客户端都能快速验证 server 可用 | ✅ v1.4.0 |
| P0 | `repo_context` 增强 | 所有后续计划和审查都依赖上下文质量 | ✅ v1.4.0 |
| P1 | `plan_from_context` 支持 `workType` | 解决模板化计划不贴合任务的问题 | ✅ v1.4.0 |
| P1 | `issueDrafts` 与 `create_issue_set` 打通 | 形成 Plan -> Issue 的闭环 | ✅ v1.5.0 |
| P2 | 合并门禁增强 | 从 CI 查询升级为工程治理判断 | ✅ v1.6.0 |
| P2 | `.agentic-sdlc.yml` | 支持不同仓库的策略差异 | 待开始 |
| P3 | `sdlc_evidence_packet` | 形成产品级差异化和审计闭环 | 待开始 |

## 成功指标

短期成功指标：

- [x] 任意 MCP 客户端中的 AI coding agent 能在 5 分钟内完成 MCP 配置验证（`docs/ai-coding-agent-smoke-test.md`，v1.4.0）
- [x] `repo_context` 能返回足够 agent 开工的上下文，不需要用户手动补充 README/package/scripts（v1.4.0）
- [x] docs-only、feature、bugfix、security、release、infra 任务能生成明显不同的计划（`plan_from_context` workType，v1.4.0）
- [x] dry-run issue 预览能让人类判断是否允许真实创建，并显示目标仓库、标签、body 摘要与 warning（`create_issue_set`，v1.5.0）

中期成功指标：

- [x] `plan_from_context` 输出可直接 dry-run 创建 issue（v1.5.0）
- [x] PR 门禁结果能解释为什么通过、失败、等待、缺审查或存在策略缺口（v1.6.0）
- [x] security/release 类任务能自动生成更严格的审查项（v1.6.0）
- 仓库策略能稳定影响计划、审查和 release readiness

长期成功指标：

- 一个 PR 或 release 可以生成完整 evidence packet
- 人类 reviewer 可以直接根据 evidence packet 判断 agent 工作是否可信
- 下一个 agent 可以根据 handoff packet 无缝接续工作
- 项目形成清晰定位：AI coding agent 的 SDLC governance layer，而不是普通 GitHub MCP wrapper
