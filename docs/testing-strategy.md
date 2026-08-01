# 测试策略与资产维护

本项目的测试目标不是单纯提高覆盖率，而是让 AI coding agent 在真实 MCP 契约、GitHub 状态变化和恶意外部输入下仍得到可解释、可审查、不会静默放行的结果。

## 测试分层

1. **纯逻辑单元测试**：覆盖分类、策略匹配、排序、截断、状态归一化和 fail-closed 决策。优先表驱动测试，边界至少包含 `0 / 1 / limit / limit + 1`。
2. **工具处理器测试**：向导出的 handler 注入 `RepoRef` 和 mock Octokit，验证 GitHub 请求参数、结构化输出、Markdown、安全降级及 dry-run 不写入。
3. **协议集成测试**：使用 `createAgenticSdlcServer()`、真实 MCP SDK v2 `Client` 与同包 `InMemoryTransport`，覆盖 legacy initialize、工具/资源发现、schema 默认值、协议错误以及代表性的端到端工具调用。
4. **进程与配置生命周期测试**：在隔离临时目录中验证环境变量、配置文件、交互输入和退出码；不得读取开发者真实 home 配置。
5. **外部环境验证**：真实 GitHub、npm 或 MCP Registry 仅用于显式 smoke/release 验证，不进入默认测试套件。测试必须绑定固定仓库、ref/SHA、权限前提和清理方案，外部波动不得伪装成产品结论。

## 对抗性场景矩阵

每个新增或变更的证据路径都应按适用性覆盖：

| 维度 | 必查场景 |
|---|---|
| 输入边界 | 空值、缺省、错误类型、极值、超限、大文本、Windows/Unix 路径差异 |
| 外部文本 | 换行/标题注入、Markdown 链接、控制字符、超长字段、空白字段 |
| GitHub 状态 | 401/403/404/422/429、部分数据源失败、分页截断、空响应、字段缺失 |
| 证据完整性 | repo/ref/SHA 不一致、同名但来源错误、stale/degraded/unverified、策略自修改 |
| 时序与全局上下文 | 默认分支变化、配置优先级、缓存 key 隔离、一个来源失败但其他来源保留 |
| 写入安全 | dry-run 默认、显式 live 参数、部分成功、重试/重复调用、禁止隐式写入 |

结构化内容保留必要的原始证据；新增或本轮触达的外部文本在进入面向用户或 AI 的 Markdown 时必须净化、限长。任何达到证据上限的情况都必须显式标记截断或未验证，不能把“没有读取到”解释为“没有风险”。v1.8 建设已让 `prepare_work_item`、`create_pr_summary` 和 `agent_handoff_packet` 隔离并标记 Issue/评论/PR/调用方文本；语义级 prompt injection 仍不能靠转义彻底消除，客户端必须继续实行最小工具权限、人类复核和受控写出。

关系和邻接证据需要同时测试“来源语义”与“结论语义”：显式路径、测试命名和根入口候选必须分别覆盖存在、404、权限失败与预算溢出；blocked-by、blocking、sub-issue 和 cross-reference 不得互相替代。每个远程来源至少保留一个独立失败用例，断言成功来源仍在、incomplete 标记出现、原始错误未泄露。`parallelizableWork` 只能断言为关系推导候选，不能用它证明子任务自身不存在其他 blocker。

## 动态运行感知的边界

`src/__tests__/fixtures/mcp-client.ts` 是内存协议测试的共享入口。它连接生产 server factory 和 SDK 内存 transport，不监听端口、不访问网络，但会执行真实 MCP 初始化、schema 校验、注册路由和序列化流程。工具运行测试只 mock GitHub 客户端边界，因此能捕获“单元 handler 正确但注册/schema/协议默认值错误”的问题。HTTP 生命周期测试另行绑定 `127.0.0.1` 随机端口，验证并发请求隔离与清理、Host/Origin 拒绝、GET/DELETE `405`、畸形/过大/内部错误的有界响应、端口解析和幂等关闭；测试 setup 允许 loopback/本地 IPC，但在连接前拒绝所有外部 fetch 和 socket。

涉及远程 HTTP、OAuth、多租户 request context 或取消/超时的能力落地后，应增加真实 HTTP transport 的本地端到端套件；在此之前，不得用内存 transport 测试声称已经验证网络层安全。

## v1.10 契约与 Evaluation 分层

v1.10 在现有单元、handler、真实 SDK client 和 loopback HTTP 测试之上增加三类证据，三者不能互相冒充：

