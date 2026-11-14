---
status: accepted
---

# Agent Loop 使用统一的角色执行配置

Agent Loop 的执行配置由实例统一提供，所有协调项目使用同一套配置。配置按执行角色直接指定执行后端、模型和推理强度：`coordinator` 负责项目协调，`worker` 负责被委派的调查、澄清、开发和交付。Agent Loop 不再提供 `verifier` 角色；独立验证由 pstack 等外部验证流程负责。

配置使用通用的 `execution` 顶层命名，不把 Codex 写入公共配置结构。角色配置的形状为：

```json
{
  "execution": {
    "coordinator": { "backend": "codex", "model": "...", "reasoningEffort": "high" },
    "worker": { "backend": "codex", "model": "...", "reasoningEffort": "xhigh" }
  }
}
```

执行后端在配置加载时校验。当前实现可以提供 Codex 后端，未来可以增加 dsh、Claude Code 等后端；未知或尚未实现的后端不得静默回退。角色配置字段全部显式提供，代码不写模型、后端或推理强度默认值。项目级 `models` 和 `reasoningEfforts`、`codex.model`、`selectionModel` 及公共 `modelProvider` 均不再属于配置契约。

工程归属不再由模型选择。已经明确项目的协调者和 Worker 直接使用项目归属；没有项目归属的 intake 或 legacy Task 保持 pending，不创建执行 Thread，直到协调者完成 `claim_intake` 或 `dispatch`。没有角色的历史 Task 不能回退到通用模型；已有项目成员关系的 Task 保留其 coordinator 或 worker 角色。

运行时监听配置文件。有效变更在当前轮次结束后、下一次创建、恢复或开始调用时生效；正在执行的轮次不被中断。无效变更保留最后一份有效配置并记录诊断，文件修复后自动恢复。任务只保存角色，不把模型或推理强度快照作为运行时来源，因此已有 Task 也会在下一次调用使用新配置。

旧项目级模型字段严格拒绝，要求迁移到统一的 `execution` 配置。配置与角色绑定属于实例级契约，不随单个项目或单个任务重复维护。

本决策改变执行配置的公共边界，但不改变项目责任、Task 持续上下文、工程资源保护或原生审批归属。当前实现已由 watcher 热加载角色配置、在加载边界校验后端，并让未归属任务保持 pending；增加 dsh 或 Claude Code 时只需注册新的执行后端与连接配置。目录选择适配器和 verifier 角色已从 Agent Loop 移除。
