# 正式任务与工程入口选择共用本机 Codex 服务

2026-11-14，用户要求 Agent Loop 复用本机 Codex 已有的共享 App Server，工程入口选择也使用该服务。正式任务保持各自持续的 Thread；工程入口选择保持独立的临时 Thread，选择历史不进入正式任务。共享执行服务与会话上下文分开管理，避免为每次目录选择启动额外的 App Server。

共享 daemon 未运行时，允许通过 Codex 官方 daemon 管理入口启动；已运行时直接连接。连接中断后重新连接并核对已保存的执行状态。Agent Loop 不主动停止或重启共享 daemon，也不在连接失败时另建私有 App Server。服务停止、选择完成或取消时，仅处理 Agent Loop 自己管理的执行、Thread 和连接，不干预其他客户端的任务。

本决策替换 [ADR 0008](0008-temporary-workspace-selection.md) 中“每次选择使用独立临时 App Server，随进程释放”的要求。该 ADR 中独立临时上下文、只读、无审批、无动态工具、选择模型可配置，以及原始材料和用户答复完整进入正式任务的约定继续适用。原任务的 Thread 身份和工程资源继续保留；共享服务不意味着合并任务上下文或调整业务授权。

已确认设计尚未实现。当前契约、验证范围和后续代码设计记录在[共享 Codex 服务规格](../../.scratch/shared-codex-app-server/spec.md)。
