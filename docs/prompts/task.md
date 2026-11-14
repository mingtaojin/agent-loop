# 正式会话提示词

正式会话按项目角色读取模板。协调者使用
[prompts/coordinator.md](../../prompts/coordinator.md)，Worker 使用
[prompts/worker.md](../../prompts/worker.md)。只有项目成员可以启动正式执行。
`engineering.promptPath` 保留创建记录的提示词快照，不替换角色指导。

用户只在项目协调群交办。CLI 和私聊接单已移除。GitHub 证据与历史接单请求继续保留。项目不明确时，临时只读会话根据
提供的候选定位项目或提出问题，不执行调查、开发或部署。选择 `none` 也不能
创建无项目归属的正式 Thread。临时模型的推理、问题和选择输出不复制进正式
执行；用户的原文、补充回答和附件完整保留。

协调者接收原始材料并决定如何处理。需要独立执行时，`dispatch(intakeTaskId)`
将接单记录原地转为 Worker。正式 Thread 从第一轮就能读取角色指导、具体委派、
原始材料和已经确认的范围限制。模糊需求由 Worker 使用 grill-with-docs 调查和
澄清，协调者在项目群转达问题与回答。

Runtime 将当前角色模板、项目规则、委派和环境说明合并，通过
`developerInstructions` 传给正式 Thread，并通过每轮 `additionalContext` 的
`agent-loop-runtime` 项传入同一份内容。旧会话的历史提示词不覆盖当前规则。
任务来源和 Issue 类型不选择另一套固定工程流程。

已有正式任务原地纳入项目协调，保留原群、Thread、资源和原生审批关联。
新旧 Thread 都使用相同的项目操作；旧 Thread 缺少动态工具时，使用任务限定的
本地客户端。客户端不增加权限，也不能冒充其他任务。

Worker 默认无群，正式问题、进展和成果通过显式 report 交给协调者，独立任务完成也须汇报。普通最终答复和任务群问答留在原任务，用户要求同步时直接 report 有实际用户来源的讨论摘要。Runtime 不发送定时监督提醒。原生审批按需建群，进度只在有效群发布。一次答复结束不表示整项工作已经验收或允许重建另一个执行者。
