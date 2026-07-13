# 测试策略与资产维护

本项目的测试目标不是单纯提高覆盖率，而是让 AI coding agent 在真实 MCP 契约、GitHub 状态变化和恶意外部输入下仍得到可解释、可审查、不会静默放行的结果。

## 测试分层

1. **纯逻辑单元测试**：覆盖分类、策略匹配、排序、截断、状态归一化和 fail-closed 决策。优先表驱动测试，边界至少包含 `0 / 1 / limit / limit + 1`。
2. **工具处理器测试**：向导出的 handler 注入 `RepoRef` 和 mock Octokit，验证 GitHub 请求参数、结构化输出、Markdown、安全降级及 dry-run 不写入。
3. **协议集成测试**：使用 `createAgenticSdlcServer()`、真实 MCP SDK `Client` 与 `InMemoryTransport`，覆盖 initialize、工具/资源发现、schema 默认值、协议错误以及代表性的端到端工具调用。
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

## 动态运行感知的边界

`src/__tests__/fixtures/mcp-client.ts` 是内存协议测试的共享入口。它连接生产 server factory 和 SDK 内存 transport，不监听端口、不访问网络，但会执行真实 MCP 初始化、schema 校验、注册路由和序列化流程。工具运行测试只 mock GitHub 客户端边界，因此能捕获“单元 handler 正确但注册/schema/协议默认值错误”的问题。HTTP 生命周期测试另行绑定 `127.0.0.1` 随机端口，验证并发请求隔离与清理；测试 setup 允许 loopback/本地 IPC，但在连接前拒绝所有外部 fetch 和 socket。

涉及远程 HTTP、OAuth、多租户 request context 或取消/超时的能力落地后，应增加真实 HTTP transport 的本地端到端套件；在此之前，不得用内存 transport 测试声称已经验证网络层安全。

## Fixture 与长期维护

- 共享 fixture 只抽取稳定基础设施或领域构造器，不隐藏测试关键差异。测试应在用例附近直接写出决定结论的字段。
- 禁止复制完整 Octokit 响应。只构造当前契约消费的最小字段，新增字段时由失败测试说明原因。
- 一个生产缺陷至少保留一个能复现原始失败的回归用例；安全缺陷同时断言“危险内容不存在”和“合法证据仍保留”。
- 避免只断言快照或大段 Markdown。优先断言结构化决策，再检查关键安全文本、边界标记和 schema 契约。
- 测试不得依赖执行顺序、真实 home、真实 token、当前时间或持续变化的公开仓库。
- 测试名称描述业务规则和失败条件，不描述实现函数的内部步骤。

## 覆盖率门槛

`npm run test:coverage` 当前执行全局最低门槛：statements 92%、branches 87%、functions 93%、lines 93%，并输出 text、LCOV 与 `coverage/coverage-summary.json`。

门槛用于阻止回退，不是完成定义。新增高风险模块应优先达到更高的局部覆盖，尤其是权限、策略、证据截断和写入边界。提高门槛前先观察完整套件的稳定基线并保留合理余量；降低门槛、扩大 exclude 或删除断言必须在 PR 中单独解释，不能作为通过 CI 的快捷方式。

## 常用命令

```powershell
npm run test
npm run test:integration
npm run test:coverage
npm run typecheck
npm run build
npm run smoke
```
