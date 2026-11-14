# 配置项目协调者

项目群就是用户与该项目协调者交流的入口，可以在这里讨论想法、澄清需求和交办工作。协调者组织 Worker、独立验证和交付，任务创建或委派本身不代表已获开发授权。

每个项目通过自己的协调者接单，使用 pstack Orchestrate 委派和监督任务。Worker 使用 poteto-mode，自行选择调查、需求澄清、开发和验证方法。用户只在项目协调群交办，包括没有 Issue 的 Bug 和新需求。GitHub 收集作为协调者证据，Runtime 不自动创建普通执行任务。CLI 和私聊不再接单。

Worker 默认不建群；用户需要直接交流时，由协调者打开指定任务群。

## 配置项目

首次建立本地项目协调群前，管理员必须在 `projects` 显式登记项目。空数据库仅配置 `engineering.projectRoot` 不会自动为每个目录建群。发现根目录只提供工程候选，GitHub 和历史请求确定项目归属时仍可复用相应协调者。项目身份按实际目录持久保存，重启复用原协调者。本地发现不扩大 GitHub 采集范围。

需要明确仓库归属、接手条件或项目规则时，在 `projects` 配置项目。目录相对于配置文件解析，必须已经存在。纯本地项目可以设置 `repositories: []`。

```json
{
  "execution": {
    "coordinator": {"backend": "codex", "model": "gpt-6-astra", "reasoningEffort": "high"},
    "worker": {"backend": "codex", "model": "gpt-6.1-sol", "reasoningEffort": "xhigh"},
    "backends": {"codex": {"executable": "codex", "approvalPolicy": "on-request", "sandbox": "workspace-write", "requestTimeoutMs": 120000}}
  },
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
    }
  ]
}
```

仓库可以设置标签、账号或 `criteria`。设置标签或账号时，Issue 带任一指定标签，或者被指派给任一指定账号，即满足这部分条件。账号比较不区分大小写，标签按原文匹配。仅设置 `criteria` 时使用其收集条件。首次运行会接手符合条件的存量未关闭 Issue。PR 不作为 Issue 接手。

仓库条目可添加可选的 `criteria`，在标签或指派条件之外再应用普通收集过滤。例如 `{"name":"crysound/OpenTest","assigneesAny":["mingtaojin"],"criteria":{"taskTypes":["bug"]}}` 仅接手同时指派给该账号且分类为 Bug 的 Issue。类型分类沿用 `nativeTypes` 和 `typeLabels`；省略 `criteria` 时保持原来的不限类型行为。

同一仓库只能属于一个协调项目。未显式配置项目的仓库使用顶层收集条件，确定工程后交给该项目的协调者；不能直接启动 Worker。只有来源配置中明确的仓库会被采集。显式项目仓库无需重复出现在顶层 `repositories` 中；需要 Runtime 管理独立工作树时，可继续配置本地路径和基线。

配置在启动时加载。启用实际配置前，按[本机服务操作](agents/operations.md)执行切换并核对。源码测试不代表正式实例已经启用。

协调者和 Worker 使用实例级 `execution` 配置。配置为每个角色指定执行后端、模型和推理强度，所有协调项目共用同一套值。Agent Loop 不提供 验证角色，独立验证由 pstack 负责。执行配置变化由 watcher 读取，已有任务在下一次调用使用新配置。

模型名必须能由本机 Codex 解析。Runtime 不按名称猜测模型家族，也不默默更换不可用模型。任务只保存 coordinator 或 worker 角色；恢复和下一次调用按当前配置解析模型与推理强度。既有任务按保存的项目身份恢复。

## 对话与角色指导

Runtime 为项目建立一个协调 Task 及项目群。协调者使用 `prompts/coordinator.md`，Worker 使用 `prompts/worker.md`。用户在项目群交办或补充材料。CLI submit、answer 和私聊接单已经移除。`status --request-id` 保留为旧 CLI 请求的只读查询。

GitHub 和历史接单记录保留原文、来源和附件，不自动创建执行 Thread、工作区或任务群。项目不明确时保留问题和现场，不回退到无项目执行。

