# agentic-sdlc-mcp

[![CI](https://github.com/SakuraCianna/agentic-sdlc-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SakuraCianna/agentic-sdlc-mcp/actions/workflows/ci.yml)

一个 MCP (Model Context Protocol) 服务器，充当 **Agentic SDLC（软件开发生命周期）控制平面** —— 旨在帮助 AI 编程智能体遵循 GitHub Agentic AI 最佳实践，以标准的流程完成软件的计划、创建、测试、审查、安全检查及发布。

- 英文原版: [README.md](./README.md)
- GitHub 仓库: [SakuraCianna/agentic-sdlc-mcp](https://github.com/SakuraCianna/agentic-sdlc-mcp)
- 提交问题 (Issues): [github.com/SakuraCianna/agentic-sdlc-mcp/issues](https://github.com/SakuraCianna/agentic-sdlc-mcp/issues)

---

## 这是一个什么项目？

`agentic-sdlc-mcp` 并不是一个简单的 GitHub API 封装。它是一个 **SDLC 编排层**，暴露了一系列结构化、对智能体友好的工具，这些工具严格遵循软件开发的完整生命周期：

```text
Plan (计划) -> Create (创建) -> Test (测试) -> Review (审查) -> Optimize (优化) -> Secure (安全)
```

**安全第一：** 所有写入操作均默认开启 `dryRun: true` (空跑模式/预览模式)。绝不会在未授权的情况下静默执行具有破坏性或不可逆的操作。

---

## 安装与部署

**环境要求：** Node.js >= 24 (参见 `package.json` 中的 `engines` 字段；CI 运行在 Node 24 上)。

```powershell
# 克隆仓库
git clone https://github.com/SakuraCianna/agentic-sdlc-mcp.git
cd agentic-sdlc-mcp

# 安装依赖项
npm install

# 编译构建
npm run build
```

---

## 环境变量配置

请将 `.env.example` 复制为 `.env` 文件，并填写你的配置值：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env` 文件 —— 在服务器启动时，`dotenv` 会自动加载它。

或者，你也可以在 PowerShell 中直接设置临时环境变量：

```powershell
$env:GITHUB_TOKEN = "ghp_你的_token_填写在这里"
$env:GITHUB_OWNER = "你的_github_用户名或组织名"
$env:GITHUB_REPO  = "你的_仓库名"
```

| 变量名 | 是否必填 | 描述说明 |
|---|---|---|
| `GITHUB_TOKEN` | 是 | GitHub PAT 或 App Token |
| `GITHUB_OWNER` | 否 | 默认所有者 (组织名或用户名) |
| `GITHUB_REPO` | 否 | 默认仓库名称 |
| `SDLC_DEFAULT_BRANCH` | 否 | 默认主分支名称 (默认: `main`) |
| `TRANSPORT` | 否 | 传输协议：`stdio` (默认) 或 `http` |
| `PORT` | 否 | HTTP 端口号 (默认: `3000`) |

### GitHub Token 权限要求

| 权限范围 (Scope) | 作用目的 |
|---|---|
| `repo` | 读写 Issues、Pull Requests、文件内容及 Checks (仅公开仓库可用 `public_repo` 代替) |
| `security_events` | 读取 Code Scanning (代码扫描) 与 Dependabot (依赖漏洞) 警报 (仅公开仓库可用 `public_repo` 代替) |
| `repo` 或 `security_events` | 读取 Secret Scanning (密钥扫描) 警报 |

> 以上权限范围已对照 GitHub REST API 官方文档 (Dependabot alerts、Code Scanning alerts、Secret Scanning alerts、Checks 相关接口) 核实, GitHub 的权限要求可能会调整, 如果工具返回的权限错误与此表不一致, 请以 [REST API 文档](https://docs.github.com/en/rest) 为准

---

## MCP 客户端配置

### Claude Desktop / Cursor / Cline 等

在你的 MCP 客户端配置文件（如 `claude_desktop_config.json`）中添加以下内容：

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "command": "node",
      "args": ["E:/CodeHome/agentic-sdlc-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_你的_token",
        "GITHUB_OWNER": "your-org",
        "GITHUB_REPO": "your-repo"
      }
    }
  }
}
```

注意：在 Windows 中请使用正斜杠 `/` 或转义的反斜杠 `\\` 来填写路径。如果你是通过 npm 发布并使用，可以直接将 command 设置为 `npx`，args 设置为 `["-y", "agentic-sdlc-mcp"]`。

---

## 运行服务器

### stdio 模式 (默认模式 —— 供 MCP 客户端直接使用)

```powershell
$env:GITHUB_TOKEN = "ghp_your_token"
node dist/index.js
```

### HTTP 模式 (供远程调用或多客户端连接)

```powershell
$env:TRANSPORT = "http"
$env:PORT      = "3000"
$env:GITHUB_TOKEN = "ghp_your_token"
node dist/index.js
# 服务器将监听在 http://localhost:3000/mcp
```

### 冒烟测试 (Smoke test，无需配置真实的 Token)

用于验证模块能否正常加载以及所有工具能否无报错注册：

```powershell
npm run smoke
# 输出示例: [agentic-sdlc-mcp] SMOKE OK — all tools and resources registered successfully.
```

---

## npm 脚本命令参考

| 脚本命令 | 描述说明 |
|---|---|
| `npm run build` | 编译 TypeScript 代码到 `dist/` 目录 |
| `npm run typecheck` | 仅执行类型检查（不生成文件） |
| `npm run test` | 运行 Vitest 测试套件 |
| `npm run test:watch` | 开启测试监听模式 (用于 TDD) |
| `npm run test:coverage` | 生成测试覆盖率报告 (lcov + text) |
| `npm run smoke` | 冒烟测试: 加载并注册工具，无需真实 token |
| `npm run dev` | 使用 tsx 开启开发监听模式 |
| `npm start` | 运行编译后的服务器代码 |

---

## 工具集参考 (Tools Reference)

### `repo_context`
读取仓库的元数据、README、package.json、未解决的 Issues 和打开的 PRs。
**使用场景**：在开始任何工作流时了解全局代码库背景。
- `issueLimit` / `prLimit` (数字, 默认: `20`, 上限: `100`)：限制拉取的 Issues/PRs 数量, 避免大型仓库返回内容占用过多 Token。

### `plan_from_context`
基于提供的目标生成分阶段的 SDLC 计划 (Plan→Create→Test→Review→Optimize→Secure)。
**机制**：纯模板驱动 —— 无需消耗 LLM 调用。

### `create_issue_set`
将计划批量创建为 GitHub Issues。
**⚠️ 警告**：`dryRun` 默认设为 `true`（仅预览）。必须显式传入 `dryRun: false` 才能真正写入 GitHub。

### `prepare_work_item`
为特定的 Issue 生成 Agent 友好的工作简报（Brief），包括目标、非目标、验收标准、潜在风险，并附带接力提示词。
- `includeRelatedFiles` (布尔值, 默认: `false`)：启发式地从 Issue 正文中提取相关文件路径。
- `includeRecentPRs` (布尔值, 默认: `false`)：扫描最近更新的最多 20 个已关闭 PR, 返回其中最多 5 个改动过相关文件提示的已合并 PR (需要 `includeRelatedFiles` 先提取出文件提示, 否则直接返回空列表)。对应输出字段：`recentPRs`。

### `quality_gate_status`
读取 PR 或特定 Git Ref 的质量检查（Check runs）结果。
**使用场景**：在合并 PR 或发布前验证 CI 是否全部通过。

### `create_pr_summary`
针对指定的 PR，生成结构化的内容摘要：变更概述、文件分类、测试覆盖率信号、潜在风险、Review 清单以及 Release Notes 草案。

### `review_pr_against_standard`
根据给定的 SDLC 标准 (`basic` / `strict` / `security-focused`) 对 PR 自动执行审查。
其中 `security-focused` (注重安全) 模式会主动扫描 Patch 差异中的敏感词（如密钥）、检测 `.env` 泄露、锁文件变更及意外引入的构建产物。

### `security_triage`
收集 Code Scanning, Dependabot 和 Secret Scanning 警报，按严重等级分类，并推荐修复顺序。

### `release_readiness_check`
发布前准备就绪度检查：包含 CI 状态、未修复的 Bug Issues、是否有 CHANGELOG，并生成发版前检查清单和回滚方案模板。

### `agent_handoff_packet`
生成一份紧凑的工作交接包（Handoff packet），以便下一个智能体（如专门负责 Review 或 Security 的 Agent）能够不丢失上下文地继续工作。

---

## 参考资源 (Resources)

这些是只读的文档资源，便于 Agent 直接获取规范指引：

| URI 资源路径 | 描述说明 |
|---|---|
| `sdlc://standards/agentic-sdlc` | 完整的 Agentic SDLC 标准，包含各阶段说明和人类审批节点 |
| `sdlc://templates/issue` | 标准的 Issue 模板 |
| `sdlc://templates/pr-summary` | 标准的 PR 摘要模板 |
| `sdlc://templates/release-readiness` | 发版前检查清单模板 |
| `sdlc://templates/handoff` | 智能体工作交接模板 |

---

## `dryRun` 安全模型

所有的写入类工具都强制集成了 `dryRun` (空跑) 机制：

| `dryRun` 参数值 | 实际效果 |
|---|---|
| `true` (默认) | 预览模式 —— 不会对 GitHub API 进行任何真实修改 |
| `false` | 写入模式 —— 真实修改 GitHub 仓库内容 |

系统始终默认 `dryRun: true`。Agent 必须明确指定 `dryRun: false` 才能执行写入操作，这能有效防止 AI 的幻觉导致破坏性操作。

---

## 典型工作流示例

### 1. 开启一个新功能开发

```
1. repo_context                  # 了解仓库基线背景
2. plan_from_context (goal=...)  # 依据目标生成 SDLC 计划
3. create_issue_set (dryRun:true) # 预览将要创建的 Issues
4. create_issue_set (dryRun:false) # 正式在 GitHub 创建 Issues
5. prepare_work_item (issueNumber=N) # 提取某一个 Issue 为当前 Agent 准备任务简报
```

### 2. 审查 Pull Request

```
1. create_pr_summary (pullNumber=N)             # 获取全局 Diff 概览
2. quality_gate_status (pullNumber=N)            # 检查 CI/CD 状态
3. review_pr_against_standard (standard:strict)  # 按严格标准找出代码质量问题
```

### 3. 发版前的终极检查

```
1. security_triage                # 检查各类安全警报
2. release_readiness_check        # 评估发版就绪度
3. (解决任何阻塞型 Issues)
4. 人类审批通过后打 Tag 发版
```

---

## 安全注意事项

- **绝不要**把你的 `GITHUB_TOKEN` 提交到代码库中 —— 始终使用 `.env` 文件或 PowerShell `$env:` 环境变量。
- 默认的 `dryRun: true` 保护机制可以防止代码库被意外修改。
- 本工具不支持自动合并 (Auto-merge)、不强制推送 (Force-push)、不支持删除分支操作。
- Secret scanning (密钥扫描) 警报始终被评级为最高危 (`critical`)。
- 服务器除了调用官方 GitHub API 之外，不发起任何额外的出站外网请求。

---

## 本地开发指南

```powershell
# 类型检查
npm run typecheck

# 监听模式 (热重载)
npm run dev

# 构建项目
npm run build

# 运行测试
npm run test

# 冒烟测试 (不需要提供真实的 GitHub Token)
npm run smoke
```

---

## 发布指南 (维护者专用)

本包通过 **Trusted Publishing (OIDC 可信发布)** 方式发布到 npm —— 仓库中不存储任何长期有效的 `NPM_TOKEN` 密钥。发布流程由 `.github/workflows/publish.yml` 负责执行。

### npm 官网一次性配置步骤

1. 登录 [npmjs.com](https://www.npmjs.com)，进入该包的 **Settings -> Publishing access** 页面。
2. 添加一个 **Trusted Publisher (可信发布者)**，填写：
   - Provider (提供方): `GitHub Actions`
   - Repository (仓库): `SakuraCianna/agentic-sdlc-mcp`
   - Workflow filename (工作流文件名): `publish.yml`
3. 保存。此后 `publish.yml` 即可在不使用任何 npm token 的情况下完成发布 —— GitHub 会签发一个短期有效的 OIDC token，npm 用它换取发布凭证，并自动生成 provenance (来源证明)。

> **首次发布例外**：如果该包名在 npm 上尚不存在，则无法预先绑定 Trusted Publisher (必须先有包才能配置)。此时需要先在本地用经典 token 手动执行一次 `npm publish`，之后的所有发布再切换为 Trusted Publishing。`publish.yml` 工作流本身始终使用 OIDC 方式，不会退回到 token 方式。

### 如何触发一次发布

- **推荐方式**：在 GitHub 上创建一个 Release (打 Tag 后点击 "Publish release")，这会触发 `release: published` 事件，自动运行 `publish.yml`。
- **手动方式**：进入 **Actions -> Publish to npm -> Run workflow** 手动触发 (`workflow_dispatch`)。

### 发布前本地检查清单

```powershell
npm run typecheck
npm run build
npm run test
npm run smoke
npm run test:coverage
npm pack --dry-run
```

`npm pack --dry-run` 会列出即将打包进发布压缩包的所有文件，但不会真正生成压缩包。请确认其中只包含 `dist/`、`README.md` 和 `.env.example` —— 测试文件和 `package-lock.json` 不应出现在其中 (这由 `tsconfig.build.json` 保证，它在编译用于发布的 `dist/` 输出时排除了 `src/__tests__/**`)。

### GitHub Actions 工作流说明

| 工作流 | 触发条件 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | `pull_request`、推送到 `main` | 在 Node 24 上运行类型检查、构建、测试、冒烟测试和覆盖率检查 |
| `.github/workflows/publish.yml` | GitHub Release 发布、或手动触发 | 通过 OIDC Trusted Publishing 方式发布到 npm |
| `.github/dependabot.yml` | 每周定时 | 自动提交 npm 依赖与 GitHub Actions 依赖的更新 PR (打上 `dependencies` 标签) |

---

## 开源协议

MIT License
