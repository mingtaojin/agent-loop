# 正式任务提示词

正式任务的规则来自一份模板，默认是应用目录中的 [prompts/task.md](../../prompts/task.md)。`engineering.promptPath` 可指定替代文件；省略时仍读取默认模板，源码和构建产物启动均不依赖当前工作目录。任务来源和 Issue 类型不参与模板选择。

新任务先在独立、只读、临时的 Thread 中选择工程入口。该会话只接收选择职责、已配置候选入口和作为判断依据的任务材料，可以返回配置仓库名、无需工程目录，或需要用户补充的目录问题。它不执行正式任务，也不加载正式任务的 poteto-mode 和 grill-with-docs 工作指导。

Runtime 校验并保存选择结果，准备工程资源后另建正式 Thread。正式 Thread 的实际工作目录为选定的工程目录；无需工程目录时使用任务资料目录。它的首轮输入接收完整任务原文，以及目录选择期间用户答复的完整文字、来源与附件；用户补充的范围限制在开始执行前可见。目录问题的用户答复单独保存，下一次选择使用新的临时 Thread 和已保存答复。临时模型的问题、推理和选择输出不复制到正式 Thread。

Runtime 将当前模板、已确定的环境信息和 `engineering.skillPath` 合并，通过 `developerInstructions` 传给新建或恢复的正式 Thread。每次开始或追加输入时，通过 `additionalContext` 的 `agent-loop-runtime` 项传递同一份内容，并说明它替换此前的 Runtime 提示词。两处传递共用内容，不再追加独立的业务规则。任务创建时保存的 prompt 快照仅作记录，后续输入使用当前文件内容。

保留 `additionalContext` 是为了已有会话的提示词更新：此前实测仅在恢复时提交 `developerInstructions` 未使模型采用新规则，通过每轮 application context 传入后才生效。

新正式 Thread 的环境说明不包含目录选择过程或备用 shell 命令。Agent 可通过 `ensure_workspace` 申请后续需要的额外工程资源。已有正式 Thread 保留原目录与会话，旧 Thread 的工作区兼容命令继续按需提供，见 [ADR 0008](../adr/0008-temporary-workspace-selection.md)。

飞书输入包含用户正文和来源信息。GitHub 初始输入包含 Issue 事实和来源信息，不重复拼入任务指导。收集条件仍通过 `repositories[].criteria` 决定，与 prompt 选择无关。

技能选择和任务边界见默认模板。具体工程流程由 poteto-mode 选择，访谈和决定记录由 grill-with-docs 及其依赖技能负责。Runtime 不编排澄清或开发阶段，也不增加澄清技能路径配置。

飞书只转发 Agent 的最终答复，中间过程说明保留在本地调试台。原生问题、工具审批和服务异常提示继续通过飞书发送。正常轮次完成后等待新输入，不要求固定 JSON 报告或 PR。
