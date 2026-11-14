Status: ready-for-agent

# 协调群消息白名单与外部 Feature 授权

## Problem Statement

GitHub Issue、评论和接单请求进入项目协调者后，协调者每次处理后台事件都可能把普通最终答复发到项目协调群。Issue 数量增加后，群消息被自动分析和进度答复淹没，用户难以找到真正需要处理的决定、阻塞和交付结论。

GitHub Feature 还存在另一条边界。Feature Issue 即使描述完整，也只是外部需求提案。Issue 作者、Issue 评论和 Worker 判断不能代表项目所有者决定开发。当前接单流程没有把“调查授权”和“开发授权”明确分开。

## Solution

项目协调群使用可见消息白名单。用户直接在项目协调群发送消息后，协调者的普通最终答复继续显示。后台 GitHub 事件和 Worker 的 `report` 只进入协调者 Thread、执行记录和进度文档。协调者需要把后台处理结果带回群时，调用新的 `announce` 项目动作。

`announce` 只允许项目协调者调用。动作包含稳定的 `requestId`、公告类型和正文。Runtime 按现有项目动作的幂等规则处理重复请求和内容冲突，并将公告作为带类型标题的普通文本发送到项目协调群。公告成功后，同一轮普通最终答复不再重复发送。

GitHub Feature 首先作为外部需求提案进入 intake。协调者可以派只调查、只澄清或只整理需求的 Worker。该委派禁止修改业务代码、提交实现、合并和部署。只有项目协调群中的实际项目所有者明确授权开发后，Feature 才能进入实现交接。调查授权不等于开发授权。用户已经明确授权实现时，调查只是实现前步骤且范围未变化，原授权继续有效。新规则不追溯已经依据有效授权进入执行的 Feature。

## User Stories

1. As a project user, I want ordinary replies to my project-group messages to remain visible, so that the coordinator still feels like a direct conversation.
2. As a project user, I want GitHub Issue processing to stay out of ordinary group messages, so that background collection does not bury decisions.
3. As a project user, I want GitHub Issue comments to stay in the coordinator context, so that raw external discussion does not create chat noise.
4. As a project user, I want GitHub-derived intake requests to stay out of ordinary group messages, so that one Issue does not create repeated visible replies.
5. As a coordinator, I want to keep all GitHub facts and comments in the Thread, so that suppressing a chat message does not remove evidence.
6. As a coordinator, I want Worker and verifier reports to reach my Thread without direct group delivery, so that I can assess their impact before addressing the user.
7. As a coordinator, I want to publish a user-facing message explicitly, so that I control which background conclusions appear in the group.
8. As a coordinator, I want to label an announcement as a decision request, blocker, approval prompt, or delivery conclusion, so that users can understand what action is needed.
9. As a project user, I want announcements to use ordinary text, so that the feature does not require new card permissions or a separate interaction surface.
10. As a project user, I want announcement text to include the complete user-facing content, so that the hidden coordinator reply is not needed to understand the message.
11. As a project user, I want an announcement and its triggering coordinator reply to appear only once, so that an explicit announcement does not duplicate the same conclusion.
12. As an operator, I want repeated announcement requests with the same request identity to be safe, so that retries do not create duplicate group messages.
13. As an operator, I want a changed announcement body under an existing request identity to fail, so that a retry cannot silently change the user-visible result.
14. As a project user, I want native questions, approvals, permission requests, and explicit Runtime failures to retain their existing notification paths, so that the new policy does not hide urgent actions.
15. As a project user, I want a GitHub Feature to be treated as a proposal, so that external requests do not silently become product commitments.
16. As a coordinator, I want to dispatch a read-only Feature investigation, so that I can learn about scope, dependencies, and cost before requesting a product decision.
17. As a coordinator, I want an investigation assignment to carry an explicit no-implementation boundary, so that a clarification task cannot accidentally modify business code.
18. As a project user, I want an investigation result brought back to the project group for a decision, so that the next implementation step is explicit.
19. As a project user, I want my project-group authorization recorded with its message and sender identity, so that the development decision can be audited.
20. As a coordinator, I want GitHub Issue text and comments excluded from authorization, so that an external contributor cannot grant project implementation permission.
21. As a coordinator, I want an explicit implementation authorization to remain valid while the agreed scope is unchanged, so that the user is not asked the same question twice.
22. As a project user, I want a changed scope, product behavior, cost, or dependency to return for a new decision, so that an old authorization does not silently expand.
23. As an operator, I want the new Feature authorization rule to apply only to new dispatches, so that existing authorized Tasks, Threads, resources, and PRs are not interrupted.
24. As a maintainer, I want Bug handling to remain separate from Feature authorization, so that clear technical fixes within an existing contract can proceed under the project rules.
25. As a maintainer, I want the existing AgentLoop integration seam to prove these behaviors, so that tests cover actual task, Thread, inbox, outbox, and Feishu boundary behavior.

