---
status: accepted
---

# 从父目录发现工程入口

2026-11-10，用户要求只配置一个父目录，由代理依据飞书任务或 GitHub Issue 材料自行定位其中的工程，免去逐个登记本地工程入口的维护。工程发现根目录与选中的项目目录是不同概念，项目目录仍可包含多个仓库。

工程入口固定为父目录的一级子目录。例如 `projects/opentest` 与 `projects/agent-loop` 是两个入口，`opentest` 内部的仓库和版本由正式 Agent 按任务需要定位。项目目录不要求自身是 Git 仓库。

工程发现根目录由用户配置提供。本机配置值确定为 `/Users/developer/IdeaProjects`，代码和默认值不得写死该路径。更换父目录只需修改配置。

本地工程发现与 GitHub 采集分别配置。GitHub 继续使用明确的仓库和收集条件，发现本地工程不会自动采集其远端 Issue。这样本地目录的增减不会改变任务来源范围。

本决策调整 [ADR 0008](0008-temporary-workspace-selection.md) 中候选入口必须逐个配置的限制，沿用独立临时选择会话和正式任务会话。更改发现根目录不自动重绑已有正式会话与资源。讨论、实现与验收要求见[规格](../../.scratch/project-discovery/spec.md)。
