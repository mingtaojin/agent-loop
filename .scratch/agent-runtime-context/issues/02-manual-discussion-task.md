# 02: 从飞书私聊新建无仓库讨论 Task

Status: ready-for-agent

Implementation: complete at 09fe3f6.

Acceptance: complete. Genuine private-chat creation, new group, original Thread continuation and real replies independently VERIFIED.

**What to build:** 在机器人私聊明确新建，携带首条文字或材料创建独立任务群，在原会话中讨论；没有目标或仓库也可使用。

**Blocked by:** 01: 让已有 Task 支持通用答复与等待

**User stories:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 17, 19, 36, 58, 69, 70

- [x] 无需 GitHub 来源、工程仓库或 Bug 模板即可新建讨论 Task；初始内容进入新群关联的原会话。
- [x] 一 Task 一群，共用应用机器人；重复新建投递不产生重复 Task、群或 Thread，群内不自动拆话题。
- [x] 创建时不产生工程 worktree；任务上下文目录与将来的工程资源分离。
- [x] 任务持久化支持人工来源和零个工程资源；旧 GitHub 任务的来源、群、Thread、目录、分支与未处理消息保持关联，迁移可验证。
- [x] 讨论回复后等待，后续群内消息继续同一 Thread，正常重启保留对应关系。
- [x] 通过服务级迁移及人工创建测试，并完成实际飞书私聊新建、群内答复和原会话续接演示；配置与权限不足应真实报告。

## Comments

2026-11-05：[独立审查](../execution/evidence/runtime-review/report.md)验证迁移、去重及实际无仓库 CLI 启动。服务测试使用受控平台；[在线验证](../execution/evidence/platform-review/report.md)复用已有验证群，没有验证真实私聊新建群。最后一项保持未勾选。

2026-11-05：上述为本轮真人验收前的历史状态。[最终独立审计](../execution/evidence/acceptance-review/final-audit.md)已核对真实 p2p 消息、新建人工 Task、独立群、零初始工程资源、原 Thread 后续输入及实际飞书答复。最后一项现已通过，验收完成。

