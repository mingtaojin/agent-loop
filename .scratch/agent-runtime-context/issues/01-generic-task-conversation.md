# 01: 让已有 Task 支持通用答复与等待

Status: ready-for-agent

Implementation: complete at 09fe3f6. Independent application and native-to-Feishu verification passed. Workspace publication is tracked separately.

**What to build:** 已有任务群能收到调查结论或普通答复，回答后等待；结果不必是 PR，Runtime 不安排下一工程阶段。

**Blocked by:** None (can start immediately)

**User stories:** 20, 28, 29, 30, 31, 32, 33, 34, 35, 36, 38, 60, 66, 67

- [x] 已有 GitHub Task 可返回不含 PR、不要求用户回答的普通结果，群内收到原答复，轮次正常结束而非被判失败。
- [x] 后续消息复用原 Task、群和 Thread；正常等待在无新输入或仅服务重启时不自动续跑。
- [x] 替换固定工程交付报告契约及运行时 PR 验收门槛；执行结束、等待、错误与业务交付结论分别表达。
- [x] 工程指导移除固定实机复现后确认步骤，保留已授权技术工作自主推进、业务歧义或授权不足澄清；不增加 Runtime 技能切换状态机。
- [x] 不增加总执行时长限制，不根据进展静默独自判定故障；旧任务对话和证据保持可读。
- [x] 通过现有服务入口验证正常答复、等待、同会话续接与错误行为，并用真实 Codex 协议验证新的结果处理。

## Comments

2026-11-05：独立验证通过。证据见[应用审查](../execution/evidence/runtime-review/report.md)、[原生协议与真实会话](../execution/evidence/native-review/report.md)和[真实飞书读回](../execution/evidence/platform-review/report.md)。飞书测试的初始输入为夹具，不冒充真实私聊创建。

