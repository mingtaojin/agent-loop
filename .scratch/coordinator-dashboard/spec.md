Status: ready-for-agent

# 项目协调者任务看板规格

## Problem Statement

项目协调者目前只能从全局任务列表和单个任务的调试流中查看执行情况。项目成员关系由 ProjectLedger 保存，但 Dashboard 没有按项目协调者展示成员任务的只读视图。Worker 的可见过程文字和任务状态分散在任务记录与执行事件中，用户难以快速判断某个任务正在做什么、是否卡住，以及最近一次可见进展是什么。

当前执行事件还会为工具输出增量写入大量数据库行。用户需要保留 Codex CLI 风格的 Agent 可见过程文字，但不需要保存工具输出正文，也不需要隐藏模型推理记录。

## Solution

提供一个只读的两层项目看板。

- 项目总览按 ProjectLedger 的项目边界展示协调者、Worker、verifier、已路由 intake、已结束任务和历史任务。总览只显示任务卡片和每个任务的最近活动，不建立跨 Worker 的总时间线。
- 任务深钻展示单个任务的可见执行说明、Turn 状态、工具调用元数据、错误、结构化工作汇报和完整可见文字历史。
- 看板监听网络地址，任何能连通端口的电脑都可以访问，不使用登录、token 或项目级鉴权。
- 看板不保存工具输出正文、隐藏 chain-of-thought、reasoning 或私有 textDelta。
- 任务的可见文字和报告历史永久保留。连续增量可以合并成有界块或最终消息，不要求保留每个原始 delta 行。

## User Stories

1. As a project owner, I want to open a project dashboard, so that I can see every task owned by its coordinator.
2. As a project owner, I want the dashboard to use the project membership relation, so that shared directories do not put a task in the wrong project.
3. As a project owner, I want to see the coordinator task, Worker tasks, verifier tasks, routed intake tasks, and finished tasks together, so that the project view reflects the full responsibility boundary.
4. As a project owner, I want unassigned intake requests excluded from a project board, so that an unclaimed request is not mistaken for project work.
5. As a project owner, I want each task card to show its role, source, Issue association, status, execution status, current Turn, last activity, and waiting reason, so that I can triage the project without opening every task.
6. As a project owner, I want to search and filter task cards by title, task ID, role, status, repository, and Issue, so that I can find one task in a large project.
7. As a project owner, I want finished and historical tasks to remain visible, so that I can review what the project delivered.
8. As a project owner, I want the task deep dive to show the Agent text that Codex CLI would show during execution, so that I can follow the Worker’s visible progress.
9. As a project owner, I want the task deep dive to preserve the complete visible Agent text and report history, so that I can review a task after it finishes.
10. As a project owner, I want Turn start, Turn end, retry, interruption, and error facts, so that I can distinguish active execution from a completed task.
11. As a project owner, I want tool invocation metadata such as tool name, start, finish, status, and exit code, so that I know what the Worker attempted without storing tool output.
12. As a project owner, I want tool output bodies omitted from persistence, so that high-volume commands do not grow the database quickly.
13. As a project owner, I want consecutive visible Agent deltas coalesced, so that the dashboard remains live without creating one database row per token or transport fragment.
14. As a Worker, I want ordinary conversation to remain free-form, so that normal task discussion does not need a rigid schema.
15. As a Worker, I want an explicit report to capture the current step, next step, blockers, and evidence, so that the coordinator can act on a stable progress summary.
16. As a project owner, I want structured reports shown in the task deep dive, so that a progress update is distinct from a final answer or a Turn ending.
17. As a project owner, I want hidden model reasoning and private text deltas excluded, so that the dashboard shows observable work rather than private internal reasoning.
18. As a project owner, I want the dashboard to remain read-only, so that opening it cannot dispatch, pause, resume, approve, retry, or modify a task.
19. As a project owner, I want the dashboard to work from persisted SQLite facts, so that a page refresh or Runtime restart does not erase visible history.
20. As a project owner, I want an interrupted event stream to resume from persisted visible events, so that a temporary browser disconnect does not lose the task narrative.
21. As a project owner, I want long visible messages bounded by the UI and transport, so that one task cannot freeze the browser or exhaust the response buffer.
22. As a project owner, I want the dashboard to display runtime heartbeat separately from task progress, so that a live service is not mistaken for a progressing Worker.
23. As a project owner, I want task completion, Worker report, independent verification, PR merge, and deployment to remain distinct facts, so that the board does not claim delivery too early.
24. As an operator, I want the existing single-task SSE and history behavior preserved where it remains compatible, so that existing debugging workflows do not disappear during the project view change.
25. As a maintainer, I want the project view to avoid a second durable activity journal, so that Task and ProjectLedger remain the facts of record.

