Status: ready-for-agent

# Worker 讨论按需同步与协调者事件触发

## Problem Statement

用户在 Worker 任务群中讨论时，用户消息和 Worker 每轮最终答复都会自动传给项目协调者。这会打断尚未结束的讨论，并使协调者处理用户尚未要求同步的信息。

Runtime 还会在项目存在 Worker 时周期生成监督提醒。即使所有 Worker 已空闲，协调者也可能反复启动，没有新事实可处理。

## Solution

用户与 Worker 的普通聊天保留在原任务。用户说“同步给协调者”后，Worker 直接发送一次讨论摘要，包含已定结论、范围变化、待决问题和证据来源，保留实际用户消息来源。用户可以指定只同步某个话题。

Worker 和 verifier 通过明确的工作汇报提交正式问题、进展或成果。普通最终答复不再自动回传。运行异常、原生问题、审批、GitHub 更新和必要生命周期事件继续通知协调者。移除定时监督，没有新事件时协调者持续等待。

## User Stories

1. As a task owner, I want ordinary messages in a Worker group to stay with that Worker, so that I can discuss unfinished ideas without interrupting the coordinator.
2. As a task owner, I want ordinary Worker replies to stay in the task, so that each chat response does not trigger another coordinator turn.
3. As a task owner, I want to request discussion synchronization in natural language, so that I can decide when a discussion is ready to share.
4. As a task owner, I want a discussion summary to state confirmed conclusions, so that the coordinator can act on the agreed facts.
5. As a task owner, I want scope changes and unresolved questions included in the summary, so that the coordinator sees what changed and what still needs a decision.
6. As a task owner, I want evidence and actual user message sources preserved, so that the coordinator can check the summary and distinguish user decisions from agent judgments.
7. As a task owner, I want to synchronize only a named topic when I specify one, so that unrelated discussion stays in the task.
8. As a task owner, I want the requested summary sent directly, so that synchronization does not introduce another preview confirmation.
9. As a Worker, I want one explicit reporting channel for formal questions, updates and results, so that ordinary conversation is distinct from project reporting.
10. As a Worker, I want to report the result of independent execution explicitly, so that ending a conversational turn is not mistaken for submitting a result.
11. As a verifier, I want the same explicit reporting contract, so that my ordinary replies do not bypass the agreed communication boundary.
12. As a coordinator, I want explicit reports to arrive in my existing Thread, so that I retain the project's continuous context.
13. As a coordinator, I want reports received during execution to enter the current turn, so that I can react without creating another coordinator task.
14. As a coordinator, I want failures and relevant interruptions to remain visible, so that event-driven coordination can respond to actual execution problems.
15. As a task owner, I want native questions and approval requests to retain their existing behavior, so that this change does not lose a request or fabricate approval.
16. As a coordinator, I want GitHub facts, comments and user messages in the project group to remain event sources, so that removing supervision does not remove normal intake.
17. As a coordinator, I want elapsed time alone to produce no supervision input, so that an idle project stays idle.
18. As a task owner, I want synchronization retries to reuse existing report deduplication, so that reconnecting does not duplicate a discussion report.
19. As a task owner, I want task history, Thread identity, attachments and engineering resources preserved, so that local discussion and synchronization continue the original task.
20. As an operator, I want historical configuration and stored task data to load safely after the change, so that removing a schedule does not unexpectedly prevent startup or replay obsolete reminders.
21. As a maintainer, I want tests to exercise message delivery and model-turn behavior through the runtime boundary, so that internal refactoring does not invalidate the behavior checks.

## Implementation Decisions

- Reuse the existing Task, project membership, persistent inbox and report action. Do not introduce a chat mode, separate synchronization task, new command parser or a second reporting API.
- Remove automatic owner-input forwarding from Worker task groups. The original user input still enters the Worker with its complete provenance and attachments.
- Remove automatic forwarding of nonempty final replies for both Worker and verifier tasks, whether or not they have a group. Keep task output persistence, direct-group delivery, summaries and status inspection.
- Keep the report kinds result, question and update. Each explicit report remains an event for the coordinator. Stable request identifiers and content checking continue to protect retries.
- In role guidance, distinguish an ordinary reply from a formal report. Require Workers and verifiers to report independent work results and blockers explicitly.
- Handle a natural-language synchronization request in Worker behavior. Send a sourced discussion summary through the existing report action. Default to the current discussion, respect a user-specified topic, and send directly without an extra preview step.
- Remove periodic supervision event generation and its runtime scheduling call. The current project configuration has no interval setting. A strict input compatibility decoder accepts and removes only the valid historical interval field for both explicit configuration and persisted project catalog entries. Other unknown settings still fail validation.
- Retire definitely undelivered historical automatic owner-input, final-answer and supervision copies with a dropped inbox terminal status. Preserve their payloads and reasons. Match their original project, task, provenance and generated event identity. Preserve delivered history and existing reconciliation for delivering or uncertain inputs; do not claim an attempted delivery was withdrawn.
- Preserve existing native requests, execution failures and non-pause interruptions, project-group user input, GitHub intake and revisions, project initialization, session rotation and confirmed recovery events.
- Keep ordinary polling for persisted input and execution-state observation. Polling transports or observes existing events; it does not create a reason to run the coordinator.
- Keep the distinction between user authorization and agent judgment. Reports, summaries and ordinary messages do not approve native tool requests or expand implementation, merge or deployment authorization.
- Preserve paused tasks, uncertain-delivery handling and existing project isolation. Do not force a Worker or coordinator to resume merely because a discussion is synchronized.