## Implementation Decisions

- Extend the project action discriminated union with `announce`.
- `announce` carries `requestId`, `kind`, and `text`. `kind` is one of `decision`, `blocker`, `approval`, and `delivery`.
- Only a coordinator member can call `announce`. The action targets that member's project coordinator group.
- Reuse the existing project action receipt and request fingerprint rules. Identical retries return the original result. Reusing a request identity with changed content fails.
- Store the announcement in the existing outbox path. Use a stable delivery key derived from the coordinator Task and request identity.
- Render the user-visible message as ordinary text with one generated type heading. Use `【需要决定】`, `【任务阻塞】`, `【需要处理审批】`, or `【交付结论】`.
- Do not add Feishu reply threading, interactive cards, or a second notification transport.
- Coordinator final output remains visible automatically when the turn includes a direct project-group user message.
- Coordinator final output triggered only by GitHub events, GitHub-derived intake, or Worker and verifier reports does not create an ordinary group message. The output remains in the Thread and execution history. A coordinator uses `announce` for user-visible conclusions.
- Preserve the existing native question, approval, permission, failure, and explicit Runtime notification paths.
- Do not change the collection criteria or the project ledger. GitHub facts, comments, intake material, and task records remain queryable.
- Treat GitHub Feature issues as external demand proposals. Collection does not imply implementation authorization.
- Allow a coordinator to dispatch a Feature investigation or clarification task with an explicit no-implementation instruction.
- Require a project-group message from the actual project owner before dispatching Feature implementation. Save the message ID, group ID, sender ID, and original text in the project record or handoff evidence.
- Do not require a fixed authorization phrase. The coordinator interprets the user's natural-language decision and records the evidence.
- Keep investigation authorization separate from implementation authorization. A clear investigation result does not start implementation without a new decision.
- Reuse an existing implementation authorization when the agreed scope and acceptance conditions remain unchanged. Reconfirm only the affected decision when the investigation changes scope, product behavior, cost, or dependencies.
- Apply the Feature rule only to new dispatches. Do not pause, reclaim, reassign, or alter existing authorized Feature Tasks.

## Testing Decisions

- Test through the existing AgentLoop integration fixture with real temporary SQLite and controlled Codex, Feishu, GitHub, and workspace ports.
- Test observable delivery rather than private helper calls. Assert which inputs reach the coordinator, which outbox messages are created, which Feishu messages are sent, and which Thread identity remains unchanged.
- Verify a project-group user message still produces one visible coordinator reply.
- Verify GitHub Issue, GitHub comment, GitHub-derived intake, and Worker reports reach the coordinator without ordinary group output.
- Verify `announce` creates one typed text message, survives duplicate retries, and rejects changed content under the same request identity.
- Verify a user-triggered turn that calls `announce` does not send a second ordinary final reply.
- Verify native questions, approvals, permission requests, and Runtime failure notifications retain their existing behavior.
- Verify only coordinators can announce and that cross-project or worker calls fail at the project action boundary.
- Verify Feature intake can be investigated with a no-implementation instruction but cannot be dispatched as development without recorded project-group authorization.
- Verify GitHub Issue text, comments, and Worker judgments cannot satisfy the Feature authorization rule.
- Verify an explicit implementation authorization remains usable when scope is unchanged, while a changed scope requires a new decision.
- Verify existing authorized Feature Tasks remain untouched when the new rule is applied.
- Run focused project-runtime and Runtime tests first, then type checking, build, and the complete local test suite.

## Out of Scope

- Redesigning the task board or adding a project-wide task overview.
- Batching GitHub collection requests or changing GitHub polling frequency.
- Changing repository, label, assignee, state, or task-type collection criteria.
- Adding Feishu cards, reply threads, reactions, or a new notification service.
- Automatically deciding that a Feature is valuable, in scope, or approved because an Issue is detailed.
- Automatically closing Issues, merging PRs, deploying services, or restarting the Agent Loop service.
- Retrospectively stopping or reauthorizing existing Feature Tasks.
- Replacing the coordinator's Thread, progress document, project records, or existing native approval flow.

## Further Notes

The design was confirmed through `grill-with-docs` before implementation. The domain terms and tradeoffs are recorded in the project glossary and ADRs 0017 and 0018.

The highest test seam is the existing AgentLoop integration boundary. No new chat mode, parser, or parallel coordination service is needed. The Runtime owns delivery and authorization boundaries. The coordinator owns product judgment and the decision to publish an announcement.
