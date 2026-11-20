# 04: 由 Prompt 决定工作范围的 Worker 派单

Status: ready-for-agent

规格：[Agent 协作工具简化](../spec.md)。用户故事：2、3、4、5、6、38、39、40。

**What to build:** 协调者依据用户要求与项目规则直接派发调查或实现任务，工具不再要求业务授权字段。

**Blocked by:** None (can start immediately)。

- [x] 删除 Feature 派单对指定群消息、Issue 版本、范围指纹和业务模式的强制检查。
- [x] Runtime 不再按业务类型追加调查限制，协调者把实际允许和禁止范围写入任务说明。
- [x] 只有协调者可以创建 Agent Loop Worker，完整执行配置选择、身份保持与创建去重继续有效。
- [x] 角色和派单指导包含目标、背景、范围、已有决定、验收和交付内容；这些是写作指导，不是新的工具字段门槛。
- [x] Worker 使用 pstack 组织内部子 agent；只讨论、只调查等用户限制继续由 prompt 和上下文指导执行。
- [x] 同步更新所有派单入口、相关动态上下文及调用方，在完整 Runtime 测试中证明新派单契约和既有身份边界。

## Comments

2026-11-20，已实现并完成自动化验收。Feature 派单取消业务字段门槛，保留原始范围和执行身份。Runtime、原生工具及 Worker execution identity 测试通过。 最终候选 ece0b56 的完整测试 775/775 通过。集成证据和真实验收范围见 [verification.md](../verification.md)。