## Testing Decisions

- Prefer the existing AgentLoop integration seam. Drive group messages, dispatch, send, report, observed execution snapshots, elapsed time and restarts through public runtime operations.
- Assert observable behavior: which task receives an input, whether the coordinator starts or receives steering input, whether the original Worker retains the user's provenance, and whether a report is delivered once.
- Pair negative chat-forwarding checks with positive explicit-report checks, so that a broken runtime cannot pass by delivering nothing.
- Exercise Worker and verifier replies, grouped and ungrouped tasks, an idle coordinator, and an already running coordinator.
- Advance the test clock with idle project members and verify that no supervision input or model turn appears. Keep positive tests for explicit events after the clock advances.
- Reuse existing report-idempotency, restart, native-request, source-update and role-guidance tests. Update old expectations that asserted automatic owner-input or final-answer forwarding.
- Verify current and historical explicit configuration and persisted catalog loading. Assert that the parsed current configuration contains no interval and that unrelated unknown settings still fail validation.
- Verify that obsolete undelivered automatic copies remain recorded but cannot wake the coordinator across restart, pause or retry. Pair these checks with valid reports and other event sources. Preserve uncertain delivery without replay or false acknowledgement.
- Check that current role instructions reach both new and resumed formal Threads. Treat instruction checks as prompt delivery evidence, not as proof that a real model always understands a natural-language request correctly.
- Run type checking, build and the complete local test suite. Obtain independent review and a behavior verdict for the exact PR head before merging.

## Out of Scope

- Replacing polling with a push transport or changing bounded recovery policy.
- Adding a new approval flow, synchronization preview, fixed command syntax, automatic discussion timer or replacement supervision schedule.
- Changing GitHub collection rules, task assignment policy, project selection, workspaces, PR ownership or merge protections.
- Treating discussion synchronization as new implementation or deployment authorization.
- Modifying the original dirty checkout, resolving its existing merge conflicts, restarting the resident service, deploying to Windows or sending real Feishu messages.

## Further Notes

The user confirmed the reporting boundary and the default discussion summary in this conversation on 2026-11-14. The subsequent request authorizes implementation in a fresh worktree from the latest main and delivery through a PR merged into main.

The existing on-demand task-group decision sends ordinary questions and final outputs through the coordinator. This change keeps explicit work reports and native events, and replaces automatic final-reply forwarding. Update the corresponding role guidance and architecture record with the implementation.

The absence of a new event means the coordinator continues waiting. Worker silence alone no longer triggers a check or proves failure. Source tests, independent behavioral evidence, Git merge and deployment must be reported separately.

## 拉取前本地讨论记录

以下保留拉取前的本地讨论稿原文，用于追溯用户确认来源。其中“尚未实施”等状态描述属于当时的记录，不覆盖上方已经合入 main 的规格。

