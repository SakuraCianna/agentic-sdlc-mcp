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

`src/__tests__/fixtures/mcp-client.ts` 是协议测试的共享入口。它连接生产 server factory、项目的 stdio wrapper 和 SDK 内存 transport，不监听端口、不访问网络，但会执行真实 MCP 初始化/发现、schema 校验、注册路由和序列化流程。工具运行测试只 mock GitHub 客户端边界，因此能捕获“单元 handler 正确但注册/schema/协议默认值错误”的问题。HTTP 生命周期测试另行绑定 `127.0.0.1` 随机端口，验证并发请求隔离与清理、Host/Origin 拒绝、GET/DELETE `405`、畸形/过大/内部错误的有界响应、端口解析和幂等关闭；测试 setup 允许 loopback/本地 IPC，但在连接前拒绝所有外部 fetch 和 socket。

涉及远程 HTTP、OAuth、多租户 request context 或取消/超时的能力落地后，应增加真实 HTTP transport 的本地端到端套件；在此之前，不得用内存 transport 测试声称已经验证网络层安全。

## v1.10 契约与 Evaluation 分层

v1.10 在现有单元、handler、真实 SDK client 和 loopback HTTP 测试之上增加三类证据，三者不能互相冒充：

1. **SDK/era parity**：先把 v1 单包迁移到稳定 SDK v2，但保持 2025 legacy wire；parity 通过后再为本地 stdio/loopback 显式启用 2025 fallback 与 `2026-07-28` modern era。package migration 与 wire opt-in 分 PR，modern 测试必须显式 pin 版本，不能从依赖版本推断。
2. **Inspector/Conformance 黑盒**：使用精确固定的 Inspector 2，从进程外通过 stdio/loopback HTTP 验证发布构建产物，只消费机器可读 JSON 与稳定 exit class；Conformance 0.1.16 先作为 legacy 非阻塞 pilot。二者都不能被描述成官方认证，也不能替代显式 modern client 的 required 测试。
3. **Agent evaluation**：required CI 使用固定 GitHub fixture 的真实 MCP tool call 和 recorded trace scorer；可选 live model-in-loop 必须记录 provider、model、版本、时间和场景 digest。recorded trace 只能证明 scorer/fixture/协议路径可重复，不能证明未来任意模型仍会做同样选择。

T3 已让生产 stdio 和 loopback HTTP 显式支持 2025/2026 双 era：legacy client 走 `initialize`，modern client 必须 pin `2026-07-28` 并走 `server/discover`。direct-fetch、真实 loopback 和构建后的 stdio 子进程均验证 13 tools/5 resources parity；modern `resultType`、`ttlMs`、`cacheScope` 与 per-request metadata 只由 SDK wire layer 产生。版本不匹配、header/body 跨时代冲突、未知方法、factory 异常和取消均有负向覆盖。2025 stateless HTTP 因没有 session/client identity，无法安全地把独立取消 POST 关联到原请求；两个时代均显式证明异步 factory 期间的预取消/handler shutdown 499（即使 factory 不释放也会立即结算），以及迟到 server 会被关闭；modern 还覆盖 factory resolve 与 close 相邻微任务的 handoff，关闭获胜后不允许再进入原始 `connect`。这些边界不能被误述为客户端取消必然停止任何不可中止的上游工作。stdio 子进程启动真实 `dist/index.js`，使用独立临时 home/storage、空 dotenv、credential/`NODE_OPTIONS` canary 和非 loopback fetch/socket guard，不依赖真实 home、凭据或外部网络；watch 模式排除这一项必须依赖构建产物的测试。

