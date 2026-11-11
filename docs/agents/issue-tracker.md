# Issue tracker: Local Markdown

本项目的规格与任务存放在 .scratch/，路径均相对项目根目录。

## 文件约定

- 每项功能一个目录：.scratch/<feature-slug>/
- 规格：.scratch/<feature-slug>/spec.md
- 实现任务：.scratch/<feature-slug>/issues/<NN>-<slug>.md
- 实现任务从 01 编号，每个任务独立文件。
- 分诊状态写在文件顶部的 Status: 行，取值见 triage-labels.md。
- 评论和讨论追加到文件末尾的 ## Comments 下。

## 技能操作

- 发布规格或任务：创建对应 Markdown 文件。
- 读取任务：按用户提供的路径读取。
- 修改状态：更新 Status: 行，保留正文和讨论。
- 当前项目未配置远端 tracker，不创建远端 issue。

这里管理的是 agent-loop 工程自身的工作项。
运行时收集哪些 GitHub Issue，由应用的采集配置决定。
