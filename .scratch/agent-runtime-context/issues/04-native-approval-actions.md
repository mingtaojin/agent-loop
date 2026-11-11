# 04: 在任务群直接批准或拒绝工具请求

Status: ready-for-agent

Implementation: complete at 09fe3f6.

Acceptance: complete. Genuine command-card approve, reject and stale-card rejection independently VERIFIED; exact client toast and pixel presentation were not captured.

**What to build:** Codex 发出原生审批时，任务群显示对应的批准／拒绝操作，用户操作回到同一个待决请求。

**Blocked by:** 01: 让已有 Task 支持通用答复与等待

**User stories:** 53, 54, 55, 56

- [x] 命令、文件和额外权限的原生审批呈现具体请求信息及明确批准/拒绝操作，不要求复制请求编号到聊天。
- [x] 回调核对操作人、Task、Thread、请求身份与有效期；重复、过期、跨群或不匹配操作不能批准其他请求。
- [x] 普通聊天不会自动授予权限，执行环境限制不因接入审批卡片而被放宽。
- [x] 用户操作结果和请求处理可追溯；回调或回复结果未知时保留证据，不自动再次批准。
- [x] 保留必要的原生问题接口供消息衔接使用；淘汰文本批准命令的交互依赖。
- [x] 服务与协议测试覆盖请求有效性，并真实验证飞书卡片点击、批准、拒绝和过期控制；SDK 类型存在不算联调通过。

## Comments

2026-11-05：[应用审查](../execution/evidence/runtime-review/report.md)验证关联、持久化接收和不确定结果屏障；命令批准/拒绝有真实原生文件证据。文件与额外权限形状为协议覆盖。[飞书实测](../execution/evidence/platform-review/report.md)创建并读回实际待决命令卡片，但未收到真实用户点击，随后中断并关闭夹具。最后一项保持未勾选。

2026-11-05：[最终独立审计](../execution/evidence/acceptance-review/final-audit.md)核对三次真实 owner 点击。第一轮批准对应原生 accept 和 approved.txt 的精确内容；旧第一卡的新拒绝动作被判过期，未影响第二请求；当前第二卡拒绝对应原生 decline，rejected.txt 未创建。验收完成。文件变更与额外权限审批形状仍为协议覆盖，不宣称本轮逐种真人点击或完整客户端外观验收。