T4 的 `mcp-tool-contract.integration.test.ts` 使用同一张 13 工具 case 表分别驱动 legacy stdio wrapper 与 modern production direct-fetch。每个成功结果都必须通过 SDK 注册层的 Standard Schema output validation，并同时保留关键 Markdown、structuredContent required signal、统一 trust metadata/boundary；modern 调用还逐次验证 `2026-07-28` 与 `tools/call` headers。schema-invalid 或顶层 GitHub 403 必须是没有 structuredContent 的 MCP error；工具明确支持的部分失败则保留为有界 structured degradation。GitHub fixture 的 `issues.create` 是 fail-fast live-write 哨兵，测试故意依赖 `create_issue_set` 的默认 `dryRun:true`，并同时阻断全局 fetch 与 socket。进程外构建产物的 discovery/lifecycle 由 T3 证明，Inspector 的进程外实际 tool call 由 T5 证明，不能把本进程 direct-fetch 结果外推成 Inspector 证据。

T5 的 `run-inspector-contracts.mjs` 使用隔离 lockfile 中精确固定的 Inspector 2.0.0，以显式 ad-hoc stdio target 调用正式 `dist/index.js`。它只消费 `--format json` stdout 与 JSON error envelope，验证 server version、legacy `2025-11-25` initialize、13 tools、5 resources 的逐项 read、显式 `dryRun:true` 且 created 为 0 的 `create_issue_set`，以及 invalid schema/unknown resource URI 的稳定机器退出与错误码。所有 `tools/call` 都只指向 `create_issue_set` 且显式保持 dry-run。runner 通过 Inspector 官方 `-e` 向目标传固定环境 allowlist，并要求真正的 `dist/index.js` 子进程写入临时 harness marker，避免只保护 Inspector 父进程的假阳性。它不改写 HOME，但通过未发布的 Node `--import` 护栏屏蔽全局产品配置路径，清除真实 GitHub 凭据、隔离 Inspector storage/OAuth/client state，并为纯 stdio 验证禁用全部 fetch/TCP（本地 IPC path 除外）；placeholder 与继承 canary 不得进入 stdout、stderr 或制品。该门禁证明 Inspector legacy CLI 与当前构建产物兼容，不是官方认证，也不替代 T3/T4 对 modern `server/discover` 的显式 SDK 证据。

T6 复用同一 runner，在 `127.0.0.1:0` 启动生产 HTTP adapter，并让 Inspector 以 canonical `/mcp` target、`--transport http`、`--stored-auth-only` 非交互执行同一 discovery/read/dry-run 契约及 invalid schema、unknown tool、closed-listener 错误路径。HTTP discovery 会与独立 stdio Inspector 的完整 tools/resources JSON 比较，覆盖 schema、annotations 与 metadata，而不只比较名称/URI。隔离 401 loopback fixture 使用空 OAuth store，并故意把 auto-open 设为 true；门禁要求 Inspector 立即返回 `3/auth_required`，且预加载的 browser-spawn marker 不得出现，证明 `--stored-auth-only` 没有进入交互 OAuth。HTTP harness 只允许精确 IPv4 loopback，拒绝 `localhost`、DNS/欺骗 hostname 与公网；成功和失败路径都关闭 listener/child。Inspector 2.0.0 在 Windows 的错误命令收尾可能于正确 JSON 后触发一个已知 libuv closing assertion；runner 只接受精确 Windows status、精确 JSON code 和精确两行 stderr，并保留 raw exit/class，Linux 或任何额外输出仍失败。Conformance 0.1.16 使用隔离 lockfile 对 legacy `2025-11-25` active suite 运行非阻塞 pilot，固定 30 个场景、5 个直接通过和 25 个带 reason/owner/remove condition 的预期缺口；新增失败与 stale baseline 都失败。artifact 仅保留可审查 check 字段，剥离 raw `details`/timestamp，不含凭据、Issue 正文或私有仓库数据。成功摘要只在 server close 成功后生成，cleanup 错误不会被吞掉；非零 runner 输出不会原样写入 CI 日志。该 pilot 不是官方认证，也不会驱动添加假 production prompt/tool/resource；modern required 证据仍由 T3/T4 显式 SDK v2 client 提供。

