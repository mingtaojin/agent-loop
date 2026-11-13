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
- Remove periodic supervision event generation and its runtime scheduling call. Retire the active interval setting while keeping historical configuration load behavior deliberate and tested.
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
- Verify configuration loading after retiring supervision and make the handling of historical interval fields explicit.
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