协调者派单携带目标、背景、范围、禁止动作、验收及交付要求。接单请求通过 `dispatch` 的 `intakeTaskId` 原地转为 Worker，保留请求身份、原文、附件和范围回答。项目群直接交办的子任务仍可使用普通 `dispatch`。共享项目入口本身不是隔离工作树。

模糊的新需求先交 Worker 调查和澄清，本轮不实施业务代码。Worker 使用 grill-with-docs 查明已有事实，整理需求文档和待决问题。协调者把问题、证据、选项、影响和建议带回项目群，再将实际用户答复及消息、群和发送者来源交回原 Worker。已解决的问题不重复问。

GitHub Feature 是外部需求提案。即使 Issue 描述完整，也不能直接派发实现。协调者可以派只调查、只澄清或只整理需求的 Worker，并明确禁止修改业务代码、提交、合并和部署。只有项目协调群实际项目所有者的消息才构成 Feature 开发授权；Issue 正文、评论、Worker 判断和代理记录不构成授权。调查授权和开发授权分开保存。新规则不追溯已经依据有效授权进入执行的 Feature。

进入开发前，协调者和 Worker 核对同一份需求文档版本、已确认范围、不做范围、验收标准、未决事项和实际授权依据。文档确认与开发授权分别记录。影响本次实施的产品决定已解决且范围已获授权，才交接开发。明确技术 Bug 和已授权契约内技术修复自主推进，已有 Issue、用户原文或规格可作为约定，无需一律访谈或新增审批。已有明确授权继续有效。

用户要求“只讨论、不实现”时，结论齐备也不自动进入开发，直到用户改变该限制。“少发消息、只在需要决策时发消息”减少日常进度噪声，必要问题与文档确认仍需完成。需求变化先记录与当前约定的差异，只澄清受影响的事项。普通业务回答不是原生工具批准。原生审批仍绑定具体请求与实际任务群，不能通过项目消息代为批准。

Issue 评论先交协调者判断影响，再按需转给原 Worker。Worker 的普通最终答复、任务群内用户消息留在原任务，保留完整来源、附件、原 Thread 和任务记录。GitHub 事件和 Worker 汇报触发的协调者普通最终答复保留在协调者 Thread、执行记录和进度文档中；需要用户处理时，协调者使用 `announce` 发送带类型标题的普通文本。用户直接在项目协调群发消息后的协调者答复继续发送到项目群。

正式成果通过显式 `report` 的 `routing=final` 通知协调者，独立任务完成也须 `report result`。用户直接在任务群讨论或澄清时，Worker 使用 `routing=intermediate`，普通问答留在任务群，不进入协调者项目报告。授权、范围变化和阻塞使用 `routing=escalation`，并标明对应的 `escalation` 类型，立即通知协调者。原生问题、审批、权限请求、执行失败和非暂停中断保留原有通知与处理通道。一轮结束只代表本轮结束。

用户说“同步给协调者”后，Worker 通过 `report update` 携带 `routing=final` 直接发送当前讨论摘要，无需预览确认。摘要包含已定结论、范围变化、待决问题和证据，引用实际用户消息、群、发送者及必要原文。用户指定话题时仅同步该话题。摘要仍是代理汇报，不能冒充用户决定或增加实施、合并、部署及原生审批授权。

## 项目工具

新正式 Thread 提供 `project_action`。工具从当前 Thread 确定调用方，Runtime 检查项目与角色。不能在参数中冒充另一个 Task。
保留的 Thread 缺少工具，或其旧 schema 缺少所需 action 或字段时，按当前 Runtime 指令使用 `project-client` 回退命令；该命令仍检查同一 Task 的活动 turn、连接 epoch 和调用方角色。

