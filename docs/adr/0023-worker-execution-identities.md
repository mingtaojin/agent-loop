---
status: accepted
---

# Worker 在创建时固定执行身份

用户要求协调者依据创建时的相关对话，从配置允许的完整模型与推理强度配对中选择一次。Worker 任务的持续上下文跨越多轮、暂停恢复和服务重启，因此把完整执行配置与来源保存在任务中。修改或删除允许项只限制新 Worker；已有身份不可改写。协调者继续使用当前角色配置。

`execution.worker` 使用非空的完整 profile 列表。旧单 profile 作为只含一项的允许列表加载。dispatch 必须显式选择完整 `execution`，保存该选择与来源。按两个独立列表交叉生成配对、逐轮重新选择、运行中修改和静默回退均违反该约定。

旧版 dispatch 曾在同一事务保存 `project-task-model:<taskId>` 与 `project-task-effort:<taskId>`，当时唯一后端为 Codex。只有这两个键提供完整有效值时才恢复旧身份，来源保留键名。缺失或无可靠证据时，Runtime 保留任务、Thread、群、原生审批、operator-paused 状态和 held 输入，向协调者发送一次执行身份阻塞事件并停止该 Worker 的执行。当前角色配置和 Thread 的当前或最近设置都不能证明原选择。

该决策取代 ADR 0017 对 Worker 后续使用热更新配置的规定。它不增加协调者模型选择、执行后端、看板控制、手工改模型或自动模型回退。
