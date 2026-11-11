# 08: 将 Agent 的进展实时同步到任务群

Status: ready-for-agent

Implementation: complete at 09fe3f6. Independent actual Codex-to-Runtime-to-Feishu progress/final readback and fresh-process no-resend verification passed.

**What to build:** 长执行期间，Agent 面向用户的进展及时出现在群里，最终答复完整到达；默认不逐条发送工具日志。

**Blocked by:** 01: 让已有 Task 支持通用答复与等待

**User stories:** 37, 38, 39

- [x] Codex 用户可见进展和最终答复经通知链路送到正确群，多个 Task 的输出不混淆。
- [x] 处理分片和最终消息，避免重复输出或把不完整片段当最终结果；重连后核对可恢复的发送状态。
- [x] 默认不转发内部推理或逐条工具原始日志；Runtime 不生成工程阶段判断或业务总结。
- [x] 通知失败及发送结果未知保持可诊断，不伪装已送达或盲目重复发送。
- [x] 服务级输出路由和持久化测试通过，并展示真实 Codex 进展进入飞书的证据。

## Comments

2026-11-05：[真实平台报告](../execution/evidence/platform-review/report.md)将原生输出、SQLite outbox 与飞书 message ID 逐一关联。进度在执行中读回，最终文本逐字一致，真实工具 stdout 未转发，重启没有重发。推理事件在实测中未出现，过滤依据为协议测试。API 读回不等于用户已在客户端查看。