1. **SDK/era parity**：先把 v1 单包迁移到稳定 SDK v2，但保持 2025 legacy wire；parity 通过后再为本地 stdio/loopback 显式启用 2025 fallback 与 `2026-07-28` modern era。package migration 与 wire opt-in 分 PR，modern 测试必须显式 pin 版本，不能从依赖版本推断。
2. **Inspector/Conformance 黑盒**：使用精确固定的 Inspector 2，从进程外通过 stdio/loopback HTTP 验证发布构建产物，只消费机器可读 JSON 与稳定 exit class；Conformance 0.1.16 先作为 legacy 非阻塞 pilot。二者都不能被描述成官方认证，也不能替代显式 modern client 的 required 测试。
3. **Agent evaluation**：required CI 使用固定 GitHub fixture 的真实 MCP tool call 和 recorded trace scorer；可选 live model-in-loop 必须记录 provider、model、版本、时间和场景 digest。recorded trace 只能证明 scorer/fixture/协议路径可重复，不能证明未来任意模型仍会做同样选择。

公共工具契约从不可变 `v1.9.0` tag/commit 生成，记录 source SHA，并按语义比较 breaking/additive 变化。禁止从升级后的当前工作树伪造旧 baseline，也禁止在普通测试中自动更新；更新必须由单独命令执行，让 PR 显示工具/resource 删除、schema required/类型变化、annotations 与描述变化。大段 inline snapshot 不能替代 output schema 对真实 `structuredContent` 的逐工具验证。

T1 的 `contracts/mcp/v1.9.0.json` 固定到 release commit `3e1cdbb2d591ba482903f53579f1f76cc95ff1c4`。`npm run contracts:check` 构建当前 server，通过真实 SDK client discovery 做快速只读语义比较，并验证本地 tag/SHA；`npm run contracts:verify-baseline` 在独立 Node 24 CI job 从系统临时目录重放历史 checkout，逐字证明 tracked JSON 可重复；`npm run contracts:generate` 是唯一写入入口。历史安装使用 lockfile 与 `--ignore-scripts --no-audit --no-fund`，需要 npm registry，但不得调用 GitHub API/模型服务、读取 GitHub/model 凭据或启动公网监听。历史 discovery 在短生命周期 Node 子进程内执行，子进程 cwd 位于 checkout 外且只继承进程启动所需的系统路径、临时目录、locale 与动态库环境变量；业务配置、凭据、`NODE_OPTIONS`、storage 与 OAuth state 都不会进入子进程。Windows 在模块句柄释放后再注销 worktree，并以有界重试删除依赖树。discovery 有 15 秒 deadline，路径 containment 与 Git worktree 注册状态都会被校验。

比较器阻塞工具/resource 删除、输入删除/收窄/default 漂移、新增 required、输出 required/type/enum/constraint/composition 保证弱化、MIME 与 annotations 漂移；可选字段只有在相对旧 `additionalProperties` 有效 schema 确实不收窄时才通过。它认识 `integer` 是 `number` 子集、JSON Schema boolean schema 与任意 JSON enum，并用 locale-independent 稳定顺序与 prototype-safe key 处理生成 manifest。T2 只把工具根 input/output schema 精确的 draft-07 → 2020-12 官方 dialect 升级记录为已审查兼容变化；无 baseline 的声明、删除、降级、任意其它 `$schema`、嵌套 dialect、引用、composition 或无法证明兼容的 validation keyword 变化仍进入人工复核，不能为了消除误报而静默放行。

Inspector 2 与 Conformance 的 engine/依赖树属于测试工具边界：各自使用隔离 lockfile，并在 Node 24 contract job 运行，不提高生产包 `engines.node >=22` 的下限，也不把测试 UI、runner 或额外 SDK client 依赖引入产品运行时。required job 使用显式 target，将 `MCP_STORAGE_DIR` 设为专用临时目录，并将 `MCP_INSPECTOR_OAUTH_STATE_PATH` 设为该目录下的 `oauth.json` 文件；不得改写 `HOME`，不得交互式 OAuth，也不得继承真实 GitHub/model 凭据。HTTP 始终只绑定 loopback。

提示词注入 evaluation 至少覆盖 Issue/PR 标题正文、Issue/PR/review comment、README/CONTRIBUTING/仓库规则、workflow/job 名称与日志、GitHub error text。断言不只检查转义后的展示，还必须证明这些不可信文本不能改变 required/forbidden 工具序列、跳过 security/release gate、扩大 repo/ref、关闭 dry-run、触发真实写入或进入日志/artifact。

