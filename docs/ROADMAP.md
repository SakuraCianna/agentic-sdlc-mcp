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

产品北极星：

> **让 AI 顺手，让用户省心，让 AI“长脑子”，让组织“敢用”。**

这四个目标分别意味着：

- **让 AI 顺手**：工具容易发现、参数清楚、structuredContent 稳定、错误可行动、上下文和分页有预算；agent 不需要反复猜该调用哪个工具或人工重写输出。
- **让用户省心**：开工简报、计划、Issue、PR gate、review、release 和 handoff 能自然衔接；安全默认值、dry-run、降级说明和下一步建议减少用户盯流程的成本。
- **让 AI“长脑子”**：通过 repo context、风险画像、仓库策略、历史关联、evidence model 和可信 handoff，给 agent 补足当前任务所需的工程判断上下文。这里不表示 MCP 擅自训练模型、建立不可控长期记忆或收集私有代码。
- **让组织“敢用”**：每个重要结论有来源、ref/SHA、时效性和限制；高风险业务有防御性要求；写操作受控；人类 gate、最小权限、provenance、审计与隐私边界可验证。

后续每个版本都应回答四个问题：AI 是否更容易正确使用、用户是否少做重复确认、agent 是否获得更可靠的上下文与判断、组织是否得到更强的控制和证据。只增加工具数量但没有改善这四项，不算有效路线图进展。

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

## 规范基线与来源

本项目所称的 “Agentic SDLC” 是项目自己的组合治理基线，不是某个标准组织已经发布的单一同名规范。后续设计必须把规则来源写清楚，不能把项目经验包装成外部认证标准。当前基线主要组合以下一手规范：