```markdown
Status: ready-for-agent

# Worker 群内讨论按需同步与协调者事件触发

本文件记录 2026-11-14 当前会话确认的需求。grill-with-docs 的两项产品问题均已确认，尚未修改业务代码或部署。

## 用户诉求

用户要求 Worker 群内聊天不逐条同步给协调者，可以在讨论结束后明确要求同步。同时去除定时监督，让协调者通过事件触发。

## 已确认决定

- D1：停止将用户在 Worker 任务群中的普通发言逐条自动转发给协调者。用户仍直接与原 Worker 交流。
- D2：用户可以在任务群以自然语言明确发起讨论同步，例如说“同步给协调者”，也可以指定只同步某个话题。
- D3：移除 Runtime 主动生成定时监督提醒的行为。项目存在 Worker、长时间没有活动或 Worker 全部空闲，都不再单独构成唤醒理由。
- D4：取消 Worker 和 verifier 普通最终答复的自动回传。无论是否有任务群，正式问题、进展和成果都由执行者通过 report 明确上报；用户要求的讨论同步也通过该通道传达。独立执行结束时，执行者须主动汇报结果，不能仅凭结束一轮回复替代汇报。
- D5：执行失败、非暂停路径的中断、原生问题以及审批和权限请求仍按既有事件路径通知协调者。普通消息不能代替原生审批。
- D6：收到讨论同步要求后，Worker 直接发送本次讨论摘要，包含已定结论、范围变化、待决问题和证据来源，并保留实际用户消息来源。默认不增加预览确认步骤，也不转发整段聊天记录。用户指定同步范围时按该范围整理。

## 当前契约与变更依据

| 路径 | 当前行为 | 本次变更 |
| --- | --- | --- |
| [receiveOwner](../../src/loop.ts#L724) | 用户消息进入 Worker，同时生成协调者的 owner_input。 | 按 D1 停止自动转发。 |
| [observe](../../src/loop.ts#L661) | Worker 每轮非空最终答复也生成 final_answer，与用户消息转发相互独立。 | 按 D4 取消自动回传，保留 D5 中的运行事件。 |
| [report](../../src/project-runtime.ts#L453) | Worker 主动提交 result、question、update，均生成协调者事件。 | 按 D4 承接正式汇报和讨论同步。 |
| [supervise](../../src/project-runtime.ts#L498) | 达到间隔且满足状态条件时写入监督事件，不检查 Worker 是否全部空闲。 | 按 D3 删除定时监督事件来源。 |
| [tick](../../src/loop.ts#L322) | 推进持久输入和观察执行状态，当前还调用 supervise。 | 移除监督调用；传输和状态观察本身不等于生成模型工作。 |
| [现有用户消息测试](../../test/project-runtime.test.ts#L660) | 断言 Worker 群内用户决定自动唤醒协调者并去重。 | 旧行为断言需随实现改写。 |
| [现有最终答复测试](../../test/project-runtime.test.ts#L909) | 断言最终调查答复自动唤醒协调者。 | 改为验证普通答复不唤醒，明确汇报才唤醒。 |

[ADR 0012](../../docs/adr/0012-on-demand-task-groups.md) 规定普通问题和最终输出交给协调者。D4 将其中最终输出的自动转发改为执行者明确汇报，实现时须同步更新相关指导。原规格中的[核查真实产物要求](../project-coordinator/spec.md#r09-监督依据真实产物)继续适用；本次移除的是定时触发来源。

## 确认状态

Q1 的汇报边界和 Q2 的同步内容均已确认，无剩余产品问题。Status 表示规格充分，不表示业务代码已经实现、测试通过或完成部署。

## 验收场景

- 用户在 Worker 群中普通聊天时，消息送达原 Worker，不生成协调者的 owner_input。
- Worker 完成本轮普通回复时，回复保留在原任务，不因 final_answer 自动唤醒协调者。有群和无群任务都遵循此规则。
- Worker 明确提交 report 的 question、update 或 result 时，协调者收到对应事件。独立执行结束须主动 report 结果。
- 用户要求“同步给协调者”时，Worker 直接发送一次符合 D6 的摘要。只同步某个话题的要求限制摘要范围。
- 相同 report 请求安全重试时，沿用现有 requestId 去重，不重复投递同一同步事件。
- Worker 的运行异常和原生请求仍按 D5 通知。同步摘要保留用户来源，不替代工具审批或增加授权。
- 只有时间流逝、项目存在 Worker 或所有 Worker 空闲时，不生成监督提醒，也不据此启动协调者。已有用户、GitHub、明确汇报、运行异常以及必要生命周期事件继续使用既有投递路径。

## 沿用的约束

- 沿用原 Task、Thread 和项目归属。讨论同步不创建另一个 Worker。
- 保留用户决定与代理判断的区别。同步内容不增加开发、部署或原生工具审批权限。
- 删除定时监督后，没有新的有效事件时，协调者继续等待，不凭静默推断 Worker 失败。
- 消息投递、状态观察和已发生故障的恢复与主动定时监督分别处理，本次不将其全部改成推送架构。
- 业务代码、测试调整、提交和部署尚未执行。当前工作区已有的其他修改及合并冲突不在本轮处理范围内。

## Comments

- 2026-11-14：解释“最终答复”只是 Worker 本轮回复结束，并非整个任务完成后，用户明确回复“你前面的第一条确认按照你的建议来”。Q1 已关闭，决定记入 D4 和 D5，不再重复确认。
- 2026-11-14：用户对 Q2 的默认讨论摘要、直接发送和可指定话题范围回复“确认”。Q2 已关闭，决定记入 D2 和 D6。
```
