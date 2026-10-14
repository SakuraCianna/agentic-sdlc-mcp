# 仓库开发约定

- 直接在用户当前项目目录开发，不创建 Git worktree、额外 checkout 或隔离副本。
- 使用标准特性分支命名，例如 feature/功能名、bugfix/问题名；分支名不加 codex 前缀。
- 不在默认或受保护分支直接开发，通过 Pull Request 进入主分支。
- 保留用户已有未提交改动，不覆盖、回滚或混入提交。
- Windows 终端使用 PowerShell。项目架构、安全边界与验证约定参见 CLAUDE.md。