风险分类回归必须成对覆盖误报和漏报。尤其要区分 LLM 字符/token 预算与 credential token、Secret Santa/secret sauce 等普通短语与真实凭据处理，以及文档中的防御性描述与已确认暴露；精确的结构化 `secret(s)`/`credential(s)` label 必须独立于自由文本规则验证。`riskProfile` 表示可解释的实施规划风险，不得被测试、文档或调用方描述成已确认漏洞。确定性模式只用于高置信、可解释信号，不能单独替代结构化 trust boundary、工具权限校验、人工 gate 或对抗性 evaluation。

取消与分页属于跨工具公共边界。timeout 测试必须覆盖父级预取消、运行中取消、非 `Error` reason、operation 同步失败、真实进程中仅剩 deadline 句柄，以及 `NaN/Infinity`；不能用 `unref()` 让进程在 deadline 前静默退出。分页测试必须覆盖短页、精确上限、`maxItems=0` 和非法 `perPage`，GitHub 每页范围固定为 1–100，避免零页大小导致无限请求。证据适配器按 CI/review/release/security 的 verified/failed/pending/unverified/not-applicable 与 partial 组合做表驱动回归。

## Fixture 与长期维护

- 共享 fixture 只抽取稳定基础设施或领域构造器，不隐藏测试关键差异。测试应在用例附近直接写出决定结论的字段。
- 禁止复制完整 Octokit 响应。只构造当前契约消费的最小字段，新增字段时由失败测试说明原因。
- 一个生产缺陷至少保留一个能复现原始失败的回归用例；安全缺陷同时断言“危险内容不存在”和“合法证据仍保留”。
- 避免只断言快照或大段 Markdown。优先断言结构化决策，再检查关键安全文本、边界标记和 schema 契约。
- 测试不得依赖执行顺序、真实 home、真实 token、当前时间或持续变化的公开仓库。
- 测试名称描述业务规则和失败条件，不描述实现函数的内部步骤。

## 仓库卫生门禁

- tracked text 统一使用 LF：`.gitattributes` 定义 Git 归一化，`.editorconfig` 提供编辑器默认值，`npm run check:line-endings` 在 CI 中扫描已跟踪文本。
- `src/__tests__/quality/line-endings.test.ts` 使用临时 fixture 分别覆盖 LF、CRLF 与 mixed EOL，并断言失败输出只包含文件名、不回显文件内容。
- 行尾规范化属于机械变更；提交前必须用 `git diff --ignore-space-at-eol` 与常规 diff 分别核对，不能让大规模格式噪声掩盖语义修改。
- 大文件不是自动重构信号。先确认稳定的职责边界、调用方向和可独立验证的契约，再抽取深模块；`prepare_work_item` 的 GitHub I/O 预算与降级语义统一由 `work-item-evidence.ts` 维护。

## 覆盖率门槛

`npm run test:coverage` 当前执行全局最低门槛：statements 94%、branches 89%、functions 94%、lines 95%，并输出 text、LCOV 与 `coverage/coverage-summary.json`。SDK v2 迁移后的当前基线为 1153 个测试、95.46% statements / 91.36% branches / 95.93% functions / 96.08% lines；门槛刻意保留 Node 22/24 插桩余量。新增边界覆盖包括扫描器 Workflow 精确 provenance、无关 Workflow 负例、重命名前路径、双扫描器逐 signal 隔离、自定义 Gitleaks/TruffleHog 配置、动态/绝对/穿越/歧义参数拒绝、合法空格/括号仓库路径、Actions API 失败、旧 provenance 缺口清理、输入不可变、非法 URL/YAML/workflow AST、不可用 base Workflow 内容、嵌套模板词法状态、scanner provenance/workflow fixture 元数据误判、GitHub Issue/PR 混合元数据归一化、HTTP Host/Origin 前置于有界 JSON parsing，以及封闭 nullable `anyOf` 中可选字段新增仍进入人工复核。真实动态 credential 与 header sink 的正向控制保持 fail-high。

门槛用于阻止回退，不是完成定义。新增高风险模块应优先达到更高的局部覆盖，尤其是权限、策略、证据截断和写入边界。提高门槛前先观察完整套件的稳定基线并保留合理余量；降低门槛、扩大 exclude 或删除断言必须在 PR 中单独解释，不能作为通过 CI 的快捷方式。

## 常用命令

```powershell
npm run test
npm run test:integration
npm run test:coverage
npm run typecheck
npm run build
npm run contracts:check
npm run contracts:verify-baseline
npm run smoke
npm run check:line-endings
```
