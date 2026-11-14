---
status: accepted
---

# Worker discussion routing

本 ADR 细化并取代 ADR 0017 中 Worker report 统一进入协调者 Thread 的路由约定。

2026-11-14，项目所有者确认 Worker 在自己的任务群使用 grill-with-docs 与项目所有者讨论。中间问题和讨论留在 Worker 群。协调者只接收最终结论。授权、范围变化和阻塞可以提前上报。

`project_action` 的 `report` 动作保存一个结构化 `routing` 字段。

- `intermediate` 表示普通问题和讨论。Runtime 要求 Worker 已经有任务群，把正文写入该 Worker 的 outbox，并且不写入协调者 inbox。
- `final` 表示最终结论。Runtime 将汇报写入协调者 inbox。
- `escalation` 表示必须协调的事项。`escalation` 必须是 `authorization`、`scope_change` 或 `blocker`，并且 Runtime 立即写入协调者 inbox。

没有显式 `routing` 时，`result` 使用 `final`，`question` 和 `update` 使用 `intermediate`。这个默认值让旧调用保持可解析，同时把普通讨论导向任务群。要求同步的 `update` 必须显式使用 `routing=final`。

Runtime 从 Worker 任务中收集用户消息的 `messageId`、`chatId` 和 `senderId`，再合并汇报显式提供的 `sources`。最终汇报和升级汇报把这些来源放入 agent provenance。中间汇报把完整审计资料写入 SQLite `meta`，正文只进入 Worker outbox，不进入协调者项目报告。

路由先通过项目成员关系校验。Worker 不能为其他项目创建汇报。中间汇报没有有效任务群时失败关闭，不降级发送给协调者。每个动作继续使用稳定 `requestId`。SQLite 的 inbox、outbox、meta 和 project receipt 让重试、重启和部分完成保持幂等。

这项决策只改变 Worker `report` 的去向。普通用户输入仍按任务群路由，原生问题、审批和权限请求仍使用原有路径。项目协调者仍只能通过 `announce` 发送协调群公告。