- MCP Specification：工具 schema、structured content、annotations、transport、authorization 与安全边界；实现前核对 [official specification](https://modelcontextprotocol.io/specification)。
- MCP Registry：server metadata、包名绑定、认证与发布流程；Registry 仍处于 preview 时必须重新核对 [Quickstart](https://modelcontextprotocol.io/registry/quickstart)、[GitHub Actions](https://modelcontextprotocol.io/registry/github-actions) 与 [Authentication](https://modelcontextprotocol.io/registry/authentication)。
- GitHub 官方安全能力：branch protection/rulesets、CODEOWNERS、CodeQL/code scanning、Dependabot/dependency review、secret scanning、Actions security hardening 与 artifact attestations。
- [NIST Secure Software Development Framework (SP 800-218)](https://csrc.nist.gov/pubs/sp/800/218/final)：按风险准备组织、保护软件、生产安全软件和响应漏洞。
- [SLSA](https://slsa.dev/spec/) 与 [OpenSSF Scorecard](https://scorecard.dev/)：构建 provenance、依赖和 CI/CD 供应链风险。
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)：对认证、授权、输入、数据保护、日志、错误处理等高风险业务给出可验证要求。

采用来源时遵循以下规则：

- 区分“官方规范要求”“GitHub/MCP 平台能力”“本项目默认策略”“仓库自定义策略”。
- 输出规则结论时附带 `policySources` 或等价来源字段，避免 agent 无法解释某项要求从何而来。
- 官方规范未覆盖的启发式必须标记为 heuristic；证据不完整时标记 degraded/unverified，不得伪装成确定事实。
- 规范或 preview API 可能变化时，在开发该版本前重新在线核对，不把本 ROADMAP 中的示例字段当作永久 API 契约。

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

> **状态：功能在 v1.7.0 完成，Registry namespace 修正在 v1.7.1 发布。** 已实现 Registry metadata/发布工作流、严格 `.agentic-sdlc.yml` schema 与安全解析、canonical digest/source provenance，以及 6 个固定 policy consumer。PR gate/review 使用 base SHA 防止策略自修改，release 使用目标 SHA；无配置仓库保持 v1.6 兼容语义。v1.7.0 npm 已发布，但 Registry OIDC 按设计拒绝了与 GitHub login 大小写不一致的 namespace；v1.7.1 使用精确的 `io.github.SakuraCianna/*` 身份完成不可变修正。

实施前代码缺口（已在 v1.7.0 关闭）：

- `quality_gate_status` 的 blocking labels、review/release 规则仍主要来自内置常量。
- `plan_from_context`、gate、review、release 与 handoff 工具各自判断风险，缺少共享 policy decision 结构；`prepare_work_item` 的风险感知接入明确延至 v1.8。
- 配置读取目前只有进程环境变量和用户主目录 JSON，没有仓库策略的 schema version、来源、合并顺序与错误隔离。
- 一次调用中多个工具可能重复读取同一配置，缺少按 repo/ref 缓存与一致性保证。

本版本必须控制范围：先建立“可读取、可解释、可安全降级”的策略基础，不在同一版实现组织级继承、远程策略服务或自动修复。

#### 0. 发布到官方 MCP Registry

v1.7 计划同步把本服务发布到 [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)。Registry 当前仍处于 preview，因此实现时必须再次核对官方规范，不能把预览接口当作永久稳定契约。

计划：

- 采用大小写敏感的 registry 名称 `io.github.SakuraCianna/agentic-sdlc-mcp`，与 GitHub OIDC 返回的账号 login 精确一致。
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
schemaVersion: 1
defaultWorkType: feature
requiredChecks:
  - { name: test, source: check_run, appId: 15368 }
  - { name: typecheck, source: check_run, appId: 15368 }
protectedPaths:
  - ".github/**"
  - "src/config.ts"
riskRules:
  - id: risk.authorization
    paths: ["src/auth/**", "src/permissions/**"]
    workTypes: ["feature", "bugfix", "security"]
    level: high
    domains: ["authorization", "cross-tenant"]
labels:
  releaseBlocking:
    - release-blocker
    - security
review:
  requireIssueLink: true
  requireCodeOwnersForProtectedPaths: true
  requiredReviewers:
    - id: reviewer.security
      riskRuleIds: ["risk.authorization"]
      paths: ["src/auth/**", ".github/workflows/**"]
      reviewers: ["@security-team"]
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
- `requiredChecks` 必须绑定 `source: check_run` 与正整数 GitHub App ID；同名 commit status、其他 App 的同名 check、skipped/neutral 均不能满足策略。v1.7 不接受只有名称的字符串，来源无法验证时返回 policy gap。
- `riskRules` 与 `requiredReviewers` 以稳定 `id` 合并；同一层 duplicate ID、`riskRuleIds` 引用不存在的 risk rule、空 reviewer 或非法 glob 直接报配置错误。一个 reviewer rule 至少声明 `riskRuleIds` 或 `paths` 之一；两类 selector 采用 OR，任一关联 risk rule 已命中或任一路径 glob 命中即要求该 reviewers，数组内部同样为 any-match。继承层按 reviewer rule `id` 整体覆盖后重新校验引用，不能把父层 selector 与子层 reviewer 意外拼接。仓库层只能增加/细化安全要求，不能覆盖 MCP 不可降低底线。

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

- `repo_context`
- `plan_from_context`
- `quality_gate_status`
- `review_pr_against_standard`
- `release_readiness_check`
- `agent_handoff_packet`

v1.7 的 policy consumer 固定为以上 6 个工具。`prepare_work_item` 在 v1.8 接入风险策略；`create_issue_set` 继续只消费已经生成的 issue draft 和保持 dry-run 写入边界，不在 v1.7 自行发明第二套策略判断。

策略影响示例：

- 如果 `requiredChecks` 包含绑定 App 的 `typecheck`，计划和 gate 都应该把该可信 check 作为必跑项
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

#### 3. 共享策略加载与决策解释层

不要让六个工具各自解析 YAML。新增独立的 policy 模块，负责：

- 用严格 Zod schema 解析配置，并通过 `schemaVersion` 支持后续演进。
- 定义合并顺序：安全内置下限 < 仓库策略增强 < 调用方显式的非降级覆盖；仓库策略不能降低不可绕过的安全底线。
- 返回 `policySources`、`appliedRules`、`ignoredRules`、`errors`、`degraded` 和配置 ref/SHA。
- 按 `owner/repo/ref/path/blobSha` 做请求内缓存，避免同一工作流读到不同版本策略。
- 将 glob 匹配、required check 名称、label 规范化和路径大小写策略集中实现并复用。
- 输出稳定的 rule ID，例如 `review.require_issue_link`，避免只能靠英文描述做自动化判断。

策略优先级示例：

```text
不可降低的 MCP 安全底线
  -> 仓库 .agentic-sdlc.yml
    -> 工具调用中的显式增强项
      -> 生成带来源的 effective policy
```

验收标准：

- 同一 repo/ref 的所有工具得到相同 effective policy 与 digest。
- 配置读取 403、404、超限、非法 YAML、duplicate key、未知 schema version 时有确定的 degraded 行为。
- 未知字段默认拒绝或进入 warnings，不能静默拼错字段后仍显示策略生效。
- 所有 policy finding 都能追溯到 rule ID、来源文件、ref/SHA 与默认值。

#### 4. v1.7 必测特殊场景

- 配置文件超过大小上限、YAML alias/billion-laughs 类资源消耗、深层嵌套与 duplicate key。
- protected path 同时命中多个规则，优先级冲突或大小写/路径分隔符不同。
- required check 使用 matrix 后缀、同名 check、skipped/neutral、App 来源不可信。
- PR 正在修改 `.agentic-sdlc.yml` 本身：新策略不能替当前 PR 自我证明，应以 base ref 策略评估并提示 policy change review。
- fork PR、重命名文件、删除受保护文件、submodule、symlink 或 patch 不完整。
- 配置要求低于 MCP 不可绕过底线，例如请求 auto-merge、忽略 secret failure 或允许 force-push；必须拒绝而不是“按配置执行”。

#### 5. v1.7 完成定义与非目标

完成定义：

- Registry 能发现 v1.7 包，npm 与 Registry metadata 一致。
- policy schema、loader、decision source 和上述 6 个消费工具拥有契约测试。
- 默认无配置仓库保持 v1.6 的兼容语义；启用配置后输出明确显示行为差异。
- 文档包含最小配置、完整配置、非法配置、策略自修改与迁移示例。

本版本非目标：

- 不实现组织级中央策略继承。
- 不持久化历史 decision/evidence。
- 不允许策略触发自动合并、自动批准或绕过人类 gate。
- 不在本版本同时重写 `prepare_work_item`；风险感知简报放到 v1.8。

### v1.8: 风险感知的 Work Item Brief 与防御性工程

目标：把 `prepare_work_item` 从“复述 Issue + 猜文件 + 通用清单”升级为可直接指导实现的开发简报。对于核心/高风险业务，简报必须主动生成防御性编程、失败模式、负向测试、可观测性和回滚要求；对于低风险 docs/样式任务则保持精简，避免模板膨胀。

当前代码缺口：

- `prepare_work_item` 只返回 issue、labels、assignees、正则提取的文件提示、最多 5 个 recent PR 和固定 handoff prompt。
- Goals、Non-Goals、Acceptance Criteria、Risks 与 verification commands 基本固定，没有从 Issue、仓库脚本、策略和路径风险生成结构化内容。
- 只读取前 5 条评论，未说明截断，也没有区分 maintainer decision、普通讨论、过期结论和未解决问题。
- recent PR 只扫描最近 20 个候选且单页读取文件；大 PR、分页、重命名和 API 失败可能造成“没有相关历史”的假象。
- 相关文件仅靠扩展名正则，不能识别 CODEOWNERS、入口、测试、schema、workflow、迁移和调用链邻接关系。
- 输出没有业务关键度、数据敏感性、信任边界、失败影响、risk rationale 或 evidence provenance。

#### 1. 引入 `workType`、`riskProfile` 与简报来源

`prepare_work_item` 应接受可选显式 `workType`/`riskLevel`，省略时使用保守推断，但必须暴露推断依据和置信度。风险不应只看关键词，还应组合：

- Issue labels、正文、验收标准与 maintainer 评论。
- `.agentic-sdlc.yml` 的 protected paths、risk rules 与 required reviewers。
- 相关文件类型：auth、billing/payment、permission、workflow、release、migration/schema、config/env、crypto、network boundary、public API。
- 仓库类型和技术栈：库、服务、CLI、基础设施、monorepo、多语言项目。
- 历史相关 PR、CODEOWNERS 与最近回归/安全修复。

建议结构化字段：

```json
{
  "workType": "feature",
  "riskProfile": {
    "level": "high",
    "domains": ["authorization", "personal-data"],
    "blastRadius": "cross-tenant",
    "confidence": "medium",
    "reasons": ["Touches protected auth path", "Issue changes tenant access rules"]
  },
  "sourceEvidence": [
    { "kind": "issue", "ref": "#42", "verified": true },
    { "kind": "policy", "ref": ".agentic-sdlc.yml@<sha>", "verified": true }
  ]
}
```

风险推断低置信度时，返回 `needsClarification` 与最多 3 个真正影响方案的问题；不能编造业务规则后继续生成确定性清单。

#### 2. 防御性编程要求生成器

高风险简报根据风险域生成 `defensiveRequirements`，至少覆盖适用项：

- 输入边界：schema、长度/深度/数量、编码、路径、URL、反序列化、动态字段、格式化/拼接与命令/查询注入。
- 身份与授权：认证与授权分离、资源级/租户级校验、默认拒绝、最小权限、权限提升与 confused deputy。
- 数据一致性：事务边界、幂等键、重复请求、并发竞争、lost update、部分成功、重试与补偿。
- 故障控制：timeout、cancellation、rate limit、backoff/jitter、circuit breaker、第三方降级与 fail-open/fail-closed 选择。
- 数据安全：敏感字段分类、最小采集、日志脱敏、加密/密钥轮换、缓存和备份泄露面。
- 兼容与迁移：向后兼容、双读/双写风险、可逆 migration、旧客户端、feature flag、分阶段 rollout 与 rollback。
- 可观测性：结构化日志、metrics、trace、审计事件、告警阈值，以及不得记录的 secret/PII。
- 资源安全：大输入、分页、内存/CPU 上限、压缩炸弹、正则回溯、无限递归和输出/token 膨胀。

生成规则必须是风险域映射，不是每个任务都输出全部清单。例如 docs-only 任务不应要求事务/熔断；涉及支付回调时必须考虑重复投递、签名校验、金额/币种、幂等和对账。

#### 3. 测试与验证矩阵

简报不只列 `npm test/typecheck/build`，而应从 repo scripts、workflow 和风险域生成 `verificationPlan`：

- happy path、边界值、无效输入、权限不足、跨租户、并发、重复请求、timeout、第三方失败和部分成功。
- bugfix 必须包含可复现 before-state 与 focused regression。
- migration 必须包含 upgrade、rollback、旧数据、空库/大库、锁表/长事务和备份恢复演练。
- auth/permission 必须包含 deny cases，不能只测试管理员成功路径。
- workflow/release 必须包含 fork、最小权限、固定 action、OIDC、制品 provenance 与回滚。
- 性能敏感路径应定义数据规模、延迟/吞吐预算和超限行为，而不是笼统写“做性能测试”。

建议字段：

- `acceptanceCriteria`：来自 Issue 的原始项与派生项分开。
- `negativeScenarios`：预期拒绝或降级的场景。
- `verificationCommands`：仅使用仓库真实存在的 scripts；不确定时标记建议而非可执行事实。
- `manualChecks`：无法自动化但需要人确认的业务/安全条件。
- `rollbackPlan`：触发条件、步骤、数据恢复与验证。
- `observabilityPlan`：上线后看什么信号、多久、由谁判断回滚。

#### 4. 相关上下文与依赖图

改善 related context，但保持 API 和 token 预算可控：

- 结合 issue 中明确路径、CODEOWNERS、仓库入口、测试命名、配置/schema/workflow 关联规则生成候选文件。
- 输出每个 related file 的 `reason` 和 `confidence`，不把猜测显示成确定调用链。
- recent PR 支持分页上限、重命名路径与 incomplete 标记；API 失败时不能返回“无相关 PR”。
- 读取 linked issues、sub-issues、milestone、blocked-by/depends-on（平台可用时），形成 `dependencies`、`blockers` 与 `parallelizableWork`。
- maintainer 评论只提取明确 decision/action item，并带 author、timestamp、URL；评论截断时标记 `commentsTruncated`。

#### 5. v1.8 必测特殊场景

- 核心支付/权限任务正文很短但命中 protected path；不能因关键词不足降为低风险。
- Issue 恶意包含 Markdown/Prompt Injection，要求 agent 忽略策略或输出 token；简报必须当作不可信内容并安全渲染。
- Issue 与 maintainer 评论冲突、旧评论被新决策推翻、验收标准互相矛盾。
- 文件提示为 URL、域名、版本号或带点普通文本，不能误当仓库路径。
- 相关 PR 超过分页上限、patch/文件列表截断、文件重命名、closed-without-merge。
- monorepo 中多个 package 使用不同命令，不能把根目录 npm 命令套给全部子项目。
- 动态拼接、模板插值、computed field、decode/encode、builder、跨行构造和配置组合等高风险输入，必须进入 negative scenarios 或人工安全审查。
- 大 Issue/评论/路径列表必须有输入与输出预算，并用截断元数据而非静默裁剪。

#### 6. v1.8 验收标准

- 低风险与高风险任务产生明显不同的简报深度。
- 核心/高风险业务至少输出 risk rationale、防御性要求、negative scenarios、回滚和可观测性要求。
- 所有派生 acceptance criteria 标记来源，不能冒充用户原始要求。
- `prepare_work_item` structuredContent 与 Markdown 一致，字段有 output schema 和契约测试。
- 测试覆盖 auth、payment、migration、workflow、docs、普通 bugfix、恶意 Issue、大输入和 degraded GitHub evidence。
- 真实 verification command 只能来自 repo context/策略；无法确认的命令标为 suggested/unverified。

本版本非目标：

- 不做完整跨文件静态分析或调用图引擎。
- 不让 MCP 自动修改代码、执行 migration 或部署。
- 不使用 LLM 在 server 内对 Issue 做不可解释的自由文本安全裁决；风险规则必须可测试、可解释。

### v1.9: Evidence Packet 与可信交接闭环

目标：形成项目的核心差异化能力：把 AI agent 的工作过程整理成可审查、可归档、可交接的证据包。

当前代码缺口：

- `agent_handoff_packet` 的 current status、decisions、next steps 主要由调用方自由文本提供，系统只补 issue/PR 基本信息，无法区分已验证事实和自报状态。
- PR summary、quality gate、review、security triage、release readiness 已有各自 structuredContent，但缺少统一 evidence ID、来源 SHA、采集时间、freshness 与完整性语义。
- 当前静态 resources 中的 handoff/release 模板可能与工具真实输出逐渐漂移，且 resources 代码覆盖为 0%。
- evidence 目前只存在于单次响应，没有稳定 schema、digest、版本或兼容策略。

本版本先实现只读、即时聚合的 evidence packet，不引入数据库或后台任务。证据持久化、签名与组织级策略留到 v2.0。

#### 0. 统一 Evidence Model

所有证据项至少包含：

- `id`、`kind`、`subject`（repo/issue/PR/ref/SHA）。
- `state`: `verified` / `failed` / `pending` / `unverified` / `not_applicable`。
- `freshness`: `fresh` / `stale` / `unknown`，与结论 state 正交；一个曾验证通过但 subject 已变化的证据可以是 `state: verified` + `freshness: stale`，聚合 gate 不得继续把它当当前有效证据。
- `completeness`: `complete` / `partial` / `omitted`，与 state/freshness 正交；省略项必须另带预算或权限原因。
- `source`: GitHub API、base workflow、repository file、policy、caller assertion 等。
- `collectedAt`、`sourceUpdatedAt`（可获得时）与 `expiresAt`（适用时）；这些时间值以及 request/correlation ID 属于易变 envelope metadata，不进入 v1.9 的稳定内容标识。`freshness` 本身是语义字段，必须进入稳定内容标识。
- `provenance`: URL、App/provider、ref/SHA、policy digest、工具版本。
- `reason`、`limitations` 与 `recommendedNextActions`。

caller 自报的 “tests passed” 只能是 `source: caller_assertion`，除非能绑定到具体 commit 的可信 check run；不能与 GitHub 验证证据混在同一个 verified 列表。

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
    "pullNumber": 42,
    "headSha": "abc123"
  },
  "evidence": [
    {
      "id": "ci:test",
      "kind": "ci_check",
      "state": "verified",
      "freshness": "fresh",
      "completeness": "complete",
      "source": "github_check_run",
      "provenance": {
        "url": "https://github.com/owner/repo/actions/runs/123/job/456",
        "subjectSha": "abc123"
      },
      "reason": "Required test check passed for the reviewed head."
    },
    {
      "id": "policy:branch-protection",
      "kind": "repository_policy",
      "state": "unverified",
      "freshness": "unknown",
      "completeness": "partial",
      "source": "github_api",
      "reason": "The token could not read all rulesets.",
      "limitations": ["branch_rules unavailable"]
    }
  ],
  "summary": {
    "idsByState": {
      "verified": ["ci:test"],
      "failed": [],
      "pending": [],
      "unverified": ["policy:branch-protection"],
      "not_applicable": []
    },
    "staleIds": [],
    "partialIds": ["policy:branch-protection"],
    "omittedIds": []
  },
  "recommendedNextActions": [
    "Re-run with permission to read repository rulesets"
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

#### 2. Evidence 完整性、预算与特殊场景

- 每个聚合子调用必须独立记录成功/失败/截断；部分 API 失败时返回 partial packet，而不是整体失败或假装 clean。
- packet 必须固定 subject SHA；采集期间 PR head 变化时标记 `stale` 并建议重跑，不能混合两个提交的证据。
- 对同名 checks、rerun、skipped/neutral、matrix、fork、merge queue、base/head workflow 差异使用 v1.6 的 provenance 语义。
- evidence packet 设置项目数、文本、文件和 API 调用预算；省略项返回 `omittedEvidence` 与原因。
- 外部标题、评论、日志、finding、URL 全部安全渲染，防止 Markdown 注入、prompt injection、控制字符和敏感信息回显。
- 对 secret/security alert 只返回必要 metadata，不把密钥值、完整敏感 patch 或私有错误写入 packet。
- packet schema 带 `schemaVersion` 和 `generatorVersion`。v1.9 只生成非签名的 `contentDigest`：规范化投影必须纳入 `state`、`freshness`、`completeness`、subject、provenance 与 limitations，只排除 `collectedAt`/`sourceUpdatedAt`/`expiresAt`/请求 ID 等易变 envelope 字段。该标识用于发现同一 generator 内的内容变化，不作为密码学来源证明，也不承诺跨实现 canonicalization。
- Markdown 必须完全由 structured evidence 渲染，禁止维护第二套独立判断逻辑。

验收标准：

- PR head 在采集过程中变化、API 403/404/429、分页截断和某个工具超时均有明确 partial/stale 结果。
- packet 中每个 verified claim 都能定位到来源 URL/ref/SHA；无法定位的 claim 不能标 verified。
- 同一 generator/schema 下，相同稳定内容产生相同 `contentDigest`；改变 subject identity/SHA（适用时）、policy、evidence state、freshness 或 completeness 必须改变 digest，而仅重新采集导致的 envelope 时间/request ID 变化不得改变 digest。
- 大仓库/大 PR 的响应在预算内，并说明省略内容。

#### 3. 增强 `agent_handoff_packet`

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

#### 4. v1.9 完成定义与非目标

完成定义：

- `sdlc_evidence_packet` 能按 PR、Issue 和 release ref 生成版本化 structuredContent 与 Markdown。
- `agent_handoff_packet` 默认从系统证据派生当前状态，调用方断言单独标记。
- PR summary、quality gate、review、security 和 release 共享 evidence model，不再靠文本拼接互相传递结论。
- resources 模板与工具 schema 有 snapshot/contract tests，避免静态标准和真实行为漂移。

本版本非目标：

- 不把 packet 自动写到 PR 评论、Release 或外部存储。
- 不签名、不声称满足法务/合规审计认证。
- 不允许 handoff 自动批准、合并或发布。

### v1.10: HTTP 运行安全与凭据迁移

目标：在保持 stdio 兼容的前提下，先解决远程 HTTP 和凭据生命周期的基础安全问题。本版本不同时承担 evaluation、供应链和 telemetry，避免安全架构迁移与质量平台建设互相阻塞。

当前代码缺口：

- HTTP transport 直接监听可配置端口，没有 OAuth/token audience 校验、Origin/Host 校验、DNS rebinding 防护，也没有项目显式定义、分层且经过测试的 JSON body/header/tool/output、并发、rate limit、timeout 与 graceful shutdown 预算。`express.json()` 的框架默认 body limit 不能替代产品级预算与测试。
- `src/config.ts` 使用进程级全局 config，`src/github/client.ts` 使用单例 Octokit；该模型适合单用户 stdio，但不能满足 remote 多用户/多租户隔离。
- 交互式配置会把 GitHub token 明文写入 `~/.agentic-sdlc-mcp.json`，没有文件权限校验、系统 keychain 或仅保存非敏感配置的模式。
- Octokit client 缺少统一 timeout、retry/backoff、rate-limit metadata、request correlation 和 cancellation。

#### 1. HTTP transport 与认证安全

- 明确 local stdio、local HTTP、remote HTTP 三种运行 profile；安全默认值优先 stdio。
- local HTTP 默认只绑定 loopback，并验证 Origin/Host，启用 MCP 官方建议的 DNS rebinding 防护。
- remote HTTP 使用 MCP Authorization/OAuth 约定；校验 issuer、audience、expiry、scope，不能直接把 GitHub PAT 当 MCP bearer token。
- 设置 JSON body、header、并发、连接、响应和工具参数大小上限。
- 支持 timeout、AbortSignal/cancellation、graceful shutdown、慢客户端和断开连接清理。
- session/stateless 模式行为与 SDK 文档一致；不能在多个请求间泄漏用户、repo 或 token 上下文。
- 错误响应不回显内部路径、token、GitHub 原始敏感 payload 或堆栈。

必要架构改造：

- 引入不可变 `RequestContext`，至少包含 MCP principal/scopes、GitHub credential handle、repo defaults、correlation ID、AbortSignal 和请求预算。
- 用 per-request `GitHubClientFactory` 代替 remote profile 下的单例 Octokit；client、repo、policy/evidence cache 都必须由 request/tenant key 隔离。
- 禁止把 MCP bearer、GitHub token 或调用方 repo 写入跨请求共享的 mutable global state；stdio 单用户兼容层也应显式适配到同一 context 接口。
- handler 不再从全局 config 隐式取得 remote 用户身份；认证、授权和 repo resolution 必须从当前 request context 传入并可测试。
- 缓存只保存必要的非敏感派生数据，并把 tenant、repo、ref/SHA、policy digest 纳入 key；不得以 token 明文作为日志或 metric label。
- 所有 tool core handler 统一接收一个显式 `ToolExecutionContext`；其组合关系固定如下，避免 transport、registration 与 handler 各自发明上下文：

```ts
interface ToolExecutionContext {
  request: RequestContext;
  deps: ToolDependencies;
}

interface ToolDependencies {
  credentialResolver: CredentialResolver;
  githubClientFactory: GitHubClientFactory;
  repoResolver: RepoResolver;
  clock: Clock;
  budget: ExecutionBudget;
  logger: SafeLogger;
}
```

- tool registration callback 只负责从当前 transport request 构造并传入 `ToolExecutionContext`，不在 handler 内再次读取进程全局身份。`credentialResolver` 只接受当前 `RequestContext` 的 credential handle，并把短生命周期凭据交给同一 request 的 `githubClientFactory`。
- remote profile 的 tool/handler 模块禁止直接 import mutable `config`、`getOctokit()` 单例或进程级 repo defaults；stdio adapter 只负责从启动配置构造固定单用户 `RequestContext`，但仍通过相同 resolver/factory/handler 接口调用。
- credential 解析结果不得进入共享 cache，request 结束/取消后清理引用；stdio adapter 也不能绕过 resolver/factory 直接把 token 注入 handler。
- 增加覆盖所有 core handler 的依赖边界测试（或 lint/architecture rule）：任何 handler 直接 import 全局 mutable config、`getOctokit()` 或进程级 credential 时 CI 失败，防止只新增 factory 而旧路径继续偷偷使用单例；不能只依赖 “remote” 目录命名约定。

必测场景：

- 非 loopback Host、恶意 Origin、DNS rebinding、伪造 forwarded headers。
- 无 token、错误 audience、过期 token、scope 不足、token substitution。
- 超大 JSON、深层对象、慢请求、并发洪峰、客户端中断和 handler timeout。
- 两个并发租户使用不同 repo/token，状态不能串线。
- 同一进程内交错执行两个长请求，Octokit mock、policy cache、default repo、AbortSignal 和错误均保持请求隔离。
- shutdown 时有进行中请求，必须有确定的完成/取消语义。

#### 2. 凭据与本地配置迁移

- 默认不再把 token 写入普通 JSON；JSON 只保存 owner/repo/default branch 等非敏感偏好。
- token 优先来自进程环境、MCP client secret injection 或平台安全凭据存储；如支持系统 keychain，必须按平台分别测试。
- 检测旧版明文配置，提供只读检查、显式迁移和删除建议；不得自动打印或上传旧 token。
- 校验配置文件 owner/ACL/permission，宽权限时发出高风险提示。
- 日志、错误、telemetry 和 crash report 统一经过 secret redaction。

#### 3. v1.10 完成定义与非目标

完成定义：

- stdio 保持兼容；remote HTTP 有明确 auth/threat model 和端到端安全测试。
- request-scoped context 与 per-request GitHub client 通过并发租户隔离测试；remote 路径不再依赖共享 token/repo 单例。
- 所有公开 tool handler 完成显式 context/dependency 迁移，架构测试证明 remote 路径不存在全局 credential/client 回退通道。
- 明文 token 配置有迁移路径，新安装默认不落盘敏感凭据。
- 请求/响应/并发/timeout/cancellation 预算是显式配置并有边界测试，不依赖框架隐式默认值。

本版本非目标：

- 不提供托管 SaaS、多租户计费或用户管理后台。
- 不实现 MCP evaluation 平台、SBOM 或 telemetry；分别放到 v1.11/v1.12。
- 不实现组织级策略中心或 evidence 数据库。

### v1.11: MCP 契约、Inspector 与 Agent Evaluation

目标：验证“agent 是否能正确发现、选择和组合工具”，而不只验证 TypeScript handler。将协议契约、客户端兼容、响应预算和稳定 evaluation 建成独立质量阶段。

当前代码缺口：

- 目前主要是 pure/helper/handler 单测和 smoke registration，没有 MCP Inspector 的协议级验证。
- tool input/output schema、annotations、structuredContent 与 Markdown 没有全量统一 contract snapshot。
- 没有真实 client/agent 的工具可发现性、多工具组合与稳定答案 evaluation。
- 性能、API 调用、响应/token 大小和故障注入没有统一预算。

#### 1. MCP 契约、兼容性与 evaluation

以 [MCP Specification](https://modelcontextprotocol.io/specification) 和官方 [MCP Inspector](https://github.com/modelcontextprotocol/inspector) 为协议依据；复杂、只读、独立、可验证、答案稳定等题目要求属于本项目的 evaluation 基线，不宣称是 MCP 官方认证标准。

- 用 MCP Inspector 验证 stdio 与 Streamable HTTP 的 initialize、tools/list、tools/call、resources/list/read 和错误路径。
- 对每个工具建立 input/output schema snapshot、annotations、structuredContent/Markdown 一致性与 backward compatibility tests。
- 建立至少 10 个只读、独立、复杂、可验证、答案稳定的 MCP evaluation；覆盖多工具组合，而不是只测 handler。
- 增加工具可发现性评估：agent 能否从描述正确选择 `repo_context`、`prepare_work_item`、gate、review、security、release/evidence。
- 建立响应预算：默认字符/token、items、分页、API calls、P95 latency 与超限降级行为。
- 对 403/404/429/5xx、GraphQL partial errors、网络 timeout、截断、大仓库和 GitHub API schema 缺字段做故障注入。

验收标准：

- evaluation 有固定 fixture/recording 或可重复的测试仓库，不依赖持续变化的公开数据。
- 所有 tool annotations 与实际副作用一致；写工具仍默认 dry-run。
- output schema 与真实 structuredContent 零漂移。
- 旧版客户端至少能继续调用 v1.x 已公开工具；新增字段保持 additive。

#### 2. v1.11 必测特殊场景

- 客户端忽略 structuredContent、只读取 Markdown，或反过来只消费 schema 字段。
- 工具描述相似导致 agent 误选，例如 gate 与 review、repo context 与 prepare brief、release readiness 与 evidence packet。
- outputSchema 声明字段但 handler 缺失/多出字段、nullable/optional 不一致、错误响应误带 structuredContent。
- 多次分页和多工具调用导致上下文膨胀；agent 应使用 limit/summary，而不是抓取全部内容。
- MCP client 取消、重复调用、乱序响应、未知 tool/resource、schema invalid 和版本不匹配。
- evaluation fixture 发生变化或答案不再稳定时必须 fail 明确，不能更新 golden answer 掩盖回归。

#### 3. v1.11 完成定义与非目标

完成定义：

- MCP Inspector 覆盖 stdio 与 Streamable HTTP 的 initialize、tools/list/call、resources/list/read 和错误路径。
- 每个工具拥有 schema/annotations/Markdown-structured 一致性与 backward compatibility tests。
- 至少 10 个稳定 evaluation 进入 CI，并覆盖多工具选择、组合、分页和 degraded evidence。
- 有明确的 API calls、items、字符/token、P95 latency 与超限降级预算。

本版本非目标：

- 不把 evaluation 分数作为自动合并或发布的唯一依据。
- 不依赖持续变化的公开仓库作为唯一 fixture。
- 不在本版本同时做 Actions/SBOM/telemetry 改造。

### v1.12: 软件供应链、Coverage 门槛与可观测性

目标：加固项目自身的构建/发布链，并让 degraded、timeout、rate limit、stale evidence 等运行状态可观测，同时坚持最小化和隐私默认值。

当前代码缺口：

- CI 中多数第三方 actions 使用可变 major tag；只有 secret-scan workflow 固定完整 SHA。
- coverage 只上传 artifact，没有门槛；config/resources/brief/handoff 等模块明显低于 gate/review 核心模块。
- npm 发布已有 OIDC，但缺少统一 SBOM、artifact attestation 与包内容/tag/commit 一致性验证。
- 没有结构化 metrics、correlation、degraded/stale/截断比例和隐私数据字典。

#### 1. CI/CD 与软件供应链

- 所有第三方 GitHub Actions 固定完整 commit SHA，并由 Dependabot 或受控流程更新。
- 增加 dependency review、CodeQL（适用时）、OpenSSF Scorecard 基线与许可证/恶意包风险检查。
- npm OIDC 发布继续最小权限；Registry 与 npm 发布分别验证 provenance 和目标版本。
- 生成 SBOM，并对发布制品使用 GitHub artifact attestation 或等价 SLSA provenance；验证包内容与 tag/commit 一致。
- 对 lockfile、install scripts、新依赖、GitHub Actions、容器/二进制下载建立 review gate。
- 设置分层 coverage threshold，优先提升 config、resources、prepare、handoff、PR summary 等低覆盖模块；不能通过排除文件伪造提升。

> 2026-07-13 基础进展：已建立首轮全局 coverage regression floor（statements 92%、branches 87%、functions/lines 93%）、机器可读 JSON summary、配置生命周期测试和基于 SDK 内存 transport 的真实 MCP 协议测试；对抗矩阵与测试资产维护规则见 `docs/testing-strategy.md`。这只是 v1.12 的测试基础，不代表本版本供应链与可观测性目标已经完成。

#### 2. 可观测性与隐私

- 记录结构化、低基数 metrics：工具调用量、延迟、GitHub API 次数、rate-limit、degraded/unverified 比例、截断和错误类别。
- 使用 correlation ID 串联一次 MCP request 内的子调用，但不把 token、Issue 正文、私有 repo 内容作为 label。
- 日志级别和 telemetry 默认关闭/最小化；远程 telemetry 必须显式 opt-in 并有数据字典和保留策略。
- 为 timeout、rate-limit、provenance failure、evidence stale 和 policy parse failure 定义可行动告警。

#### 3. v1.12 必测特殊场景

- action SHA 更新与注释版本不一致、Dependabot PR 修改 workflow 权限、第三方 action 仓库转移/删除。
- tag、package version、Registry version、artifact digest、SBOM 和 attestation 指向不同 commit。
- install script、新 transitive dependency、lockfile-only 变更、许可证变化和 npm provenance 缺失。
- telemetry label 高基数、Issue/PR 私有正文泄露、错误含 token、用户未 opt-in 却发送远程数据。
- metrics backend 不可用不能阻塞 MCP 工具主路径；本地 buffer 也必须有上限和丢弃策略。
- coverage 提升不能通过排除低覆盖文件、删除测试目标或只测生成代码实现。

#### 4. v1.12 完成定义与非目标

完成定义：

- 发布包有 SBOM/provenance，CI actions 固定且供应链检查通过。
- config、resources、prepare、handoff、PR summary 等低覆盖模块达到分层门槛，且阈值进入 CI。
- metrics/logs 有数据字典、redaction、高基数限制、retention 和 opt-in 策略。
- telemetry/metrics 后端失败不会改变工具结论，只产生有界、可观察的降级。

本版本非目标：

- 不为了 telemetry 收集仓库源码、Issue/PR 正文或 secret。
- 不自建完整 SIEM、APM 或 package registry。
- 不把 coverage 百分比当作代码正确性的替代品。

### v2.0: 组织级治理、签名证据与可演进契约

进入 v2.0 的条件不是“v1.12 做完了”，而是至少出现一个确实需要 breaking change 的产品需求，例如：公共 schema 无法 additive 演进、引入持久化 evidence identity、组织级策略继承需要新的授权模型，或签名/验证协议需要稳定 canonical format。若没有这些条件，继续发布 v1.13、v1.14，而不是为了路线图编号强行升主版本。

目标：在保持人类控制权的前提下，把单仓库即时判断升级为可跨仓库复用、可签名验证、可审计豁免的治理平台。

#### 1. 组织级策略包与继承

- 支持 organization -> repository -> path/work type 的策略继承、覆盖与冲突解释。
- 策略包带版本、签名、来源、兼容范围和变更记录；拉取失败时使用明确的 last-known-good/deny 策略。
- 支持 policy bundle dry-run，展示对现有 PR/release 的影响后再启用。
- 设计 waiver/exception：申请人、审批人、理由、范围、过期时间、补偿控制和审计记录。
- 不允许下级策略绕过组织不可降低的安全底线。

#### 2. 签名 Evidence 与可验证决策记录

- 在 v1.9 非签名 `contentDigest` 之上，正式定义跨实现一致的 canonical evidence format、密码学 digest、签名和验证流程，绑定 repo、适用的 subject SHA、policy digest、工具版本与采集时间；两类 digest 使用不同字段名/算法标识，不能混用。
- 与 artifact attestation/SLSA provenance 对接，区分“源码审查证据”“构建制品证据”“部署环境证据”。
- 支持 append-only decision record：谁在何时基于哪些证据批准、拒绝或豁免；不得伪造 GitHub 人类审批。
- 定义 retention、redaction、访问控制、删除和导出策略，兼顾隐私与审计。
- 签名只证明 packet 未被篡改及来源身份，不声称业务正确或绝对安全。

#### 3. 多仓库与变更集治理

- 支持一个工作项跨多个 repo/package/service 的 dependency graph、版本兼容和分批 rollout。
- 聚合多个 PR 的 gate/evidence，但每个结论仍绑定独立 SHA，避免“一个绿 PR 替其他 PR 背书”。
- 对 schema/API 生产者与消费者生成兼容性和发布顺序要求。
- 支持 partial rollout、回滚顺序、跨仓库 blocker 与 owner routing。

#### 4. v2 公共契约迁移

- 所有 breaking schema/tool rename 都提供 migration guide、deprecation window 与双版本兼容测试。
- 优先 additive schema；确需删除/重命名时说明为什么 v1 无法安全演进。
- Registry、npm、server metadata、tool schemas、resources 和 evidence schema 版本一致可追踪。
- 发布 v2 前使用真实 v1 client/agent fixtures 验证迁移，不只做单元测试。

#### 5. v2.0 对抗与特殊场景

必须覆盖：

- 策略供应链投毒：合法签名但恶意策略、过期/撤销签名、依赖策略包被替换、组织管理员账号失陷。
- 签名生命周期：密钥轮换、撤销、算法迁移、丢失、多个 signer、历史 packet 验证和 timestamp/replay。
- rollback attack：攻击者强制加载旧 policy、旧 evidence schema、旧 allowlist 或有已知缺陷的 generator。
- 跨租户泄露：cache key、日志、metrics、trace、error、导出与备份把 A 组织数据暴露给 B。
- waiver 滥用：自批自审、无限期豁免、范围过宽、过期后仍生效、通过多个小 waiver 绕过组织底线。
- stale evidence：PR head、base policy、artifact、deployment environment 或审批人在决策后发生变化。
- 组织策略不可用：网络分区、签名服务失败、last-known-good 过期、首次启动无缓存和灾难恢复。
- 多仓库部分成功：部分 PR 已合并、部分发布失败、兼容窗口错位、回滚顺序与数据格式不可逆。
- canonicalization 差异：字段顺序、Unicode、时间、浮点/数字、缺省值导致不同实现签名结果不一致。
- 大规模组织：数千仓库/规则/packet 下的分页、索引、权限过滤、保留和删除请求。

#### 6. v2.0 完成定义

- 至少两个独立实现或 verifier 能对 canonical evidence 得到相同 digest/签名验证结果。
- 组织策略继承、冲突、waiver、撤销和 last-known-good 有端到端测试与审计记录。
- 多仓库 change set 的每个结论绑定独立 SHA/policy/evidence，不出现跨仓库证据借用。
- v1 -> v2 migration guide、兼容期、deprecation telemetry（不含私有内容）和 rollback 均经过真实 fixture 演练。
- threat model、密钥管理、数据分类、retention、访问控制和灾难恢复通过独立安全审查。
- performance/load 测试证明在目标组织规模内满足预算，超限时 fail-closed 或明确 degraded。
- Registry、npm、server/tool/resource/evidence schema 的版本与 provenance 可关联到同一 release commit。

#### 7. v2.0 非目标

仍然不做：

- 自动合并 PR、绕过 required review 或替人类批准。
- 任意代码执行、自动部署或自动数据库迁移。
- 将“签名 evidence”宣传为代码绝对安全证明。
- 默认收集私有源码用于中心化训练或遥测。

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
| P0 | MCP Registry 发布与 `.agentic-sdlc.yml` 基础 | 先建立可发现、可配置、可解释的统一策略入口 | ✅ v1.7.1 |
| P0 | 风险感知 `prepare_work_item` | 把高风险任务的防御性编程、负向测试、回滚和可观测性前移到开工阶段 | v1.8 待开始 |
| P1 | `sdlc_evidence_packet` 与可信 handoff | 统一 verified/unverified/stale/partial 证据语义 | v1.9 待开始 |
| P1 | HTTP 运行安全与凭据迁移 | 引入 request-scoped context/client、remote auth 和非明文凭据默认值 | v1.10 待开始 |
| P1 | MCP 契约与 Agent evaluation | 用 Inspector、稳定评测、性能预算和故障注入验证 agent 真正会用 | v1.11 待开始 |
| P1 | CI/CD 供应链与可观测性 | 固定 Actions、SBOM/provenance、coverage 门槛和隐私安全 metrics | v1.12 待开始 |
| P2 | 组织策略与签名 evidence | 只有出现真实 breaking/persistence 需求时进入主版本 | v2.0 条件触发 |

## 成功指标

北极星指标按四个产品目的组织：

| 产品目的 | 可验证指标 |
|---|---|
| 让 AI 顺手 | 工具选择 evaluation 正确率、schema/structuredContent 零漂移、在预算内完成多工具任务的成功率、可行动错误比例 |
| 让用户省心 | 从 repo briefing 到 plan/issue/PR/release/handoff 的重复手工改写次数、dry-run 后一次确认成功率、因缺上下文反复追问的比例 |
| 让 AI“长脑子” | 简报/计划中有来源的风险与约束覆盖率、verified 与 caller assertion 正确分离率、handoff 后不重复已验证步骤的成功率 |
| 让组织“敢用” | 高风险结论 provenance 完整率、degraded/stale 正确暴露率、最小权限与人类 gate 覆盖率、敏感信息泄露与越权写入为零 |

指标采集必须遵守 v1.12 的隐私原则：优先用本地/CI fixture 与聚合低基数数据，不收集私有源码、Issue/PR 正文或 secret；没有真实 telemetry 前，使用可重复 evaluation 和 contract tests 作为代理指标。

版本验收使用固定 fixture 的代理阈值（首次实现时把 fixture 与计算脚本一并纳入仓库，后续只能通过评审调整，不能为过 CI 临时降低）：

- v1.7：策略 fixture 的 expected rule decision/source/digest 匹配率 100%，非法/未知配置静默生效率 0%。
- v1.8：高风险 fixture 的 `riskProfile`、来源、防御性要求、negative scenarios、rollback、observability 必备字段覆盖率 100%；低风险 docs fixture 不相关高风险清单误加率 0%。
- v1.9：`state`/`freshness`/`completeness` schema 契约匹配率 100%，`state: verified` claim 的 provenance 完整率 100%，caller assertion 被标成 verified 的数量为 0。
- v1.10：至少 100 组交错并发双租户 fixture 中 credential/repo/client/cache/AbortSignal 串线为 0；无效 auth、Host/Origin 与超预算请求拒绝率 100%。
- v1.11：固定工具选择与多工具组合 evaluation 总正确率至少 90%，其中涉及写操作、security gate、release gate 的安全关键题必须 100%；schema/structuredContent drift 为 0%。
- v1.12：仓库内第三方 Actions 完整 SHA 固定率 100%，发布版本/tag/artifact/SBOM/attestation commit 一致率 100%，敏感内容作为 metric label 或远程 telemetry payload 的 fixture 泄露数为 0。

这些阈值是发布 gate 的最低代理指标，不代表真实用户体验已经充分；每版仍需记录失败样本、人工可用性反馈和未覆盖场景。

短期成功指标：

- [x] 任意 MCP 客户端中的 AI coding agent 能在 5 分钟内完成 MCP 配置验证（`docs/ai-coding-agent-smoke-test.md`，v1.4.0）
- [x] `repo_context` 能返回足够 agent 开工的上下文，不需要用户手动补充 README/package/scripts（v1.4.0）
- [x] docs-only、feature、bugfix、security、release、infra 任务能生成明显不同的计划（`plan_from_context` workType，v1.4.0）
- [x] dry-run issue 预览能让人类判断是否允许真实创建，并显示目标仓库、标签、body 摘要与 warning（`create_issue_set`，v1.5.0）

中期成功指标：

- [x] `plan_from_context` 输出可直接 dry-run 创建 issue（v1.5.0）
- [x] PR 门禁结果能解释为什么通过、失败、等待、缺审查或存在策略缺口（v1.6.0）
- [x] security/release 类任务能自动生成更严格的审查项（v1.6.0）
- [x] 仓库策略能稳定影响计划、审查和 release readiness，并显示 rule ID、来源 ref/SHA 与 policy digest（v1.7.0）
- [x] Registry metadata、npm 包版本与 MCP server metadata 可验证一致（v1.7.1；namespace 与 GitHub OIDC login 大小写一致）
- `prepare_work_item` 能根据 auth/payment/migration/workflow/docs 等任务生成不同深度的开发简报（v1.8）
- 高风险简报包含防御性要求、negative scenarios、回滚和上线可观测性，且所有派生要求可追溯（v1.8）
- PR/Issue/release evidence packet 能用正交字段区分结论 state、freshness（fresh/stale/unknown）与 completeness（complete/partial/omitted）（v1.9）
- handoff 不再把调用方自报状态伪装成系统验证事实（v1.9）

长期成功指标：

- MCP Inspector 与稳定 evaluation 能验证 agent 是否会正确选择并组合工具，而不只是 handler 单测通过（v1.11）
- HTTP transport 具备官方授权、安全 Host/Origin、请求预算、timeout/cancellation 与并发隔离（v1.10）
- 发布制品具备 SBOM/provenance，所有第三方 Actions 固定且供应链 gate 可解释（v1.12）
- 一个 PR 或 release 可以生成完整、版本化、来源可追溯的 evidence packet
- 人类 reviewer 可以直接根据 evidence packet 判断 agent 工作是否可信，同时看见证据缺口和时效性
- 下一个 agent 可以根据 handoff packet 无缝接续工作，不重复已验证步骤，也不继承未经验证的假设
- 项目形成清晰定位：AI coding agent 的 SDLC governance layer，而不是普通 GitHub MCP wrapper

## 跨版本完成门槛

从 v1.7 开始，每个版本除功能验收外，还必须满足：

- 新增/变更工具同时更新 input schema、output schema、structuredContent、Markdown、annotations、README/ROADMAP 与契约测试。
- 覆盖 happy path、权限不足、API 失败、分页/截断、大输入、恶意外部文本、并发/状态变化和 fail-open/fail-closed 边界。
- 所有外部证据在适用时绑定 repo/ref/SHA；Issue、评论、Registry metadata 等无 commit SHA 的对象则绑定稳定 subject、URL/ID、版本和采集时间。无法完整验证时明确 degraded/unverified/stale。
- 明确 API 调用、响应大小、items、字符/token 与 latency 预算；达到上限时不得静默漏证据。
- 写操作保持 dry-run 默认和显式确认；任何新配置都不能开启 auto-merge、force-push、删除保护或绕过 review。
- 独立 reviewer 检查需求完成度、安全、类型、性能、兼容性、测试和文档后，才允许发布。
- 发布说明列出已验证能力、已知限制、迁移影响、回滚方案与下一版本未完成项。