## Implementation Decisions

- Use ProjectLedger membership and coordinator identity as the project boundary. Do not infer project ownership from workspace paths or resource names.
- Add a read-only project dashboard reader that combines ProjectLedger, Task records, inbox and outbox records, diagnostics, and execution events. Keep aggregation out of the HTTP route handler.
- Add project overview and task detail read APIs. Keep the existing single-task history and SSE contracts where compatible.
- Project overview returns task cards and each task’s latest activity. It does not create or persist a cross-Worker timeline or project activity journal.
- Task detail returns visible Agent messages, lifecycle events, structured reports, tool invocation metadata, and errors. It does not return tool output bodies, provider raw payloads, hidden reasoning, or private text deltas.
- Keep ordinary Worker messages free-form. Treat explicit `report(update|question|result)` as structured work reports with current step, next step, blockers, and evidence.
- Keep full visible message and report history indefinitely. Coalesce adjacent visible deltas by task, Turn, and item before durable storage or store a final visible message with bounded in-progress chunks.
- Keep tool lifecycle metadata such as tool identity, status, timing, and exit code. Do not persist command stdout, stderr, MCP result bodies, dynamic-tool content, or file diff bodies. Keep file paths and change status only when needed for the task view.
- Keep the dashboard read-only. Every dashboard route is a read route. It cannot call project actions or native approval handlers.
- Bind the dashboard to a network address and preserve the user’s decision to require no authentication. The board is a global read-only view for any client that can reach the port.
- Use existing global execution sequence values for single-task replay. Do not add a second durable project sequence unless later measurements prove that query-time aggregation cannot support the board.
- Bound visible text at the API and UI boundary. Preserve complete logical content in the durable visible history while avoiding unbounded DOM or response bodies.
- Treat runtime heartbeat, task state, report state, verification, merge, and deployment as separate facts.

## Testing Decisions

- Test externally visible behavior through the existing HTTP, SQLite, SSE, and browser harness seams. Do not assert private helper calls or SQL statement shape.
- Extend Dashboard integration tests with a project containing a coordinator, Worker, verifier, routed intake, finished task, and unassigned intake. Assert correct inclusion and exclusion by membership.
- Assert that project cards contain task status, role, latest visible activity, and waiting facts without exposing another project’s task.
- Assert that task detail and SSE contain visible Agent text, Turn lifecycle, tool metadata, reports, and errors while omitting tool output bodies, private reasoning, private text deltas, raw provider payloads, and file diff bodies.
- Assert that repeated visible deltas are coalesced or replaced by a complete visible message without duplicated text.
- Assert that ordinary free-form messages remain unchanged and structured reports expose current step, next step, blockers, and evidence.
- Assert that dashboard routes remain read-only and cannot create or control tasks.
- Assert that event replay after a Last-Event-ID resumes visible events without cross-task leakage.
- Assert that long visible text is bounded at the API and UI seams while the stored logical content remains recoverable.
- Reuse the existing `test/dashboard.test.ts`, `test/project-runtime.test.ts`, and browser verification patterns instead of creating a second fake execution stack.

## Out of Scope

- A cross-Worker project activity timeline.
- A project activity index or independent project event journal.
- Persisting or displaying tool stdout, stderr, MCP results, dynamic-tool bodies, or full file diffs.
- Persisting or displaying hidden model reasoning, chain-of-thought, reasoning deltas, or private provider fields.
- Dashboard login, token authentication, project-level authorization, or user-specific visibility.
- Dashboard controls for dispatch, pause, resume, approval, retry, model selection, merge, deployment, or cleanup.
- Automatic task scheduling, project workflow stages, PR state machines, or deployment gates.
- Automatic deletion or compaction of visible Agent and report history.

## Further Notes

The existing execution event projection currently accepts tool output deltas. Implementation must change the persistence and dashboard projection so the new contract is true at the storage boundary, not only hidden by the page. The project dashboard is a read model over existing task and project facts. A future performance index requires a new decision and a rebuild path.
