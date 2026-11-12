# 配置项目协调者

每个项目通过自己的协调者接单，使用 pstack Orchestrate 委派和监督任务。Worker 使用 poteto-mode，自行选择调查、需求澄清、开发和验证方法。GitHub、飞书私聊和 CLI 都先进入项目协调，Runtime 不再创建普通执行任务。项目群是主要交流入口，也可以直接交办没有 Issue 的 Bug 和新需求。

## 配置项目

在 `engineering.projectRoot` 配置工程父目录后，Runtime 按直接子目录发现项目，首次接单时创建该项目的协调者。配置了本地路径的仓库也能确定项目。项目身份按实际目录持久保存，重复请求与重启复用原协调者。本地发现不扩大 GitHub 采集范围。

需要明确仓库归属、接手条件或项目规则时，在 `projects` 配置项目。目录相对于配置文件解析，必须已经存在。纯本地项目可以设置 `repositories: []`。

```json
{
  "projects": [
    {
      "id": "product",
      "name": "Product",
      "directory": "../product",
      "repositories": [
        {"name": "example/frontend", "labelsAny": ["agent"], "assigneesAny": ["automation-account"]},
        {"name": "example/backend", "labelsAny": ["agent"], "assigneesAny": []}
      ],
      "instructions": "优先处理 priority:urgent。用户保留亲自审核的 PR 等待确认。",
      "models": {"coordinator": "gpt-6-astra", "worker": "gpt-6.1-sol"},
      "reasoningEfforts": {"coordinator": "high", "worker": "xhigh"},
      "supervisionIntervalMs": 300000
    }
  ]
}
```

仓库可以设置标签、账号或 `criteria`。设置标签或账号时，Issue 带任一指定标签，或者被指派给任一指定账号，即满足这部分条件。账号比较不区分大小写，标签按原文匹配。仅设置 `criteria` 时使用其收集条件。首次运行会接手符合条件的存量未关闭 Issue。PR 不作为 Issue 接手。

仓库条目可添加可选的 `criteria`，在标签或指派条件之外再应用普通收集过滤。例如 `{"name":"crysound/OpenTest","assigneesAny":["mingtaojin"],"criteria":{"taskTypes":["bug"]}}` 仅接手同时指派给该账号且分类为 Bug 的 Issue。类型分类沿用 `nativeTypes` 和 `typeLabels`；省略 `criteria` 时保持原来的不限类型行为。

同一仓库只能属于一个协调项目。未显式配置项目的仓库使用顶层收集条件，确定工程后交给该项目的协调者；不能直接启动 Worker。只有来源配置中明确的仓库会被采集。显式项目仓库无需重复出现在顶层 `repositories` 中；需要 Runtime 管理独立工作树时，可继续配置本地路径和基线。

配置在启动时加载。启用实际配置前，按[本机服务操作](agents/operations.md)执行切换并核对。源码测试不代表正式实例已经启用。

协调者默认使用 `gpt-6-astra` 和 `high`，Worker 默认使用 `gpt-6.1-sol` 和 `xhigh`。项目可通过 `models` 和 `reasoningEfforts` 分别覆盖角色模型和推理强度。verifier 未指定时沿用 Codex 默认配置，按 pstack 为独立验证选择不同模型家族。

模型名必须能由本机 Codex 解析。Runtime 不按名称猜测模型家族，也不默默更换不可用模型。任务创建时保存所选模型与推理强度，恢复与协调会话切换继续使用保存值。普通非项目任务保持原 Codex 配置。

## 对话与角色指导

Runtime 为项目建立一个协调 Task 及项目群。协调者使用 `prompts/coordinator.md`，Worker 使用 `prompts/worker.md`。接单记录先保存原文、来源和附件，不创建执行 Thread、工作区或新的任务群。项目不明确时，在原私聊中澄清；只有一项待答请求时可以直接回复，也可用 `/reply <请求编号> 回答` 指定请求。CLI 使用 `status --request-id` 查询问题，再用 `answer --request-id <原请求 UUID> --answer-id <本次回答 UUID> --prompt-file <文件>` 补充材料。

协调者派单携带目标、背景、范围、禁止动作、验收及交付要求。接单请求通过 `dispatch` 的 `intakeTaskId` 原地转为 Worker，保留请求身份、原文、附件和范围回答。项目群直接交办的子任务仍可使用普通 `dispatch`。共享项目入口本身不是隔离工作树。

