# 07: Issue 更新与评论进入原 Task

Status: ready-for-agent

Implementation: complete at 09fe3f6.

Acceptance: complete. Actual isolated private GitHub Issue updates/comments, native original conversations and real Feishu readback independently VERIFIED. Business Issues were not modified.

**What to build:** 原 Issue 的内容、状态、分配、标签变化和评论，在运行时追加、空闲时唤醒原会话。

**Blocked by:** 05: 所有普通消息及时进入原会话

**User stories:** 44, 46, 47, 48, 49, 50, 51, 52

- [x] 扩展原 Issue 更新及评论输入，保留来源、评论身份和变化证据；不创建独立评论 Task。
- [x] 已有来源不再匹配筛选条件时仍向原 Task 传递变化，不由 Runtime 暂停或要求重新满足条件才能继续。
- [x] 活跃时追加、空闲和正常等待时唤醒原 Thread；外部事件不能被当作用户答复或批准。
- [x] 重复读取或无事实变化不重复唤醒；分页、断线补收、消息去重和投递中断得到验证。
- [x] 验证外部输入与轮次结束、用户输入并发时的关联和唯一执行；至少包含 Issue 关闭及新增评论。
- [x] 使用现有服务级边界测试并验证实际 Issue 更新与评论送入任务群对应的 Codex 会话；不接入 PR/CI 自动事件。

## Comments

2026-11-05：[独立审查](../execution/evidence/runtime-review/report.md)验证关闭、评论、来源失配、并发与 A/B/A/B 事实转换，保留来源身份且不冒充人工回答。没有授权修改真实业务 Issue 或评论，因此真实变更送达对应在线会话的末项仍未验证。

2026-11-05：使用专用私有验收仓库的两个真实 Issue 补齐末项，未修改业务 Issue。[最终独立审计](../execution/evidence/acceptance-review/final-audit.md)核对实际 GitHub 身份、正文更新、评论和关闭失配事实，经正常适配器进入原 Task/Thread，并由实际飞书读回证明答复。验收完成。

