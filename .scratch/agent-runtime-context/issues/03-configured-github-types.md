# 03: 按配置收集并启动不同类型的 Issue

Status: ready-for-agent

Implementation: complete at 09fe3f6. Independent configured-type, service and actual CLI HTTP verification passed, including custom refactor classification and unchanged Bug defaults.

**What to build:** 配置启用的 Feature 等非 Bug Issue 能成为可对话的 Task，未启用类型不进入，现有收集范围保持不变。

**Blocked by:** 01: 让已有 Task 支持通用答复与等待

**User stories:** 40, 41, 42, 43, 44, 45

- [x] 移除独立于配置的只允许 Bug 检查；按配置的分类与筛选依据决定纳入并记录跳过原因。
- [x] 仓库、分配人、标签、原生类型与分类映射仍有效；不强制新增启动标签，不自动扩大原配置的范围。
- [x] 仅收集仍不创建群或启动 Agent，运行服务后匹配来源可创建任务群并获得通用答复。
- [x] 重复来源只关联既有 Task，首次匹配积压与新来源按同一配置处理。
- [x] 模板和技能输入不再只为 Bug 路径硬编码工程流程；保留 Agent 对实际工作方法的决定权。
- [x] 用配置启用 Feature 的完整收集到答复场景验证，并覆盖仅 Bug 配置、冲突或未知分类、分页和 CLI 仅收集回归。

## Comments

2026-11-05：[独立审查](../execution/evidence/runtime-review/report.md)通过 Feature、自定义 refactor、未启用类型、冲突与未知分类以及真实 CLI 到本地 HTTP 分页。没有启动或修改真实业务 Issue；真实外部组合验收仍由第 10 票记录。

