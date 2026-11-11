# 09: 暂时故障后有限恢复原任务

Status: ready-for-agent

Implementation: complete at 09fe3f6. Independent fault, real native interruption, same-Thread recovery and uncertainty-barrier verification passed.

**What to build:** 执行进程或连接暂时故障后，核对现场再有限恢复；连续失败达到配置上限时通知并保留现场。

**Blocked by:** 02: 从飞书私聊新建无仓库讨论 Task；05: 所有普通消息及时进入原会话

**User stories:** 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69

- [x] 恢复前核对既有执行、输入与输出状态，保持同一 Task 唯一活跃执行，人工与 GitHub Task 均适用。
- [x] 暂时故障有限自动恢复，重试参数来自配置；达到上限后保持可诊断状态并通知，不无限重试。
- [x] 未知业务副作用及未确认消息不能直接重放，恢复错误不影响其他独立 Task。
- [x] 正常等待和 Agent 已遵从的主动停止不被当成故障；正常重启本身不触发额外工作，新输入可按既定规则处理。
- [x] 不引入总执行时长硬上限，不以进展静默单独认定失败。
- [x] 故障注入和真实进程中断场景验证恢复、失败上限及原会话续接；不把进程恢复验证说成任意外部命令副作用恢复。

## Comments

2026-11-05：[应用审查](../execution/evidence/runtime-review/report.md)和[独立真实 SIGKILL 探针](../execution/evidence/native-review/report.md)通过。正常等待、显式暂停、未知投递与错误资源关联保留各自屏障。此证据不证明任意外部业务命令的副作用可安全重放。

