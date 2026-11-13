# 项目责任与 Task 执行身份分开保存

项目协调者和 Worker 复用 Task 的输入、执行与恢复机制。ProjectLedger 保存项目关系、请求回执、Issue 修订和项目决定，使用现有 SQLite 写入者与事务。与建立第二套协调者执行系统相比，这避免重复原生审批和消息恢复逻辑，同时让项目责任跨协调 Thread 延续。

[ADR 0012](0012-on-demand-task-groups.md) 将任务群改为可选交互入口。协调者保留项目群，Worker 默认无群，只有用户请求直接对话或原生审批时才建群。群失效不能结束或失败整个任务。

Runtime 提供通用项目工具和事件投递，不解释 pstack 工程阶段。协调者用 Orchestrate 决策，Worker 用 poteto-mode 组织工作。协调消息保留代理来源，不能冒充用户授权。