| action | 作用 | 允许角色 |
| --- | --- | --- |
| `status` | 查询项目、任务和持久记录 | 项目成员 |
| `claim_intake` | 引用本项目群实际用户消息，原地认领明确的未归属旧请求，不启动执行 | 协调者 |
| `dispatch` | 接管指定 intakeTaskId，或按请求身份创建 Worker、外部验证流程 | 协调者 |
| `send` | 向本项目 Worker 追加指导或回答 | 协调者 |
| `announce` | 向项目协调群发送带类型标题的用户可见公告 | 协调者 |
| `open_group` | 打开本项目指定 Worker 的任务群，已有有效群则复用 | 协调者 |
| `plan_group_cleanup` | 冻结既有任务群清单，排除所有项目协调群 | 协调者 |
| `confirm_group_cleanup` | 核对实际用户对清单的确认消息 | 协调者 |
| `apply_group_cleanup` | 执行或继续已确认清单，逐群记录结果 | 协调者 |
| `control` | 暂停或恢复本项目的指定 Worker | 协调者 |
| `report` | 上报结果、问题或更新 | Worker |
| `record` | 按 scope 追加带项目版本的记录，返回有界确认 | 项目成员 |
| `rotate` | 保存恢复说明并在安全结束后更换协调会话 | 协调者 |
| `allocate_artifacts` | 分配新任务专属产物目录 | 项目成员 |
| `register_artifact` | 登记唯一交付物保护和交付状态；协调者可指定本项目 taskId | 项目成员 |
| `complete_task` | 正式结束 Worker 并冻结新归属资源的清理意图 | 协调者 |
| `cleanup_artifacts` | 冻结自己的指定 scope，不结束协调 Task | 协调者 |
| `release_workspace` | 释放调用方拥有的 Runtime 工作树 | 项目成员 |

修改动作携带稳定的 `requestId`。同一调用方使用相同 ID 和内容重试，返回原操作确认；更换内容会报冲突。历史 record 回执也只返回记录确认，不重新暴露过去保存的整份项目状态。`record` 同时携带 `expectedVersion`，版本不符时先重新读取，再决定如何更新。

默认 `status` 返回有界概览。Worker 只能读取自己的任务详情、关联 Issue 和评论，以及对自己可见的记录。其他任务的输出、资源和原生请求正文不进入其结果。协调者可显式查询本项目任务详情。过滤先于分页，counts 表示调用方可见的数量。完整历史按 `section` 分页，支持 `issues`、`comments`、`records`、`tasks` 和 `intakes`。协调者还可查询 `unassigned_intakes`，只发现脱敏标识，不提供其他项目的正文和附件路径。`offset` 从零开始，`limit` 默认 20、最大 100。继续读取 `nextOffset`，不要把概览当作全部历史。

```json
{"action":"status","section":"records","offset":0,"limit":20}
```

旧 Thread 无法补注册动态工具。Runtime 为项目成员提供任务限定的本机客户端命令，接收动作 JSON 文件，调用相同接口。命令只在该任务活跃执行时有效。能力文件不能读取、复制或在任务间共享。

未归属的历史请求先在项目群确认实际归属，再调用 `claim_intake`。动作携带 `taskId`、`messageId` 和稳定 `requestId`，其中 `messageId` 必须指向本项目协调群保存的实际所有者消息。认领仅保存路由，不创建 Worker、启动 Thread 或回答原生请求。已有项目归属、正式 Thread、暂停以及其他项目的 GitHub catalog 绑定都会阻止认领。同一请求安全重试，随后仍需显式 `dispatch(intakeTaskId)`。不要自动认领积压请求。

### 选择记录范围

record 的 scope 与作者分别保存。

| scope | 可见范围 | 可写入角色 |
| --- | --- | --- |
| `{"kind":"project"}` | 本项目所有成员 | 协调者 |
| `{"kind":"task","taskId":"<目标 Task>"}` | 目标 Task，以及可显式查询的协调者 | 目标 Worker，或本项目协调者 |
| `{"kind":"coordinator"}` | 协调者 | 协调者 |

省略 scope 时，Worker 写入自己的任务范围，协调者写入协调者范围。目标必须已经属于同一项目。协调者将选定资料写到目标 Worker 的任务范围，或通过 send 交接。Worker 不因此获得作者的其他记录。

当前记录按 scope 和 key 的组合取最新值。两个任务可以各自使用同一个 key。`expectedVersion` 仍使用项目级 version，其他任务写入可能引起版本冲突。重新读取并修改请求内容时使用新的 requestId。

旧记录保留原文。没有 scope 的旧记录只供协调者显式查询。它们不进入任何成员的自动上下文。record 返回 accepted、requestId、key、version 和已保存的 scope，不返回其他项目资料。