公共工具契约从不可变 `v1.9.0` tag/commit 生成，记录 source SHA，并按语义比较 breaking/additive 变化。禁止从升级后的当前工作树伪造旧 baseline，也禁止在普通测试中自动更新；更新必须由单独命令执行，让 PR 显示工具/resource 删除、schema required/类型变化、annotations 与描述变化。大段 inline snapshot 不能替代 output schema 对真实 `structuredContent` 的逐工具验证。

T1 的 `contracts/mcp/v1.9.0.json` 固定到 release commit `3e1cdbb2d591ba482903f53579f1f76cc95ff1c4`。`npm run contracts:check` 构建当前 server，通过真实 SDK client discovery 做快速只读语义比较，并验证本地 tag/SHA；`npm run contracts:verify-baseline` 在独立 Node 24 CI job 从系统临时目录重放历史 checkout，逐字证明 tracked JSON 可重复；`npm run contracts:generate` 是唯一写入入口。历史安装使用 lockfile 与 `--ignore-scripts --no-audit --no-fund`，需要 npm registry，但不得调用 GitHub API/模型服务、读取 GitHub/model 凭据或启动公网监听。历史 discovery 在短生命周期 Node 子进程内执行，子进程 cwd 位于 checkout 外且只继承进程启动所需的系统路径、临时目录、locale 与动态库环境变量；业务配置、凭据、`NODE_OPTIONS`、storage 与 OAuth state 都不会进入子进程。Windows 在模块句柄释放后再注销 worktree，并以有界重试删除依赖树。discovery 有 15 秒 deadline，路径 containment 与 Git worktree 注册状态都会被校验。

比较器阻塞工具/resource 删除、输入删除/收窄/default 漂移、新增 required、输出 required/type/enum/constraint/composition 保证弱化、MIME 与 annotations 漂移；可选字段只有在相对旧 `additionalProperties` 有效 schema 确实不收窄时才通过。它认识 `integer` 是 `number` 子集、JSON Schema boolean schema 与任意 JSON enum，并用 locale-independent 稳定顺序与 prototype-safe key 处理生成 manifest。T2 只把工具根 input/output schema 精确的 draft-07 → 2020-12 官方 dialect 升级记录为已审查兼容变化；无 baseline 的声明、删除、降级、任意其它 `$schema`、嵌套 dialect、引用、composition 或无法证明兼容的 validation keyword 变化仍进入人工复核，不能为了消除误报而静默放行。

Inspector 2 与 Conformance 的 engine/依赖树属于测试工具边界：各自使用隔离 lockfile，并在 Node 24 contract job 运行，不提高生产包 `engines.node >=22` 的下限，也不把测试 UI、runner 或额外 SDK client 依赖引入产品运行时。required job 使用显式 target，将 `MCP_STORAGE_DIR` 设为专用临时目录，并将 `MCP_INSPECTOR_OAUTH_STATE_PATH` 设为该目录下的 `oauth.json` 文件；不得改写 `HOME`，不得交互式 OAuth，也不得继承真实 GitHub/model 凭据。HTTP 始终只绑定 loopback。

提示词注入 evaluation 至少覆盖 Issue/PR 标题正文、Issue/PR/review comment、README/CONTRIBUTING/仓库规则、workflow/job 名称与日志、GitHub error text。断言不只检查转义后的展示，还必须证明这些不可信文本不能改变 required/forbidden 工具序列、跳过 security/release gate、扩大 repo/ref、关闭 dry-run、触发真实写入或进入日志/artifact。

风险分类回归必须成对覆盖误报和漏报。尤其要区分 LLM 字符/token 预算与 credential token、Secret Santa/secret sauce 等普通短语与真实凭据处理，以及文档中的防御性描述与已确认暴露；精确的结构化 `secret(s)`/`credential(s)` label 必须独立于自由文本规则验证。`riskProfile` 表示可解释的实施规划风险，不得被测试、文档或调用方描述成已确认漏洞。确定性模式只用于高置信、可解释信号，不能单独替代结构化 trust boundary、工具权限校验、人工 gate 或对抗性 evaluation。

