# 06: 同一 Task 从讨论进入多仓库工作

Status: ready-for-agent

Implementation: complete at 09fe3f6. Independent final-head new/legacy Thread verification passed with actual GitWorkspace paths, scoped native permissions and project/skill evidence.

**What to build:** 用户在原群交办工程工作后，Agent 按需使用两个仓库的独立工作目录，仍保留原 Task 和会话。

**Blocked by:** 02: 从飞书私聊新建无仓库讨论 Task

**User stories:** 12, 13, 14, 15, 28, 29, 30, 31, 32, 33, 68

- [x] 讨论 Task 在需要工程工作时按需建立或关联资源；一项 Task 支持多个仓库，不预先复制全部配置仓库。
- [x] 仓库选择、技能调用、澄清和交付由 Agent 决定，Runtime 不判断工程阶段或强制固定 PR 流程。
- [x] 使用工程目录后仍为原 Thread；项目说明加载、工作目录与实际可用权限有真实证据，不能只依赖协议 Schema。
- [x] 各仓库和各 Task 的修改隔离，原始已暂存、未暂存与未跟踪内容保持；不因多仓库能力额外授权。
- [x] 重启后所有工程资源关联保留，错误目录或分支不被自动重置；不同 Task 仍可独立运行。
- [x] 从人工讨论到两个临时仓库的最小工程工作可演示；验证实际 poteto-mode 调用和澄清上下文延续，不要求真实业务部署。

## Comments

2026-11-05：[独立当前提交探针](../execution/evidence/runtime-review/report.md)在 cwd 和系统临时可写根之外验证新旧 Thread 各两个目录、实际 AGENTS 与 poteto-mode 读取、上下文记忆和六次限定原生批准。旧 Thread 通过同一资源管理器的任务限定 IPC 访问目录。原生夹具保留未暂存与未跟踪文件；已暂存文件保护由独立重跑的真实 Git 工作区测试证明。没有扩大全局可写根或修改业务仓库。