角色指导和配置规则保持稳定。可见记录在实际 start 或 steer 输入中单独提供，最多八条，每条正文最多 2000 字符。记录写入不会创建 Turn，也不会因全局版本改变而更新无关任务的上下文或加载状态。协调者的自动上下文只包含共享记录及自身范围的记录，其他任务详情按需查询。

过滤作用于 Runtime 提供的项目资料，不清除原 Thread 已经收到的历史，也不构成共享工程目录的文件访问隔离。每个 Task 继续使用原有持续 Thread。

### 保存需求决定与开发交接

项目自己的文档版本、决定、来源、授权和下一步通过现有 `record` 保存。文档负责描述需求，记录引用文档和具体变化，不再复制整份规格。下面的示意记录把选定交接资料提供给已存在的 Worker。目标 Task、路径、消息身份和版本须替换为当前项目的真实证据。`expectedVersion` 使用刚读取的项目版本。

```json
{
  "action": "record",
  "requestId": "d279fb3e-4d62-4192-91da-1968e189ed20",
  "expectedVersion": 8,
  "scope": {"kind": "task", "taskId": "<worker-task-id>"},
  "key": "export-v3-development-handoff",
  "text": "需求 .scratch/export/spec.md v3，提交 <commit>；确认范围：导出当前筛选结果；不做：定时导出；验收：列顺序和数量与筛选一致；未决：无。用户文档确认来源 <message-id-1/group-id/sender-id>，开发授权来源 <message-id-2/group-id/sender-id>，原文及范围见这两条输入。协调者判断：可交接实现；下一步：原 Worker 在独立分支开发并提交独立验证。"
}
```

仍在澄清或仅讨论时，记录实际未决问题与“本轮只调查和文档，不实现”，不要写成已获授权。开发派单引用这条记录及其需求版本，并携带禁止动作与验证交付要求。记录中的代理判断不能替代实际用户决定。新建、恢复或更换协调会话先查 `status` 和相关记录，再核实现场、原 Worker 与 PR，沿用有效授权及暂停限制。

### 公共提示词如何生效

同一实例的项目角色共用该实例代码目录中的 `prompts/coordinator.md` 和 `prompts/worker.md`，Worker 也读取 Worker 模板。项目自己的规则与授权由项目配置和持久记录提供，公共模板不授予跨项目的合并或部署权限。其他安装实例需要各自发布对应文件；只更新一个工作树不会更新其他实例。

`src/loop.ts` 在建立正式 Thread 和检查已有 Thread 时读取当前角色文件，再拼接项目指导和执行环境。源码入口从源码目录定位 `prompts/`，编译入口从 `dist/src/` 回到安装根目录的 `prompts/`，部署时也需保留这两个 Markdown 文件。项目成员不使用普通任务的 `engineering.promptPath`；Task 中保存的旧 prompt 不是角色指导的读取依据。

`src/adapters/codex.ts` 在 `thread/start` 传入 `developerInstructions`。检查保留 Thread 时，指导发生变化会通过 `thread/resume` 传入当前内容；后续 `turn/start` 和 `turn/steer` 同时携带当前 Runtime 指导。正在运行的轮次不会因修改文件而立即重写已执行的行为，暂停任务也不因此恢复。保留 Thread 的动态工具限制与上文的本机客户端回退仍然适用。

这些是加载与投递机制，不保证模型逐次遵守规则。源码、编译入口的隔离检查与场景核对见[共享需求工作流验证](verification/shared-requirement-workflow.md)。本改动不代表正式实例已发布或重启。

## 事件触发和恢复

项目关系、决定与请求回执通过现有 SQLite 写入者保存。协调者通过 `rotate` 提交恢复说明。当前轮次结束、没有未答原生问题和未确认输入后，Runtime 保留同一项目、Task、群和 Worker 关系，建立新正式 Thread。恢复输入要求读取项目记录并核实当前事实。原会话执行记录仍保留。

升级时，已经存在的正式任务依据保存的工程资源原地纳入协调，保留群、Thread、待处理输入、审批、资源和暂停或失败状态。尚未执行的旧任务作为接单请求交给协调者决定。无法确定项目的历史任务保留现场并等待澄清，不继续无项目归属的执行。`status` 的 `intakes` 分页保存未派发请求入口，协调者更换上下文后仍能找回。

