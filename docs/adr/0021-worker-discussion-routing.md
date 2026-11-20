---
status: accepted
---

# Worker discussion routing

本 ADR 细化并取代 ADR 0017 中 Worker report 统一进入协调者 Thread 的路由约定。

2026-11-14，项目所有者确认 Worker 在自己的任务群使用 grill-with-docs 与项目所有者讨论。中间问题和讨论留在 Worker 群。2026-11-20，项目所有者要求所有发给协调者的 Worker 汇报都由用户明确发起。

`project_action` 的 `report` 动作保存一个结构化 `routing` 字段。

- `intermediate` 表示普通问题和讨论。Runtime 要求 Worker 已经有任务群，把正文写入该 Worker 的 outbox，并且不写入协调者 inbox。
- `final` 表示最终结论。Runtime 将汇报写入协调者 inbox。
- `escalation` 表示必须协调的事项。`escalation` 必须是 `authorization`、`scope_change` 或 `blocker`，通过用户请求校验后写入协调者 inbox。

没有显式 `routing` 时，`result` 使用 `final`，`question` 和 `update` 使用 `intermediate`。要求同步的 `update` 必须显式使用 `routing=final`。

Runtime 从 Worker 任务中收集用户消息的 `messageId`、`chatId` 和 `senderId`，再合并汇报显式提供的 `sources`。最终汇报和升级汇报把这些来源放入 agent provenance。中间汇报把完整审计资料写入 SQLite `meta`，正文只进入 Worker outbox，不进入协调者项目报告。

路由先通过项目成员关系校验。Worker 不能为其他项目创建汇报。中间汇报没有有效任务群时失败关闭，不降级发送给协调者。跨群汇报使用 Worker 群明确请求汇报的所有者消息 ID 作为 `requestId`。Runtime 校验实际收到的消息及其当前群绑定。同一消息只对应一份汇报，投递记录与回执一起写入 SQLite。

这项决策只改变 Worker `report` 的去向。普通用户输入仍按任务群路由，原生问题、审批和权限请求仍使用原有路径。项目协调者仍只能通过 `announce` 发送协调群公告。


2026-11-20 修复记录。任务群的普通问答默认通过普通最终答复发布。`routing=intermediate` 用于继续执行期间需要立即发布的讨论。两种路径可以发布不同的消息，不以文字相似度或“本轮已汇报”合并。

已接收入队且绑定可信执行身份的 intermediate report 回执提供 `acknowledgement` 指导。Worker 需要用文字结束一条已经发布的答复时，调用 `acknowledge_report`，引用该 report 的 `reportRequestId`，并明确指定即将输出的完整 `finalText`。Runtime 校验任务、原 Thread、Turn 和原投递目标，只省略这一条明确确认的 final 副本。确认信息通过工具回执传递，不向群聊发送协议标记。未确认的普通 final、新发现、用户后续输入产生的答复及原生问题、审批继续正常处理。

这项修复保证遵守显式确认约定的发布流程只投递一次。没有关联身份的旧式 report 加改写 final 仍是两个发布，不自动推断其语义相同。回执中的 queued 只承诺持久化入队；发送结果未知仍遵循现有保守恢复策略。