模糊需求由 Worker 使用 grill-with-docs 调查和澄清。协调者把待决问题带到项目群，再把回答交给原 Worker。普通业务回答不是原生工具批准。原生审批仍绑定具体请求与实际任务群，不能通过项目消息代为批准。

Issue 评论先交协调者判断影响，再按需转给原 Worker。Worker 最终答复、原生问题、执行失败和任务群内用户补充会通知协调者。一轮结束只代表本轮结束。

## 项目工具

新正式 Thread 提供 `project_action`。工具从当前 Thread 确定调用方，Runtime 检查项目与角色。不能在参数中冒充另一个 Task。

| action | 作用 | 允许角色 |
| --- | --- | --- |
| `status` | 查询项目、任务和持久记录 | 项目成员 |
| `dispatch` | 接管指定 intakeTaskId，或按请求身份创建 Worker、独立 verifier | 协调者 |
| `send` | 向本项目 Worker 追加指导或回答 | 协调者 |
| `control` | 暂停或恢复本项目的指定 Worker | 协调者 |
| `report` | 上报结果、问题或更新 | Worker、verifier |
| `record` | 追加带版本的项目记录 | 项目成员 |
| `rotate` | 保存恢复说明并在安全结束后更换协调会话 | 协调者 |
| `release_workspace` | 释放调用方拥有的 Runtime 工作树 | 项目成员 |

修改动作携带稳定的 `requestId`。同一调用方使用相同 ID 和内容重试，返回原结果；更换内容会报冲突。`record` 同时携带 `expectedVersion`，版本不符时先重新读取，再决定如何更新。

默认 `status` 返回有界概览。完整历史按 `section` 分页，支持 `issues`、`comments`、`records` 和 `tasks`。`offset` 从零开始，`limit` 默认 20、最大 100。继续读取 `nextOffset`，不要把概览当作全部历史。

```json
{"action":"status","section":"records","offset":0,"limit":20}
```

旧 Thread 无法补注册动态工具。Runtime 为项目成员提供任务限定的本机客户端命令，接收动作 JSON 文件，调用相同接口。命令只在该任务活跃执行时有效。能力文件不能读取、复制或在任务间共享。

## 监督和恢复

项目关系、决定与请求回执通过现有 SQLite 写入者保存。协调者通过 `rotate` 提交恢复说明。当前轮次结束、没有未答原生问题和未确认输入后，Runtime 保留同一项目、Task、群和 Worker 关系，建立新正式 Thread。恢复输入要求读取项目记录并核实当前事实。原会话执行记录仍保留。

升级时，已经存在的正式任务依据保存的工程资源原地纳入协调，保留群、Thread、待处理输入、审批、资源和暂停或失败状态。尚未执行的旧任务作为接单请求交给协调者决定。无法确定项目的历史任务保留现场并等待澄清，不继续无项目归属的执行。`status` 的 `intakes` 分页保存未派发请求入口，协调者更换上下文后仍能找回。

存在 Worker 时，Runtime 按 `supervisionIntervalMs` 发送通用监督提醒。提醒要求核查真实进展，不因静默判定失败。协调者处于暂停、故障、运行中或已有待投递输入时，不叠加监督提醒。具体重规划与恢复方法由 Orchestrate 决定。

## 交付与清理

角色指导包含本规格确认的自动交付授权。独立验证、仓库检查和业务决定满足后，由 PR Owner 执行合并。协调者核对实际合并状态，完整目标满足后关闭 Issue，保留交付说明与证据。GitHub 操作由 Agent 使用可用工具执行。Runtime 不将 PR 阶段编码为固定工作流。部署需要独立授权。

`release_workspace` 只处理调用方登记的 Git 工作树。当前会话工作目录、其他任务引用的目录和共享项目目录不能释放。存在改动、未跟踪文件或 ignored 文件时拒绝清理，先由 Worker 根据 pstack 保全成果、核查临时产物。

自动释放还要求提交已被保全到配置的基线。基线未更新或 squash 合并无法通过提交祖先核对时，保留目录并报告原因，不强制删除。Worker 自建的工作树按 Worktree cleanup 另行核查。

## 验证

需求及验收场景见[项目协调者规格](../.scratch/project-coordinator/spec.md)。隔离 Runtime 测试使用真实 SQLite 和受控平台接口，协议测试运行实际适配器及子进程。真实模型探针使用独立临时项目，不对业务仓库或任务群操作。结果分别记录在功能目录的 `execution` 中。