取消与分页属于跨工具公共边界。timeout 测试必须覆盖父级预取消、运行中取消、非 `Error` reason、operation 同步失败、真实进程中仅剩 deadline 句柄，以及 `NaN/Infinity`；不能用 `unref()` 让进程在 deadline 前静默退出。协议取消必须按 era/transport 分开证明，不能把 2025 stateless HTTP 的客户端本地取消外推为 server abort。分页测试必须覆盖短页、精确上限、`maxItems=0` 和非法 `perPage`，GitHub 每页范围固定为 1–100，避免零页大小导致无限请求。证据适配器按 CI/review/release/security 的 verified/failed/pending/unverified/not-applicable 与 partial 组合做表驱动回归。

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

`npm run test:coverage` 当前执行全局最低门槛：statements 94%、branches 89%、functions 94%、lines 95%，并输出 text、LCOV 与 `coverage/coverage-summary.json`。当前基线为 1327 个测试、96.46% statements / 91.26% branches / 97.17% functions / 97.22% lines；门槛刻意保留 Node 22/24 插桩余量。新增边界覆盖包括扫描器 Workflow 精确 provenance、无关 Workflow 负例、重命名前路径、双扫描器逐 signal 隔离、自定义 Gitleaks/TruffleHog 配置、动态/绝对/穿越/歧义参数拒绝、合法空格/括号仓库路径、Actions API 失败、旧 provenance 缺口清理、输入不可变、非法 URL/YAML/workflow AST、不可用 base Workflow 内容、嵌套模板词法状态、scanner provenance/workflow fixture 元数据误判、JSON/lockfile 普通成员分隔扫描、新旧 package-lock 与 npm-shrinkwrap 包成员形状、真实 node_modules/scoped package member 负例、package metadata 不能自证豁免、package-shaped scalar 不豁免、跨 hunk 结构隔离、转义与斜杠凭据键、编号凭据目标、中立键后的已知裸密钥格式、凭据键/值/容器跨行分组、quoted/unquoted scalar 与 array/object literal、placeholder、嵌套 literal 去重、UI/DOM `accessKey` 负例、多行/嵌套 ternary operator 识别、Ruby predicate/Rust postfix question mark 分隔、Swift/PHP/Dart/Elixir question-mark syntax、C/C++ ternary comma-expression/decimal literal、多行 credential ternary 延续、同行多 member continuation、凭据相关同 hunk context taint、split context key 的 100 行/64 KiB fail-closed、20,000 行 JSONC 线性 lookahead，以及单行/凭据容器/operator/work 上限 fail-closed、T7 scenario/trace schema drift、Unicode code-point 边界、工具集合互斥、必选 gate 闭包、顺序/gate 环、调用数、安全 gate、固定 golden digest、provenance 与阈值边界、GitHub Issue/PR 混合元数据归一化、HTTP Host/Origin 前置于有界 JSON parsing、双时代 negotiation/取消/关闭、pending factory 结算与 modern handoff 同 tick 竞态、跨时代 header/body 冲突、有界 factory 错误、全工具双时代真实调用，以及 Inspector stdio/HTTP/认证/完整 discovery、Conformance artifact 与网络/退出/cleanup 边界。真实动态 credential 与 header sink 的正向控制保持 fail-high。

旧版 lockfile 的局部 diff 如果没有包含其 `dependencies` 父对象，补充启发式无法证明该 member 的结构位置，会保守保留 credential finding；这是避免由不连续或恶意 hunk 伪造父结构而关闭扫描的 fail-high 取舍。完整 lockfile、`node_modules/...` 键、scoped package 键，以及同一 hunk 内可验证的旧 `dependencies` 结构均有独立负例。

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
npm run contracts:inspector:install
npm run contracts:inspector:stdio
npm run contracts:inspector:http
npm run contracts:conformance:install
npm run contracts:conformance:pilot
npm run smoke
npm run check:line-endings
```
