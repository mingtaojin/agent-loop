# 10: 完成首版真实使用与升级验收

Status: ready-for-agent

Implementation: code and operating docs complete at 09fe3f6.

Acceptance: complete. The six previously open real human/external criteria are independently VERIFIED in the recorded isolated fixture scope. This ticket is complete; the parent specification is unchanged.

**What to build:** 用真实飞书和 Codex 连通已完成的纵向能力，验证旧任务升级、讨论到工程、事件追加、审批及故障恢复的组合行为。

**Blocked by:** 03: 按配置收集并启动不同类型的 Issue；06: 同一 Task 从讨论进入多仓库工作；07: Issue 更新与评论进入原 Task；08: 将 Agent 的进展实时同步到任务群；09: 暂时故障后有限恢复原任务

**User stories:** 首版组合验收，覆盖前序票交叉路径

- [x] 前序各票自身测试与必要真实验证已完成；本票验证交叉路径，不把各票基本验收推迟到最后。
- [x] 验证旧数据升级后任务群、Thread、工作区与未处理输入保留，历史来源与新人工 Task 可共存。
- [x] 完整演示人工新建讨论、后续按需工程目录、运行中图片与日志追加、进展/最终答复及审批操作。
- [x] 完整演示配置允许的 Issue 纳入、更新和评论追加/唤醒、等待期间更新、重复事件及服务重启后继续同一会话。
- [x] 组合验证消息、审批与故障恢复的竞争；原始代码工作区和无关任务不受影响。
- [x] 运行相关自动化检查与构建，分别记录测试、协议和真实联调证据；未完成的外部环境验证明确列出，不能宣称通过。
- [x] 更新运行说明与实现状态，反映人工入口、类型配置、通用结果、故障恢复和已确定的首版排除项，不改动父规格或关闭父工作项。

## Comments

2026-11-05：[逐票报告](../execution/evidence/acceptance.md)记录 125 项独立重跑测试、真实新旧 Thread 多仓库、原生问答与审批、进度/最终答复实际飞书读回及重启不重发。真实私聊新建群、所有者上传附件、实际按钮点击和真实 GitHub 变更组合链路未完成，不将这些未勾选项改写为通过。应用及复制辅助脚本经独立审查后，38 个文件已[回写并核对](../execution/evidence/publication/report.md)，真实工作区检查与构建通过。配置和运行数据未变，未启动服务或部署。父规格未修改或关闭。

2026-11-05：真人验收补齐并完成[最终独立审计](../execution/evidence/acceptance-review/final-audit.md)，77 项一致性检查通过。真实私聊建群、运行中图片与日志、暗号记忆、原 Thread 两仓库准备、真实批准/拒绝/旧卡过期、专用私有 GitHub 变更、重复观察和实际进程重启均有原始证据。上述历史未完成项现已通过，全部工单合计 60 项验收条件通过。隔离服务正常停止，三个 Task 均 idle 且无待决请求；正式收集器未启动。Astra 协调者及原验收人员末轮受用量限制中断，改由新的 Sol xhigh 独立验证者审查已捕获证据，未把中断报告当作通过结论。

