# 05: 所有普通消息及时进入原会话

Status: ready-for-agent

Implementation: complete at 09fe3f6.

Acceptance: complete. Service races, native questions and genuine owner-uploaded image/log append in the original running Thread are VERIFIED within the recorded capabilities.

**What to build:** 运行时追加、空闲时唤醒；停止指示交给 Agent 判断，原生提问也能收到用户回复而不假送达。

**Blocked by:** 04: 在任务群直接批准或拒绝工具请求

**User stories:** 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 50, 56, 57, 61

- [x] 移除普通群消息的工作控制命令截获；停止指示与旧普通控制文本均进入原会话，Runtime 不据文字暂停或恢复任务。
- [x] 活跃时及时追加，无活跃执行时在原 Thread 启动；轮次结束竞争、重复消息、启动期间输入和离线补收不丢失或重复投递。
- [x] 原生阻塞与非阻塞问题均验证用户输入真正抵达等待中的 Agent；不将外部来源信息转换为人工答案，不引入访谈阶段。
- [x] 已有图片、UTF-8 日志和文字完整送达；附件独立保留，失败可见并可在核对后重试，错误不被静默当成成功。
- [x] 独立工具审批动作与普通输入保持分离，不恢复文本权限批准捷径。
- [x] 服务级竞态与历史补收测试通过，并在真实 Codex 会话验证运行中追加、图片/日志读取及原生问答衔接。

## Comments

2026-11-05：[服务审查](../execution/evidence/runtime-review/report.md)和[原生验证](../execution/evidence/native-review/report.md)通过。图片为有效合成 PNG，日志为临时 UTF-8 文件。非阻塞原生提问使用验证进程专用开关，阻塞提问使用原生 Plan 模式探针；未修改生产工作流。真实所有者从飞书上传材料的全链路未验证，保留在第 10 票。

2026-11-05：[最终独立审计](../execution/evidence/acceptance-review/final-audit.md)已补齐真实所有者从 Freedom 客户端上传的 PNG 和日志，实际资源下载、哈希、原生 inProgress 状态、同轮 steer、内容读取和最终飞书答复均有对应证据。该历史缺口关闭，原生问题能力限定保持不变。