Runtime 不生成定时监督提醒。显式汇报、项目群用户输入、原生请求、执行异常、GitHub 更新及必要生命周期事件继续进入原协调者 Thread，运行中追加输入，空闲时启动下一轮。没有新事件时协调者持续等待，静默本身不证明任务失败。正常轮询仍负责观察执行状态、投递已有输入和有限恢复，不因时间流逝制造协调任务。具体核查、重规划与恢复方法由 Orchestrate 决定。

当前项目配置不含监督间隔。显式配置和持久项目 catalog 的兼容入口只接受并移除历史合法 `supervisionIntervalMs`，不生成默认值；其他未知设置仍拒绝。正常保存 catalog 后旧字段消失，不改写用户配置文件。

升级后，身份、来源和生成事件标识均匹配的旧自动用户消息副本、最终答复副本和监督提醒，在尚未尝试投递时标为终态 `dropped`。原始 payload、退役原因及已有错误保留，不再因重启、暂停恢复或附件重试投递。已送达历史不变；`delivering` 和 `uncertain` 继续按已见输入 ID 对账，不能宣称撤回，也不盲目重发。旧消息若已经进入模型历史，升级不能从历史中删除它。

正常活动检查和动态工具校验使用当前连接的 Turn 身份与轻量状态，不读取完整历史。启动恢复、终态、结果未知的输入和审批仍需完整核对。轻量活动证据不包含历史输入 ID，不能据此宣称未知输入已投递。

单个请求超时只使该请求结果不确定，保留其他 Thread 和原生审批的连接身份。超时的 thread/resume 在原结果未知时不重发，后到的原响应可以解除该 Task 的等待。真实进程退出、协议损坏或写通道故障才使共享连接失效。重建连接后，按实际任务需要恢复原 Thread，缺失的旧 Thread 不阻止其他任务恢复。未知输入和审批不自动重放。

## 交付与清理

各项目的实际授权决定能否自动合并、关闭 Issue 和清理，公共角色指导本身不授予这些权限。已获项目授权时，独立验证、仓库检查和业务决定满足后，由 PR Owner 执行合并。协调者核对实际合并状态，完整目标满足后按授权关闭 Issue，保留交付说明与证据。GitHub 操作由 Agent 使用可用工具执行。Runtime 不将 PR 阶段编码为固定工作流。部署需要独立授权。

`release_workspace` 只处理调用方登记的 Git 工作树。当前会话工作目录、其他任务引用的目录和共享项目目录不能释放。存在改动、未跟踪文件或 ignored 文件时拒绝清理，先由 Worker 根据 pstack 保全成果、核查临时产物。

自动释放还要求提交已被保全到配置的基线。基线未更新或 squash 合并无法通过提交祖先核对时，保留目录并报告原因，不强制删除。Worker 自建的工作树按 Worktree cleanup 另行核查。

## 验证

任务结束和新产物目录的工具参数、保护范围及恢复行为见[任务收尾](task-closeout.md)。可重跑验收使用 `npm run verify:closeout`，测试真实 SQLite、文件、Git 和占用资源的子进程，模型与飞书为受控替身。真实模型、飞书及业务实例清理不在该测试结论内。

需求及验收场景见[项目协调者规格](../.scratch/project-coordinator/spec.md)。隔离 Runtime 测试使用真实 SQLite 和受控平台接口，协议测试运行实际适配器及子进程。真实模型探针使用独立临时项目，不对业务仓库或任务群操作。结果分别记录在功能目录的 `execution` 中。

任务记录、活动检查、事件触发和超时隔离可在本地复查，无需真实模型或飞书实例。

```sh
node --import tsx --test test/project.test.ts test/project-runtime.test.ts test/project-codex.test.ts test/codex.test.ts test/codex-isolation.test.ts test/runtime.test.ts
npm run check
npm run build
npm test
```

上述检查使用临时 SQLite 目录和本地协议子进程。它们不代表真实飞书验收，也不证明现场首次 Codex 请求阻塞的内部原因。
