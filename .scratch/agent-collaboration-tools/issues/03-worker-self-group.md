# 03: Worker 自行建立和复用任务群

Status: ready-for-agent

规格：[Agent 协作工具简化](../spec.md)。用户故事：17、18、19。

**What to build:** Worker 需要与用户直接讨论时，自行创建任务群并开始正常交流。

**Blocked by:** None (can start immediately)。

- [ ] Worker 能为自己建立任务群，协调者仍能为自己项目内的 Worker 建群。
- [ ] 重复、并发调用或响应丢失后复用已确认的群，不制造重复任务群。
- [ ] Worker 不能为另一个 Worker 或其他项目建群，既有项目协调群不被误当作任务群复用。
- [ ] 建群后普通用户输入继续原 Worker 和 Thread，完整助手输出沿用现有 Worker 群行为。
- [ ] 更新建群能力的工具定义和相关 prompt，不再要求 Worker 先请协调者代办。
- [ ] 复用现有群创建和恢复测试，覆盖无群、已有群、创建失败和不确定回执场景。
